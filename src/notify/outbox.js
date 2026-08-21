/**
 * The queue between "something happened" and "somebody was told".
 *
 * The split that makes this work is between an **event** — a fact about the
 * world, like Georgia's general election being fourteen days out — and an
 * **outbox row**, which is one message to one person on one channel. Fanout
 * turns the first into the second.
 *
 * Everything hard about a notification pipeline falls out of that split being
 * enforced by the database rather than by worker code:
 *
 *   - **Never twice.** `UNIQUE (event_id, user_id, channel)` plus
 *     `ON CONFLICT DO NOTHING`. A fanout that runs twice, or runs on two
 *     instances at once, produces one row. No coordination needed.
 *   - **Never at 3am.** `send_after` is computed in the recipient's timezone
 *     at enqueue, and re-checked at claim — because a row that has been
 *     retrying since yesterday carries a stale `send_after`.
 *   - **Never on two instances.** Claims use `FOR UPDATE SKIP LOCKED`, so
 *     several senders can drain the same queue and simply take different rows.
 *   - **Never without consent.** Suppression and consent are joins in the
 *     fanout query and are re-checked at send, because a STOP that arrives
 *     between the two must win.
 */

const crypto = require('crypto');
const db = require('../db');
const notify = require('./index');
const render = require('./render');
const { hmac, equal, signingKey } = require('../lib/tokens');
const { configuredBaseUrl } = require('../lib/baseUrl');

/* ---------------- one-click links ----------------

   Unsubscribe has to work from an email client with no session and no
   JavaScript — that is the whole point of RFC 8058 one-click — so the link
   carries its own authority: the user's public id plus an HMAC over it.

   Scoped by channel and purpose so an unsubscribe link cannot be repurposed
   into anything else, and carrying no expiry on purpose: an unsubscribe link
   in a two-year-old email must still work. That is a feature, not an
   oversight — the alternative is somebody unable to make us stop.            */

function signLink(purpose, publicId, channel = 'all') {
  const payload = `${purpose}:${publicId}:${channel}`;
  return `${Buffer.from(payload).toString('base64url')}.${hmac(signingKey(), payload).toString('base64url')}`;
}

function verifyLink(token, expectedPurpose) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  let payload;
  try {
    payload = Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let mac;
  try {
    mac = Buffer.from(raw.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }

  if (!equal(hmac(signingKey(), payload), mac)) return null;

  const [purpose, publicId, channel] = payload.split(':');
  if (purpose !== expectedPurpose) return null;
  return { purpose, publicId, channel };
}

const siteUrl = () => configuredBaseUrl() || `http://localhost:${process.env.PORT || 3000}`;

const unsubscribeUrl = (publicId, channel = 'all') =>
  `${siteUrl()}/api/me/unsubscribe/${signLink('unsub', publicId, channel)}`;

const preferencesUrl = (publicId) =>
  `${siteUrl()}/api/me/preferences/${signLink('prefs', publicId)}`;

/* ---------------- fanout ---------------- */

/**
 * Expand one event into outbox rows.
 *
 * This single statement is where subscriptions, seats, issues, geography,
 * preferences, verification, suppression, consent and the frequency cap all
 * meet. Keeping it as one statement rather than a loop in JavaScript is what
 * makes it atomic and what makes the dedup constraint do its job.
 *
 * The audience is the union of three ways somebody can be interested: they
 * follow this exact race, they follow the seat it belongs to (which is what
 * carries them across cycles), or they follow the state and this is a
 * statewide matter.
 */
async function fanout(eventId) {
  const event = await db.one(
    `SELECT e.*, s.seat_key, t.channel AS template_channel
       FROM notification_events e
       LEFT JOIN subjects s ON s.key = e.subject_key
       JOIN message_templates t ON t.key = e.template_key
      WHERE e.id = $1 AND e.fanned_out_at IS NULL`,
    [eventId]
  );
  if (!event) return { inserted: 0, skipped: 'already fanned out or missing' };

  const result = await db.query(
    `INSERT INTO outbox (event_id, user_id, contact_id, channel, digest_bucket, send_after)
     SELECT $1,
            u.id,
            cc.id,
            cc.channel,
            CASE WHEN np.digest_mode = 'immediate' OR $6 = 'deadlines'
                 THEN NULL
                 ELSE u.id || ':' || to_char(timezone(u.timezone, now()), 'YYYY-MM-DD')
            END,
            next_allowed_send(now(), u.timezone, np.quiet_start_hour, np.quiet_end_hour)
       FROM users u
       JOIN notification_preferences np ON np.user_id = u.id
       JOIN contact_channels cc
         ON cc.user_id = u.id
        AND cc.status = 'verified'
        AND cc.verified_at IS NOT NULL
        -- An event carries one template, and a template is written for one
        -- channel. Without this an SMS-worded event would also go out as
        -- email, complete with "Reply STOP to opt out".
        AND ($7::text = 'both' OR cc.channel = $7)
      WHERE u.status = 'active'
        AND EXISTS (
              SELECT 1
                FROM subscriptions sub
                JOIN subjects sj ON sj.key = sub.subject_key
               WHERE sub.user_id = u.id
                 AND (sub.muted_until IS NULL OR sub.muted_until < now())
                 AND sj.status <> 'retired'
                 AND ( sub.subject_key = $2
                    OR ($3::text IS NOT NULL AND sub.subject_key = $3)
                    OR (sj.type = 'state' AND $4::char(2) IS NOT NULL AND sj.state_code = $4)))
        AND CASE $6::text
              WHEN 'deadlines' THEN np.cat_deadlines
              WHEN 'odds'      THEN np.cat_odds
              WHEN 'news'      THEN np.cat_news
              WHEN 'filings'   THEN np.cat_filings
              ELSE np.cat_product
            END
        AND CASE cc.channel WHEN 'email' THEN np.email_enabled ELSE np.sms_enabled END
        AND (cc.channel <> 'sms' OR $5::boolean)
        AND NOT EXISTS (
              SELECT 1 FROM suppressions sup
               WHERE sup.address_hash = cc.address_hash
                 AND sup.channel = cc.channel
                 AND (sup.expires_at IS NULL OR sup.expires_at > now()))
        AND EXISTS (
              SELECT 1 FROM consent_state cs
               WHERE cs.address_hash = cc.address_hash
                 AND cs.action <> 'revoke'
                 AND cs.consent_type = CASE cc.channel
                       WHEN 'sms' THEN 'sms_alerts' ELSE 'email_updates' END)
        AND (SELECT count(*) FROM deliveries d
              WHERE d.user_id = u.id
                AND d.status_at > now() - interval '7 days') < np.max_per_week
     ON CONFLICT (event_id, user_id, channel) DO NOTHING`,
    [
      event.id,
      event.subject_key,
      event.seat_key,
      event.state_code,
      notify.smsEnabled(),
      event.category,
      event.template_channel,
    ]
  );

  await db.query('UPDATE notification_events SET fanned_out_at = now() WHERE id = $1', [event.id]);
  return { inserted: result.rowCount, eventId: event.id };
}

/** Fan out everything waiting. Returns per-event counts. */
async function fanoutPending({ limit = 50 } = {}) {
  const pending = await db.rows(
    `SELECT id FROM notification_events
      WHERE fanned_out_at IS NULL
        AND (auto_send = true OR broadcast_id IS NOT NULL)
      ORDER BY occurred_at ASC
      LIMIT $1`,
    [limit]
  );
  const results = [];
  for (const row of pending) results.push(await fanout(row.id));
  return results;
}

/* ---------------- claiming ---------------- */

const instanceId = `${require('os').hostname()}:${process.pid}`;

/**
 * Claim a batch to send.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole multi-instance story: two senders
 * running the same query take different rows rather than fighting, and a
 * crashed instance's claim becomes available again when `locked_until`
 * passes. No Redis, no leader election, no dedicated worker process.
 *
 * The quiet-hours clause is repeated here rather than trusted from
 * `send_after`, because a row that failed twice yesterday carries yesterday's
 * answer — and the cost of that being wrong is a text message at 3am, which
 * is both a complaint and a TCPA violation.
 */
async function claim({ limit = 25, lockMs = 120_000 } = {}) {
  const rows = await db.rows(
    `UPDATE outbox o
        SET status = 'claimed',
            locked_until = now() + ($2::int * interval '1 millisecond'),
            locked_by = $3,
            attempts = o.attempts + 1
      WHERE o.id IN (
        SELECT o2.id
          FROM outbox o2
          JOIN users u ON u.id = o2.user_id
          JOIN notification_preferences np ON np.user_id = u.id
         WHERE o2.status = 'pending'
           AND o2.send_after <= now()
           AND o2.digest_bucket IS NULL
           AND ( o2.channel <> 'sms'
              OR EXTRACT(hour FROM timezone(u.timezone, now()))
                   BETWEEN np.quiet_start_hour AND np.quiet_end_hour - 1 )
         ORDER BY o2.send_after ASC, o2.id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1)
    RETURNING o.*`,
    [limit, lockMs, instanceId]
  );
  return rows;
}

/** Return rows whose lock expired without a result to the pending pool. */
async function reclaimStale() {
  const res = await db.query(
    `UPDATE outbox SET status = 'pending', locked_until = NULL, locked_by = NULL
      WHERE status = 'claimed' AND locked_until < now()`
  );
  return res.rowCount;
}

/* ---------------- sending ---------------- */

const MAX_ATTEMPTS = 5;

/** Exponential backoff, capped. 30s, 1m, 2m, 4m … up to six hours. */
const backoffMs = (attempts) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);

/**
 * Send one claimed row.
 *
 * Re-checks suppression and consent immediately before dispatch. That is not
 * belt-and-braces: fanout may have run hours ago, and a STOP that arrived in
 * between has to win. Checking only at enqueue is how people receive one
 * final message after unsubscribing, which is the exact thing they complain
 * about.
 */
async function sendOne(row) {
  const consent = require('../lib/consent');

  const context = await db.one(
    `SELECT cc.address, cc.address_hash, cc.channel,
            u.public_id AS user_public_id, u.display_name, u.state_code, u.timezone,
            e.payload, e.category, e.sources, e.subject_key,
            t.key AS template_key, t.channel AS template_channel,
            t.subject_tpl, t.body_tpl, t.active AS template_active
       FROM outbox o
       JOIN contact_channels cc ON cc.id = o.contact_id
       JOIN users u ON u.id = o.user_id
       JOIN notification_events e ON e.id = o.event_id
       JOIN message_templates t ON t.key = e.template_key
      WHERE o.id = $1`,
    [row.id]
  );

  if (!context) return finish(row, 'failed', 'context row disappeared');

  if (!context.template_active) {
    return finish(row, 'failed', `template ${context.template_key} is not active`);
  }

  const suppressed = await consent.isSuppressed(context.address, context.channel);
  if (suppressed) return finish(row, 'suppressed', `suppressed: ${suppressed}`);

  const consentType = context.channel === 'sms' ? 'sms_alerts' : 'email_updates';
  if (!(await consent.has(context.address, consentType))) {
    return finish(row, 'suppressed', 'no live consent at send time');
  }

  if (!notify.sendingEnabled()) {
    return finish(row, 'pending', 'sending disabled (SEND_ENABLED=0)', { requeue: true });
  }

  const vars = {
    displayName: context.display_name || 'there',
    stateCode: context.state_code || '',
    siteUrl: siteUrl(),
    ...(context.payload || {}),
  };

  let rendered;
  try {
    rendered = render.render(
      {
        key: context.template_key,
        channel: context.template_channel,
        subject_tpl: context.subject_tpl,
        body_tpl: context.body_tpl,
      },
      vars,
      {
        channel: context.channel,
        unsubscribeUrl: unsubscribeUrl(context.user_public_id, context.channel),
        preferencesUrl: preferencesUrl(context.user_public_id),
        sources: context.sources || [],
        candidates: (context.payload && context.payload.candidates) || [],
      }
    );
  } catch (err) {
    // A render failure is never transient — a missing variable or a blocked
    // phrase will fail identically on every retry, so do not spend attempts
    // on it. It needs a human.
    return finish(row, 'failed', `render refused: ${err.message}`);
  }

  try {
    const result = await notify.send({
      channel: context.channel,
      to: context.address,
      subject: rendered.subject,
      body: rendered.body,
      headers: rendered.headers,
      idempotencyKey: `outbox-${row.id}`,
      statusCallback: `${siteUrl()}/hooks/twilio/status`,
    });

    await db.query(
      `INSERT INTO deliveries
         (outbox_id, user_id, address_hash, channel, provider, provider_msg_id, status, segments)
       VALUES ($1,$2,$3,$4,$5,$6,'sent',$7)`,
      [
        row.id, row.user_id, context.address_hash, context.channel,
        result.provider, result.id,
        result.segments || (context.channel === 'sms' ? render.smsSegments(rendered.body).segments : null),
      ]
    );

    await db.query(
      `UPDATE outbox
          SET status = 'sent', sent_at = now(), locked_until = NULL,
              rendered_subject = $2, rendered_body = $3, body_sha256 = $4, last_error = NULL
        WHERE id = $1`,
      [
        row.id, rendered.subject, rendered.body,
        crypto.createHash('sha256').update(rendered.body).digest(),
      ]
    );

    return { id: row.id, status: 'sent' };
  } catch (err) {
    if (err.permanent) {
      await consent.suppress(context.address, context.channel, 'invalid', {
        source: `${err.provider || 'provider'}_permanent`,
        evidence: { message: err.message, code: err.twilioCode || err.status || null },
      });
      return finish(row, 'failed', `permanent: ${err.message}`);
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      return finish(row, 'failed', `giving up after ${row.attempts}: ${err.message}`);
    }
    return finish(row, 'pending', err.message, { requeue: true, delayMs: backoffMs(row.attempts) });
  }
}

async function finish(row, status, error, { requeue = false, delayMs = 0 } = {}) {
  await db.query(
    `UPDATE outbox
        SET status = $2,
            last_error = $3,
            locked_until = NULL,
            locked_by = NULL,
            send_after = CASE WHEN $4 THEN now() + ($5::int * interval '1 millisecond')
                              ELSE send_after END
      WHERE id = $1`,
    [row.id, status, error ? String(error).slice(0, 500) : null, requeue, delayMs]
  );
  return { id: row.id, status, error };
}

/** Claim a batch and send it. One pass; the worker loop calls this. */
async function drain({ limit = 25 } = {}) {
  await reclaimStale();
  const rows = await claim({ limit });
  const results = [];
  for (const row of rows) {
    try {
      results.push(await sendOne(row));
    } catch (err) {
      results.push(await finish(row, 'failed', `unexpected: ${err.message}`));
    }
  }
  return results;
}

module.exports = {
  fanout, fanoutPending, claim, drain, sendOne, reclaimStale,
  unsubscribeUrl, preferencesUrl, signLink, verifyLink, siteUrl,
  backoffMs, MAX_ATTEMPTS,
};

/**
 * Provider callbacks: bounces, complaints, delivery status, and STOP.
 *
 * Mounted at /hooks in server.js, deliberately outside the /api router and
 * before the global express.json(), for two reasons that are easy to get
 * wrong and miserable to debug:
 *
 *   - routes/api.js rate-limits everything under /api at 240 requests per
 *     minute per IP. Providers call from a handful of addresses and burst
 *     during a send, so a mailing would rate-limit its own delivery receipts.
 *   - Both providers sign the **raw bytes**. Once express.json() has parsed a
 *     body, re-serializing it does not reproduce them — key order and
 *     whitespace are gone — and every signature check fails in a way that
 *     looks like a wrong secret.
 *
 * Every callback is stored before it is processed, keyed so replays are free.
 * An unverified signature is stored too, with `signature_ok = false`: a burst
 * of those is somebody probing, and that is worth being able to see.
 */

const express = require('express');
const errors = require('../lib/errors');
const db = require('../db');
const consent = require('../lib/consent');
const resend = require('../notify/providers/resend');
const twilio = require('../notify/providers/twilio');
const { requestUrl } = require('../lib/baseUrl');
const { rateLimit } = require('../lib/rateLimit');
const { addressHash } = require('../lib/contacts');

const router = express.Router();

// Generous, because a real send produces a lot of receipts — but not
// unlimited, because this is an unauthenticated endpoint.
router.use(rateLimit({
  windowMs: 60_000,
  max: Number(process.env.WEBHOOK_RATE_LIMIT) || 3000,
  message: 'Too many webhook deliveries.',
}));

// The raw body is the thing being signed. `type: '*/*'` because providers
// vary in their content-type and a mismatch here silently yields an empty
// body, which then fails signature verification for the wrong reason.
const rawBody = express.raw({ type: '*/*', limit: '512kb' });

function requireDatabase(req, res, next) {
  if (db.enabled()) return next();
  // 200, not 503. A provider that gets an error retries with backoff and
  // eventually disables the endpoint; an instance with no database has
  // nothing to record and nothing to retry into.
  res.status(200).json({ ignored: 'no database configured' });
}

/** Store the callback. Returns false when we have already seen this one. */
async function recordWebhook(provider, eventId, signatureOk, headers, body) {
  const row = await db.one(
    `INSERT INTO webhook_events (provider, provider_event_id, signature_ok, headers, body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [provider, eventId, signatureOk, JSON.stringify(headers || {}), JSON.stringify(body || {})]
  );
  return row ? row.id : null;
}

const markProcessed = (id, error) =>
  db.query('UPDATE webhook_events SET processed_at = now(), process_error = $2 WHERE id = $1', [
    id, error ? String(error).slice(0, 400) : null,
  ]).catch(() => {});

/**
 * Apply a normalized provider event.
 *
 * Delivery status is recorded against the message; suppression is applied
 * against the address. Only a hard bounce or a complaint suppresses — a full
 * mailbox on Tuesday is not a reason to stop somebody's election reminders
 * forever.
 */
async function applyEvent(event) {
  if (!event) return;

  if (event.providerMessageId) {
    await db.query(
      `UPDATE deliveries
          SET status = $2, status_at = now(), error_code = $3, raw = COALESCE(raw, '{}'::jsonb)
        WHERE provider = $1 AND provider_msg_id = $4`,
      [event.provider, event.status, event.errorCode || null, event.providerMessageId]
    );
  }

  if (event.suppress && event.address) {
    await consent.suppress(event.address, event.channel, event.reason || 'hard_bounce', {
      source: `${event.provider}_webhook`,
      evidence: { messageId: event.providerMessageId, status: event.status },
    });

    // A complaint is a withdrawal of consent even though it did not come
    // through our own unsubscribe. Recording it keeps the consent log honest
    // about why we stopped.
    if (event.reason === 'spam_complaint' || event.reason === 'stop_keyword') {
      const user = await db.one(
        'SELECT user_id FROM contact_channels WHERE address_hash = $1 AND channel = $2 LIMIT 1',
        [addressHash(event.address), event.channel]
      );
      await consent.record({
        userId: user?.user_id || null,
        address: event.address,
        channel: event.channel,
        consentType: event.channel === 'sms' ? 'sms_alerts' : 'email_updates',
        action: 'revoke',
        method: 'webhook',
        evidence: { provider: event.provider, reason: event.reason },
      }).catch((err) => console.error('webhook: consent revoke failed —', err.message));
    }

    // Nothing already queued should still go out.
    await db.query(
      `UPDATE outbox o SET status = 'cancelled'
         FROM contact_channels cc
        WHERE o.contact_id = cc.id
          AND cc.address_hash = $1 AND cc.channel = $2
          AND o.status IN ('pending', 'claimed')`,
      [addressHash(event.address), event.channel]
    );
  }
}

/* ---------------- Resend ---------------- */

router.post('/resend', requireDatabase, rawBody, async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const check = resend.verifyWebhook(req.headers, raw);

  let body = {};
  try {
    body = JSON.parse(raw);
  } catch { /* stored as {} below; the signature result is the useful part */ }

  const eventId = req.headers['svix-id'] || `resend:${Date.now()}`;
  const stored = await recordWebhook('resend', eventId, check.ok, safeHeaders(req.headers), body);

  if (!check.ok) {
    console.error('webhook: rejected a Resend callback —', check.reason);
    return res.status(401).json({ error: 'signature verification failed' });
  }
  // Already seen. Acknowledge so the provider stops retrying.
  if (!stored) return res.json({ ok: true, duplicate: true });

  try {
    await applyEvent(resend.parseEvent(body));
    await markProcessed(stored, null);
  } catch (err) {
    await markProcessed(stored, err.message);
    console.error('webhook: resend processing failed —', err.message);
  }
  res.json({ ok: true });
});

/* ---------------- Twilio ---------------- */

/** Twilio posts form-encoded, and signs over the parsed parameters. */
const parseForm = (raw) => Object.fromEntries(new URLSearchParams(raw));

router.post('/twilio/status', requireDatabase, rawBody, async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const params = parseForm(raw);
  const check = twilio.verifyWebhook(requestUrl(req), params, req.headers['x-twilio-signature']);

  const eventId = params.MessageSid
    ? `status:${params.MessageSid}:${params.MessageStatus}`
    : `twilio:${Date.now()}`;
  const stored = await recordWebhook('twilio', eventId, check.ok, safeHeaders(req.headers), params);

  if (!check.ok) {
    console.error('webhook: rejected a Twilio status callback —', check.reason);
    return res.status(401).type('text/xml').send('<Response/>');
  }
  if (!stored) return res.type('text/xml').send('<Response/>');

  try {
    await applyEvent(twilio.parseStatus(params));
    await markProcessed(stored, null);
  } catch (err) {
    await markProcessed(stored, err.message);
    console.error('webhook: twilio status processing failed —', err.message);
  }
  res.type('text/xml').send('<Response/>');
});

/**
 * Inbound SMS: STOP, HELP, START.
 *
 * STOP takes effect immediately and unconditionally.
 *
 * START does **not** silently restore. Carriers permit it, but our posture is
 * that somebody who once said stop should have to say yes again in a way we
 * can point at — so it sends a confirmation and waits for a fresh consent
 * record rather than quietly resuming. One extra message, and a consent trail
 * with no gap in it.
 */
router.post('/twilio/inbound', requireDatabase, rawBody, async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const params = parseForm(raw);
  const check = twilio.verifyWebhook(requestUrl(req), params, req.headers['x-twilio-signature']);

  const eventId = params.MessageSid ? `inbound:${params.MessageSid}` : `twilio-in:${Date.now()}`;
  const stored = await recordWebhook('twilio', eventId, check.ok, safeHeaders(req.headers), params);

  if (!check.ok) {
    console.error('webhook: rejected a Twilio inbound callback —', check.reason);
    return res.status(401).type('text/xml').send('<Response/>');
  }
  if (!stored) return res.type('text/xml').send('<Response/>');

  const from = params.From;
  const kind = twilio.classifyInbound(params.Body);
  let reply = null;

  try {
    if (kind === 'stop' && from) {
      await consent.suppress(from, 'sms', 'stop_keyword', {
        source: 'twilio_inbound',
        evidence: { messageSid: params.MessageSid, body: String(params.Body || '').slice(0, 40) },
      });
      const user = await db.one(
        'SELECT user_id FROM contact_channels WHERE address_hash = $1 AND channel = \'sms\' LIMIT 1',
        [addressHash(from)]
      );
      await consent.record({
        userId: user?.user_id || null,
        address: from, channel: 'sms', consentType: 'sms_alerts',
        action: 'revoke', method: 'sms_keyword',
        evidence: { messageSid: params.MessageSid },
      });
      if (user?.user_id) {
        await db.query('UPDATE notification_preferences SET sms_enabled = false WHERE user_id = $1', [user.user_id]);
      }
      await db.query(
        `UPDATE outbox o SET status = 'cancelled'
           FROM contact_channels cc
          WHERE o.contact_id = cc.id AND cc.address_hash = $1
            AND o.channel = 'sms' AND o.status IN ('pending','claimed')`,
        [addressHash(from)]
      );
      // Twilio's Advanced Opt-Out sends the confirmation itself. Replying
      // here as well would double-send.
      reply = null;
    } else if (kind === 'help') {
      reply =
        'Pollbook sends election reminders for the races you follow. ' +
        'Msg & data rates may apply. Reply STOP to cancel. Help: ' +
        `${require('../notify/outbox').siteUrl()}`;
    } else if (kind === 'start') {
      reply =
        'Pollbook: to restart election reminders, sign in and turn text alerts back on at ' +
        `${require('../notify/outbox').siteUrl()}/#/account — we will confirm before sending anything.`;
    }
    await markProcessed(stored, null);
  } catch (err) {
    await markProcessed(stored, err.message);
    console.error('webhook: twilio inbound processing failed —', err.message);
  }

  res.type('text/xml').send(reply ? `<Response><Message>${escapeXml(reply)}</Message></Response>` : '<Response/>');
});

/* ---------------- helpers ---------------- */

/** Signature headers are kept; anything that could carry a credential is not. */
function safeHeaders(headers) {
  const keep = [
    'svix-id', 'svix-timestamp', 'svix-signature', 'x-twilio-signature',
    'content-type', 'user-agent',
  ];
  const out = {};
  for (const key of keep) if (headers[key]) out[key] = headers[key];
  return out;
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

router.use(errors.handler('webhooks'));

module.exports = router;
module.exports.__applyEvent = applyEvent;

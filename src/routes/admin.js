/**
 * The API the staff portal calls.
 *
 * Every route is gated on a *permission*, never a role, and the ones that
 * touch a person or reach an inbox are additionally gated on a recent
 * re-authentication. Two shapes here are deliberate and should survive
 * whoever builds the portal:
 *
 *   - **There is no endpoint that lists subscribers.** Support looks one up
 *     by exact address, and that lookup is audited. A list endpoint with a
 *     search box is a subscriber export with extra steps.
 *   - **Metrics are aggregates with a minimum cell size.** "How many people
 *     in Wyoming follow the reproductive-health issue" is a re-identification
 *     vector at small numbers, so small cells are suppressed rather than
 *     rounded.
 */

const express = require('express');
const errors = require('../lib/errors');
const db = require('../db');
const session = require('../lib/session');
const csrf = require('../lib/csrf');
const { requirePermission } = require('../lib/permissions');
const permissions = require('../lib/permissions');
const broadcasts = require('../services/broadcastService');
const audit = require('../lib/audit');
const notify = require('../notify');
const nonpartisan = require('../lib/nonpartisan');
const contacts = require('../lib/contacts');
const consent = require('../lib/consent');

const router = express.Router();

/** Below this, a count is suppressed rather than shown. */
const MIN_CELL = Number(process.env.METRICS_MIN_CELL) || 25;

router.use((req, res, next) => {
  if (db.enabled()) return next();
  const err = new Error('The staff portal needs a database, and none is configured here.');
  err.status = 503;
  next(err);
});

router.use(session.attach, session.requireAuth, csrf.protect);

/* ---------------- metrics ---------------- */

const cell = (n) => (Number(n) >= MIN_CELL ? Number(n) : null);

router.get('/metrics', requirePermission('metrics.read'), async (req, res, next) => {
  try {
    const [totals, byState, byIssue, queue] = await Promise.all([
      db.one(
        `SELECT count(*) FILTER (WHERE status = 'active') AS subscribers,
                count(*) FILTER (WHERE status = 'active' AND email_verified_at IS NOT NULL) AS verified,
                count(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_30d
           FROM users`
      ),
      db.rows(
        `SELECT state_code, count(*)::int AS n FROM users
          WHERE status = 'active' AND state_code IS NOT NULL
          GROUP BY state_code ORDER BY n DESC`
      ),
      db.rows(
        `SELECT i.slug, i.name, count(ui.user_id)::int AS n
           FROM issues i LEFT JOIN user_issues ui ON ui.issue_slug = i.slug
          GROUP BY i.slug, i.name ORDER BY n DESC`
      ),
      db.one(
        `SELECT count(*) FILTER (WHERE status = 'pending')  AS pending,
                count(*) FILTER (WHERE status = 'failed')   AS failed,
                count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '7 days') AS sent_7d
           FROM outbox`
      ),
    ]);

    res.json({
      minimumCellSize: MIN_CELL,
      note: `Counts below ${MIN_CELL} are reported as null rather than rounded — a small cell can identify a person.`,
      totals: {
        subscribers: Number(totals.subscribers),
        verified: Number(totals.verified),
        new30d: Number(totals.new_30d),
      },
      byState: byState.map((r) => ({ state: r.state_code, subscribers: cell(r.n) })),
      byIssue: byIssue.map((r) => ({ slug: r.slug, name: r.name, subscribers: cell(r.n) })),
      queue: {
        pending: Number(queue.pending),
        failed: Number(queue.failed),
        sent7d: Number(queue.sent_7d),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/deliverability', requirePermission('deliverability.read'), async (req, res, next) => {
  try {
    const rows = await db.rows(
      `SELECT channel, provider, status, count(*)::int AS n
         FROM deliveries
        WHERE status_at > now() - interval '30 days'
        GROUP BY channel, provider, status
        ORDER BY channel, provider, status`
    );
    res.json({ window: '30d', rows, messaging: notify.status() });
  } catch (err) {
    next(err);
  }
});

/* ---------------- support: one subscriber at a time ---------------- */

/**
 * Look up exactly one subscriber, by exact address.
 *
 * No partial match, no wildcard, no listing. Support needs to action the
 * request in front of them, and that needs one record. Anything broader is an
 * export.
 *
 * The response is masked by default, because the common case — "did their
 * confirmation send?" — does not need the address on screen, and screenshots
 * of support tools travel.
 */
router.get('/subscribers/lookup', requirePermission('pii.read_single'), async (req, res, next) => {
  try {
    const email = req.query.email ? contacts.normalizeEmail(req.query.email) : null;
    const phone = req.query.phone ? contacts.normalizePhone(req.query.phone) : null;

    if (!email && !phone) {
      const err = new Error('Give an exact email address or phone number. There is no subscriber list to browse.');
      err.status = 400;
      throw err;
    }

    const hash = contacts.addressHash(email || phone);
    const row = await db.one(
      `SELECT u.id, u.public_id, u.email, u.display_name, u.state_code, u.timezone,
              u.status, u.created_at, u.email_verified_at
         FROM users u
         JOIN contact_channels cc ON cc.user_id = u.id
        WHERE cc.address_hash = $1
        LIMIT 1`,
      [hash]
    );

    await audit.write({
      req, actorUserId: req.user.id, actorRole: req.roles?.join(','),
      action: 'pii.read', objectType: 'subscriber',
      objectId: row ? row.public_id : null,
      subjectUserId: row ? row.id : null,
      outcome: row ? 'ok' : 'ok',
      detail: { by: email ? 'email' : 'phone', found: Boolean(row) },
    });

    if (!row) return res.status(404).json({ error: 'No subscriber with that address.' });

    const [channels, subs, suppression] = await Promise.all([
      db.rows(
        'SELECT channel, address, status, verified_at FROM contact_channels WHERE user_id = $1',
        [row.id]
      ),
      db.rows(
        `SELECT s.subject_key, sj.label FROM subscriptions s
           JOIN subjects sj ON sj.key = s.subject_key
          WHERE s.user_id = $1 AND s.source = 'explicit'`,
        [row.id]
      ),
      db.rows(
        `SELECT channel, reason, created_at FROM suppressions WHERE address_hash = $1`,
        [hash]
      ),
    ]);

    res.json({
      subscriber: {
        id: row.public_id,
        email: contacts.maskEmail(row.email),
        displayName: row.display_name,
        state: row.state_code,
        timezone: row.timezone,
        status: row.status,
        emailVerified: Boolean(row.email_verified_at),
        createdAt: row.created_at,
      },
      channels: channels.map((c) => ({
        channel: c.channel,
        address: c.channel === 'sms' ? contacts.maskPhone(c.address) : contacts.maskEmail(c.address),
        status: c.status,
        verifiedAt: c.verified_at,
      })),
      subscriptions: subs,
      suppressions: suppression,
      note: 'This lookup has been recorded in the audit log.',
    });
  } catch (err) {
    next(err);
  }
});

/** Consent history for an address. Compliance only. */
router.get('/consent', requirePermission('consent.read'), async (req, res, next) => {
  try {
    const address = req.query.email
      ? contacts.normalizeEmail(req.query.email)
      : contacts.normalizePhone(req.query.phone);
    if (!address) {
      const err = new Error('Give an exact address.');
      err.status = 400;
      throw err;
    }
    const rows = await consent.history(address);
    await audit.write({
      req, actorUserId: req.user.id, action: 'consent.read', objectType: 'consent',
      detail: { records: rows.length },
    });
    res.json({ records: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/suppressions', requirePermission('suppression.add'), async (req, res, next) => {
  try {
    const { email, phone, reason = 'manual' } = req.body || {};
    const address = email ? contacts.normalizeEmail(email) : contacts.normalizePhone(phone);
    if (!address) {
      const err = new Error('Give an exact address.');
      err.status = 400;
      throw err;
    }
    await consent.suppress(address, email ? 'email' : 'sms', reason, { source: 'manual' });
    await audit.write({
      req, actorUserId: req.user.id, action: 'suppression.added', objectType: 'suppression',
      detail: { channel: email ? 'email' : 'sms', reason },
    });
    res.status(201).json({ suppressed: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------- broadcasts ---------------- */

router.get('/broadcasts', requirePermission('broadcast.read'), async (req, res, next) => {
  try {
    res.json({ broadcasts: await broadcasts.list(req.query.status, Number(req.query.limit) || 50) });
  } catch (err) {
    next(err);
  }
});

router.get('/broadcasts/:id', requirePermission('broadcast.read'), async (req, res, next) => {
  try {
    const bc = await broadcasts.byPublicId(req.params.id);
    res.json({
      id: bc.public_id,
      title: bc.title,
      category: bc.category,
      channel: bc.channel,
      subjectKey: bc.subject_key,
      subjectLine: bc.subject_line,
      body: bc.body,
      sources: bc.sources,
      status: bc.status,
      lintReport: bc.lint_report,
      balanceReport: bc.balance_report,
      audience: {
        subjectKeys: bc.subject_keys || [],
        issueSlugs: bc.issue_slugs || [],
        stateCodes: bc.state_codes || [],
        channels: bc.channels || [],
      },
      createdBy: bc.created_by,
      approvedBy: bc.approved_by,
      sentAt: bc.sent_at,
      recipientCount: bc.recipient_count,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts', requirePermission('broadcast.draft'), async (req, res, next) => {
  try {
    res.status(201).json(await broadcasts.create(req.user.id, req.body || {}, { req }));
  } catch (err) {
    next(err);
  }
});

/** Dry-run the checks without saving. What the compose screen calls as you type. */
router.post('/broadcasts/lint', requirePermission('broadcast.draft'), async (req, res, next) => {
  try {
    const { subjectLine, body, sources, subjectKey, category, audience } = req.body || {};
    const audienceCheck = audience ? nonpartisan.checkAudience(audience) : { ok: true, errors: [] };
    const report = await broadcasts.review({ subjectLine, body, sources, subjectKey, category });
    res.json({ ...report, audience: audienceCheck });
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts/:id/submit', requirePermission('broadcast.draft'), async (req, res, next) => {
  try {
    res.json(await broadcasts.submit(req.user.id, req.params.id, { req }));
  } catch (err) {
    next(err);
  }
});

router.get('/broadcasts/:id/preview', requirePermission('broadcast.read'), async (req, res, next) => {
  try {
    res.json(await broadcasts.previewAudience(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts/:id/approve', requirePermission('broadcast.approve'), async (req, res, next) => {
  try {
    res.json(await broadcasts.approve(req.user.id, req.params.id, {
      acknowledgements: req.body?.acknowledgements || [],
      note: req.body?.note,
      req,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts/:id/reject', requirePermission('broadcast.approve'), async (req, res, next) => {
  try {
    res.json(await broadcasts.reject(req.user.id, req.params.id, { note: req.body?.note, req }));
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts/:id/send', requirePermission('broadcast.send'), async (req, res, next) => {
  try {
    res.json(await broadcasts.send(req.user.id, req.params.id, { req }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- operations ---------------- */

router.get('/jobs', requirePermission('metrics.read'), async (req, res, next) => {
  try {
    res.json({
      jobs: await db.rows(
        `SELECT key, interval_ms, next_run_at, last_run_at, last_status, last_error,
                last_duration_ms, consecutive_failures, enabled, locked_by, locked_until
           FROM scheduled_jobs ORDER BY key`
      ),
      messaging: notify.status(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:key', requirePermission('job.manage'), async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    await db.query('UPDATE scheduled_jobs SET enabled = $2 WHERE key = $1', [
      req.params.key, Boolean(enabled),
    ]);
    await audit.write({
      req, actorUserId: req.user.id, action: 'job.toggled', objectType: 'job',
      objectId: req.params.key, detail: { enabled: Boolean(enabled) },
    });
    res.json({ key: req.params.key, enabled: Boolean(enabled) });
  } catch (err) {
    next(err);
  }
});

/**
 * The kill switch.
 *
 * Disables every job and cancels the queue. When something goes wrong at
 * forty thousand recipients you need one obvious lever, and you need it to
 * work without a deploy.
 */
router.post('/send/killswitch', requirePermission('send.killswitch'), async (req, res, next) => {
  try {
    await db.query('UPDATE scheduled_jobs SET enabled = false');
    const cancelled = await db.query(
      "UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'claimed')"
    );
    await audit.write({
      req, actorUserId: req.user.id, action: 'send.killswitch', objectType: 'system',
      detail: { cancelled: cancelled.rowCount, reason: req.body?.reason || null },
    });
    res.json({
      stopped: true,
      cancelled: cancelled.rowCount,
      note: 'All jobs disabled and the queue cleared. Also set SEND_ENABLED=0 if this needs to survive a restart.',
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- audit ---------------- */

router.get('/audit', requirePermission('audit.read'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await db.rows(
      `SELECT id, actor_user_id, actor_role, action, object_type, object_id,
              subject_user_id, outcome, detail, occurred_at
         FROM audit_log
        WHERE ($2::text IS NULL OR action = $2)
        ORDER BY id DESC LIMIT $1`,
      [limit, req.query.action || null]
    );
    const chain = await audit.verifyChain('audit_log', { limit: 1000 });
    res.json({ entries: rows, chain });
  } catch (err) {
    next(err);
  }
});

/* ---------------- roles ---------------- */

router.post('/roles', requirePermission('roles.grant'), async (req, res, next) => {
  try {
    const { userId, role, expiresAt, note } = req.body || {};

    // Only an owner may create another admin or an owner. `roles.grant` stops
    // one step below itself, so an admin cannot promote themselves sideways
    // into the roles they deliberately do not hold.
    if (['admin', 'owner'].includes(role)) {
      const { permissions: held } = await permissions.resolve(req.user.id);
      if (!held.has('roles.grant_any')) {
        const err = new Error('Only an owner can grant admin or owner.');
        err.status = 403;
        throw err;
      }
    }

    const target = await db.one('SELECT id FROM users WHERE public_id = $1', [userId]);
    if (!target) {
      const err = new Error('No such account.');
      err.status = 404;
      throw err;
    }

    await db.query(
      `INSERT INTO user_roles (user_id, role_key, granted_by, expires_at, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, role_key)
       DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by`,
      [target.id, role, req.user.id, expiresAt || null, note || null]
    );

    permissions.invalidate(target.id);
    await audit.write({
      req, actorUserId: req.user.id, action: 'role.grant', objectType: 'user',
      objectId: userId, subjectUserId: target.id, detail: { role, expiresAt: expiresAt || null },
    });

    res.status(201).json({ granted: role, userId, expiresAt: expiresAt || null });
  } catch (err) {
    next(err);
  }
});

router.delete('/roles', requirePermission('roles.grant'), async (req, res, next) => {
  try {
    const { userId, role } = req.body || {};
    const target = await db.one('SELECT id FROM users WHERE public_id = $1', [userId]);
    if (!target) {
      const err = new Error('No such account.');
      err.status = 404;
      throw err;
    }
    await db.query('DELETE FROM user_roles WHERE user_id = $1 AND role_key = $2', [target.id, role]);
    permissions.invalidate(target.id);
    await audit.write({
      req, actorUserId: req.user.id, action: 'role.revoke', objectType: 'user',
      objectId: userId, subjectUserId: target.id, detail: { role },
    });
    res.json({ revoked: role, userId });
  } catch (err) {
    next(err);
  }
});

/* ---------------- taxonomy ---------------- */

router.post('/issues', requirePermission('taxonomy.approve'), async (req, res, next) => {
  try {
    const { slug, name, description, sortOrder, active } = req.body || {};

    // The naming rule, enforced. "Election integrity" and "voting access"
    // describe the same bills; picking between them announces a side.
    const check = nonpartisan.checkIssueLabel(name || '', description || '');
    if (!check.ok) {
      throw Object.assign(
        new Error(check.findings.map((f) => `"${f.text}": ${f.note}`).join(' ')),
        { status: 422, code: 'PB_POSITION_CODED', findings: check.findings }
      );
    }

    await db.query(
      `INSERT INTO issues (slug, name, description, sort_order, active)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             sort_order = EXCLUDED.sort_order, active = EXCLUDED.active`,
      [slug, name, description, sortOrder || 100, active !== false]
    );

    await audit.write({
      req, actorUserId: req.user.id, action: 'taxonomy.changed', objectType: 'issue',
      objectId: slug, detail: { name },
    });
    res.json({ slug, name });
  } catch (err) {
    next(err);
  }
});

router.use(errors.handler('admin'));

module.exports = router;

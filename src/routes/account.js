/**
 * Everything a signed-in person can do with their own account.
 *
 * Two routes here deliberately do not require a session: the one-click
 * unsubscribe and the preferences link that appears in every email. They have
 * to work from a mail client with no cookie — that is the whole point of RFC
 * 8058 — so they authenticate with the signed token in the URL instead. See
 * notify/outbox.js for how that is signed and why it never expires.
 */

const express = require('express');
const errors = require('../lib/errors');
const db = require('../db');
const session = require('../lib/session');
const csrf = require('../lib/csrf');
const subscribers = require('../services/subscriberService');
const permissions = require('../lib/permissions');
const consent = require('../lib/consent');
const outbox = require('../notify/outbox');
const audit = require('../lib/audit');
const notify = require('../notify');
const { CURRENT, consentText } = require('../data/consentTexts');

const router = express.Router();

router.use(session.attach);

function requireDatabase(req, res, next) {
  if (db.enabled()) return next();
  const err = new Error('Accounts are not available on this instance.');
  err.status = 503;
  next(err);
}

/* ---------------- unauthenticated, token-authenticated ---------------- */

/**
 * One-click unsubscribe.
 *
 * Accepts POST because RFC 8058 requires it — a mail client posts
 * `List-Unsubscribe=One-Click` with no user interaction — and GET because
 * people click links. Both act, and both are idempotent.
 *
 * There is no confirmation step and no "are you sure". Somebody who has
 * decided to stop hearing from us has already confirmed.
 */
async function handleUnsubscribe(req, res, next) {
  try {
    const claim = outbox.verifyLink(req.params.token, 'unsub');
    if (!claim) {
      const err = new Error('That unsubscribe link is not valid. Sign in to change your settings.');
      err.status = 400;
      throw err;
    }

    const user = await db.one(
      'SELECT id, public_id FROM users WHERE public_id = $1 AND status = \'active\'',
      [claim.publicId]
    );
    // Already deleted, or already gone: still report success. There is
    // nothing useful to tell somebody who is trying to leave.
    if (!user) return respondUnsubscribed(req, res, 'all');

    const channels = claim.channel === 'all' ? ['email', 'sms'] : [claim.channel];

    for (const channel of channels) {
      const contacts = await db.rows(
        'SELECT address FROM contact_channels WHERE user_id = $1 AND channel = $2',
        [user.id, channel]
      );
      for (const contact of contacts) {
        await consent.suppress(contact.address, channel, 'unsubscribe', { source: 'list_unsubscribe' });
        await consent.record({
          userId: user.id,
          address: contact.address,
          channel,
          consentType: channel === 'sms' ? 'sms_alerts' : 'email_updates',
          action: 'revoke',
          method: 'list_unsubscribe',
          version: CURRENT[channel === 'sms' ? 'sms_alerts' : 'email_updates'],
          req,
        });
      }
      await db.query(
        `UPDATE notification_preferences
            SET ${channel === 'sms' ? 'sms_enabled' : 'email_enabled'} = false, updated_at = now()
          WHERE user_id = $1`,
        [user.id]
      );
    }

    // Anything already queued for them stops too. Receiving one more message
    // after unsubscribing is the single most common complaint about mailing
    // lists, and it is entirely avoidable.
    await db.query(
      `UPDATE outbox SET status = 'cancelled'
        WHERE user_id = $1 AND status IN ('pending', 'claimed') AND channel = ANY($2::text[])`,
      [user.id, channels]
    );

    await audit.write({
      req, actorUserId: user.id, action: 'unsubscribe', objectType: 'user',
      objectId: String(user.id), subjectUserId: user.id,
      detail: { channels, via: 'one_click' },
    });

    respondUnsubscribed(req, res, claim.channel);
  } catch (err) {
    next(err);
  }
}

function respondUnsubscribed(req, res, channel) {
  if (req.accepts(['html', 'json']) === 'html') {
    return res.type('html').send(plainPage(
      'Unsubscribed',
      channel === 'sms'
        ? 'You will not receive any more text messages from Pollbook.'
        : 'You will not receive any more email from Pollbook.',
      'Everything on Pollbook still works without an account — no sign-in required.'
    ));
  }
  res.json({ unsubscribed: true, channel });
}

router.post('/unsubscribe/:token', requireDatabase, handleUnsubscribe);
router.get('/unsubscribe/:token', requireDatabase, handleUnsubscribe);

/** The preferences link in a footer: verifies, then hands off to the SPA. */
router.get('/preferences/:token', requireDatabase, async (req, res, next) => {
  try {
    const claim = outbox.verifyLink(req.params.token, 'prefs');
    if (!claim) {
      const err = new Error('That link is not valid. Sign in to change your settings.');
      err.status = 400;
      throw err;
    }
    // Deliberately does not mint a session — a link sitting in an old email
    // should not be a permanent credential. It sends them to sign in, which
    // for a magic-link account is one click from the same inbox.
    res.redirect(302, '/#/account');
  } catch (err) {
    next(err);
  }
});

/* ---------------- authenticated ---------------- */

router.use(requireDatabase, session.requireAuth);

/** Who am I, and what can I do? The portal renders against `permissions`. */
router.get('/', async (req, res, next) => {
  try {
    const [prefs, subs, issues, contacts, resolved] = await Promise.all([
      db.one('SELECT * FROM notification_preferences WHERE user_id = $1', [req.user.id]),
      subscribers.listSubscriptions(req.user.id),
      subscribers.userIssues(req.user.id),
      db.rows(
        `SELECT channel, address, status, verified_at FROM contact_channels WHERE user_id = $1`,
        [req.user.id]
      ),
      permissions.resolve(req.user.id),
    ]);

    res.json({
      user: {
        id: req.user.publicId,
        email: req.user.email,
        emailVerified: req.user.emailVerified,
        displayName: req.user.displayName,
        state: req.user.state,
        zip5: req.user.zip5,
        timezone: req.user.timezone,
      },
      preferences: prefs,
      subscriptions: subs,
      issues,
      contacts: contacts.map((c) => ({
        channel: c.channel,
        address: c.channel === 'sms'
          ? require('../lib/contacts').maskPhone(c.address)
          : c.address,
        status: c.status,
        verifiedAt: c.verified_at,
      })),
      roles: resolved.roles,
      permissions: [...resolved.permissions],
      elevated: permissions.isElevated(req.session),
      messaging: { smsAvailable: notify.smsEnabled() },
    });
  } catch (err) {
    next(err);
  }
});

router.use(csrf.protect);

router.patch('/profile', async (req, res, next) => {
  try {
    res.json(await subscribers.updateProfile(req.user.id, req.body || {}, { req }));
  } catch (err) {
    next(err);
  }
});

router.put('/preferences', async (req, res, next) => {
  try {
    res.json(await subscribers.updatePreferences(req.user.id, req.body || {}, { req }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- subscriptions ---------------- */

router.get('/subscriptions', async (req, res, next) => {
  try {
    res.json({ subscriptions: await subscribers.listSubscriptions(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/subscriptions', async (req, res, next) => {
  try {
    const { key, label } = req.body || {};
    res.status(201).json(await subscribers.subscribe(req.user.id, key, { label, req }));
  } catch (err) {
    next(err);
  }
});

router.delete('/subscriptions/:key', async (req, res, next) => {
  try {
    res.json(await subscribers.unsubscribeFrom(req.user.id, req.params.key, { req }));
  } catch (err) {
    next(err);
  }
});

/**
 * Bulk import, for the one-time migration of `pb-tracked` out of localStorage.
 *
 * Anonymous tracking has existed since before accounts did, and somebody who
 * has been following six races in their browser should not have to add them
 * again to get the alerts they just signed up for.
 */
router.post('/subscriptions/import', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
    const added = [];
    const rejected = [];

    for (const item of items) {
      const key = typeof item === 'string' ? item : item?.key;
      const label = typeof item === 'object' ? item?.label : null;
      try {
        added.push(await subscribers.subscribe(req.user.id, normalizeKey(key), { label, req }));
      } catch {
        rejected.push(key);
      }
    }
    res.json({ added: added.length, rejected });
  } catch (err) {
    next(err);
  }
});

/** The SPA stores bare `ga-general-2026` ids; accept those as well as keys. */
function normalizeKey(value) {
  const { fromLegacyId } = require('../lib/subjects');
  return String(value || '').includes(':') ? value : fromLegacyId(value);
}

/* ---------------- issues ---------------- */

router.get('/issues', async (req, res, next) => {
  try {
    res.json({
      available: await subscribers.listIssues(),
      selected: (await subscribers.userIssues(req.user.id)).map((i) => i.slug),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/issues', async (req, res, next) => {
  try {
    res.json(await subscribers.setIssues(req.user.id, req.body?.issues, { req }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- phone / SMS ---------------- */

/**
 * The SMS consent text, so the UI renders the exact wording that gets stored.
 *
 * Serving it from here rather than hardcoding it in the frontend is what
 * makes the consent record honest: the words on the screen and the words in
 * the evidence table come from the same constant.
 */
router.get('/sms/consent-text', (req, res) => {
  const entry = consentText(CURRENT.sms_alerts);
  res.json({
    version: CURRENT.sms_alerts,
    text: entry.text,
    supporting: entry.supporting || null,
    available: notify.smsEnabled(),
  });
});

router.post('/phone', async (req, res, next) => {
  try {
    if (!notify.smsEnabled()) {
      const err = new Error('Text alerts are not switched on yet. Email reminders work today.');
      err.status = 503;
      throw err;
    }
    if (req.body?.consent !== true) {
      const err = new Error('Text alerts need their own explicit agreement — tick the box to continue.');
      err.status = 400;
      throw err;
    }

    const { phone, code } = await subscribers.startPhoneVerification(req.user.id, req.body?.phone, {
      req,
      consentVersion: CURRENT.sms_alerts,
    });

    const template = await db.one(
      "SELECT key, channel, subject_tpl, body_tpl FROM message_templates WHERE key = 'product.sms_confirm'"
    );
    const render = require('../notify/render');
    const rendered = render.render(template, {}, {
      channel: 'sms',
      unsubscribeUrl: outbox.unsubscribeUrl(req.user.publicId, 'sms'),
      preferencesUrl: outbox.preferencesUrl(req.user.publicId),
      sources: [{ url: 'https://vote.gov' }],
    });

    await notify.send({
      channel: 'sms',
      to: phone,
      body: `${rendered.body}\n\nYour code: ${code}`,
    });

    res.status(202).json({
      pending: true,
      message: 'Check your phone for a six-digit code, and reply to the text to confirm.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/phone/confirm', async (req, res, next) => {
  try {
    res.json(await subscribers.confirmPhone(req.user.id, req.body?.phone, req.body?.code, { req }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- data rights ---------------- */

router.get('/export', async (req, res, next) => {
  try {
    const data = await subscribers.exportData(req.user.id, { req });
    res.setHeader('content-disposition', 'attachment; filename="pollbook-my-data.json"');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * Delete the account.
 *
 * Requires typing the word, because it is genuinely irreversible: the
 * suppression tombstone survives deliberately, so re-signing-up with the same
 * address will not restore anything and will not resume mail without a fresh
 * consent.
 */
router.post('/delete', async (req, res, next) => {
  try {
    if (String(req.body?.confirm || '').toLowerCase() !== 'delete') {
      const err = new Error('Send {"confirm":"delete"} to confirm. This cannot be undone.');
      err.status = 400;
      throw err;
    }
    const result = await subscribers.deleteAccount(req.user.id, { req });
    await session.revokeAllForUser(req.user.id, 'account_deleted').catch(() => {});
    session.clearCookie(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ---------------- helpers ---------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function plainPage(title, message, note) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Pollbook</title>
<meta name="robots" content="noindex,nofollow"><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#EFF0EB;color:#16181A;
     display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
.card{background:#fff;border:2px solid #16181A;max-width:26rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .75rem}p{font-size:.9rem;line-height:1.5;color:#4A4F55;margin:0 0 .75rem}
a{color:#2038C8}.mark{font-family:ui-monospace,monospace;font-size:.7rem;letter-spacing:.14em;
color:#4A4F55;margin-bottom:1rem}</style></head><body><div class="card">
<p class="mark">POLLBOOK</p><h1>${esc(title)}</h1><p>${esc(message)}</p><p>${esc(note)}</p>
<p><a href="/">Back to Pollbook</a></p></div></body></html>`;
}

router.use(errors.handler('account'));

module.exports = router;

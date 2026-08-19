/**
 * Sign-in routes.
 *
 * Three methods, one outcome: a session cookie. Magic link is first because
 * it is the only one that does not depend on a third party — which matters
 * when Apple hands back a private-relay address and email deliverability is
 * the product — and because it works with nothing configured but a database,
 * printing the link to stdout.
 */

const express = require('express');
const errors = require('../lib/errors');
const db = require('../db');
const session = require('../lib/session');
const csrf = require('../lib/csrf');
const magicLink = require('../auth/magicLink');
const google = require('../auth/google');
const apple = require('../auth/apple');
const subscribers = require('../services/subscriberService');
const notify = require('../notify');
const outbox = require('../notify/outbox');
const render = require('../notify/render');
const audit = require('../lib/audit');
const { rateLimit } = require('../lib/rateLimit');
const { baseUrl, safeRedirect } = require('../lib/baseUrl');
const { normalizeEmail } = require('../lib/contacts');

const router = express.Router();

// Apple posts the callback as a form, so that one route needs urlencoded
// parsing. Mounted narrowly rather than router-wide: nothing else here takes
// a form body, and a parser is attack surface.
const formBody = express.urlencoded({ extended: false, limit: '16kb' });

// A cheap in-process first line, in front of the Postgres counters inside
// magicLink.issue(). This one rejects a flood without a query; that one is
// the absolute ceiling across instances.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT) || 20,
  message: 'Too many sign-in attempts. Wait a few minutes and try again.',
});

router.use(session.attach);

// Issue the CSRF cookie on any safe request to this router, so the frontend
// has one before its first POST. Without this the very first sign-in attempt
// fails the double-submit check and there is no obvious way to recover — the
// browser has to be sent somewhere else first, which is a bootstrapping
// problem with no good place to solve it on the client.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) csrf.issue(req, res);
  next();
});

/** Which sign-in methods this instance can actually offer. */
router.get('/providers', (req, res) => {
  res.json({
    email: db.enabled(),
    google: db.enabled() && google.configured(),
    apple: db.enabled() && apple.configured(),
    accountsEnabled: db.enabled(),
  });
});

function requireDatabase(req, res, next) {
  if (db.enabled()) return next();
  const err = new Error(
    'Accounts are not available on this instance. Everything else on Pollbook works without one.'
  );
  err.status = 503;
  next(err);
}

/* ---------------- magic link ---------------- */

/**
 * Request a sign-in link.
 *
 * **The response is identical whether or not the address has an account.**
 * Anything else — a different message, a different status, a measurably
 * different response time — turns this into an oracle for whether a given
 * person is a subscriber, which for a civic site is a genuinely sensitive
 * fact.
 */
router.post('/email', requireDatabase, authLimiter, csrf.protect, async (req, res, next) => {
  try {
    const { email, redirectTo } = req.body || {};
    const result = await magicLink.issue({
      email,
      redirectTo: safeRedirect(redirectTo, '/#/account'),
      req,
    });

    if (result.token) {
      const url = `${baseUrl(req)}/api/auth/verify?token=${encodeURIComponent(result.token)}`;
      await sendSignInEmail(result.email, url);
    }

    // Same body, same status, every time.
    res.status(202).json({
      sent: true,
      message: 'If that address can receive mail from us, a sign-in link is on its way.',
    });
  } catch (err) {
    next(err);
  }
});

async function sendSignInEmail(email, url) {
  const template = await db.one(
    "SELECT key, channel, subject_tpl, body_tpl FROM message_templates WHERE key = 'product.signin'"
  );
  if (!template) throw new Error('The product.signin template is missing.');

  const rendered = render.render(template, { actionUrl: url }, {
    channel: 'email',
    // A sign-in email is transactional: there is nothing to unsubscribe from,
    // but the footer machinery is not optional, so both links point at the
    // preferences page rather than being omitted.
    unsubscribeUrl: `${outbox.siteUrl()}/#/account`,
    preferencesUrl: `${outbox.siteUrl()}/#/account`,
    sources: [{ label: 'Pollbook', url: outbox.siteUrl().startsWith('https') ? outbox.siteUrl() : 'https://vote.gov' }],
  });

  await notify.send({
    channel: 'email',
    to: email,
    subject: rendered.subject,
    body: rendered.body,
    headers: rendered.headers,
  });
}

/**
 * The link in the email lands here, and this renders a button.
 *
 * It does not consume the token. Corporate mail scanners — Defender,
 * Proofpoint, and most security gateways — fetch every URL in an inbound
 * message before the recipient sees it, which would burn a single-use token
 * and produce a "your link didn't work" report that is impossible to
 * reproduce. A GET that only renders, and a POST that acts, makes that whole
 * class of failure go away for the price of one click.
 *
 * Deliberately a standalone page rather than the SPA: this has to work before
 * any JavaScript has booted, and it has to work if the SPA is broken.
 */
router.get('/verify', requireDatabase, (req, res) => {
  const token = String(req.query.token || '');
  const csrfToken = csrf.issue(req, res);
  res.type('html').send(interstitial(token, csrfToken));
});

/** Consume the token and start a session. */
router.post('/verify', requireDatabase, authLimiter, csrf.protect, async (req, res, next) => {
  try {
    const token = String(req.body?.token || req.query?.token || '');
    const row = await magicLink.consume(token);

    if (!row) {
      // One message for every failure mode. "Expired" would confirm the
      // address exists, which is the thing the whole flow avoids saying.
      const err = new Error('That sign-in link is no longer valid. Request a new one.');
      err.status = 400;
      throw err;
    }

    const { userId, created } = await subscribers.findOrCreateFromEmail(row.email_normalized, {
      req,
      signupSource: { method: 'magic_link' },
    });

    await magicLink.invalidateOutstanding(row.email_normalized);
    await subscribers.confirmEmail(userId, row.email_normalized, { req, method: 'double_optin_click' });

    // A fresh proof of inbox control is exactly what step-up means, so a
    // sign-in that just happened starts elevated.
    await session.issue(req, res, userId, { elevated: true });

    await audit.write({
      req, actorUserId: userId, action: 'auth.signin', objectType: 'user',
      objectId: String(userId), subjectUserId: userId, detail: { method: 'magic_link', created },
    });

    const target = safeRedirect(row.redirect_to, '/#/account');
    if (req.accepts(['html', 'json']) === 'html') return res.redirect(302, target);
    res.json({ signedIn: true, created, redirectTo: target });
  } catch (err) {
    next(err);
  }
});

/* ---------------- Google ---------------- */

router.get('/google/start', requireDatabase, authLimiter, async (req, res, next) => {
  try {
    if (!google.configured()) {
      const err = new Error('Google sign-in is not configured on this instance.');
      err.status = 503;
      throw err;
    }
    res.redirect(302, await google.authorizationUrl(baseUrl(req), { redirectTo: req.query.redirect_to }));
  } catch (err) {
    next(err);
  }
});

router.get('/google/callback', requireDatabase, async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.redirect(302, `/#/signin?error=${encodeURIComponent(String(req.query.error).slice(0, 64))}`);
    }
    const identity = await google.handleCallback({
      code: String(req.query.code || ''),
      state: String(req.query.state || ''),
      base: baseUrl(req),
    });
    await completeOauth(req, res, identity);
  } catch (err) {
    next(err);
  }
});

/* ---------------- Apple ---------------- */

router.get('/apple/start', requireDatabase, authLimiter, async (req, res, next) => {
  try {
    if (!apple.configured()) {
      const err = new Error('Sign in with Apple is not configured on this instance.');
      err.status = 503;
      throw err;
    }
    res.redirect(302, await apple.authorizationUrl(baseUrl(req), { redirectTo: req.query.redirect_to }));
  } catch (err) {
    next(err);
  }
});

/**
 * Apple's callback: a cross-site POST, form-encoded.
 *
 * Note there is no CSRF middleware here, and that is correct — the request
 * genuinely comes from another origin, and the `state` parameter consumed
 * inside handleCallback is the flow's own CSRF defence. Applying the cookie
 * check would reject every real callback, because SameSite=Lax means our
 * cookies are not sent on it at all.
 */
router.post('/apple/callback', requireDatabase, formBody, async (req, res, next) => {
  try {
    if (req.body?.error) {
      return res.redirect(302, `/#/signin?error=${encodeURIComponent(String(req.body.error).slice(0, 64))}`);
    }
    const identity = await apple.handleCallback({ body: req.body, base: baseUrl(req) });
    await completeOauth(req, res, identity);
  } catch (err) {
    next(err);
  }
});

/** Shared tail of both OAuth flows. */
async function completeOauth(req, res, identity) {
  const { userId, created } = await subscribers.findOrCreateFromIdentity(identity, {
    req,
    signupSource: { method: identity.provider },
  });

  if (identity.email && identity.emailVerified) {
    await subscribers.confirmEmail(userId, identity.email, {
      req,
      method: 'web_form',
    });
  }

  await session.issue(req, res, userId, { elevated: true });

  await audit.write({
    req, actorUserId: userId, action: 'auth.signin', objectType: 'user',
    objectId: String(userId), subjectUserId: userId,
    detail: { method: identity.provider, created, privateRelay: identity.isPrivateRelay },
  });

  res.redirect(302, safeRedirect(identity.redirectTo, '/#/account'));
}

/* ---------------- sign out ---------------- */

router.post('/logout', csrf.protect, async (req, res, next) => {
  try {
    if (req.session) await session.revoke(req.session.id);
    session.clearCookie(res);
    res.json({ signedOut: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout-all', csrf.protect, session.requireAuth, async (req, res, next) => {
  try {
    const count = await session.revokeAllForUser(req.user.id);
    session.clearCookie(res);
    await audit.write({
      req, actorUserId: req.user.id, action: 'auth.signout_all', objectType: 'user',
      objectId: String(req.user.id), subjectUserId: req.user.id, detail: { sessions: count },
    });
    res.json({ signedOut: true, sessions: count });
  } catch (err) {
    next(err);
  }
});

/* ---------------- the interstitial page ---------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function interstitial(token, csrfToken) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Pollbook</title>
<meta name="robots" content="noindex,nofollow">
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#EFF0EB;color:#16181A;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
  .card{background:#fff;border:2px solid #16181A;max-width:26rem;padding:2rem}
  h1{font-size:1.25rem;letter-spacing:-0.01em;margin:0 0 .75rem}
  p{font-size:.9rem;line-height:1.5;color:#4A4F55;margin:0 0 1.25rem}
  button{background:#2038C8;color:#fff;border:0;padding:.85rem 1.5rem;font-size:1rem;
         font-weight:600;cursor:pointer;width:100%}
  button:hover{background:#16299b}
  .mark{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.7rem;
        letter-spacing:.14em;color:#4A4F55;margin-bottom:1rem}
</style></head><body>
<div class="card">
  <p class="mark">POLLBOOK</p>
  <h1>Sign in</h1>
  <p>Confirm you meant to open this link. It works once, and only from this page.</p>
  <form method="POST" action="/api/auth/verify">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
    <button type="submit">Sign in to Pollbook</button>
  </form>
</div>
<script>
  // The CSRF check reads a header, and a plain form cannot set one. Submit
  // via fetch when JavaScript is available, and fall back to the form post
  // otherwise — the Origin check still covers that path.
  document.querySelector('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    fetch(f.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-pollbook-csrf': f._csrf.value },
      body: JSON.stringify({ token: f.token.value })
    }).then(function (r) { return r.json(); })
      .then(function (d) { window.location = d.redirectTo || '/#/account'; })
      .catch(function () { f.submit(); });
  });
</script>
</body></html>`;
}

/* ---------------- errors ---------------- */

router.use(errors.handler('auth'));

module.exports = router;
module.exports.__sendSignInEmail = sendSignInEmail;

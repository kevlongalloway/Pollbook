const fs = require('fs');
const path = require('path');
const express = require('express');
const apiRoutes = require('./src/routes/api');
const { baseUrl } = require('./src/lib/baseUrl');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

// Render (and most hosts) terminate TLS at a proxy, so the caller's address
// only survives in X-Forwarded-For. Without this, req.ip is the proxy's
// address and every visitor shares a single rate-limit bucket. `1` trusts
// exactly one hop — trusting them all would let a caller spoof the header and
// mint a fresh bucket per request. It is also what makes the IP recorded in a
// consent record the subscriber's rather than the load balancer's, which is
// the difference between evidence and noise.
app.set('trust proxy', 1);

/* ---------------- provider webhooks ----------------

   Mounted first, and deliberately outside the /api router, for two reasons
   that are easy to get wrong and painful to debug:

   1. `routes/api.js` applies apiLimiter() to everything under /api — 240
      requests per minute per IP. Resend and Twilio call from a small set of
      addresses and burst during a send, so a delivery run would rate-limit
      its own delivery receipts.

   2. Both providers sign the *raw bytes* of the request. Once express.json()
      has parsed a body, `JSON.stringify(req.body)` does not reproduce them —
      key order and whitespace are gone — and every signature check fails for
      reasons that look nothing like a signature problem. So the webhook
      router takes express.raw() and must be mounted before the global
      express.json() below.                                                   */

app.use('/hooks', require('./src/routes/webhooks'));

// Q&A history is the only body the API accepts and it's capped at 40 short
// messages client-side; 100kb is Express's default and is already generous
// for that, but stating it keeps a large-body DoS off the table explicitly.
app.use(express.json({ limit: '100kb' }));

/* ---------------- index.html + absolute link-preview URLs ----------------

   The OpenGraph tags in index.html have to carry absolute URLs — iMessage,
   Slack and friends ignore relative ones, so a relative og:image means a
   preview with no picture. The origin isn't known at build time, so
   __BASE_URL__ is a placeholder substituted here on every render.

   The origin logic itself now lives in lib/baseUrl.js, because outbound email
   links and Twilio's webhook signature both need to agree with it.         */

function readIndex() {
  return fs.readFileSync(INDEX_FILE, 'utf8');
}

let cachedIndex = readIndex();

function sendIndex(req, res) {
  const html = process.env.NODE_ENV === 'production' ? cachedIndex : (cachedIndex = readIndex());
  res.type('html').send(html.split('__BASE_URL__').join(baseUrl(req, PORT)));
}

app.get(['/', '/index.html'], sendIndex);

// index: false so `/` falls through to sendIndex above instead of being served
// as a static file with the placeholder still in it.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ---------------- the staff portal ----------------

   A separate frontend project in portal/, served from this origin so the
   session cookie works with no CORS and no bearer tokens. The mount is a
   no-op until the portal has an index.html, so this file needs no change when
   somebody builds it — `dist/` wins if a build step produced one.          */

const PORTAL_ROOT = ['dist', '.']
  .map((d) => path.join(__dirname, 'portal', d))
  .find((dir) => fs.existsSync(path.join(dir, 'index.html')));

if (PORTAL_ROOT) {
  app.use('/admin', express.static(PORTAL_ROOT, { index: false }));
  app.get('/admin/*', (req, res) => res.sendFile(path.join(PORTAL_ROOT, 'index.html')));
}

/* ---------------- API ----------------

   Every router has to be mounted above the SPA fallback below. `app.get('*')`
   matches anything, so a router registered after it is silently unreachable
   and its endpoints return index.html with a 200 — which reads as a JSON
   parse error on the client and sends you looking in entirely the wrong
   place. test/routes.js asserts each mount is actually reachable.          */

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/me', require('./src/routes/account'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/transparency', require('./src/routes/transparency'));
app.use('/api', apiRoutes);

// SPA fallback — the frontend handles routing via hash, but keep this
// so deep links to / always resolve.
app.get('*', sendIndex);

/* ---------------- boot ---------------- */

async function start() {
  // Migrations run at boot rather than as a separate deploy step, because the
  // failure mode of "somebody forgot" is a live site querying tables that do
  // not exist. The advisory lock inside migrate() makes it safe when Render
  // starts several instances at once. Set RUN_MIGRATIONS=0 to opt out.
  if (db.enabled() && process.env.RUN_MIGRATIONS !== '0') {
    try {
      await require('./src/db/migrate').migrate();
    } catch (err) {
      // A schema that is behind the code is not survivable — accounts would
      // fail in ways that corrupt data rather than error cleanly.
      console.error('Startup migration failed:', err.message);
      process.exit(1);
    }
  }

  // Background jobs run in-process, and every one of them claims its work
  // with FOR UPDATE SKIP LOCKED, so running them on every instance is safe.
  // Off by default: a deploy should not start sending mail because somebody
  // set DATABASE_URL.
  if (db.enabled() && process.env.ENABLE_JOBS === '1') {
    require('./src/workers').start();
  }

  app.listen(PORT, () => {
    console.log(`Pollbook running → http://localhost:${PORT}`);
    console.log(`Data provider: ${process.env.DATA_PROVIDER || 'live'}`);
    console.log(`Accounts: ${db.enabled() ? 'enabled' : 'disabled (no DATABASE_URL)'}`);
    if (db.enabled()) {
      console.log(`Messaging: ${require('./src/notify').describe()}`);
      console.log(`Background jobs: ${process.env.ENABLE_JOBS === '1' ? 'running' : 'off (set ENABLE_JOBS=1)'}`);
    }
  });
}

// Required by test/routes.js, which boots the real app in-process.
module.exports = { app, start };

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

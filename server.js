const fs = require('fs');
const path = require('path');
const express = require('express');
const apiRoutes = require('./src/routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

app.use(express.json());

/* ---------------- index.html + absolute link-preview URLs ----------------

   The OpenGraph tags in index.html have to carry absolute URLs — iMessage,
   Slack and friends ignore relative ones, so a relative og:image means a
   preview with no picture. The origin isn't known at build time, so
   __BASE_URL__ is a placeholder substituted here on every render.        */

const HOSTNAME_RE = /^[a-zA-Z0-9.\-[\]]+(:\d{1,5})?$/;

function readIndex() {
  return fs.readFileSync(INDEX_FILE, 'utf8');
}

let cachedIndex = readIndex();

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');

  // Behind Render's proxy the original scheme only survives in the forwarded
  // header. Both headers can be comma-joined lists — the first hop is ours.
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();

  // The Host header is caller-controlled and lands inside an HTML attribute,
  // so anything that isn't a plain host:port is discarded rather than escaped.
  if (!HOSTNAME_RE.test(host)) return `http://localhost:${PORT}`;
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

function sendIndex(req, res) {
  const html = process.env.NODE_ENV === 'production' ? cachedIndex : (cachedIndex = readIndex());
  res.type('html').send(html.split('__BASE_URL__').join(baseUrl(req)));
}

app.get(['/', '/index.html'], sendIndex);

// index: false so `/` falls through to sendIndex above instead of being served
// as a static file with the placeholder still in it.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api', apiRoutes);

// SPA fallback — the frontend handles routing via hash, but keep this
// so deep links to / always resolve.
app.get('*', sendIndex);

app.listen(PORT, () => {
  console.log(`Pollbook running → http://localhost:${PORT}`);
  console.log(`Data provider: ${process.env.DATA_PROVIDER || 'live'}`);
});

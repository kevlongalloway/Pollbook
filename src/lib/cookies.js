/**
 * Cookie reading and writing.
 *
 * Express ships `cookie` as a transitive dependency but does not expose it,
 * and `cookie-parser` is a dependency to add for eight lines of work, so this
 * does the work.
 *
 * The session cookie carries `<id>.<hmac>`. The HMAC is not the security
 * boundary — the token is 32 random bytes and is looked up by hash in the
 * database, so a forged one simply misses. What it buys is that a garbage or
 * expired-format cookie is rejected in microseconds without a database round
 * trip, which matters because every request from a logged-out browser that
 * still holds a stale cookie would otherwise cost a query.
 */

const { hmac, equal, signingKey } = require('./tokens');

/** Parse a Cookie header into a plain object. Malformed pairs are skipped. */
function parse(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    if (name in out) continue; // first wins, as browsers do for same-name cookies
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // a value that isn't valid percent-encoding is still a value
    }
  }
  return out;
}

/** One cookie off the request. */
const read = (req, name) => parse(req.headers?.cookie)[name];

/**
 * Serialize a Set-Cookie value.
 *
 * `Secure` is conditional on production so local http development works;
 * everything else is fixed. `SameSite=Lax` is the default because it blocks
 * cross-site POST outright, which is the bulk of CSRF — and note that this is
 * exactly why Sign in with Apple's form_post callback cannot rely on a
 * cookie, and why the OAuth transaction lives in Postgres instead.
 */
function serialize(name, value, opts = {}) {
  const {
    maxAge,
    path = '/',
    httpOnly = true,
    sameSite = 'Lax',
    secure = process.env.NODE_ENV === 'production',
    expires,
  } = opts;

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

/** Append a Set-Cookie without clobbering ones already queued on the response. */
function set(res, name, value, opts) {
  const existing = res.getHeader('Set-Cookie');
  const cookie = serialize(name, value, opts);
  if (!existing) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', [].concat(existing, cookie));
}

/** Expire a cookie. Path must match the one it was set with or it survives. */
function clear(res, name, opts = {}) {
  set(res, name, '', { ...opts, maxAge: 0, expires: new Date(0) });
}

/* ---------------- signing ---------------- */

const sign = (value) => `${value}.${hmac(signingKey(), value).toString('base64url')}`;

/**
 * Verify and strip a signature. Returns null on any tampering.
 *
 * Split from the right: the value itself is base64url and contains no dots,
 * but splitting from the left would break the moment somebody signs something
 * that does.
 */
function unsign(signed) {
  const raw = String(signed || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  let provided;
  try {
    provided = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  return equal(hmac(signingKey(), value), provided) ? value : null;
}

module.exports = { parse, read, serialize, set, clear, sign, unsign };

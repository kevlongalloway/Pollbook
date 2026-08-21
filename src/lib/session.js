/**
 * Sessions: issuing, resolving, and revoking them.
 *
 * Opaque random tokens in the database, not JWTs. The usual argument for a
 * JWT is a stateless read, and it does not apply here: every authenticated
 * request already touches Postgres for roles and subscriptions, so
 * statelessness buys nothing — while revocation buys a great deal. Signing
 * somebody out of a stolen laptop, offboarding an employee, and the step-up
 * window that gates subscriber data all need the server to be able to say no
 * *now*, which a self-contained bearer token cannot do.
 *
 * Only the SHA-256 of each token is stored, so a database dump is not a set
 * of live sessions.
 */

const db = require('../db');
const cookies = require('./cookies');
const { secret, hash } = require('./tokens');

const COOKIE = 'pb_session';
const DEFAULT_TTL_DAYS = 30;

/**
 * How long a step-up lasts.
 *
 * Long enough to approve a broadcast and send it without re-authenticating
 * twice; short enough that an unattended browser is not a standing grant.
 */
const ELEVATION_MS = 15 * 60 * 1000;

/**
 * `last_seen_at` is only written once an hour.
 *
 * Updating it per request turns every page view into a write, which on a
 * read-mostly civic site is most of the write load for a column nobody reads
 * to the minute.
 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Create a session and set the cookie. Returns the raw token, for tests. */
async function issue(req, res, userId, { elevated = false, ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const token = secret(32);
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const audit = require('./audit');

  await db.query(
    `INSERT INTO sessions (public_id, user_id, token_hash, expires_at, ip, user_agent, elevated_until)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
    [
      userId,
      hash(token),
      expires,
      audit.ipOf(req),
      audit.shortUa(req.headers?.['user-agent']),
      elevated ? new Date(Date.now() + ELEVATION_MS) : null,
    ]
  );

  cookies.set(res, COOKIE, cookies.sign(token), {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: ttlDays * 24 * 60 * 60,
  });

  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return token;
}

/**
 * Resolve the session on a request, or null.
 *
 * The signature is checked before the database is touched, so a browser
 * carrying a stale or garbage cookie costs a HMAC rather than a query.
 */
async function resolve(req) {
  if (!db.enabled()) return null;

  const raw = cookies.read(req, COOKIE);
  if (!raw) return null;

  const token = cookies.unsign(raw);
  if (!token) return null;

  const row = await db.one(
    `SELECT s.id, s.public_id, s.user_id, s.expires_at, s.last_seen_at, s.elevated_until,
            u.public_id AS user_public_id, u.email, u.email_normalized, u.display_name,
            u.state_code, u.zip5, u.timezone, u.locale, u.status, u.email_verified_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [hash(token)]
  );
  if (!row) return null;

  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id])
      .catch(() => {}); // bookkeeping, never worth failing a request over
  }

  return {
    session: {
      id: row.id,
      publicId: row.public_id,
      expiresAt: row.expires_at,
      elevated_until: row.elevated_until,
    },
    user: {
      id: row.user_id,
      publicId: row.user_public_id,
      email: row.email,
      emailNormalized: row.email_normalized,
      emailVerified: Boolean(row.email_verified_at),
      displayName: row.display_name,
      state: row.state_code,
      zip5: row.zip5,
      timezone: row.timezone,
      locale: row.locale,
    },
  };
}

/** Re-arm the step-up window after a fresh authentication. */
async function elevate(sessionId) {
  await db.query('UPDATE sessions SET elevated_until = $2 WHERE id = $1', [
    sessionId,
    new Date(Date.now() + ELEVATION_MS),
  ]);
}

/** End one session. */
async function revoke(sessionId, reason = 'signed_out') {
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason]
  );
}

/** End every session for a user. "Sign out everywhere", and offboarding. */
async function revokeAllForUser(userId, reason = 'signed_out_everywhere') {
  const res = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason]
  );
  return res.rowCount;
}

/* ---------------- middleware ---------------- */

/**
 * Attach `req.user` and `req.session` when a session exists.
 *
 * Never rejects. Anonymous browsing is the default state of this site and
 * most routes are happy to serve it — the ones that are not use
 * `requireAuth` below.
 */
async function attach(req, res, next) {
  try {
    const resolved = await resolve(req);
    if (resolved) {
      req.user = resolved.user;
      req.session = resolved.session;
    }
    next();
  } catch (err) {
    // A database blip must not sign everybody out of pages that never needed
    // an account. Treat it as anonymous and carry on.
    console.error('session: resolve failed —', err.message);
    next();
  }
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  const err = new Error('Sign in to do that.');
  err.status = 401;
  err.code = 'PB_UNAUTHENTICATED';
  next(err);
}

/** Clear the cookie regardless of whether the session row was found. */
function clearCookie(res) {
  cookies.clear(res, COOKIE, { httpOnly: true, sameSite: 'Lax' });
}

module.exports = {
  issue, resolve, revoke, revokeAllForUser, elevate,
  attach, requireAuth, clearCookie,
  COOKIE, ELEVATION_MS, DEFAULT_TTL_DAYS,
};

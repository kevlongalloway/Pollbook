/**
 * Passwordless email sign-in.
 *
 * The important one, for two reasons. It is the only sign-in method that does
 * not depend on a third party — which matters when Apple hands back a private
 * relay address and email deliverability *is* the product — and it is the
 * path that has to be hardened, because "send a link to any address" is an
 * open invitation to use us as a spam relay.
 *
 * Five defences, each closing a specific hole:
 *
 *  - **The token is never stored.** Only its SHA-256. A database dump does
 *    not hand over the ability to sign in as anybody.
 *  - **Consumption is a conditional UPDATE.** A double-click, a retried
 *    request, or a replay: exactly one wins, because the database decides,
 *    not a read-then-write in application code that two instances would both
 *    pass.
 *  - **No account enumeration.** The endpoint answers identically whether or
 *    not the address exists, and does the same amount of work either way.
 *  - **Throttled in Postgres, not in process.** lib/rateLimit.js documents
 *    itself as per-instance, which is the right call for protecting an AI
 *    quota and the wrong one for minting credentials — two instances would
 *    allow double, and here the limit is meant to be absolute.
 *  - **A confirmation step, not a bare GET.** Corporate mail scanners
 *    (Defender, Proofpoint) fetch every URL in an inbound message, which
 *    burns a single-use token before the human has clicked anything. So the
 *    emailed link renders a page with a button that POSTs. One extra click,
 *    and it eliminates an entire class of "the link didn't work" reports.
 */

const db = require('../db');
const { secret, hash } = require('../lib/tokens');
const { normalizeEmail } = require('../lib/contacts');
const { safeRedirect } = require('../lib/baseUrl');
const audit = require('../lib/audit');

const TOKEN_TTL_MS = 15 * 60 * 1000;

/** Per-address and per-IP ceilings, per hour. */
const LIMITS = {
  email: Number(process.env.MAGIC_LINK_PER_EMAIL_HOUR) || 5,
  ip: Number(process.env.MAGIC_LINK_PER_IP_HOUR) || 20,
};

/**
 * A fixed-window counter in Postgres.
 *
 * Returns true when the caller is over the limit. The UPSERT is atomic, so
 * concurrent requests across instances cannot both slip under the ceiling.
 */
async function overLimit(bucket, max) {
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const row = await db.one(
    `INSERT INTO auth_attempts (bucket, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = auth_attempts.count + 1
     RETURNING count`,
    [bucket, windowStart]
  );
  return row.count > max;
}

/**
 * Issue a sign-in token.
 *
 * Returns `{ token, email }` when one was created, or `{ throttled: true }`.
 * **The caller must not vary its response on the outcome** — that is what
 * turns this endpoint into an account-existence oracle.
 */
async function issue({ email, purpose = 'login', redirectTo = '/', req }) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { invalid: true };

  const ip = audit.ipOf(req);
  const { hashHex } = require('../lib/tokens');

  if (await overLimit(`magic:${hashHex(normalized)}`, LIMITS.email)) {
    return { throttled: true };
  }
  if (ip && (await overLimit(`ip:${ip}`, LIMITS.ip))) {
    return { throttled: true };
  }

  const token = secret(32);

  await db.query(
    `INSERT INTO login_tokens
       (email_normalized, token_hash, purpose, expires_at, request_ip, user_agent, redirect_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      normalized, hash(token), purpose,
      new Date(Date.now() + TOKEN_TTL_MS),
      ip, audit.shortUa(req?.headers?.['user-agent']), safeRedirect(redirectTo),
    ]
  );

  return { token, email: normalized };
}

/**
 * Redeem a token, atomically and exactly once.
 *
 * Returns the row or null. Null covers every failure — unknown, expired,
 * already used — deliberately, so the caller cannot accidentally tell a user
 * which one it was, since "expired" confirms the address exists.
 */
async function consume(token, { purpose = 'login' } = {}) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;

  return db.one(
    `UPDATE login_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, email_normalized, redirect_to, created_at`,
    [hash(token), purpose]
  );
}

/**
 * Invalidate every outstanding token for an address.
 *
 * Called after a successful sign-in: somebody who requested three links and
 * used the last one should not leave two live credentials sitting in an
 * inbox.
 */
async function invalidateOutstanding(emailNormalized, purpose = 'login') {
  const res = await db.query(
    `UPDATE login_tokens SET consumed_at = now()
      WHERE email_normalized = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [emailNormalized, purpose]
  );
  return res.rowCount;
}

/** Housekeeping: expired tokens are dead weight and they are personal data. */
async function purgeExpired() {
  const res = await db.query(
    `DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'`
  );
  return res.rowCount;
}

module.exports = { issue, consume, invalidateOutstanding, purgeExpired, TOKEN_TTL_MS, LIMITS };

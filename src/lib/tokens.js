/**
 * Random secrets, hashing, and constant-time comparison.
 *
 * One place, because these are the primitives it is easiest to get subtly
 * wrong and hardest to notice: a token compared with `===` leaks its contents
 * one byte at a time to a patient attacker, and a token stored in plaintext
 * turns a database backup into a set of live sessions.
 *
 * The rules everything here exists to enforce:
 *
 *   - Secrets are 32 bytes from the CSPRNG. Never Math.random, never a UUID —
 *     a v4 UUID carries 122 bits in a format that invites people to treat it
 *     as an identifier and log it.
 *   - What we store is the SHA-256 of the secret, never the secret. Lookup is
 *     by hash, so a stolen database yields nothing usable.
 *   - Plain SHA-256 rather than a password hash, deliberately: these are
 *     high-entropy random values, not passwords, so there is nothing to brute
 *     force and no reason to pay bcrypt's cost on every request.
 *   - Comparison is timing-safe, always.
 */

const crypto = require('crypto');

/** A fresh 32-byte secret, base64url. Safe in a URL, a cookie, or a header. */
function secret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** What we store for a secret. Never store the secret itself. */
function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

/** Hex, for logging an identifier without logging the thing it identifies. */
const hashHex = (value) => hash(value).toString('hex');

/**
 * Constant-time equality for two Buffers or two strings.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal, so unequal lengths are compared against a fixed-length digest
 * instead of returning early.
 */
function equal(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    // Still do the work, on values that cannot match, so the failure costs the
    // same as a mismatch of equal length.
    const d = crypto.createHash('sha256').update(left).digest();
    const e = crypto.createHash('sha256').update(right).digest();
    crypto.timingSafeEqual(d, e);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** HMAC-SHA256, hex. */
function hmac(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

/**
 * The signing key for cookies and one-click unsubscribe links.
 *
 * In production a missing SESSION_SECRET is fatal rather than silently
 * replaced: a per-boot random key would sign cookies that stop verifying on
 * the next deploy, logging everybody out and looking like a bug in the auth
 * code rather than a missing environment variable. In development it is
 * generated, because forcing a secret to run locally teaches people to paste
 * one into a shell.
 */
let cachedKey = null;
function signingKey() {
  if (cachedKey) return cachedKey;
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) {
    cachedKey = Buffer.from(configured, 'utf8');
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET is required in production and must be at least 32 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
  }
  if (configured) {
    console.warn('SESSION_SECRET is shorter than 32 characters — using a generated key instead.');
  }
  cachedKey = crypto.randomBytes(32);
  return cachedKey;
}

/** For tests, which must not inherit a key from another suite. */
function resetSigningKey() {
  cachedKey = null;
}

module.exports = { secret, hash, hashHex, equal, hmac, signingKey, resetSigningKey };

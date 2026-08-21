/**
 * JWT signing and verification, on node:crypto.
 *
 * Two jobs, and we need this file for the first one regardless — which is
 * what makes adding `jose` a poor trade for a project with two dependencies:
 *
 *  1. **Signing Apple's client secret.** Sign in with Apple does not issue a
 *     static secret; you sign an ES256 JWT with a `.p8` key from the developer
 *     portal, valid for at most six months.
 *
 *  2. **Verifying ID tokens.** Strictly belt-and-braces: OIDC Core §3.1.3.7
 *     permits skipping signature validation when the token comes straight
 *     from the token endpoint over an authenticated TLS channel, which is the
 *     only flow used here. We verify anyway — the machinery is already
 *     present for (1), and a check that costs one cached JWKS fetch is worth
 *     having if TLS is ever terminated somewhere unexpected.
 *
 * Every historically exploitable JWT mistake is a claim this file checks
 * explicitly: the algorithm comes from an allowlist and must match the key
 * type rather than being taken on the token's word (this is the `alg: none`
 * and the RS256-verified-as-HMAC family), `kid` must resolve, and `iss`,
 * `aud`, `exp`, `iat` and `nonce` are all validated rather than decoded and
 * trusted.
 */

const crypto = require('crypto');
const { fetchJson } = require('./http');
const { cached } = require('./cache');
const { equal } = require('./tokens');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(String(str), 'base64url');

/** Clock skew tolerance. Two minutes covers a badly-synced host. */
const SKEW_MS = 120_000;

/* ---------------- signing (Apple's client secret) ---------------- */

/**
 * Sign an ES256 JWT.
 *
 * The load-bearing detail is `dsaEncoding: 'ieee-p1363'`. Node's default for
 * ECDSA is a DER-wrapped signature; JOSE requires the raw `r || s` pair. Get
 * it wrong and Apple rejects the request with `invalid_client`, which reads
 * like a wrong key ID and sends you looking in the developer portal for an
 * hour. There is no other symptom.
 */
function signES256(payload, { privateKeyPem, kid }) {
  const header = { alg: 'ES256', kid, typ: 'JWT' };
  const signingInput =
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  const key = crypto.createPrivateKey(normalizePem(privateKeyPem));
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Repair a PEM that travelled through an environment variable.
 *
 * Newlines rarely survive a dashboard paste — they arrive as the two
 * characters `\` and `n`. Without this the key fails to parse with an error
 * that says nothing useful about why.
 */
function normalizePem(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing private key.');
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/* ---------------- decoding ---------------- */

/** Split a JWT without validating anything. Never trust what this returns. */
function decode(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(fromB64url(parts[0]).toString('utf8')),
      payload: JSON.parse(fromB64url(parts[1]).toString('utf8')),
      signature: fromB64url(parts[2]),
      signingInput: `${parts[0]}.${parts[1]}`,
    };
  } catch {
    return null;
  }
}

/* ---------------- JWKS ---------------- */

const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch a provider's signing keys, cached for an hour.
 *
 * Goes through the same `cached()` helper the FEC and Congress sources use,
 * so an unreachable JWKS endpoint serves the last good copy rather than
 * failing every sign-in — key rotation is infrequent and yesterday's key set
 * is far better than an outage.
 */
async function jwks(url) {
  const doc = await cached(`jwks:${url}`, JWKS_TTL_MS, () => fetchJson(url, { timeoutMs: 8000 }));
  return Array.isArray(doc?.keys) ? doc.keys : [];
}

/**
 * Find the key for a `kid`, refreshing once if it is unknown.
 *
 * A `kid` we have never seen usually means the provider rotated keys, so one
 * forced refresh is right. It is rate-limited to once every five minutes
 * because the same path is also what an attacker would use to make us hammer
 * Google with a made-up `kid`.
 */
const lastForcedRefresh = new Map();

async function keyFor(url, kid, alg) {
  let keys = await jwks(url);
  let match = keys.find((k) => k.kid === kid);

  if (!match) {
    const last = lastForcedRefresh.get(url) || 0;
    if (Date.now() - last > 5 * 60 * 1000) {
      lastForcedRefresh.set(url, Date.now());
      const { clear } = require('./cache');
      clear();
      keys = await jwks(url);
      match = keys.find((k) => k.kid === kid);
    }
  }

  if (!match) throw new Error(`No signing key matching kid "${kid}".`);

  // The key's own `alg`, when present, is authoritative — not the token's.
  // Taking the algorithm from the token is how an RS256 key gets used as an
  // HMAC secret.
  if (match.alg && alg && match.alg !== alg) {
    throw new Error(`Token claims ${alg} but key ${kid} is ${match.alg}.`);
  }

  return crypto.createPublicKey({ key: match, format: 'jwk' });
}

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);

/**
 * Verify an ID token and return its claims.
 *
 * @param {string}  token
 * @param {object}  opts
 * @param {string}  opts.jwksUrl
 * @param {string|string[]} opts.issuer
 * @param {string}  opts.audience
 * @param {string} [opts.nonce]      required when the flow sent one
 */
async function verify(token, { jwksUrl, issuer, audience, nonce }) {
  const parsed = decode(token);
  if (!parsed) throw new Error('Malformed ID token.');

  const { header, payload, signature, signingInput } = parsed;

  if (!ALLOWED_ALGS.has(header.alg)) {
    throw new Error(`Unsupported token algorithm "${header.alg}".`);
  }
  if (!header.kid) throw new Error('ID token has no key id.');

  const key = await keyFor(jwksUrl, header.kid, header.alg);

  const ok = header.alg === 'ES256'
    ? crypto.verify('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature)
    : crypto.verify('sha256', Buffer.from(signingInput), {
      key, padding: crypto.constants.RSA_PKCS1_PADDING,
    }, signature);

  if (!ok) throw new Error('ID token signature does not verify.');

  const issuers = Array.isArray(issuer) ? issuer : [issuer];
  if (!issuers.includes(payload.iss)) {
    throw new Error(`ID token issuer "${payload.iss}" is not expected here.`);
  }

  // `aud` may be a string or an array; either way ours has to be in it.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(audience)) {
    throw new Error('ID token was issued for a different application.');
  }

  const now = Date.now();
  if (typeof payload.exp !== 'number' || payload.exp * 1000 + SKEW_MS < now) {
    throw new Error('ID token has expired.');
  }
  if (typeof payload.iat === 'number' && payload.iat * 1000 - SKEW_MS > now) {
    throw new Error('ID token was issued in the future.');
  }

  // Comparing timing-safely is belt-and-braces here — the nonce is not a
  // secret — but it costs nothing and keeps the habit consistent.
  if (nonce && !equal(String(payload.nonce || ''), String(nonce))) {
    throw new Error('ID token nonce does not match this sign-in attempt.');
  }

  if (!payload.sub) throw new Error('ID token carries no subject.');

  return payload;
}

module.exports = { signES256, decode, verify, jwks, normalizePem, b64url, SKEW_MS };

/**
 * The shared half of the OAuth/OIDC flows.
 *
 * Both providers use the authorization-code flow with PKCE, and both need the
 * same three throwaway secrets kept somewhere for the round trip:
 *
 *   `state`         correlates the callback with the request that started it,
 *                   and is the CSRF defence for the flow itself.
 *   `nonce`         binds the returned ID token to this attempt, so a token
 *                   captured elsewhere cannot be replayed into it.
 *   `code_verifier` the PKCE secret. Its SHA-256 goes out in the redirect;
 *                   the secret itself is only revealed at the token exchange,
 *                   so an intercepted authorization code is not enough.
 *
 * **They live in Postgres, not in a cookie.** That is not a stylistic
 * preference. Sign in with Apple returns via `response_mode=form_post`, which
 * makes the callback a cross-site POST from appleid.apple.com — and a
 * SameSite=Lax cookie is simply not sent on one. A cookie-based `state` never
 * arrives, and the failure looks like Apple misbehaving rather than like a
 * cookie policy. Putting the transaction in the database fixes that and, as a
 * bonus, lets the callback land on a different Render instance than the one
 * that started the flow.
 */

const crypto = require('crypto');
const db = require('../db');
const { secret } = require('../lib/tokens');
const { safeRedirect } = require('../lib/baseUrl');

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

/**
 * Start a flow: mint the secrets, store them, hand back what goes in the URL.
 */
async function beginTransaction(provider, { redirectTo = '/' } = {}) {
  const state = secret(32);
  const nonce = secret(24);
  const codeVerifier = secret(48); // 64 base64url chars, inside RFC 7636's 43–128

  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  await db.query(
    `INSERT INTO auth_transactions (state, provider, code_verifier, nonce, redirect_to, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [state, provider, codeVerifier, nonce, safeRedirect(redirectTo), new Date(Date.now() + TRANSACTION_TTL_MS)]
  );

  return { state, nonce, codeVerifier, codeChallenge };
}

/**
 * Consume a transaction, atomically.
 *
 * The conditional UPDATE is what makes it single-use: two callbacks racing —
 * a double-click, a retried POST, or a replay — mean exactly one gets a row
 * back and the other gets nothing.
 */
async function consumeTransaction(state, provider) {
  if (!state || typeof state !== 'string' || state.length > 128) return null;
  return db.one(
    `UPDATE auth_transactions
        SET consumed_at = now()
      WHERE state = $1
        AND provider = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING state, code_verifier, nonce, redirect_to`,
    [state, provider]
  );
}

/**
 * Exchange an authorization code for tokens.
 *
 * Deliberately not routed through lib/http.js: that helper throws on any
 * non-2xx, and an OAuth error response carries a JSON body naming the
 * problem (`invalid_grant`, `invalid_client`) which is the single most useful
 * thing to have when a provider integration will not work.
 */
async function exchangeCode(tokenEndpoint, params, { timeoutMs = 10_000 } = {}) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'Pollbook/0.2 (nonpartisan election awareness app)',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }

  if (!res.ok || body.error) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    const err = new Error(`Token exchange failed: ${detail}`);
    err.status = 502;
    err.providerError = body.error || null;
    throw err;
  }

  return body;
}

/** Housekeeping: drop transactions nobody came back for. */
async function purgeExpired() {
  const res = await db.query(
    `DELETE FROM auth_transactions WHERE expires_at < now() - interval '1 day'`
  );
  return res.rowCount;
}

module.exports = { beginTransaction, consumeTransaction, exchangeCode, purgeExpired, TRANSACTION_TTL_MS };

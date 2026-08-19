/**
 * Sign in with Apple.
 *
 * Structurally the same flow as Google, with four differences that cause
 * essentially every failed integration:
 *
 *  1. **There is no static client secret.** You sign an ES256 JWT with a `.p8`
 *     key from the developer portal, valid for at most six months. See
 *     lib/jwt.js for the `dsaEncoding` trap inside that.
 *
 *  2. **`response_mode=form_post`.** Apple POSTs the result back as a form,
 *     cross-site. That means the callback route needs urlencoded body parsing
 *     rather than JSON, and it means a `SameSite=Lax` cookie is not sent —
 *     which is why the flow's state lives in Postgres (see auth/oauth.js).
 *
 *  3. **The name arrives exactly once.** Apple includes a `user` field with
 *     the person's name only on the *first* authorization for a given Service
 *     ID. Miss it and it is gone permanently; the only recovery is the user
 *     revoking the app in iOS Settings and starting again. So it is captured
 *     before anything else in the callback.
 *
 *  4. **Private relay addresses.** Apple's default is to hide the real
 *     address behind `@privaterelay.appleid.com`, which forwards — but only
 *     if the sending domain is registered with Apple's Private Email Relay
 *     service in the developer portal. Without that registration, every
 *     message to an Apple user bounces silently. That is an operational
 *     prerequisite, not a code change, and it is flagged in the README.
 */

const oauth = require('./oauth');
const jwt = require('../lib/jwt');
const { isPrivateRelay } = require('../lib/contacts');

const AUTH_ENDPOINT = process.env.APPLE_AUTH_ENDPOINT || 'https://appleid.apple.com/auth/authorize';
const TOKEN_ENDPOINT = process.env.APPLE_TOKEN_ENDPOINT || 'https://appleid.apple.com/auth/token';
const JWKS_URL = process.env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys';
const ISSUER = 'https://appleid.apple.com';

const serviceId = () => process.env.APPLE_SERVICE_ID || '';   // the client_id
const teamId = () => process.env.APPLE_TEAM_ID || '';
const keyId = () => process.env.APPLE_KEY_ID || '';
const privateKey = () => process.env.APPLE_PRIVATE_KEY || '';

const configured = () => Boolean(serviceId() && teamId() && keyId() && privateKey());

const redirectUri = (base) => `${base}/api/auth/apple/callback`;

/*
 * The client secret is cached rather than signed per request. Apple allows up
 * to six months; we mint for one hour and refresh, so a rotated key takes
 * effect within the hour without a deploy and a leaked secret is short-lived.
 */
const SECRET_TTL_MS = 60 * 60 * 1000;
let cachedSecret = null;

function clientSecret() {
  if (cachedSecret && cachedSecret.expires > Date.now() + 60_000) return cachedSecret.value;

  const now = Math.floor(Date.now() / 1000);
  const value = jwt.signES256(
    {
      iss: teamId(),
      iat: now,
      exp: now + 3600,
      aud: ISSUER,
      sub: serviceId(),
    },
    { privateKeyPem: privateKey(), kid: keyId() }
  );

  cachedSecret = { value, expires: Date.now() + SECRET_TTL_MS };
  return value;
}

/** The URL to send the browser to. */
async function authorizationUrl(base, { redirectTo = '/' } = {}) {
  const { state, nonce } = await oauth.beginTransaction('apple', { redirectTo });

  const params = new URLSearchParams({
    client_id: serviceId(),
    redirect_uri: redirectUri(base),
    response_type: 'code id_token',
    // Requesting any scope forces form_post; Apple rejects the combination of
    // a scope with response_mode=query.
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce,
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Handle the form_post callback.
 *
 * @param {object} body  the parsed urlencoded body: code, state, id_token, user
 */
async function handleCallback({ body, base }) {
  const { code, state, user: userJson } = body || {};

  // Captured first, deliberately. This is the only request in the account's
  // entire lifetime that carries the person's name, and anything that throws
  // before this point loses it forever.
  let firstAuthName = null;
  if (userJson) {
    try {
      const parsed = typeof userJson === 'string' ? JSON.parse(userJson) : userJson;
      const first = parsed?.name?.firstName || '';
      const last = parsed?.name?.lastName || '';
      firstAuthName = `${first} ${last}`.trim() || null;
    } catch {
      firstAuthName = null; // a malformed name is not worth failing a sign-in
    }
  }

  const tx = await oauth.consumeTransaction(state, 'apple');
  if (!tx) {
    const err = new Error('That sign-in attempt has already been used or has expired. Try again.');
    err.status = 400;
    throw err;
  }

  const tokens = await oauth.exchangeCode(TOKEN_ENDPOINT, {
    client_id: serviceId(),
    client_secret: clientSecret(),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(base),
  });

  if (!tokens.id_token) {
    const err = new Error('Apple did not return an ID token.');
    err.status = 502;
    throw err;
  }

  const claims = await jwt.verify(tokens.id_token, {
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    audience: serviceId(),
    nonce: tx.nonce,
  });

  const email = claims.email || null;

  return {
    provider: 'apple',
    subject: claims.sub,
    email,
    // Apple sends this as the string "true" more often than as a boolean.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    displayName: firstAuthName,
    isPrivateRelay:
      claims.is_private_email === true ||
      claims.is_private_email === 'true' ||
      isPrivateRelay(email),
    redirectTo: tx.redirect_to || '/',
  };
}

/** For tests, and for a key rotation that should take effect immediately. */
function __resetSecret() {
  cachedSecret = null;
}

module.exports = {
  configured, authorizationUrl, handleCallback, clientSecret, redirectUri,
  __resetSecret, JWKS_URL, ISSUER,
};

/**
 * Sign in with Google.
 *
 * Authorization code + PKCE + state + nonce. The only Google-specific pieces
 * are the endpoints, the scopes, and one rule worth stating plainly:
 * `email_verified` must be true before the address is used to link to an
 * existing account. Google will hand back an unverified address for some
 * Workspace configurations, and treating one as proof of control is the
 * classic pre-verified-email account takeover.
 */

const oauth = require('./oauth');
const jwt = require('../lib/jwt');

const AUTH_ENDPOINT = process.env.GOOGLE_AUTH_ENDPOINT || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = process.env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';
const JWKS_URL = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const clientId = () => process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '';

/** Is Google sign-in configured on this instance? */
const configured = () => Boolean(clientId() && clientSecret());

const redirectUri = (base) => `${base}/api/auth/google/callback`;

/** The URL to send the browser to. */
async function authorizationUrl(base, { redirectTo = '/' } = {}) {
  const { state, nonce, codeChallenge } = await oauth.beginTransaction('google', { redirectTo });

  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(base),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Without this, a browser signed into several Google accounts silently
    // picks one, and the user has no idea which identity they just linked.
    prompt: 'select_account',
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Handle the callback. Returns a normalized identity.
 *
 * @returns {{provider, subject, email, emailVerified, displayName, isPrivateRelay, redirectTo}}
 */
async function handleCallback({ code, state, base }) {
  const tx = await oauth.consumeTransaction(state, 'google');
  if (!tx) {
    const err = new Error('That sign-in link has already been used or has expired. Try again.');
    err.status = 400;
    throw err;
  }

  const tokens = await oauth.exchangeCode(TOKEN_ENDPOINT, {
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    code_verifier: tx.code_verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(base),
  });

  if (!tokens.id_token) {
    const err = new Error('Google did not return an ID token.');
    err.status = 502;
    throw err;
  }

  const claims = await jwt.verify(tokens.id_token, {
    jwksUrl: JWKS_URL,
    issuer: ISSUERS,
    audience: clientId(),
    nonce: tx.nonce,
  });

  return {
    provider: 'google',
    subject: claims.sub,
    email: claims.email || null,
    // Google sends this as a boolean or the string "true" depending on the
    // endpoint; both mean verified and neither should be coerced loosely.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    displayName: claims.name || null,
    isPrivateRelay: false,
    redirectTo: tx.redirect_to || '/',
  };
}

module.exports = { configured, authorizationUrl, handleCallback, redirectUri, JWKS_URL, ISSUERS };

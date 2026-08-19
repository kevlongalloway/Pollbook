/**
 * The public origin of this instance, derived from the request.
 *
 * Extracted from server.js because three things now need to agree on it and a
 * second copy would drift: the `__BASE_URL__` substitution in index.html
 * (absolute OpenGraph URLs), the links inside outbound email and SMS, and
 * Twilio's webhook signature — which is computed over the *public* URL the
 * request arrived at, so getting this wrong means every callback fails its
 * signature check for reasons that look nothing like a URL problem.
 *
 * Behind Render's proxy the original scheme and host only survive in the
 * forwarded headers, and both can be comma-joined lists — the first hop is
 * ours. The Host header is caller-controlled and lands inside an HTML
 * attribute, so anything that isn't a plain host:port is discarded rather
 * than escaped.
 */

const HOSTNAME_RE = /^[a-zA-Z0-9.\-[\]]+(:\d{1,5})?$/;

/** The configured canonical origin, if one is set. Trailing slashes stripped. */
function configuredBaseUrl() {
  if (!process.env.PUBLIC_BASE_URL) return null;
  return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
}

/**
 * Origin for a request — `https://pollbook.example`, no trailing slash.
 *
 * @param {import('express').Request} req
 * @param {number|string} [fallbackPort] used only when the Host header is unusable
 */
function baseUrl(req, fallbackPort = process.env.PORT || 3000) {
  const configured = configuredBaseUrl();
  if (configured) return configured;

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();

  if (!HOSTNAME_RE.test(host)) return `http://localhost:${fallbackPort}`;
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * The absolute URL this request actually arrived at, including path and query.
 *
 * Twilio signs this exact string. `req.originalUrl` already carries the mount
 * prefix and query, which is what we want — `req.url` is rewritten by the
 * router and would omit the prefix.
 */
function requestUrl(req) {
  return `${baseUrl(req)}${req.originalUrl || req.url || ''}`;
}

/**
 * Is `target` a safe same-app redirect?
 *
 * Login endpoints take a `redirect_to`, and an open redirect on one is a
 * phishing primitive: the attacker gets to borrow our domain for the
 * credential prompt and then bounce the user somewhere else. So only
 * app-relative paths are allowed — never a scheme, never a host, and never
 * `//evil.example` which browsers read as protocol-relative.
 */
function safeRedirect(target, fallback = '/') {
  const value = String(target || '');
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  if (value.includes('\\')) return fallback; // some parsers treat \ as /
  if (!/^\/[A-Za-z0-9\-._~/?=&#%+:@!$'()*,;]*$/.test(value)) return fallback;
  return value;
}

module.exports = { baseUrl, configuredBaseUrl, requestUrl, safeRedirect, __HOSTNAME_RE: HOSTNAME_RE };

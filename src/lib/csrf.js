/**
 * CSRF protection, in three independent layers.
 *
 * Cookie authentication means the browser attaches credentials to requests
 * the user did not intend to make. Three defences, because each fails
 * differently and the cost of all three is a few hundred bytes:
 *
 *  1. **SameSite=Lax on the session cookie** (see lib/cookies.js). Browsers
 *     simply do not send it on a cross-site POST. This covers the realistic
 *     attack on its own.
 *  2. **Origin checking.** Every state-changing request must carry an Origin
 *     or Referer that matches this deployment. This is the layer that survives
 *     a browser regression or an old client, and it costs one string compare.
 *  3. **A double-submit token.** A readable cookie echoed in a header. Since
 *     an attacker on another origin can neither read our cookies nor set our
 *     headers, matching the two proves the request came from our own page.
 *     Its real value is against a same-site subdomain compromise, which Lax
 *     does not cover at all.
 *
 * `csurf` is not used: it is deprecated, and this is forty lines.
 */

const cookies = require('./cookies');
const { secret, equal } = require('./tokens');
const { baseUrl } = require('./baseUrl');

const COOKIE = 'pb_csrf';
const HEADER = 'x-pollbook-csrf';

// GET/HEAD/OPTIONS are required to be safe; a route that changes state on one
// has a bigger problem than CSRF.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Issue the CSRF cookie if the browser does not have one.
 *
 * Deliberately readable by JavaScript — the frontend has to echo it into a
 * header, which is the entire mechanism. It carries no authority on its own:
 * knowing the value proves nothing, only that the code reading it is running
 * on our origin.
 */
function issue(req, res) {
  const existing = cookies.read(req, COOKIE);
  if (existing && existing.length >= 20) return existing;
  const token = secret(24);
  cookies.set(res, COOKIE, token, {
    httpOnly: false,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 30,
  });
  return token;
}

/** Does the request's Origin (or Referer) match this deployment? */
function sameOrigin(req) {
  const expected = baseUrl(req);
  const origin = req.headers.origin;

  if (origin && origin !== 'null') return origin === expected;

  // No Origin header: older clients and some same-origin navigations. Fall
  // back to Referer, and if there is neither, refuse — for a state-changing
  // request, "no provenance at all" is not a state we should accept.
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

/**
 * Middleware: enforce layers 2 and 3 on every state-changing request.
 *
 * Webhooks are not mounted behind this — a provider callback has no Origin
 * and no cookie, and is authenticated by its signature instead.
 */
function protect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    issue(req, res);
    return next();
  }

  if (!sameOrigin(req)) {
    const err = new Error('This request did not come from Pollbook. Reload the page and try again.');
    err.status = 403;
    err.code = 'PB_CSRF_ORIGIN';
    return next(err);
  }

  const cookieToken = cookies.read(req, COOKIE);
  const headerToken = req.headers[HEADER];

  if (!cookieToken || !headerToken || !equal(cookieToken, headerToken)) {
    const err = new Error('Your session token did not match. Reload the page and try again.');
    err.status = 403;
    err.code = 'PB_CSRF_TOKEN';
    return next(err);
  }

  return next();
}

module.exports = { protect, issue, sameOrigin, COOKIE, HEADER };

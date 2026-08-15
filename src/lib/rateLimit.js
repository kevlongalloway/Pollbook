/**
 * Fixed-window rate limiting, in-process and dependency-free.
 *
 * The exposure this closes: `/ask` calls Groq and a web-search provider on
 * every request, both metered, neither behind auth. A loop against one
 * candidate page could drain the day's quota and take the AI panels down for
 * everyone — a denial of service that costs the attacker nothing.
 *
 * Two ceilings, because they fail differently:
 *
 *   - **Per-IP** stops one caller monopolizing the service. It's the limit
 *     that matters for ordinary abuse, and it's the one users can hit
 *     accidentally, so its message says when to come back.
 *   - **Global** caps total spend against the upstream regardless of how many
 *     IPs show up. Per-IP limits do nothing against a botnet; this is what
 *     actually protects the quota, and it's deliberately set well above what
 *     real traffic looks like so it only trips under abuse.
 *
 * In-process state means limits are per-instance: two instances behind a load
 * balancer allow roughly double. That's fine for the threat being addressed
 * (quota exhaustion, not precise fairness) and avoids requiring Redis for what
 * is currently a single-instance deployment. Revisit if this ever scales out.
 */

/** Where a fixed window puts its boundary, for a given clock. */
const windowStart = (now, windowMs) => Math.floor(now / windowMs) * windowMs;

/**
 * The caller's address.
 *
 * `req.ip` is correct only when Express is told which proxies to trust (see
 * `trust proxy` in server.js); without that it reports the load balancer's
 * address and every visitor shares one bucket. Falls back to the socket so a
 * misconfiguration degrades to "limit by connection" rather than "limit
 * everyone together".
 */
const clientKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Build a limiter. Returns Express middleware plus a `reset()` for tests.
 *
 * @param {number} windowMs  width of the fixed window
 * @param {number} max       requests allowed per key per window
 * @param {number} [globalMax] total requests allowed per window across all keys
 * @param {string} message   user-facing explanation, shown verbatim by the UI
 */
function rateLimit({ windowMs, max, globalMax = Infinity, message }) {
  const hits = new Map(); // key → { count, window }
  let global = { count: 0, window: 0 };

  const middleware = (req, res, next) => {
    const now = Date.now();
    const win = windowStart(now, windowMs);
    const retryAfter = Math.ceil((win + windowMs - now) / 1000);

    if (global.window !== win) global = { count: 0, window: win };

    // Buckets are only cleaned when their own key is next seen, so a burst
    // from many addresses would otherwise leave an entry per address forever.
    // Sweeping on window rollover keeps the map proportional to live traffic.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.window !== win) hits.delete(k);
    }

    const key = clientKey(req);
    const entry = hits.get(key);
    const count = entry && entry.window === win ? entry.count : 0;

    const overPerIp = count >= max;
    const overGlobal = global.count >= globalMax;

    if (overPerIp || overGlobal) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: overGlobal
          ? 'This service is handling more AI questions than its quota allows right now. Try again in a few minutes.'
          : message,
      });
    }

    hits.set(key, { count: count + 1, window: win });
    global.count += 1;
    return next();
  };

  middleware.reset = () => {
    hits.clear();
    global = { count: 0, window: 0 };
  };
  return middleware;
}

const minutes = (n) => n * 60 * 1000;

/**
 * The AI endpoints. One question costs a web search plus a completion and
 * takes up to 25 seconds, so the honest ceiling is low — this is roughly
 * "a curious person reading a page", not "a script".
 */
const askLimiter = () => rateLimit({
  windowMs: minutes(10),
  max: Number(process.env.ASK_RATE_LIMIT) || 12,
  globalMax: Number(process.env.ASK_RATE_LIMIT_GLOBAL) || 240,
  message: 'You have asked a lot of questions in a short time. Give it a few minutes and try again — this keeps the AI panels available for everyone.',
});

/**
 * Everything else. Read endpoints are cached and cheap, so this is set to
 * catch scrapers rather than to shape ordinary use: a person clicking through
 * the site quickly should never see it.
 */
const apiLimiter = () => rateLimit({
  windowMs: minutes(1),
  max: Number(process.env.API_RATE_LIMIT) || 240,
  message: 'Too many requests. Slow down and try again shortly.',
});

module.exports = { rateLimit, askLimiter, apiLimiter, __windowStart: windowStart };

/**
 * In-memory TTL cache for external API responses.
 *
 * - Deduplicates in-flight requests for the same key.
 * - Serves stale data when a refresh fails (external election APIs flake;
 *   yesterday's candidate list beats an error page).
 */

const store = new Map(); // key → { value, expires, promise }

async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const entry = store.get(key);

  if (entry && entry.expires > now && 'value' in entry) return entry.value;
  if (entry && entry.promise) return entry.promise;

  const promise = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } catch (err) {
      store.delete(key);
      if (entry && 'value' in entry) return entry.value; // stale fallback
      throw err;
    }
  })();

  store.set(key, { ...(entry || {}), promise });
  return promise;
}

module.exports = { cached };

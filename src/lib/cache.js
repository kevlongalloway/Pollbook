/**
 * TTL cache for external API responses.
 *
 * - Deduplicates in-flight requests for the same key.
 * - Serves stale data when a refresh fails (external election APIs flake;
 *   yesterday's candidate list beats an error page).
 * - Backs off after a failure with nothing stale to fall back on.
 * - Survives a process restart by keeping a snapshot on disk.
 *
 * The last two exist because of how the metered upstreams actually fail.
 * FEC and Congress.gov are rate-limited per key — 30 requests an hour on the
 * shared demo keys — and the previous behaviour turned that into a spiral:
 * a 429 deleted the entry, so the next page load retried immediately, spent
 * another request against the same exhausted limit, and failed again. Traffic
 * made it worse rather than better, and the cache emptying on every restart
 * meant a cold start began by hammering both APIs at once.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = new Map(); // key → { value, expires, promise, error, errorUntil }

/**
 * How long a failure suppresses retries when there's no stale value to serve.
 *
 * Short enough that a blip resolves on the next page load, long enough that a
 * burst of traffic against a down upstream costs one request rather than one
 * per visitor. Callers still get a rejection — degradation is their decision,
 * the same as before; this only stops the network call being repeated.
 */
const FAILURE_TTL = Number(process.env.CACHE_FAILURE_TTL_MS) || 30_000;

/* ---------------- disk snapshot ---------------- */

/*
 * Written to the OS temp directory rather than the repo: it is derived data,
 * it should never be committed, and tmpdir is writable on every host this runs
 * on including read-only-root containers. It survives a process restart within
 * a container, which is the case worth optimizing — a host that discards the
 * filesystem between deploys simply starts cold, exactly as it does today.
 */
const PERSIST = process.env.CACHE_PERSIST !== '0';
const CACHE_FILE = process.env.CACHE_FILE
  || path.join(os.tmpdir(), 'pollbook-cache.json');

// A whole feed of bills is a few hundred KB; this bounds the file well above
// normal working set while refusing to grow without limit.
const MAX_PERSISTED_BYTES = Number(process.env.CACHE_MAX_BYTES) || 8 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 5000;

let writeTimer = null;
let loaded = false;

function loadSnapshot() {
  if (loaded || !PERSIST) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    for (const [key, value, expires] of entries) {
      if (typeof key !== 'string') continue;
      // Expired entries are kept deliberately: they are exactly what
      // stale-on-error wants to serve if the upstream is still down. A fresh
      // fetch overwrites them on the first successful call.
      store.set(key, { value, expires: Number(expires) || 0 });
    }
  } catch {
    // No snapshot, unreadable, or corrupt — starting cold is always valid.
  }
}

function persistSoon() {
  if (!PERSIST || writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const entries = [];
      for (const [key, entry] of store) {
        if (!('value' in entry)) continue; // in-flight or failed: nothing to keep
        entries.push([key, entry.value, entry.expires]);
      }
      const json = JSON.stringify(entries);
      if (Buffer.byteLength(json) > MAX_PERSISTED_BYTES) return;
      // Write-then-rename so a crash mid-write can't leave a truncated file
      // that then fails to parse on the next boot.
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, CACHE_FILE);
    } catch {
      // Persistence is an optimization; a read-only or full disk must never
      // take down a request path.
    }
  }, WRITE_DEBOUNCE_MS);
  // Don't hold the event loop open just to flush a cache.
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/* ---------------- the cache ---------------- */

async function cached(key, ttlMs, fn) {
  loadSnapshot();

  const now = Date.now();
  const entry = store.get(key);

  if (entry && entry.expires > now && 'value' in entry) return entry.value;
  if (entry && entry.promise) return entry.promise;

  // A recent failure with nothing stale behind it: re-throw without touching
  // the network again until the cooldown passes.
  if (entry && entry.errorUntil > now && !('value' in entry)) throw entry.error;

  const promise = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      persistSoon();
      return value;
    } catch (err) {
      if (entry && 'value' in entry) {
        // Serve stale, and hold it for the cooldown rather than restoring its
        // original (already-past) expiry — otherwise every subsequent read
        // looks expired and re-runs the call that just failed, which is the
        // stampede this is here to prevent.
        store.set(key, { value: entry.value, expires: Date.now() + FAILURE_TTL });
        return entry.value;
      }
      store.set(key, { error: err, errorUntil: Date.now() + FAILURE_TTL });
      throw err;
    }
  })();

  store.set(key, { ...(entry || {}), promise });
  return promise;
}

/** Drop everything. Exported for tests, which must not share state. */
function clear() {
  store.clear();
  loaded = false;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

module.exports = { cached, clear, __CACHE_FILE: CACHE_FILE };

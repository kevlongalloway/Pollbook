/**
 * Cache behaviour under upstream failure — the part that decides whether a
 * rate-limited API recovers or spirals.
 *
 * The bug these guard: on failure the cache used to delete the entry, so the
 * next request retried immediately. Against a 429 that meant every page load
 * spent another request on an already-exhausted limit — traffic made the
 * outage worse instead of riding it out. Demo keys allow 30 requests an hour,
 * so this is reachable in ordinary use, not just under attack.
 *
 * Run: node test/cache.js
 */

// Each test needs its own view of the store, so persistence is exercised
// explicitly rather than inherited from a previous run.
process.env.CACHE_PERSIST = '0';
process.env.CACHE_FAILURE_TTL_MS = '80';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push({ name, fn });

const cache = require('../src/lib/cache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  test('a fresh value is fetched once and reused', async () => {
    cache.clear();
    let calls = 0;
    const fn = async () => { calls++; return 'v1'; };

    assert.strictEqual(await cache.cached('k', 1000, fn), 'v1');
    assert.strictEqual(await cache.cached('k', 1000, fn), 'v1');
    assert.strictEqual(calls, 1);
  });

  test('concurrent callers share one in-flight request', async () => {
    cache.clear();
    let calls = 0;
    const fn = async () => { calls++; await sleep(20); return 'v'; };

    const results = await Promise.all([
      cache.cached('k', 1000, fn),
      cache.cached('k', 1000, fn),
      cache.cached('k', 1000, fn),
    ]);
    assert.deepStrictEqual(results, ['v', 'v', 'v']);
    assert.strictEqual(calls, 1, 'a stampede must collapse to a single upstream call');
  });

  test('a stale value is served when the refresh fails', async () => {
    cache.clear();
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return 'good';
      throw new Error('upstream 500');
    };

    assert.strictEqual(await cache.cached('k', 10, fn), 'good');
    await sleep(20); // let it expire
    assert.strictEqual(await cache.cached('k', 10, fn), 'good', 'stale beats an error page');
    assert.strictEqual(calls, 2);
  });

  test('a served-stale value does not re-run the failing call on every read', async () => {
    cache.clear();
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) return 'good';
      throw new Error('rate limited');
    };

    await cache.cached('k', 5, fn);
    await sleep(10);
    await cache.cached('k', 5, fn); // fails, falls back to stale
    const after = calls;
    await cache.cached('k', 5, fn);
    await cache.cached('k', 5, fn);
    assert.strictEqual(calls, after, 'stale should be served directly, not re-fetched each time');
  });

  test('a failure with nothing stale backs off instead of retrying every request', async () => {
    cache.clear();
    let calls = 0;
    const fn = async () => { calls++; throw new Error('HTTP 429 from api.open.fec.gov'); };

    // This is the spiral: three visitors arrive while the upstream is angry.
    await assert.rejects(() => cache.cached('k', 1000, fn), /429/);
    await assert.rejects(() => cache.cached('k', 1000, fn), /429/);
    await assert.rejects(() => cache.cached('k', 1000, fn), /429/);

    assert.strictEqual(calls, 1, 'the upstream must be called once, not once per visitor');
  });

  test('the backoff expires so a recovered upstream is picked up', async () => {
    cache.clear();
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('down');
      return 'recovered';
    };

    await assert.rejects(() => cache.cached('k', 1000, fn));
    await sleep(120); // past CACHE_FAILURE_TTL_MS
    assert.strictEqual(await cache.cached('k', 1000, fn), 'recovered');
  });

  test('callers still see the rejection, so their own degradation still runs', async () => {
    cache.clear();
    const fn = async () => { throw new Error('boom'); };
    // Sources rely on .catch(() => []) to degrade a panel; swallowing the
    // error here would turn a missing panel into a silently empty one.
    const degraded = await cache.cached('k', 1000, fn).catch(() => 'fallback-ran');
    assert.strictEqual(degraded, 'fallback-ran');
  });

  test('a snapshot is written and reloaded, so a restart starts warm', async () => {
    const file = path.join(os.tmpdir(), `pollbook-cache-test-${process.pid}.json`);
    fs.rmSync(file, { force: true });

    // A second module instance with persistence on, standing in for a restart.
    process.env.CACHE_PERSIST = '1';
    process.env.CACHE_FILE = file;
    delete require.cache[require.resolve('../src/lib/cache')];
    const c1 = require('../src/lib/cache');

    await c1.cached('warm', 60_000, async () => ({ bills: [1, 2, 3] }));
    // The write is debounced; wait it out rather than reaching into internals.
    await sleep(5200);
    assert.ok(fs.existsSync(file), 'a snapshot should have been written');

    delete require.cache[require.resolve('../src/lib/cache')];
    const c2 = require('../src/lib/cache');
    let calls = 0;
    const value = await c2.cached('warm', 60_000, async () => { calls++; return 'refetched'; });

    assert.deepStrictEqual(value, { bills: [1, 2, 3] }, 'the snapshot should serve the value');
    assert.strictEqual(calls, 0, 'a warm start must not call the upstream');

    fs.rmSync(file, { force: true });
    process.env.CACHE_PERSIST = '0';
    delete process.env.CACHE_FILE;
    delete require.cache[require.resolve('../src/lib/cache')];
  });

  for (const { name, fn } of checks) {
    try { await fn(); passed++; }
    catch (err) { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; }
  }
  console.log(`cache: ${passed}/${checks.length} passed`);
})().catch((err) => {
  console.error(`✗ ${err.stack}`);
  process.exit(1);
});

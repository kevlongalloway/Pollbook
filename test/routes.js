/**
 * HTTP-level tests for the API: input validation, error mapping, and the rate
 * limits that stand between a loop and the Groq bill.
 *
 * Runs against the real Express app with DATA_PROVIDER=mock, so no external
 * service is touched. This is the layer the other suites don't reach — they
 * test sources and libraries directly, which means a route that validates
 * nothing, or a limiter wired to the wrong handler, would pass all of them.
 *
 * Run: node test/routes.js
 */

process.env.CACHE_PERSIST = '0';
process.env.DATA_PROVIDER = 'mock';
// Small enough to exhaust in a test without sending hundreds of requests.
// The global ceiling is left high here and tested directly instead: the
// router builds one limiter at require time, so a low global cap would leak
// across every test in this file rather than isolating the behaviour.
process.env.ASK_RATE_LIMIT = '3';
process.env.ASK_RATE_LIMIT_GLOBAL = '100000';
process.env.API_RATE_LIMIT = '5000';

const assert = require('node:assert');
const http = require('node:http');

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push({ name, fn });

let base;

/*
 * Every test that spends AI budget gets its own address. The limiter runs
 * before the route handler — deliberately, so a flood of malformed requests
 * is cheap to reject — which means a shared address would let one test's
 * spending decide another test's status code.
 */
let nextIp = 1;
const freshIp = () => `198.51.100.${nextIp++}`;

/** One request. `ip` sets X-Forwarded-For so per-IP limiting is exercisable. */
function request(method, path, { body, ip = '203.0.113.1' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        'x-forwarded-for': ip,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not all responses are JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p, o) => request('GET', p, o);
const post = (p, body, o) => request('POST', p, { body, ...o });

/*
 * Stubs Groq and the search provider so an ask that passes validation
 * actually returns an answer. Without them these tests would only ever see
 * the 503 for a missing key, and the happy path through the route — the thing
 * most worth knowing still works — would go unexercised.
 */
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const send = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (url.pathname === '/chat/completions') {
      return send({ choices: [{ message: { role: 'assistant', content: 'A stub answer.' } }] });
    }
    if (url.pathname === '/search') {
      return send({ results: [{ title: 'T', url: 'https://example.com/a', content: 'body' }] });
    }
    return res.writeHead(404).end('{}');
  });
});

(async () => {
  await new Promise((r) => upstream.listen(0, r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  process.env.GROQ_API_BASE = upstreamBase;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.TAVILY_API_BASE = upstreamBase;
  process.env.TAVILY_API_KEY = 'test-key';

  // Required after env is set so the modules pick up the stub bases.
  const express = require('express');
  const apiRoutes = require('../src/routes/api');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', apiRoutes);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  /* ---------------- basic contracts ---------------- */

  test('meta reports the provider and which upstreams have their own key', async () => {
    const { status, json } = await get('/api/meta');
    assert.strictEqual(status, 200);
    assert.strictEqual(json.provider, 'mock');
    assert.strictEqual(json.live, false);
    // The signal that tells an operator their key never reached the process.
    assert.ok(['configured', 'DEMO_KEY'].includes(json.congressKey));
    assert.ok(['configured', 'DEMO_KEY'].includes(json.fecKey));
  });

  test('a missing candidate is a 404, not a 500', async () => {
    const { status, json } = await get('/api/candidates/does-not-exist');
    assert.strictEqual(status, 404);
    assert.match(json.error, /not found/i);
  });

  test('a well-formed reference to a bill that does not exist is a 404', async () => {
    // Distinct from the 400 cases below: the reference is valid, the bill
    // just isn't there.
    const { status } = await get('/api/bills/119/hr/99999');
    assert.strictEqual(status, 404);
  });

  /* ---------------- bill reference validation ---------------- */

  test('a bill reference that is not a real reference is rejected before any lookup', async () => {
    // The type segment lands in an upstream URL, so it must be checked
    // against the known list rather than passed through.
    for (const path of [
      '/api/bills/119/zz/1',        // not a bill type
      '/api/bills/0/hr/1',          // no such congress
      '/api/bills/119/hr/abc',      // non-numeric
      '/api/bills/119/hr/123456',   // implausibly long
    ]) {
      const { status } = await get(path);
      assert.strictEqual(status, 400, `${path} should be a 400`);
    }
  });

  test('a valid bill reference resolves', async () => {
    const { status, json } = await get('/api/bills/119/hr/9001');
    assert.strictEqual(status, 200);
    assert.strictEqual(json.label, 'H.R. 9001');
    assert.strictEqual(json.stage.step, 3, 'stage step should match the five-stage rail');
  });

  test('the bills feed reports what it scanned', async () => {
    const { status, json } = await get('/api/bills');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(json.bills));
    assert.strictEqual(json.mode, 'feed');
    assert.ok(json.coverage >= 0);
  });

  /* ---------------- ask endpoint validation ---------------- */

  test('a question reaches the model and comes back with sources', async () => {
    const { status, json } = await post(
      '/api/candidates/cand-mwhitfield/ask', { question: 'What do they support?' }, { ip: freshIp() }
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(json.answer, 'A stub answer.');
    assert.ok(Array.isArray(json.sources));
  });

  test('a bill question works through the route too', async () => {
    const { status, json } = await post(
      '/api/bills/119/hr/9001/ask', { question: 'What would this change?' }, { ip: freshIp() }
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(json.answer, 'A stub answer.');
  });

  test('an empty or oversized question is rejected before reaching the model', async () => {
    const ip = freshIp();
    const blank = await post('/api/candidates/cand-mwhitfield/ask', { question: '   ' }, { ip });
    assert.strictEqual(blank.status, 400);

    const huge = await post('/api/candidates/cand-mwhitfield/ask', { question: 'x'.repeat(5000) }, { ip });
    assert.strictEqual(huge.status, 400);

    const missing = await post('/api/candidates/cand-mwhitfield/ask', {}, { ip });
    assert.strictEqual(missing.status, 400);
  });

  test('a bad bill reference on the ask route is rejected too', async () => {
    const { status } = await post('/api/bills/119/zz/1/ask', { question: 'hi' }, { ip: freshIp() });
    assert.strictEqual(status, 400);
  });

  /* ---------------- rate limiting ---------------- */

  test('the ask endpoints share one per-IP budget across candidates and bills', async () => {
    const ip = freshIp();
    // ASK_RATE_LIMIT=3. Validation failures still consume budget, which is
    // intended: a loop of malformed requests is exactly what this stops.
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const res = await post('/api/candidates/cand-mwhitfield/ask', { question: 'x' }, { ip });
      codes.push(res.status);
    }
    assert.strictEqual(codes[3], 429, `4th request should be limited, got ${codes[3]}`);

    // The budget is per-service, not per-route: the bill endpoint is already
    // exhausted for this caller.
    const bill = await post('/api/bills/119/hr/9001/ask', { question: 'x' }, { ip });
    assert.strictEqual(bill.status, 429, 'a second Q&A route must not reset the budget');
  });

  test('a limited response explains itself and says when to retry', async () => {
    const ip = freshIp();
    let limited = null;
    for (let i = 0; i < 5 && !limited; i++) {
      const res = await post('/api/candidates/cand-mwhitfield/ask', { question: 'x' }, { ip });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'the limit should trip');
    assert.ok(limited.headers['retry-after'], 'Retry-After should be set');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    // The frontend renders `error` verbatim, so it has to read as English.
    assert.ok(limited.json.error.length > 20);
    assert.doesNotMatch(limited.json.error, /rate.?limit exceeded/i);
  });

  test('limits are per caller, so one abuser does not lock everyone out', async () => {
    // A fresh address gets its own budget even though others are exhausted.
    const { status } = await post('/api/candidates/cand-mwhitfield/ask', { question: 'x' }, { ip: freshIp() });
    assert.notStrictEqual(status, 429);
  });

  test('read endpoints are not limited by the strict AI budget', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) {
      await post('/api/candidates/cand-mwhitfield/ask', { question: 'x' }, { ip });
    }
    const { status } = await get('/api/meta', { ip });
    assert.strictEqual(status, 200, 'browsing must keep working after the AI budget is spent');
  });

  test('the global ceiling caps total spend regardless of how many addresses show up', async () => {
    // Tested directly rather than through the router: per-IP limits do nothing
    // against a botnet, and this is the limiter that actually protects the
    // upstream quota, so it needs to be provably independent of the caller.
    const { rateLimit } = require('../src/lib/rateLimit');
    const limiter = rateLimit({ windowMs: 60_000, max: 100, globalMax: 3, message: 'per-ip' });

    const run = (ip) => new Promise((resolve) => {
      const res = {
        set() { return this; },
        status(code) { this.code = code; return this; },
        json(body) { resolve({ code: this.code || 200, body }); },
      };
      limiter({ ip }, res, () => resolve({ code: 200, body: null }));
    });

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await run(`10.0.0.${i}`)); // every call a new address

    assert.deepStrictEqual(results.map((r) => r.code), [200, 200, 200, 429, 429]);
    assert.match(results[3].body.error, /quota/i, 'the global message should differ from the per-IP one');
  });

  for (const { name, fn } of checks) {
    try { await fn(); passed++; }
    catch (err) { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; }
  }

  console.log(`routes: ${passed}/${checks.length} passed`);
  server.close();
  upstream.close();
})().catch((err) => {
  console.error(`✗ ${err.stack}`);
  process.exit(1);
});

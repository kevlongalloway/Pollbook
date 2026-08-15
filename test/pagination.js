/**
 * Verifies keyset pagination against a local stub that mimics the FEC's
 * cursor behaviour (`pagination.last_indexes` echoed back as query params).
 *
 * This is the logic that fixes the "every candidate shows the same small
 * PAC totals" bug: the FEC refuses deep page-number paging on itemized
 * schedules, so a single page only ever returned an arbitrary slice of
 * identically-sized max-out checks. Run: npm run test:pagination
 */

// Hermetic: never read or write the on-disk cache snapshot from a test run.
process.env.CACHE_PERSIST = '0';


const assert = require('node:assert');
const http = require('node:http');

const TOTAL_ROWS = 450;   // more than 4 full pages
const PER_PAGE = 100;

// Build a deterministic dataset: 3 PACs giving repeated $5,000 checks.
const PACS = ['REALTORS PAC', 'HONEYWELL INTERNATIONAL PAC', 'AIPAC PAC'];
const ALL_ROWS = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
  contributor_name: PACS[i % PACS.length],
  contributor_id: `C0000000${i % PACS.length}`,
  contribution_receipt_amount: 5000,
  index: i,
}));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.endsWith('/schedules/schedule_a/')) {
    res.writeHead(404).end('{}');
    return;
  }
  // Reject page-number paging exactly as the live API does.
  if (url.searchParams.has('page')) {
    res.writeHead(422).end(JSON.stringify({ error: 'page paging not supported' }));
    return;
  }
  const after = Number(url.searchParams.get('last_index') ?? -1);
  const perPage = Number(url.searchParams.get('per_page') || PER_PAGE);
  const slice = ALL_ROWS.filter((r) => r.index > after).slice(0, perPage);
  const last = slice[slice.length - 1];
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    results: slice,
    pagination: {
      count: TOTAL_ROWS,
      last_indexes: last
        ? { last_index: last.index, last_contribution_receipt_amount: last.contribution_receipt_amount }
        : null,
    },
  }));
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.FEC_API_BASE = `http://127.0.0.1:${server.address().port}`;

  // Require after the env var is set so the module picks up the stub base.
  const fec = require('../src/sources/fec');
  const rows = await fec.__fetchScheduleA({ committee_id: 'C00TEST' });

  assert.strictEqual(rows.length, TOTAL_ROWS,
    `expected every row to be walked, got ${rows.length}`);
  assert.strictEqual(new Set(rows.map((r) => r.index)).size, TOTAL_ROWS,
    'rows must not repeat across pages');

  const agg = fec.aggregateContributors(rows);
  assert.strictEqual(agg.length, 3);
  // 450 rows over 3 PACs = 150 each × $5,000 = $750,000 — a figure a
  // single-page fetch could never have produced.
  assert.strictEqual(agg[0].total, 750000);
  assert.strictEqual(agg[0].count, 150);

  console.log(`pagination: walked ${rows.length} rows across ${Math.ceil(TOTAL_ROWS / PER_PAGE)} pages, aggregated to ${agg.length} committees ✓`);
  server.close();
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  server.close();
  process.exit(1);
});

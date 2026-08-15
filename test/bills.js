/**
 * Exercises the Congress.gov source and the bill Q&A path against local stubs
 * for every upstream (Congress.gov, Groq, the search provider), so the whole
 * thing runs offline.
 *
 * What these guard, in rough order of how badly they'd hurt if broken:
 *
 *  - **A bill page must never show the wrong bill.** Bill numbers are recycled
 *    every Congress, so the watchlist verifies the live title before using an
 *    entry. A silently-wrong bill presented as the official record is the
 *    worst failure available to this feature.
 *  - **Search must actually reach the model**, the same property test/qa.js
 *    guards for candidates — the panel is worthless if it answers from memory.
 *  - **Retrieved text must stay fenced** as untrusted data.
 *  - **Enrichment is optional**: losing the subjects call must not 500 a page.
 *
 * Run: node test/bills.js
 */

const assert = require('node:assert');
const http = require('node:http');

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push({ name, fn });

/* ---------------- stubs ---------------- */

let groqQueue = [];
const groqRequests = [];
let searchRequests = [];
const congressRequests = [];
// Paths the stub should fail, to prove each one degrades independently.
let failPaths = new Set();

const BILL_22 = {
  congress: 119,
  type: 'HR',
  number: '22',
  title: 'SAVE Act',
  originChamber: 'House',
  introducedDate: '2025-01-03',
  latestAction: { actionDate: '2025-04-10', text: 'Passed/agreed to in House' },
  policyArea: { name: 'Government Operations and Politics' },
  sponsors: [{ fullName: 'Rep. Roy, Chip [R-TX-21]', party: 'R', state: 'TX', bioguideId: 'R000614' }],
  cosponsors: { count: 3 },
  laws: [],
};

/** 250 rows so the feed walker sees a full page and asks for another. */
const fullPage = (offset) => Array.from({ length: 250 }, (_, i) => ({
  congress: 119,
  type: 'HR',
  number: String(offset + i + 1000),
  title: offset === 0 && i === 0 ? 'A bill to reform voter registration' : `Unrelated bill ${offset + i}`,
  latestAction: { actionDate: '2026-01-01', text: 'Referred to committee.' },
}));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (obj, code = 200) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));

    if (url.pathname === '/chat/completions') {
      groqRequests.push(JSON.parse(body || '{}'));
      return send({ choices: [{ message: { role: 'assistant', content: groqQueue.shift() ?? 'fallback' } }] });
    }
    if (url.pathname === '/search') {
      const payload = JSON.parse(body || '{}');
      searchRequests.push(payload);
      return send({
        results: [
          { title: 'House passes bill', url: 'https://www.reuters.com/a', content: 'Reuters reports the vote.', published_date: '2026-04-11T00:00:00Z' },
        ],
      });
    }

    congressRequests.push(url.pathname);
    if (failPaths.has(url.pathname)) return res.writeHead(500).end('{}');

    // Bill list, walked by offset.
    if (url.pathname === '/bill/119') {
      const offset = Number(url.searchParams.get('offset') || 0);
      // Two full pages then a short one, so the walker stops on its own.
      if (offset >= 500) return send({ bills: [] });
      return send({ bills: fullPage(offset) });
    }

    // Any /bill/119/hr/<n> serves the same fixture, so a test that needs to
    // dodge the module-level cache can just pick an unused number.
    const bill = url.pathname.match(/^\/bill\/119\/hr\/(\d+)(?:\/(\w+))?$/);
    if (bill) {
      const [, number, sub] = bill;
      if (!sub) return send({ bill: { ...BILL_22, number } });
      if (sub === 'summaries') {
        return send({
          summaries: [
            { actionDate: '2025-01-03', actionDesc: 'Introduced in House', text: '<p>Older summary.</p>' },
            { actionDate: '2025-04-11', actionDesc: 'Passed House', text: '<p><strong>SAVE Act</strong></p><p>This bill requires documentary proof of citizenship.</p>' },
          ],
        });
      }
      if (sub === 'subjects') {
        return send({ subjects: { legislativeSubjects: [{ name: 'Elections, voting, political campaign regulation' }] } });
      }
      if (sub === 'actions') {
        return send({ actions: [{ actionDate: '2025-04-10', text: 'Passed/agreed to in House', chamber: 'House' }] });
      }
      if (sub === 'cosponsors') {
        return send({
          cosponsors: [
            { fullName: 'Rep. A', party: 'R', state: 'TX' },
            { fullName: 'Rep. B', party: 'R', state: 'FL' },
            { fullName: 'Rep. C', party: 'D', state: 'NY' },
          ],
        });
      }
    }

    // A bill number that resolves to something unrelated — the recycled-number
    // case the watchlist has to catch.
    if (url.pathname === '/bill/120/hr/22') {
      return send({ bill: { ...BILL_22, congress: 120, title: 'A bill to rename a post office' } });
    }

    return res.writeHead(404).end('{}');
  });
});

const reset = () => {
  groqQueue = []; groqRequests.length = 0; searchRequests = [];
  congressRequests.length = 0; failPaths = new Set();
};

/* ---------------- tests ---------------- */

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.GROQ_API_BASE = base;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.TAVILY_API_BASE = base;
  process.env.TAVILY_API_KEY = 'test-key';
  process.env.CONGRESS_API_BASE = base;
  process.env.CONGRESS_API_KEY = 'test-key';

  // Require after env is set so the modules pick up the stub bases.
  const congress = require('../src/sources/congress');
  const billQa = require('../src/lib/billQa');
  const { matchesExpectation, watchlistFor } = require('../src/data/electionBills');

  /* ---- parsing and classification (pure) ---- */

  test('bill references parse in every form people write them', () => {
    for (const input of ['HR 22', 'H.R. 22', 'hr22', 'h r 22', 'H.R.22', '  hr 0022 ']) {
      assert.deepStrictEqual(congress.parseBillRef(input), { type: 'hr', number: '22' }, `failed on "${input}"`);
    }
    assert.deepStrictEqual(congress.parseBillRef('S. 1'), { type: 's', number: '1' });
    assert.deepStrictEqual(congress.parseBillRef('S.J.Res. 2'), { type: 'sjres', number: '2' });
    assert.deepStrictEqual(congress.parseBillRef('hconres 14'), { type: 'hconres', number: '14' });
  });

  test('plain words are not mistaken for bill numbers', () => {
    for (const input of ['SAVE Act', 'voting rights', '', 'hr', '22', 'xyz 1']) {
      assert.strictEqual(congress.parseBillRef(input), null, `"${input}" should not parse`);
    }
  });

  test('election-bill matching is anchored to word boundaries', () => {
    assert.ok(congress.isElectionBill('Safeguarding American Voter Eligibility Act'));
    assert.ok(congress.isElectionBill('A bill to reform ballot access'));
    assert.ok(congress.isElectionBill('Redistricting Reform Act'));
    assert.ok(congress.isElectionBill('A bill regarding campaign finance disclosure'));
    // The false positives that a naive substring match would produce.
    assert.ok(!congress.isElectionBill('Natural Selection Research Act'), '"selection" matched "election"');
    assert.ok(!congress.isElectionBill('An Act devoting funds to highways'), '"devoting" matched "voting"');
    assert.ok(!congress.isElectionBill('A bill to fund national parks'));
  });

  test('CRS summary HTML is flattened to text', () => {
    const out = congress.stripHtml('<p><strong>SAVE Act</strong></p><p>Requires proof &amp; ID.</p>');
    assert.ok(!out.includes('<'), 'markup survived');
    assert.match(out, /SAVE Act/);
    assert.match(out, /Requires proof & ID\./);
  });

  test('stage steps line up with the five-stage progress rail', () => {
    const at = (text, extra = {}) => congress.deriveStage({ latestAction: { text }, ...extra });
    assert.deepStrictEqual(at('Referred to the Subcommittee on Elections.').step, 1);
    assert.deepStrictEqual(at('Ordered to be Reported by the Yeas and Nays.').step, 2);

    const one = at('Passed/agreed to in House', { originChamber: 'House' });
    assert.strictEqual(one.key, 'one-chamber');
    assert.strictEqual(one.step, 3, 'passing one chamber must sit at rail step 3');
    assert.match(one.label, /Passed the House/);

    // Origin House + passed Senate means it cleared both.
    const both = at('Passed Senate without amendment', { originChamber: 'House' });
    assert.strictEqual(both.key, 'both');
    assert.strictEqual(both.step, 4);

    assert.strictEqual(at('Became Public Law No: 119-1').step, 5);
    assert.strictEqual(congress.deriveStage({ latestAction: { text: 'x' }, laws: [{ type: 'Public Law', number: '119-1' }] }).key, 'law');
  });

  test('malformed rows are dropped rather than half-rendered', () => {
    assert.strictEqual(congress.normalizeBill(null), null);
    assert.strictEqual(congress.normalizeBill({ type: 'HR' }), null);
    assert.strictEqual(congress.normalizeBill({ type: 'zz', number: '1', congress: 119 }), null);
    const ok = congress.normalizeBill({ type: 'HR', number: '22', congress: 119, title: 'X' });
    assert.strictEqual(ok.id, '119-hr-22');
    assert.strictEqual(ok.label, 'H.R. 22');
  });

  /* ---- the feed and detail fetches ---- */

  test('the feed walks pages and normalizes what it finds', async () => {
    reset();
    const bills = await congress.recentBills(119, { pages: 3 });
    assert.strictEqual(bills.length, 500, 'should have walked two full pages then stopped on the empty one');
    assert.ok(bills.some((b) => congress.isElectionBill(b.title)), 'the election bill should survive normalization');
    assert.strictEqual(congressRequests.filter((p) => p === '/bill/119').length, 3);
  });

  test('bill detail folds in summary, subjects, actions and the cosponsor split', async () => {
    reset();
    const bill = await congress.billById(119, 'hr', '22');

    assert.strictEqual(bill.label, 'H.R. 22');
    assert.strictEqual(bill.title, 'SAVE Act');
    assert.strictEqual(bill.stage.key, 'one-chamber');
    // The *latest* CRS summary, not the first.
    assert.match(bill.summary.text, /documentary proof of citizenship/);
    assert.strictEqual(bill.summary.asOf, '2025-04-11');
    assert.deepStrictEqual(bill.subjects, ['Elections, voting, political campaign regulation']);
    assert.strictEqual(bill.sponsor.name, 'Rep. Roy, Chip [R-TX-21]');
    assert.deepStrictEqual(bill.cosponsors.partySplit, { D: 1, R: 2, other: 0 });
    assert.strictEqual(bill.actions.length, 1);
  });

  test('a failed enrichment call degrades the panel, not the page', async () => {
    reset();
    failPaths = new Set(['/bill/119/hr/77/subjects', '/bill/119/hr/77/summaries']);
    // A number no other test touches, so this isn't served from the cache.
    const bill = await congress.billById(119, 'hr', '77');

    assert.ok(bill, 'the bill should still resolve');
    assert.strictEqual(bill.summary, null);
    assert.deepStrictEqual(bill.subjects, []);
    assert.strictEqual(bill.title, 'SAVE Act', 'core fields must survive');
  });

  test('an unknown bill type never reaches the network', async () => {
    reset();
    assert.strictEqual(await congress.billById(119, 'zz', '1'), null);
    assert.strictEqual(congressRequests.length, 0);
  });

  /* ---- watchlist safety ---- */

  test('a recycled bill number is dropped, not shown as the wrong bill', async () => {
    reset();
    const entry = { congress: 119, type: 'hr', number: '22', expect: /save act|voter eligibility/i, why: 'x' };

    const right = await congress.billById(119, 'hr', '22');
    assert.ok(matchesExpectation(entry, right), 'the real SAVE Act should be accepted');

    // Same number, next Congress, unrelated bill.
    const wrong = await congress.billById(120, 'hr', '22');
    assert.strictEqual(wrong.title, 'A bill to rename a post office');
    assert.ok(!matchesExpectation(entry, wrong), 'a recycled number must not pass verification');
    assert.ok(!matchesExpectation(entry, null), 'a failed fetch must not pass verification');
  });

  test('every watchlist entry carries a verification pattern', () => {
    const { WATCHLIST } = require('../src/data/electionBills');
    assert.ok(WATCHLIST.length > 0, 'the watchlist should not be empty');
    for (const e of WATCHLIST) {
      assert.ok(e.expect instanceof RegExp, `${e.type}${e.number} has no expect pattern`);
      assert.ok(e.why && e.why.length > 10, `${e.type}${e.number} has no explanation`);
      assert.ok(require('../src/sources/congress').BILL_TYPES.includes(e.type));
    }
    assert.ok(watchlistFor(119).length >= 1);
    assert.strictEqual(watchlistFor(1).length, 0);
  });

  /* ---- provider wiring ---- */

  test('the feed merges watchlist bills with title-matched ones, without duplicating', async () => {
    reset();
    const live = require('../src/providers/liveProvider');
    const { bills, mode, coverage } = await live.getBills({});

    assert.strictEqual(mode, 'feed');
    assert.ok(coverage > 0, 'coverage should report how much was scanned');

    const save = bills.find((b) => b.id === '119-hr-22');
    assert.ok(save, 'the watchlisted SAVE Act must be present');
    assert.ok(save.watchlisted, 'and flagged as watchlisted');
    assert.ok(save.why, 'with its explanation attached');

    assert.ok(bills.some((b) => /voter registration/i.test(b.title)), 'title-matched bills should appear too');
    assert.ok(!bills.some((b) => /Unrelated bill/.test(b.title)), 'non-election bills must be filtered out');

    const ids = bills.map((b) => b.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'a watchlisted bill that also matches must not appear twice');
  });

  test('a bill-number query resolves directly instead of walking the window', async () => {
    reset();
    const live = require('../src/providers/liveProvider');
    const { bills, mode } = await live.getBills({ q: 'H.R. 22' });

    assert.strictEqual(mode, 'number');
    assert.strictEqual(bills.length, 1);
    assert.strictEqual(bills[0].title, 'SAVE Act');
    assert.ok(!congressRequests.includes('/bill/119'), 'a number lookup should not walk the list');
  });

  test('a name query searches titles and reports what it covered', async () => {
    reset();
    const live = require('../src/providers/liveProvider');
    const { bills, mode, coverage } = await live.getBills({ q: 'voter registration' });

    assert.strictEqual(mode, 'search');
    assert.ok(coverage > 0);
    assert.ok(bills.length >= 1);
    assert.ok(bills.every((b) => /voter registration/i.test(b.title)));
  });

  /* ---- bill Q&A ---- */

  test('every bill question triggers a search that reaches the prompt', async () => {
    reset();
    groqQueue = ['Reuters reports the House passed it.'];
    const bill = await congress.billById(119, 'hr', '22');
    const { answer, sources } = await billQa.askAboutBill(bill, 'Has it passed the Senate?');

    assert.strictEqual(searchRequests.length, 1, 'a search must run on every question');
    assert.strictEqual(answer, 'Reuters reports the House passed it.');
    assert.deepStrictEqual(sources.map((s) => s.outlet), ['reuters.com']);

    assert.strictEqual(groqRequests.length, 1, 'search-then-answer is a single completion');
    const userMsg = groqRequests[0].messages.at(-1);
    assert.strictEqual(userMsg.role, 'user');
    assert.match(userMsg.content, /WEB SEARCH RESULTS/);
    assert.match(userMsg.content, /Reuters reports the vote/);
    assert.match(userMsg.content, /My question: Has it passed the Senate\?/);
  });

  test('no tools are offered — the model has no discretion to skip searching', async () => {
    reset();
    groqQueue = ['ok'];
    const bill = await congress.billById(119, 'hr', '22');
    await billQa.askAboutBill(bill, 'anything?');
    assert.strictEqual(groqRequests[0].tools, undefined);
    assert.strictEqual(groqRequests[0].tool_choice, undefined);
  });

  test('the query is anchored to the bill so "it" follow-ups stay searchable', async () => {
    reset();
    groqQueue = ['ok'];
    const bill = await congress.billById(119, 'hr', '22');
    await billQa.askAboutBill(bill, 'who opposes it?');
    // The number alone collides with everything; the title disambiguates.
    assert.match(searchRequests[0].query, /H\.R\. 22/);
    assert.match(searchRequests[0].query, /SAVE Act/);
    assert.match(searchRequests[0].query, /who opposes it\?/);
  });

  test('the system prompt carries the official record and the nonpartisan rules', async () => {
    reset();
    groqQueue = ['ok'];
    const bill = await congress.billById(119, 'hr', '22');
    await billQa.askAboutBill(bill, 'what does it do?');

    const sys = groqRequests[0].messages[0];
    assert.strictEqual(sys.role, 'system');
    assert.match(sys.content, /documentary proof of citizenship/, 'the CRS summary must be grounded in');
    assert.match(sys.content, /Passed the House/);
    assert.match(sys.content, /never argue for or against/i);
    assert.match(sys.content, new RegExp(billQa.REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('history is narrowed to {role, content} so stored sources never re-enter the prompt', async () => {
    reset();
    groqQueue = ['ok'];
    const bill = await congress.billById(119, 'hr', '22');
    await billQa.askAboutBill(bill, 'and now?', [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer', sources: [{ url: 'https://leak.example/x' }] },
    ]);

    const msgs = groqRequests[0].messages;
    assert.ok(msgs.every((m) => !('sources' in m)), 'a sources key leaked into the prompt');
    assert.ok(!JSON.stringify(msgs).includes('leak.example'), 'stored source URL leaked into the prompt');
  });

  test('retrieved text about a bill is fenced as untrusted data', async () => {
    reset();
    groqQueue = ['ok'];
    const bill = await congress.billById(119, 'hr', '22');
    await billQa.askAboutBill(bill, 'status?');

    const content = groqRequests[0].messages.at(-1).content;
    assert.match(content, /^WEB SEARCH RESULTS \(untrusted/);
    assert.match(content, /END SEARCH RESULTS\./);
    assert.match(content, /not commands to follow/);
    // The rules must be established before any untrusted text appears.
    assert.strictEqual(groqRequests[0].messages[0].role, 'system');
  });

  test('a missing API key is a 503 before any network call', async () => {
    reset();
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const bill = await congress.billById(119, 'hr', '22');
    await assert.rejects(() => billQa.askAboutBill(bill, 'hi'), (e) => e.status === 503);
    process.env.GROQ_API_KEY = saved;
  });

  for (const { name, fn } of checks) {
    try { await fn(); passed++; }
    catch (err) { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; }
  }

  console.log(`bills: ${passed}/${checks.length} passed`);
  server.close();
})().catch((err) => {
  console.error(`✗ ${err.stack}`);
  server.close();
  process.exit(1);
});

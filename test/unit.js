/**
 * Offline unit tests — validate calendar math and the parsers/mappers that
 * transform external API payloads, using realistic fixtures. Run: npm test
 */

const assert = require('node:assert');
const calendar = require('../src/lib/calendar');
const fec = require('../src/sources/fec');
const { parseItems } = require('../src/sources/news');
const { extractPositions } = require('../src/sources/wikipedia');
const { attachProbabilities } = require('../src/sources/markets');
const { STATES } = require('../src/data/usStates');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (err) { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; }
};

/* ---------------- states table ---------------- */

test('51 areas, 36 governor races, 35 senate races in 2026', () => {
  assert.strictEqual(STATES.length, 51);
  assert.strictEqual(STATES.filter((s) => s.governor2026).length, 36);
  assert.strictEqual(STATES.filter((s) => s.senate2026).length, 35);
});

/* ---------------- calendar ---------------- */

test('general election dates follow 2 U.S.C. §7', () => {
  assert.strictEqual(calendar.generalElectionDate(2026), '2026-11-03');
  assert.strictEqual(calendar.generalElectionDate(2028), '2028-11-07');
  assert.strictEqual(calendar.generalElectionDate(2030), '2030-11-05');
  assert.strictEqual(calendar.generalElectionDate(2032), '2032-11-02');
});

test('cycle rolls over after election day', () => {
  assert.strictEqual(calendar.currentCycle('2026-08-15'), 2026);
  assert.strictEqual(calendar.currentCycle('2026-11-03'), 2026);
  assert.strictEqual(calendar.currentCycle('2026-11-04'), 2028);
  assert.strictEqual(calendar.currentCycle('2027-01-01'), 2028);
});

test('every state produces a general election entry', () => {
  const all = calendar.allElections({ today: '2026-01-01', upcoming: true });
  for (const s of STATES) {
    assert.ok(all.some((e) => e.id === `${s.code.toLowerCase()}-general-2026`), `missing ${s.code}`);
  }
  assert.ok(all.some((e) => e.id === 'us-general-2026'));
});

/* ---------------- FEC mappers ---------------- */

test('FEC name flipping', () => {
  assert.strictEqual(fec.displayName('OSSOFF, T. JONATHAN (JON)'), 'Jon Ossoff');
  assert.strictEqual(fec.displayName('MCBATH, LUCY'), 'Lucy McBath');
  assert.strictEqual(fec.displayName('DE LA CRUZ, ISABEL'), 'Isabel De La Cruz');
  assert.strictEqual(fec.displayName('SMITH, JOHN JR.'), 'John Smith');
  assert.strictEqual(fec.displayName('SINGLENAME'), 'Singlename');
});

test('party code mapping', () => {
  assert.strictEqual(fec.mapParty('DEM'), 'DEM');
  assert.strictEqual(fec.mapParty('DFL'), 'DEM');
  assert.strictEqual(fec.mapParty('GRE'), 'GRN');
  assert.strictEqual(fec.mapParty('XYZ'), 'OTH');
  assert.strictEqual(fec.mapParty(null), 'OTH');
});

test('district labels', () => {
  assert.strictEqual(fec.districtLabel('04'), 'District 4');
  assert.strictEqual(fec.districtLabel('00'), 'At-Large');
  assert.strictEqual(fec.districtLabel(null), 'At-Large');
});

/* ---------------- Google News RSS parser ---------------- */

test('parses Google News RSS items', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Candidate unveils rural health plan - The Tribune</title>
      <link>https://news.google.com/rss/articles/abc123</link>
      <pubDate>Wed, 12 Aug 2026 14:00:00 GMT</pubDate>
      <source url="https://tribune.example">The Tribune</source></item>
    <item><title>Debate set for &amp; more</title>
      <link>https://news.google.com/rss/articles/def456</link>
      <pubDate>Mon, 10 Aug 2026 09:30:00 GMT</pubDate>
      <source url="https://ledger.example">Ledger</source></item>
  </channel></rss>`;
  const items = parseItems(xml, 6);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, 'Candidate unveils rural health plan');
  assert.strictEqual(items[0].outlet, 'The Tribune');
  assert.strictEqual(items[0].date, '2026-08-12');
  assert.strictEqual(items[1].title, 'Debate set for & more');
});

/* ---------------- Wikipedia positions extractor ---------------- */

test('extracts political positions section with sub-topics', () => {
  const article = [
    'Jane Doe is an American politician.',
    '== Early life ==', 'Born somewhere.',
    '== Political positions ==', 'Doe is described as a moderate.',
    '=== Healthcare ===', 'Doe supports expanding rural hospitals.',
    '=== Energy ===', 'Doe backs grid modernization.',
    '== Electoral history ==', 'Won in 2022.',
  ].join('\n');
  const positions = extractPositions(article);
  assert.strictEqual(positions.length, 3);
  assert.strictEqual(positions[0].topic, 'Overview');
  assert.match(positions[0].text, /moderate/);
  assert.deepStrictEqual(positions.map((p) => p.topic), ['Overview', 'Healthcare', 'Energy']);
  assert.match(positions[1].text, /rural hospitals/);
});

test('returns empty when no positions section exists', () => {
  assert.deepStrictEqual(extractPositions('== Career ==\nDid things.'), []);
});

/* ---------------- market probability matching ---------------- */

test('attaches probabilities from general-election market by surname', () => {
  const candidates = [
    { id: 'a', name: 'Jane Doe' },
    { id: 'b', name: 'Rex Fairbanks' },
    { id: 'c', name: 'Al Unmatched' },
  ];
  const markets = [
    { name: 'Who will win the 2026 Republican primary in Testland?', contracts: [{ name: 'Fairbanks', price: 0.9 }] },
    { name: 'Who will win the 2026 U.S. Senate election in Testland?', contracts: [
      { name: 'Jane Doe', shortName: 'Doe', price: 0.62 },
      { name: 'Fairbanks', shortName: '', price: 0.35 },
    ] },
  ];
  attachProbabilities(candidates, markets);
  assert.strictEqual(candidates[0].probability, 62);
  assert.strictEqual(candidates[1].probability, 35); // primary market ignored
  assert.strictEqual(candidates[2].probability, undefined);
});

/* ---------------- PAC / money tracking ---------------- */

const { expandQuery } = require('../src/data/committeeAliases');

test('AIPAC search expands to United Democracy Project', () => {
  const { terms, expansions } = expandQuery('aipac');
  assert.ok(terms.some((t) => /united democracy project/i.test(t)));
  assert.ok(expansions.length >= 1);
  assert.match(expansions[0].why, /super PAC/i);
});

test('plain searches do not expand', () => {
  const { terms, expansions } = expandQuery('Club for Growth');
  assert.deepStrictEqual(terms, ['Club for Growth']);
  assert.strictEqual(expansions.length, 0);
});

test('committee type labels', () => {
  assert.strictEqual(fec.committeeTypeLabel('O'), 'Super PAC');
  assert.strictEqual(fec.committeeTypeLabel('Q'), 'PAC');
  assert.strictEqual(fec.committeeTypeLabel('X'), 'Party committee');
  assert.strictEqual(fec.committeeTypeLabel('??'), 'Committee');
});

test('aggregates PAC contributions by contributor, skipping refunds', () => {
  const rows = [
    { contributor_name: 'GOOD GOVERNMENT PAC', contributor_id: 'C001', contribution_receipt_amount: 5000 },
    { contributor_name: 'GOOD GOVERNMENT PAC', contributor_id: 'C001', contribution_receipt_amount: 2500 },
    { contributor_name: 'OTHER COMMITTEE', contributor_id: 'C002', contribution_receipt_amount: 1000 },
    { contributor_name: 'REFUNDED PAC', contributor_id: 'C003', contribution_receipt_amount: -500 },
  ];
  const agg = fec.aggregateContributors(rows);
  assert.strictEqual(agg.length, 2);
  assert.strictEqual(agg[0].name, 'Good Government Pac');
  assert.strictEqual(agg[0].total, 7500);
  assert.strictEqual(agg[0].count, 2);
  assert.strictEqual(agg[0].committeeId, 'C001');
});

test('aggregates recipients by committee', () => {
  const rows = [
    { committee: { committee_id: 'C010', name: 'SMITH FOR SENATE' }, contribution_receipt_amount: 5000 },
    { committee: { committee_id: 'C010', name: 'SMITH FOR SENATE' }, contribution_receipt_amount: 5000 },
    { committee: { committee_id: 'C011', name: 'DOE FOR CONGRESS' }, contribution_receipt_amount: 3000 },
  ];
  const agg = fec.aggregateRecipients(rows);
  assert.strictEqual(agg.length, 2);
  assert.strictEqual(agg[0].total, 10000);
  assert.strictEqual(agg[0].name, 'Smith For Senate');
});

test('aggregates earmarked money by conduit (the AIPAC mechanism)', () => {
  const rows = [
    // Bundled donations naming the conduit committee.
    { contribution_receipt_amount: 2900, donor_committee_name: 'AIPAC PAC' },
    { contribution_receipt_amount: 3300, donor_committee_name: 'AIPAC PAC' },
    // Conduit only named in the memo text.
    { contribution_receipt_amount: 1000, memo_text: 'EARMARKED THROUGH ACTBLUE (C00401224)' },
    { contribution_receipt_amount: 500, memo_text: 'Earmarked via ActBlue' },
    // Ordinary individual money — no conduit, must be excluded.
    { contribution_receipt_amount: 250, memo_text: '' },
    { contribution_receipt_amount: 900 },
    // Refund must be excluded.
    { contribution_receipt_amount: -100, donor_committee_name: 'AIPAC PAC' },
  ];
  const agg = fec.aggregateEarmarks(rows);
  assert.strictEqual(agg.length, 2);
  assert.strictEqual(agg[0].name, 'Aipac Pac');
  assert.strictEqual(agg[0].total, 6200);
  assert.strictEqual(agg[0].count, 2);
  assert.strictEqual(agg[1].name, 'Actblue');
  assert.strictEqual(agg[1].total, 1500);
});

test('PAC aggregation totals repeated max-out checks across the cycle', () => {
  // Real PAC giving clusters at the $5k legal cap — the point of full
  // pagination is that the same PAC's repeated checks sum correctly.
  const rows = Array.from({ length: 4 }, () => ({
    contributor_name: 'REALTORS PAC', contributor_id: 'C00030718', contribution_receipt_amount: 5000,
  }));
  const agg = fec.aggregateContributors(rows);
  assert.strictEqual(agg.length, 1);
  assert.strictEqual(agg[0].total, 20000);
  assert.strictEqual(agg[0].count, 4);
});

/* ---------------- congress numbering ---------------- */

test('congress number advances every odd January', () => {
  assert.strictEqual(calendar.currentCongress('2025-06-01'), 119);
  assert.strictEqual(calendar.currentCongress('2026-08-15'), 119);
  assert.strictEqual(calendar.currentCongress('2027-06-01'), 120);
  assert.strictEqual(calendar.currentCongress('2029-06-01'), 121);
  // A new Congress convenes on January 3, so the first two days of an odd
  // year still belong to the outgoing one.
  assert.strictEqual(calendar.currentCongress('2027-01-01'), 119);
  assert.strictEqual(calendar.currentCongress('2027-01-03'), 120);
});

/* ---------------- money-flow model ---------------- */

const { buildMoneyFlow } = require('../src/lib/moneyFlow');

const FINANCE = {
  cycle: 2026, coverageEnd: '2026-06-30',
  receipts: 1000000, disbursements: 600000, cashOnHand: 400000,
  fromIndividuals: 700000, fromPacs: 50000, fromParty: 100000,
};

const FUNDING = {
  donorSizes: [{ size: 0, total: 200000 }, { size: 2000, total: 500000 }],
  earmarked: [{ name: 'Advocacy Network', total: 150000, count: 210 }],
  independent: {
    support: [{ committee: 'Priorities PAC', committeeId: 'C1', total: 2000000 }],
    oppose: [{ committee: 'Values Fund', committeeId: 'C2', total: 500000 }],
  },
};

test('inflow bands reconcile to the reported receipts total', () => {
  const mf = buildMoneyFlow({ finance: FINANCE, funding: FUNDING });
  const total = mf.campaign.inflows.reduce((t, f) => t + f.amount, 0);
  assert.strictEqual(total, FINANCE.receipts, 'bands must sum to what the campaign says it raised');
  assert.strictEqual(mf.campaign.raised, 1000000);
  // 1,000,000 - (700k + 50k + 100k) lands in an explicit remainder rather
  // than silently disappearing.
  const other = mf.campaign.inflows.find((f) => f.key === 'other');
  assert.strictEqual(other.amount, 150000);
});

test('conduit money annotates the individual bands, never adds a band', () => {
  const mf = buildMoneyFlow({ finance: FINANCE, funding: FUNDING });
  // The bug this guards: bundled money arrives *as* individual contributions,
  // so adding it as its own inflow would double-count it against the total.
  assert.ok(!mf.campaign.inflows.some((f) => /conduit|earmark|bundl/i.test(f.key + f.label)));
  assert.strictEqual(mf.campaign.inflows.reduce((t, f) => t + f.amount, 0), FINANCE.receipts);
  assert.strictEqual(mf.campaign.conduits.total, 150000);
  // 150k bundled out of 700k individual.
  assert.ok(Math.abs(mf.campaign.conduits.shareOfIndividuals - 150000 / 700000) < 1e-9);
});

test('outside spending stays out of the campaign total', () => {
  const mf = buildMoneyFlow({ finance: FINANCE, funding: FUNDING });
  assert.strictEqual(mf.outside.total, 2500000);
  assert.strictEqual(mf.outside.support.total, 2000000);
  assert.strictEqual(mf.outside.oppose.total, 500000);
  // Independent expenditures never touch the campaign's books.
  assert.strictEqual(mf.campaign.raised, 1000000);
  // One ruler across both tracks, so the taller stack really is the bigger
  // pile of money.
  assert.strictEqual(mf.scale, 2500000);
});

test('small-donor split is dropped when the aggregates do not reconcile', () => {
  // The FEC's donor-size aggregate covers a different window than the
  // individual total, so it can exceed it. Splitting anyway would draw a
  // sub-band wider than its parent.
  const mf = buildMoneyFlow({
    finance: { ...FINANCE, fromIndividuals: 100000 },
    funding: { ...FUNDING, donorSizes: [{ size: 0, total: 900000 }] },
  });
  const keys = mf.campaign.inflows.map((f) => f.key);
  assert.ok(keys.includes('individuals'), 'should fall back to one undivided band');
  assert.ok(!keys.includes('small'));
  assert.ok(mf.caveats.some((c) => /small-donor/i.test(c)), 'the fallback must be explained');
});

test('shares are computed against the drawn total', () => {
  const mf = buildMoneyFlow({ finance: FINANCE, funding: FUNDING });
  const sum = mf.campaign.inflows.reduce((t, f) => t + f.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'shares should sum to 1');
});

test('nothing to draw returns null rather than an empty chart', () => {
  assert.strictEqual(buildMoneyFlow({}), null);
  assert.strictEqual(buildMoneyFlow({ finance: { receipts: 0 }, funding: {} }), null);
  assert.strictEqual(buildMoneyFlow({ finance: { receipts: null } }), null);
});

test('outside spending alone still draws', () => {
  const mf = buildMoneyFlow({
    finance: null,
    funding: { independent: { support: [{ committee: 'X', total: 90000 }], oppose: [] } },
  });
  assert.ok(mf, 'a candidate with no filings but real outside spending must still render');
  assert.strictEqual(mf.outside.total, 90000);
  assert.deepStrictEqual(mf.campaign.inflows, []);
});

test('negative and missing aggregates are skipped, not drawn', () => {
  const mf = buildMoneyFlow({
    finance: { receipts: 500000, fromIndividuals: 500000, fromPacs: -2000, fromParty: null },
    funding: {},
  });
  assert.deepStrictEqual(mf.campaign.inflows.map((f) => f.key), ['individuals']);
  assert.strictEqual(mf.campaign.conduits, null);
  assert.strictEqual(mf.outside, null);
});

console.log(`${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);

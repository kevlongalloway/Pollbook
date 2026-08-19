/**
 * The neutrality safeguards.
 *
 * These are the tests that matter most in this suite, and they are
 * deliberately the ones that need no database: every safeguard worth having
 * is a pure function over text, so it can be tested exhaustively and cheaply
 * against a corpus rather than by inspection.
 *
 * The schema guard at the bottom is the exception in spirit — it reads the
 * migration files rather than a live database, so "there is no party column"
 * is asserted on every run, on every machine, with nothing configured.
 *
 * Run: node test/nonpartisan.js
 */

process.env.CACHE_PERSIST = '0';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const np = require('../src/lib/nonpartisan');
const render = require('../src/notify/render');
const retention = require('../src/workers/retention');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
};

const SOURCES = [{ label: 'vote.gov', url: 'https://vote.gov' }];

/** A contested race: an incumbent, a well-funded challenger, and a no-hoper. */
const RACE = [
  { name: 'Jon Ossoff', party: 'DEM', incumbent: true, receipts: 1_000_000 },
  { name: 'Marjorie Greene', party: 'REP', incumbent: false, receipts: 900_000 },
  { name: 'Zeb Aardvark', party: 'IND', incumbent: false, receipts: 4_000 },
];

const lint = (text, opts = {}) => np.lint(text, { sources: SOURCES, ...opts });
const blocked = (text, opts) => lint(text, opts).blocked;
const rules = (text, opts) => lint(text, opts).findings.map((f) => f.rule);

/* ---------------- copy that must pass ---------------- */

const CLEAN = [
  'Georgia\'s general election is Tuesday, November 3. Check your registration at vote.gov.',
  'Most states close voter registration 15 to 30 days before election day.',
  'Remember to vote. If you are in line when polls close, stay in line.',
  'The market price for this contract moved 12 cents this week.',
  'Congress is considering three bills that would change how you register.',
  'Your polling place may have changed. Confirm it with your county election office.',
];

for (const text of CLEAN) {
  test(`clean: ${text.slice(0, 46)}…`, () => {
    const report = lint(text, { candidates: RACE });
    assert.equal(report.blocked, false, `blocked: ${JSON.stringify(report.findings)}`);
  });
}

test('disclaiming advocacy is not advocacy', () => {
  // This sentence is one of the most useful things the product can say, and a
  // naive "vote for" rule blocks it.
  assert.equal(blocked('We will never tell you who to vote for, and we do not ask your party.'), false);
  assert.equal(blocked('Pollbook does not endorse candidates.'), false);
});

/* ---------------- express advocacy ---------------- */

test('express advocacy naming a candidate is blocked', () => {
  assert.equal(blocked('Vote for Ossoff on November 3.', { candidates: RACE }), true);
  assert.equal(blocked('Help us defeat Greene this November.', { candidates: RACE }), true);
  assert.equal(blocked('Re-elect Ossoff.', { candidates: RACE }), true);
  assert.equal(blocked('Cast your ballot for Greene.', { candidates: RACE }), true);
});

test('express advocacy naming a party is blocked even with no candidate list', () => {
  assert.equal(blocked('Vote for Democrats this fall.'), true);
  assert.equal(blocked('Vote against Republicans.'), true);
});

test('advocacy verbs are flagged even when the target is unknown', () => {
  assert.ok(rules('Stand with us.').includes('express-advocacy'));
});

/* ---------------- fundraising: the brightest line ---------------- */

test('donation links are blocked in the body', () => {
  assert.equal(blocked('Chip in $25: https://secure.actblue.com/donate/x'), true);
  assert.equal(blocked('Support the campaign at winred.com/give'), true);
  assert.equal(blocked('Your gift will be matched. Donate today.'), true);
});

test('a fundraising domain in the sources list is blocked', () => {
  const report = np.lint('The election is Tuesday.', {
    sources: [{ url: 'https://secure.actblue.com/x' }],
  });
  assert.equal(report.blocked, true);
  assert.ok(report.findings.some((f) => f.rule === 'fundraising'));
});

/* ---------------- framing and loaded language ---------------- */

test('partisan framing is blocked', () => {
  for (const text of [
    'The radical left is coming for your ballot.',
    'MAGA extremists are on the ballot.',
    'The deep state runs the election system.',
    'The Democrat Party filed suit.',
  ]) {
    assert.equal(blocked(text), true, `should block: ${text}`);
  }
});

test('a loaded adjective near a candidate name is blocked, alone it warns', () => {
  assert.equal(blocked('Ossoff is a corrupt and dangerous extremist.', { candidates: RACE }), true);

  const bare = lint('The proposal has been called dangerous.');
  assert.equal(bare.blocked, false);
  assert.ok(bare.findings.some((f) => f.rule === 'loaded-language' && f.severity === 'warn'));
});

test('unsourced attribution warns', () => {
  assert.ok(rules('Critics say the bill would restrict access.').includes('unsourced-claim'));
});

/* ---------------- citations ---------------- */

test('a message with no source is blocked', () => {
  const report = np.lint('The election is Tuesday.', { sources: [] });
  assert.equal(report.blocked, true);
  assert.ok(report.findings.some((f) => f.rule === 'no-sources'));
});

test('an http source is blocked, an unfamiliar https domain only warns', () => {
  assert.ok(np.checkSourceUrls([{ url: 'http://vote.gov' }])
    .some((f) => f.rule === 'source-insecure' && f.severity === 'block'));

  const unfamiliar = np.checkSourceUrls([{ url: 'https://the-local-paper.example' }]);
  assert.ok(unfamiliar.some((f) => f.rule === 'source-unrecognized' && f.severity === 'warn'));

  // A local newspaper will never be on a hand-maintained list, and refusing
  // it would push editors toward the handful of national outlets that are.
  assert.equal(np.checkSourceUrls([{ url: 'https://vote.gov' }]).length, 0);
  assert.equal(np.checkSourceUrls([{ url: 'https://www.sos.ga.gov/x' }]).length, 0);
});

/* ---------------- the balance rule ---------------- */

test('qualifying excludes candidates below the one-percent floor', () => {
  const names = np.qualifyingCandidates(RACE).map((c) => c.name);
  assert.deepEqual(names, ['Jon Ossoff', 'Marjorie Greene']);
});

test('an incumbent qualifies regardless of money', () => {
  const names = np.qualifyingCandidates([
    { name: 'A Nobody', incumbent: true, receipts: 0 },
    { name: 'B Rich', receipts: 5_000_000 },
  ]).map((c) => c.name);
  assert.ok(names.includes('A Nobody'));
});

test('naming nobody is fine', () => {
  const result = np.assertBalanced('The Georgia Senate race is on November 3.', RACE);
  assert.equal(result.ok, true);
  assert.equal(result.applies, false);
});

test('naming one qualifying candidate but not the other is blocked', () => {
  const result = np.assertBalanced('Ossoff is on the ballot.', RACE);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.rule === 'balance-incomplete'));
  assert.equal(result.missing[0].name, 'Marjorie Greene');
});

test('naming both in alphabetical order by surname passes', () => {
  const result = np.assertBalanced('Greene and Ossoff are both on the ballot.', RACE);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test('naming both in any other order is blocked', () => {
  // The order check is the part people are surprised by and the part that
  // matters most: putting the front-runner first is a thumb on the scale
  // nobody consciously notices.
  const result = np.assertBalanced('Ossoff and Greene are both on the ballot.', RACE);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.rule === 'balance-order'));
  assert.deepEqual(result.expectedOrder, ['Marjorie Greene', 'Jon Ossoff']);
});

test('the no-hoper need not be named, but may be', () => {
  assert.equal(np.assertBalanced('Greene and Ossoff filed.', RACE).ok, true);
});

test('surnames handle FEC "LAST, FIRST" and suffixes', () => {
  assert.equal(np.surnameOf('OSSOFF, JON'), 'ossoff');
  assert.equal(np.surnameOf('Jon Ossoff'), 'ossoff');
  assert.equal(np.surnameOf('Martin Luther King Jr.'), 'king');
});

/* ---------------- odds framing ---------------- */

test('market prices may not be described as predictions', () => {
  for (const text of [
    'Ossoff is now likely to win.',
    'Forecasters put Greene ahead.',
    'Greene surges in the market.',
    'The market predicts a Democratic hold.',
  ]) {
    assert.equal(np.checkOddsFraming(text).ok, false, `should block: ${text}`);
  }
  assert.equal(np.checkOddsFraming('The market price moved 12 cents this week.').ok, true);
});

/* ---------------- the audience selector ---------------- */

test('a lawful audience is accepted', () => {
  assert.equal(np.checkAudience({
    subjectKeys: ['race:ga-senate-2026'], channels: ['email'],
  }).ok, true);
});

test('an audience naming party or ideology is rejected, not ignored', () => {
  // Rejected rather than silently dropped: a request to target by party
  // should fail loudly rather than appear to work.
  for (const key of ['party', 'ideology', 'partyRegistration', 'voteHistory', 'lean']) {
    const result = np.checkAudience({ stateCodes: ['GA'], [key]: 'x' });
    assert.equal(result.ok, false, `should reject "${key}"`);
    assert.ok(result.errors[0].includes(key));
  }
});

test('there is no "everyone" audience', () => {
  assert.equal(np.checkAudience({ channels: ['email'] }).ok, false);
});

/* ---------------- the issue taxonomy ---------------- */

test('subject-area topic names are accepted', () => {
  for (const name of [
    'Voting access and registration', 'Campaign finance', 'Firearms policy',
    'Reproductive health policy', 'Immigration', 'Redistricting and apportionment',
  ]) {
    assert.equal(np.checkIssueLabel(name).ok, true, `should accept: ${name}`);
  }
});

test('position-coded topic names are rejected', () => {
  for (const name of [
    'Election integrity', 'Ballot security', 'Gun rights', 'Gun control',
    'Pro-life policy', 'Pro-choice policy', 'Amnesty', 'Common-sense reform',
  ]) {
    assert.equal(np.checkIssueLabel(name).ok, false, `should reject: ${name}`);
  }
});

test('the seeded taxonomy passes its own naming rule', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrations', '010_seed_issues.sql'), 'utf8'
  );
  // ('slug', 'Name', 'Description', n)
  const rows = [...sql.matchAll(/\('([a-z-]+)',\s*'([^']+)',\s*'((?:[^']|'')+)'/g)];
  assert.ok(rows.length >= 20, `expected the full taxonomy, found ${rows.length}`);
  for (const [, slug, name, description] of rows) {
    const result = np.checkIssueLabel(name, description.replace(/''/g, "'"));
    assert.equal(result.ok, true,
      `seeded issue "${slug}" (${name}) trips the naming rule: ${result.findings.map((f) => f.text)}`);
  }
});

/* ---------------- the structural guarantee ---------------- */

const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
const schemaSql = fs.readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
  .join('\n');

test('the schema has no column for party, ideology, or vote history', () => {
  // The single most important test in this file. Every other safeguard is a
  // rule somebody could relax; this one is the absence of a place to put the
  // data, which is why the neutrality claim is structurally true rather than
  // promised. Matches column definitions, not prose in comments.
  const columnLines = schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .filter((line) => /^\s{2,}[a-z_]+\s+(text|boolean|integer|smallint|char|varchar|jsonb|numeric)/.test(line));

  const forbidden = /^\s*(party|partisan|ideolog|lean|pvi|vote_history|voted|turnout_score|donor_history|modeled_|propensity|support_score)/;

  for (const line of columnLines) {
    const column = line.trim().split(/\s+/)[0];
    assert.ok(!forbidden.test(column),
      `The schema defines a column named "${column}". Pollbook must not be able to store political ` +
      'affiliation or inferred political attributes — see 001_core.sql.');
  }
});

test('no code references a voter-file or fundraising vendor', () => {
  const vendors = /\b(i360|catalist|targetsmart|aristotle|ngpvan|actblue|winred|deepsync|l2political)\b/i;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

  for (const file of walk(path.join(__dirname, '..', 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    // nonpartisan.js names the fundraising domains precisely in order to
    // block them, which is the opposite of integrating with them.
    if (file.endsWith('nonpartisan.js')) continue;
    const match = vendors.exec(source);
    assert.ok(!match, `${path.relative(process.cwd(), file)} references "${match?.[0]}"`);
  }
});

test('the two-person rule is a database constraint, not an app check', () => {
  assert.ok(/CHECK \(approved_by IS NULL OR approved_by <> created_by\)/.test(schemaSql),
    'broadcasts must carry a CHECK enforcing that the approver is not the author');
});

test('editorial categories cannot be sent without a human', () => {
  assert.ok(/auto_send = false OR category IN \('deadlines', 'product'\)/.test(schemaSql),
    'notification_events must constrain auto_send to logistics categories');
});

test('every message must carry a source', () => {
  const checks = schemaSql.match(/jsonb_array_length\(sources\) >= 1/g) || [];
  assert.ok(checks.length >= 2, 'both broadcasts and notification_events need a sources CHECK');
});

test('the append-only logs refuse UPDATE and DELETE', () => {
  assert.ok(/CREATE TRIGGER audit_log_append_only/.test(schemaSql));
  assert.ok(/CREATE TRIGGER consent_records_append_only/.test(schemaSql));
  assert.ok(/CREATE TRIGGER audit_log_chain/.test(schemaSql));
});

/* ---------------- what the send path guarantees ---------------- */

const TEMPLATE = {
  key: 'test', channel: 'email',
  subject_tpl: 'A reminder for {{stateName}}',
  body_tpl: 'The {{electionName}} is on {{electionDateLong}}. Details: {{registrationUrl}}',
};

const VARS = {
  stateName: 'Georgia',
  electionName: 'Georgia General Election',
  electionDateLong: 'Tuesday, November 3, 2026',
  registrationUrl: 'https://vote.gov/register/ga',
};

const RENDER_OPTS = {
  unsubscribeUrl: 'https://pollbook.test/api/me/unsubscribe/abc',
  preferencesUrl: 'https://pollbook.test/api/me/preferences/abc',
  sources: SOURCES,
};

test('every email carries the unsubscribe, postal address and funding line', () => {
  process.env.MAILING_ADDRESS = 'Nolvek Technologies, 1 Example St, Atlanta GA 30303';
  const out = render.render(TEMPLATE, VARS, RENDER_OPTS);

  assert.ok(out.body.includes('Unsubscribe'), 'unsubscribe link missing');
  assert.ok(out.body.includes('1 Example St'), 'CAN-SPAM postal address missing');
  assert.ok(out.body.includes('Nolvek Technologies'), 'funding line missing');
  assert.ok(out.body.includes('not authorized by any candidate'), 'disclaimer missing');

  // RFC 8058: Gmail and Yahoo require both headers from bulk senders.
  assert.equal(out.headers['List-Unsubscribe'], '<https://pollbook.test/api/me/unsubscribe/abc>');
  assert.equal(out.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('an SMS always carries the opt-out, and is not doubled up', () => {
  const once = render.render(
    { key: 't', channel: 'sms', body_tpl: 'The {{electionName}} is tomorrow.' },
    VARS, { ...RENDER_OPTS, channel: 'sms' }
  );
  assert.ok(/Reply STOP to opt out/.test(once.body));

  const already = render.render(
    { key: 't', channel: 'sms', body_tpl: 'Vote tomorrow. Reply STOP to opt out.' },
    VARS, { ...RENDER_OPTS, channel: 'sms' }
  );
  assert.equal((already.body.match(/Reply STOP/g) || []).length, 1);
});

test('a template variable that is missing fails loudly rather than rendering blank', () => {
  assert.throws(
    () => render.render(TEMPLATE, { stateName: 'Georgia' }, RENDER_OPTS),
    /missing values for/
  );
});

test('a template may not reference a variable outside the allowlist', () => {
  assert.throws(
    () => render.render({ key: 't', channel: 'email', body_tpl: 'Hello {{secretToken}}' }, {}, RENDER_OPTS),
    /not an allowed variable/
  );
});

test('rendering refuses copy that fails the linter', () => {
  // The last gate: copy can change between approval and send, so the check
  // runs on the finished bytes every time.
  assert.throws(
    () => render.render(
      { key: 't', channel: 'email', body_tpl: 'Vote for Ossoff on {{electionDateLong}}.' },
      VARS, { ...RENDER_OPTS, candidates: RACE }
    ),
    /Refusing to send/
  );
});

test('a message cannot be rendered without an unsubscribe link', () => {
  assert.throws(() => render.render(TEMPLATE, VARS, { sources: SOURCES }), /unsubscribe/i);
});

test('SMS segment counting notices the unicode cliff', () => {
  const ascii = render.smsSegments('a'.repeat(160));
  assert.equal(ascii.segments, 1);
  assert.equal(ascii.encoding, 'GSM-7');

  // One curly apostrophe forces UCS-2 and more than doubles the cost.
  const unicode = render.smsSegments(`${'a'.repeat(100)}’`);
  assert.equal(unicode.encoding, 'UCS-2');
  assert.ok(unicode.segments > 1);
});

/* ---------------- data retention ---------------- */

test('every table holding personal data is either aged out or kept on purpose', () => {
  const covered = new Set([
    ...retention.POLICY.map((r) => r.table),
    ...Object.keys(retention.RETAINED),
  ]);

  const PII_TABLES = [
    'users', 'user_identities', 'sessions', 'login_tokens', 'auth_transactions',
    'auth_attempts', 'contact_channels', 'consent_records', 'suppressions',
    'webhook_events', 'outbox', 'deliveries', 'audit_log',
  ];

  for (const table of PII_TABLES) {
    assert.ok(covered.has(table),
      `${table} holds personal data but appears in neither the retention policy nor the ` +
      'documented list of things kept deliberately. Add it to one.');
  }
});

test('the evidence tables are kept rather than aged out', () => {
  const aged = new Set(retention.POLICY.map((r) => r.table));
  assert.ok(!aged.has('consent_records'), 'consent records are the TCPA evidence — never deleted');
  assert.ok(!aged.has('audit_log'), 'an audit log with a delete job is not an audit log');
  assert.ok(!aged.has('suppressions'), 'a suppression must outlive everything else about a person');
});

console.log(`nonpartisan: ${passed} passed`);

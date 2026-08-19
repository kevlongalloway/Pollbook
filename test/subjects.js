/**
 * The subject-key grammar.
 *
 * Races and elections are derived strings with no table, and once they can be
 * stored they are also user input arriving on a URL. These tests are the
 * boundary: everything the grammar accepts reaches the database, and
 * everything it rejects does not.
 *
 * The rollover cases matter as much as the rejection cases. A key that embeds
 * a cycle year expires, and getting that wrong means either silently moving
 * somebody's subscription onto a different contest or silently dropping it.
 *
 * Run: node test/subjects.js
 */

process.env.CACHE_PERSIST = '0';

const assert = require('node:assert');
const s = require('../src/lib/subjects');

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

/* ---------------- what the providers actually emit ---------------- */

test('the keys liveProvider and calendar produce all parse', () => {
  // These exact shapes come from buildRaces() and calendar.js. If either
  // changes shape, this is the test that should fail.
  const cases = {
    'election:ga-primary-2026': { type: 'election', stateCode: 'GA', cycle: 2026 },
    'election:ga-general-2026': { type: 'election', stateCode: 'GA', cycle: 2026 },
    'election:us-general-2026': { type: 'election', stateCode: null, cycle: 2026 },
    'race:ga-senate-2026': { type: 'race', stateCode: 'GA', cycle: 2026, seatKey: 'seat:ga-senate' },
    'race:ga-governor-2026': { type: 'race', stateCode: 'GA', cycle: 2026, seatKey: 'seat:ga-governor' },
    'race:ga-house-04-2026': { type: 'race', stateCode: 'GA', cycle: 2026, seatKey: 'seat:ga-house-04' },
  };

  for (const [key, expected] of Object.entries(cases)) {
    const parsed = s.parseSubjectKey(key);
    assert.ok(parsed, `${key} should parse`);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(parsed[field], value, `${key}.${field}`);
    }
    assert.equal(parsed.canonical, key);
  }
});

test('at-large districts are 00 and are real', () => {
  // Seven states elect a single at-large representative, which the FEC codes
  // as district 00. Rejecting it would make those states untrackable.
  const parsed = s.parseSubjectKey('race:wy-house-00-2026');
  assert.ok(parsed);
  assert.equal(parsed.district, '00');
  assert.equal(parsed.seatKey, 'seat:wy-house-00');
});

test('candidate, committee, bill, state and issue keys parse', () => {
  assert.ok(s.parseSubjectKey('candidate:H8GA05123'));
  assert.ok(s.parseSubjectKey('committee:C00401224'));
  assert.ok(s.parseSubjectKey('bill:119-hr-22'));
  assert.ok(s.parseSubjectKey('bill:119-sjres-2'));
  assert.ok(s.parseSubjectKey('state:GA'));
  assert.ok(s.parseSubjectKey('issue:voting-access'));
});

/* ---------------- what must be refused ---------------- */

const REJECT = {
  'race:ga-house-4-2026': 'district must be two digits — the FEC pads it',
  'race:ga-house-99-2026': 'no state has 99 districts',
  'race:zz-senate-2026': 'ZZ is not a state',
  'race:ga-senate-2027': 'federal cycles are even years',
  'race:ga-senate-1990': 'far outside the plausible window',
  'race:ga-senate-2099': 'far outside the plausible window',
  'race:ga-mayor-2026': 'not an office the FEC covers',
  'state:ZZ': 'not a state',
  'state:ga': 'state codes are upper case',
  'issue:Voting-Access': 'slugs are lower case',
  'bill:119-zz-22': 'not a bill type Congress recognises',
  'bill:999-hr-22': 'congress number out of range',
  'election:us-primary-2026': 'there is no national primary',
  'nonsense:ga-senate-2026': 'unknown namespace',
  'ga-senate-2026': 'no namespace at all',
  '../../etc/passwd': 'path traversal',
  'race:ga-senate-2026; DROP TABLE users': 'injection attempt',
  '': 'empty',
  ':': 'empty parts',
  'race:': 'empty remainder',
};

for (const [key, why] of Object.entries(REJECT)) {
  test(`rejected — ${key || '(empty)'}: ${why}`, () => {
    assert.equal(s.parseSubjectKey(key), null);
  });
}

test('an absurdly long key is refused before anything else looks at it', () => {
  assert.equal(s.parseSubjectKey(`race:${'a'.repeat(500)}`), null);
});

test('non-string input is refused rather than coerced', () => {
  for (const value of [null, undefined, 0, {}, [], true]) {
    assert.equal(s.parseSubjectKey(value), null, `should reject ${JSON.stringify(value)}`);
  }
});

/* ---------------- seats and rollover ---------------- */

test('every race yields a cycle-free seat', () => {
  assert.equal(s.seatKeyFor('race:ga-senate-2026'), 'seat:ga-senate');
  assert.equal(s.seatKeyFor('race:ga-house-04-2026'), 'seat:ga-house-04');
  // Elections belong to no seat: they are a date, not a contest.
  assert.equal(s.seatKeyFor('election:ga-general-2026'), null);
  assert.equal(s.seatKeyFor('seat:ga-senate'), null);
});

test('a seat resolves to the same contest in a later cycle', () => {
  // This is what carries a subscriber across an election without either
  // dropping them or silently re-pointing them at a different race.
  assert.equal(s.raceKeyForCycle('seat:ga-senate', 2028), 'race:ga-senate-2028');
  assert.equal(s.raceKeyForCycle('seat:ga-house-04', 2028), 'race:ga-house-04-2028');
});

test('rollover refuses an odd year or a non-seat', () => {
  assert.equal(s.raceKeyForCycle('seat:ga-senate', 2027), null);
  assert.equal(s.raceKeyForCycle('race:ga-senate-2026', 2028), null);
});

test('a rolled-over key parses back into the same seat', () => {
  const next = s.raceKeyForCycle('seat:ga-house-04', 2028);
  assert.equal(s.parseSubjectKey(next).seatKey, 'seat:ga-house-04');
});

/* ---------------- the seam with the existing API ---------------- */

test('bare ids from the existing API map onto namespaced keys', () => {
  // The frontend and /api/elections deal in unprefixed ids and changing that
  // would break every existing link, so this is the translation layer.
  assert.equal(s.fromLegacyId('ga-senate-2026'), 'race:ga-senate-2026');
  assert.equal(s.fromLegacyId('ga-general-2026'), 'election:ga-general-2026');
  assert.equal(s.fromLegacyId('us-general-2026'), 'election:us-general-2026');
  assert.equal(s.fromLegacyId('H8GA05123'), 'candidate:H8GA05123');
  assert.equal(s.fromLegacyId('C00401224'), 'committee:C00401224');
});

test('a hint disambiguates, and a bad id still fails', () => {
  assert.equal(s.fromLegacyId('ga-senate-2026', 'race'), 'race:ga-senate-2026');
  assert.equal(s.fromLegacyId('ga-senate-2026', 'election'), null);
  assert.equal(s.fromLegacyId('not-a-thing'), null);
  assert.equal(s.fromLegacyId(''), null);
});

test('an already-namespaced key passes through validation, not around it', () => {
  assert.equal(s.fromLegacyId('race:ga-senate-2026'), 'race:ga-senate-2026');
  assert.equal(s.fromLegacyId('race:zz-senate-2026'), null);
});

test('toLegacyId round-trips', () => {
  assert.equal(s.toLegacyId('race:ga-senate-2026'), 'ga-senate-2026');
  assert.equal(s.toLegacyId('election:us-general-2026'), 'us-general-2026');
});

/* ---------------- the helpers ---------------- */

test('cycle plausibility', () => {
  const thisYear = new Date().getUTCFullYear();
  assert.equal(s.plausibleCycle(2026), true);
  assert.equal(s.plausibleCycle(2027), false, 'odd years are not federal cycles');
  assert.equal(s.plausibleCycle(1998), false, 'before the window');
  assert.equal(s.plausibleCycle(thisYear + 20), false, 'too far ahead');
});

test('district plausibility', () => {
  assert.equal(s.plausibleDistrict('00'), true, 'at-large');
  assert.equal(s.plausibleDistrict('52'), true, "California's current count");
  assert.equal(s.plausibleDistrict('61'), false);
});

console.log(`subjects: ${passed} passed`);

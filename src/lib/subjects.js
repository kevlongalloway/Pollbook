/**
 * The grammar for everything a person can follow.
 *
 * Pollbook has no table of races or elections. They are strings, derived per
 * request by lib/calendar.js and liveProvider.buildRaces(): `ga-senate-2026`,
 * `ga-general-2026`, `ga-house-04-2026`. Once subscriptions exist, those
 * strings arrive from a URL and get stored, which raises three problems this
 * module answers.
 *
 * **They are untrusted input.** A subscription key reaches the database and
 * later reaches a fanout query. So it is validated by shape before it is
 * stored — the same discipline `billParams()` in routes/api.js applies to bill
 * coordinates, and for the same reason: cheap, total, and it does not need the
 * network to be up.
 *
 * **They expire.** Every race key embeds a cycle year, so somebody who follows
 * `race:ga-senate-2026` hears nothing in 2028. Each race key therefore also
 * yields a cycle-free **seat** key, `seat:ga-senate`, and following a race
 * creates a standing subscription to its seat as well. The seat is the durable
 * thing; the race key is a view onto one cycle of it. That is what carries a
 * subscriber across an election without anybody having to re-opt-in, and
 * without us silently re-pointing their subscription at a different contest.
 *
 * **They come and go.** buildRaces only emits a Senate race when the FEC
 * returned candidates, so an upstream outage makes a key vanish and reappear.
 * Nothing here deletes on absence; the reconcile job marks a key unresolved
 * and the label snapshot keeps the page rendering meanwhile.
 */

const { getState } = require('../data/usStates');
const { BILL_TYPES } = require('../sources/congress');

const TYPES = ['election', 'race', 'seat', 'candidate', 'committee', 'bill', 'state', 'issue'];

// Offices that are a single statewide seat, versus the districted one.
const STATEWIDE_OFFICES = ['senate', 'governor'];

const RE = {
  // ga-primary-2026 | ga-general-2026 | us-general-2026
  election: /^([a-z]{2})-(primary|general)-(\d{4})$/,
  // ga-senate-2026 | ga-governor-2026 | ga-house-04-2026
  raceStatewide: /^([a-z]{2})-(senate|governor)-(\d{4})$/,
  raceHouse: /^([a-z]{2})-house-(\d{2})-(\d{4})$/,
  seatStatewide: /^([a-z]{2})-(senate|governor)$/,
  seatHouse: /^([a-z]{2})-house-(\d{2})$/,
  // FEC candidate IDs: office letter then 8 alphanumerics.
  candidate: /^[HSP][0-9A-Z]{8}$/,
  committee: /^C\d{8}$/,
  bill: /^(\d{1,3})-([a-z]{1,7})-(\d{1,5})$/,
  state: /^[A-Z]{2}$/,
  issue: /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/,
};

const isRealState = (code) => Boolean(getState(String(code || '').toUpperCase()));

// `us` is not a state but is a legitimate scope for the national election and
// for balance-of-power seats.
const isStateOrNation = (code) => code === 'us' || isRealState(code);

/**
 * Parse a namespaced subject key, or return null.
 *
 * Returns `{ type, canonical, stateCode, cycle, seatKey, office, district }`.
 * Anything malformed, out of range, or naming a state that does not exist
 * returns null — callers treat null as "reject the request", never as
 * "store it and find out later".
 */
function parseSubjectKey(input) {
  const raw = String(input ?? '');
  if (raw.length > 96) return null;

  const colon = raw.indexOf(':');
  if (colon === -1) return null;

  const type = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  if (!TYPES.includes(type) || !rest) return null;

  const base = { type, canonical: `${type}:${rest}` };

  if (type === 'election') {
    const m = RE.election.exec(rest);
    if (!m) return null;
    const [, st, kind, year] = m;
    if (!isStateOrNation(st)) return null;
    if (!plausibleCycle(year)) return null;
    // The national election is only ever a general.
    if (st === 'us' && kind !== 'general') return null;
    return { ...base, stateCode: st === 'us' ? null : st.toUpperCase(), cycle: Number(year), kind };
  }

  if (type === 'race') {
    const statewide = RE.raceStatewide.exec(rest);
    if (statewide) {
      const [, st, office, year] = statewide;
      if (!isRealState(st) || !plausibleCycle(year)) return null;
      return {
        ...base,
        stateCode: st.toUpperCase(),
        cycle: Number(year),
        office,
        district: null,
        seatKey: `seat:${st}-${office}`,
      };
    }
    const house = RE.raceHouse.exec(rest);
    if (house) {
      const [, st, district, year] = house;
      if (!isRealState(st) || !plausibleCycle(year) || !plausibleDistrict(district)) return null;
      return {
        ...base,
        stateCode: st.toUpperCase(),
        cycle: Number(year),
        office: 'house',
        district,
        seatKey: `seat:${st}-house-${district}`,
      };
    }
    return null;
  }

  if (type === 'seat') {
    const statewide = RE.seatStatewide.exec(rest);
    if (statewide) {
      const [, st, office] = statewide;
      if (!isRealState(st)) return null;
      return { ...base, stateCode: st.toUpperCase(), cycle: null, office, district: null };
    }
    const house = RE.seatHouse.exec(rest);
    if (house) {
      const [, st, district] = house;
      if (!isRealState(st) || !plausibleDistrict(district)) return null;
      return { ...base, stateCode: st.toUpperCase(), cycle: null, office: 'house', district };
    }
    return null;
  }

  if (type === 'candidate') {
    if (!RE.candidate.test(rest)) return null;
    return { ...base, stateCode: null, cycle: null };
  }

  if (type === 'committee') {
    if (!RE.committee.test(rest)) return null;
    return { ...base, stateCode: null, cycle: null };
  }

  if (type === 'bill') {
    const m = RE.bill.exec(rest);
    if (!m) return null;
    const [, congress, billType, number] = m;
    if (!BILL_TYPES.includes(billType)) return null;
    const c = Number(congress);
    if (!Number.isInteger(c) || c < 1 || c > 200) return null;
    return { ...base, stateCode: null, cycle: null, congress: c, billType, number };
  }

  if (type === 'state') {
    if (!RE.state.test(rest) || !isRealState(rest)) return null;
    return { ...base, stateCode: rest, cycle: null };
  }

  if (type === 'issue') {
    if (!RE.issue.test(rest)) return null;
    return { ...base, stateCode: null, cycle: null, slug: rest };
  }

  return null;
}

/**
 * Cycle sanity. Federal elections are even years, and a key far outside the
 * plausible window is a typo or an attack rather than somebody planning ahead.
 */
function plausibleCycle(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y % 2 !== 0) return false;
  const now = new Date().getUTCFullYear();
  return y >= 2000 && y <= now + 12;
}

/**
 * District numbers, two digits.
 *
 * `00` is at-large and real — seven states have exactly one representative and
 * the FEC codes that district as 00, which `fec.districtLabel()` renders as
 * "At-Large". California's 52 is the current ceiling; 60 leaves room for
 * reapportionment without letting `99` through.
 */
function plausibleDistrict(d) {
  const n = Number(d);
  return Number.isInteger(n) && n >= 0 && n <= 60;
}

/** The cycle-free seat a race belongs to, or null for keys that have no seat. */
function seatKeyFor(key) {
  const parsed = parseSubjectKey(key);
  return parsed?.seatKey || null;
}

/**
 * The same seat in a different cycle.
 *
 * Used when a race concludes: we can offer the subscriber the next cycle's
 * contest by name instead of silently moving them onto it.
 */
function raceKeyForCycle(seatKey, cycle) {
  const parsed = parseSubjectKey(seatKey);
  if (!parsed || parsed.type !== 'seat') return null;
  if (!plausibleCycle(cycle)) return null;
  const st = parsed.stateCode.toLowerCase();
  return parsed.office === 'house'
    ? `race:${st}-house-${parsed.district}-${cycle}`
    : `race:${st}-${parsed.office}-${cycle}`;
}

/**
 * Turn a bare ID from the existing API into a namespaced key.
 *
 * The frontend and the election API deal in `ga-senate-2026` with no prefix,
 * because that is what liveProvider emits and changing it would break every
 * existing link. This is the seam between the two vocabularies.
 */
function fromLegacyId(id, hint) {
  const raw = String(id || '');
  if (!raw) return null;
  if (raw.includes(':')) return parseSubjectKey(raw)?.canonical || null;

  const candidates = hint
    ? [`${hint}:${raw}`]
    : [`election:${raw}`, `race:${raw}`, `candidate:${raw}`, `committee:${raw}`, `state:${raw}`];

  for (const attempt of candidates) {
    const parsed = parseSubjectKey(attempt);
    if (parsed) return parsed.canonical;
  }
  return null;
}

/** The bare ID the existing API and frontend use, stripped of its namespace. */
const toLegacyId = (key) => String(key || '').slice(String(key || '').indexOf(':') + 1);

module.exports = {
  parseSubjectKey,
  seatKeyFor,
  raceKeyForCycle,
  fromLegacyId,
  toLegacyId,
  plausibleCycle,
  plausibleDistrict,
  SUBJECT_TYPES: TYPES,
  STATEWIDE_OFFICES,
};

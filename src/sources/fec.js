/**
 * Federal Election Commission — OpenFEC API (https://api.open.fec.gov).
 *
 * The authoritative, continuously-updated list of who has filed to run for
 * President, U.S. Senate, and U.S. House, plus campaign-finance totals.
 * Works out of the box with the shared DEMO_KEY (30 req/hour); set
 * FEC_API_KEY (free, instant, https://api.open.fec.gov/developers/) for
 * real rate limits. State-level offices (governor etc.) are not in FEC data.
 */

const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');

const BASE = 'https://api.open.fec.gov/v1';
const KEY = () => process.env.FEC_API_KEY || 'DEMO_KEY';

const HOUR = 3600 * 1000;

function url(path, params = {}) {
  const q = new URLSearchParams({ api_key: KEY(), ...params });
  return `${BASE}${path}?${q}`;
}

async function fetchAllPages(path, params, maxPages = 3) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchJson(url(path, { ...params, per_page: 100, page }));
    results.push(...(data.results || []));
    if (!data.pagination || page >= (data.pagination.pages || 1)) break;
  }
  return results;
}

/* ---------------- normalizers ---------------- */

const PARTY_MAP = {
  DEM: 'DEM', REP: 'REP', LIB: 'LIB', GRE: 'GRN', GRN: 'GRN', IND: 'IND',
  DFL: 'DEM', NPA: 'IND', NNE: 'IND', UNK: 'OTH', NON: 'NP', CON: 'OTH',
  OTH: 'OTH', W: 'OTH', PAF: 'OTH', SWP: 'OTH',
};

const mapParty = (code) => PARTY_MAP[String(code || '').toUpperCase()] || 'OTH';

const titleCase = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
    // Keep common name particles and suffixes tidy.
    .replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase())
    .replace(/\bMc([a-z])/g, (m, c) => `Mc${c.toUpperCase()}`);

/** FEC names arrive as "LAST, FIRST MIDDLE (NICK)" — flip to display order. */
function displayName(fecName) {
  const raw = String(fecName || '').trim();
  const comma = raw.indexOf(',');
  if (comma === -1) return titleCase(raw);
  const last = raw.slice(0, comma).trim();
  let rest = raw.slice(comma + 1).trim();
  // Prefer the nickname when one is given: "THOMAS JONATHAN (JON)" → "Jon".
  const nick = rest.match(/\(([^)]+)\)/);
  if (nick) rest = nick[1].trim();
  // Drop trailing suffixes from the given-name side ("JR", "SR", roman numerals).
  rest = rest.replace(/\b(JR\.?|SR\.?|II|III|IV)\b\.?$/i, '').trim();
  return titleCase(`${rest} ${last}`.replace(/\s+/g, ' ').trim());
}

const districtLabel = (d) => {
  const n = Number(d);
  return !n ? 'At-Large' : `District ${n}`;
};

function candidateSummary(r) {
  return {
    id: r.candidate_id,
    name: displayName(r.name),
    party: mapParty(r.party),
    partyFull: r.party_full || null,
    incumbent: r.incumbent_challenge === 'I',
    office: r.office,
    district: r.district || null,
    receipts: typeof r.receipts === 'number' ? Math.round(r.receipts) : null,
  };
}

/* ---------------- queries ---------------- */

/**
 * All candidates in a state's races for a cycle, with finance totals.
 * office: 'S' | 'H' | 'P'
 */
async function raceCandidates(stateCode, office, year) {
  return cached(`fec:race:${stateCode}:${office}:${year}`, 6 * HOUR, async () => {
    const rows = await fetchAllPages('/candidates/totals/', {
      state: stateCode,
      office,
      election_year: year,
      is_active_candidate: 'true',
      sort: '-receipts',
    });
    return rows.map(candidateSummary);
  });
}

async function candidateById(id) {
  return cached(`fec:cand:${id}`, 6 * HOUR, async () => {
    const data = await fetchJson(url(`/candidate/${encodeURIComponent(id)}/`, {}));
    const r = (data.results || [])[0];
    if (!r) return null;
    return {
      id: r.candidate_id,
      name: displayName(r.name),
      rawName: r.name,
      party: mapParty(r.party),
      partyFull: r.party_full || null,
      office: r.office,
      officeFull: r.office_full || null,
      state: r.state,
      district: r.district || null,
      incumbent: r.incumbent_challenge === 'I',
      electionYears: r.election_years || [],
      firstFileDate: r.first_file_date || null,
    };
  });
}

async function candidateFinance(id) {
  return cached(`fec:fin:${id}`, 6 * HOUR, async () => {
    const data = await fetchJson(url(`/candidate/${encodeURIComponent(id)}/totals/`, {
      sort: '-cycle', per_page: 1,
    }));
    const r = (data.results || [])[0];
    if (!r) return null;
    return {
      cycle: r.cycle,
      receipts: Math.round(r.receipts || 0),
      disbursements: Math.round(r.disbursements || 0),
      cashOnHand: Math.round(r.last_cash_on_hand_end_period || 0),
      coverageEnd: r.coverage_end_date ? String(r.coverage_end_date).slice(0, 10) : null,
    };
  });
}

async function searchCandidates(q, { limit = 20 } = {}) {
  const query = String(q || '').trim();
  if (!query) return [];
  return cached(`fec:search:${query.toLowerCase()}:${limit}`, HOUR, async () => {
    const data = await fetchJson(url('/candidates/search/', {
      q: query, per_page: limit, sort: '-first_file_date',
    }));
    return (data.results || []).map((r) => ({
      id: r.candidate_id,
      name: displayName(r.name),
      party: mapParty(r.party),
      partyFull: r.party_full || null,
      office: r.office,
      officeFull: r.office_full || null,
      state: r.state,
      district: r.district || null,
      incumbent: r.incumbent_challenge === 'I',
      electionYears: r.election_years || [],
    }));
  });
}

/** Top fundraisers for the Data view — statewide or national. */
async function topFundraisers({ state, cycle, limit = 12 } = {}) {
  const key = `fec:top:${state || 'US'}:${cycle}:${limit}`;
  return cached(key, 6 * HOUR, async () => {
    const params = {
      election_year: cycle,
      sort: '-receipts',
      per_page: limit,
      is_active_candidate: 'true',
    };
    if (state) params.state = state;
    const data = await fetchJson(url('/candidates/totals/', params));
    return {
      total: data.pagination ? data.pagination.count : null,
      candidates: (data.results || []).map(candidateSummary),
    };
  });
}

module.exports = {
  raceCandidates,
  candidateById,
  candidateFinance,
  searchCandidates,
  topFundraisers,
  displayName,
  mapParty,
  districtLabel,
};

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

// FEC_API_BASE is overridable so the pagination logic can be exercised
// against a local stub in tests.
const BASE = () => process.env.FEC_API_BASE || 'https://api.open.fec.gov/v1';
const KEY = () => process.env.FEC_API_KEY || 'DEMO_KEY';

const HOUR = 3600 * 1000;

function url(path, params = {}) {
  const q = new URLSearchParams({ api_key: KEY(), ...params });
  return `${BASE()}${path}?${q}`;
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

/**
 * Itemized Schedule A receipts, walked with keyset pagination.
 *
 * The FEC rejects deep `page=N` paging on the itemized schedules — you must
 * pass back the `pagination.last_indexes` object from the previous response.
 * Aggregating a single page (as an earlier version did) produces a
 * meaningless slice: PAC contributions cluster at the legal maximum, so the
 * "top 100 by amount" is an arbitrary subset of same-sized checks.
 */
async function fetchScheduleA(params, { maxPages = 12, perPage = 100 } = {}) {
  const rows = [];
  let cursor = {};
  for (let i = 0; i < maxPages; i++) {
    const data = await fetchJson(url('/schedules/schedule_a/', {
      ...params, per_page: perPage, ...cursor,
    }), { timeoutMs: 15000 });
    const results = data.results || [];
    rows.push(...results);
    const next = data.pagination && data.pagination.last_indexes;
    if (!next || results.length < perPage) break;
    cursor = next;
  }
  return rows;
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
    const num = (v) => (typeof v === 'number' ? Math.round(v) : null);
    return {
      cycle: r.cycle,
      receipts: Math.round(r.receipts || 0),
      disbursements: Math.round(r.disbursements || 0),
      cashOnHand: Math.round(r.last_cash_on_hand_end_period || 0),
      coverageEnd: r.coverage_end_date ? String(r.coverage_end_date).slice(0, 10) : null,
      // Money mix — who the campaign's own money comes from.
      fromIndividuals: num((r.individual_itemized_contributions || 0) + (r.individual_unitemized_contributions || 0)),
      fromPacs: num(r.other_political_committee_contributions),
      fromParty: num(r.political_party_committee_contributions),
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

/* ---------------- committees (PACs, super PACs, party committees) ---------------- */

const COMMITTEE_TYPE_LABELS = {
  O: 'Super PAC', U: 'Super PAC (single candidate)', V: 'Hybrid PAC', W: 'Hybrid PAC',
  Q: 'PAC', N: 'PAC', H: 'Candidate committee (House)', S: 'Candidate committee (Senate)',
  P: 'Candidate committee (Presidential)', X: 'Party committee', Y: 'Party committee',
  Z: 'Party committee (national)', D: 'Delegate committee', I: 'Independent spender',
  E: 'Electioneering', C: 'Communication cost',
};

const committeeTypeLabel = (t) => COMMITTEE_TYPE_LABELS[t] || 'Committee';

function committeeSummary(r) {
  return {
    id: r.committee_id,
    name: titleCase(r.name),
    type: r.committee_type || null,
    typeLabel: committeeTypeLabel(r.committee_type),
    designation: r.designation_full || null,
    party: r.party_full || null,
    state: r.state || null,
  };
}

async function searchCommitteesByName(term, { limit = 12 } = {}) {
  return cached(`fec:cmte-search:${term.toLowerCase()}:${limit}`, 6 * HOUR, async () => {
    const data = await fetchJson(url('/committees/', { q: term, per_page: limit }));
    return (data.results || []).map(committeeSummary);
  });
}

async function committeeById(id) {
  return cached(`fec:cmte:${id}`, 6 * HOUR, async () => {
    const data = await fetchJson(url(`/committee/${encodeURIComponent(id)}/`, {}));
    const r = (data.results || [])[0];
    return r ? committeeSummary(r) : null;
  });
}

async function committeeTotals(id) {
  return cached(`fec:cmte-totals:${id}`, 6 * HOUR, async () => {
    const data = await fetchJson(url(`/committee/${encodeURIComponent(id)}/totals/`, {
      sort: '-cycle', per_page: 1,
    }));
    const r = (data.results || [])[0];
    if (!r) return null;
    return {
      cycle: r.cycle,
      receipts: Math.round(r.receipts || 0),
      disbursements: Math.round(r.disbursements || 0),
      independentExpenditures: Math.round(r.independent_expenditures || 0),
      contributionsToCandidates: Math.round(r.contributions || 0),
    };
  });
}

const mapIndependentRow = (r) => ({
  committeeId: r.committee_id || null,
  committee: titleCase(r.committee_name || ''),
  candidateId: r.candidate_id || null,
  candidate: displayName(r.candidate_name || ''),
  support: r.support_oppose_indicator === 'S',
  total: Math.round(r.total || 0),
});

/** Independent expenditures (super-PAC money) about one candidate. */
async function candidateIndependentSpending(candidateId, cycle) {
  return cached(`fec:ie-cand:${candidateId}:${cycle}`, 6 * HOUR, async () => {
    const data = await fetchJson(url('/schedules/schedule_e/by_candidate/', {
      candidate_id: candidateId, cycle, per_page: 50,
    }));
    return (data.results || []).map(mapIndependentRow)
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
  });
}

/** Every candidate a committee has spent independently for or against. */
async function committeeIndependentSpending(committeeId, cycle) {
  return cached(`fec:ie-cmte:${committeeId}:${cycle}`, 6 * HOUR, async () => {
    const rows = await fetchAllPages('/schedules/schedule_e/by_candidate/', {
      committee_id: committeeId, cycle,
    }, 2);
    return rows.map(mapIndependentRow)
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
  });
}

/** Aggregate itemized Schedule A rows by contributor (pure — unit tested). */
function aggregateContributors(rows, { limit = 10 } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    const amount = r.contribution_receipt_amount;
    if (!(amount > 0)) continue; // skip refunds/negatives
    const name = titleCase(r.contributor_name || 'Unknown');
    const id = r.contributor_id || null;
    const key = id || name.toLowerCase();
    const entry = byKey.get(key) || { name, committeeId: id, total: 0, count: 0 };
    entry.total += amount;
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((e) => ({ ...e, total: Math.round(e.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** Aggregate itemized Schedule A rows by recipient committee (pure). */
function aggregateRecipients(rows, { limit = 12 } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    const amount = r.contribution_receipt_amount;
    if (!(amount > 0)) continue;
    const cmte = r.committee || {};
    const name = titleCase(cmte.name || 'Unknown recipient');
    const key = cmte.committee_id || name.toLowerCase();
    const entry = byKey.get(key) || { name, committeeId: cmte.committee_id || null, total: 0, count: 0 };
    entry.total += amount;
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((e) => ({ ...e, total: Math.round(e.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** A candidate's principal campaign committee id. */
async function principalCommitteeId(candidateId) {
  return cached(`fec:pcc:${candidateId}`, 6 * HOUR, async () => {
    const data = await fetchJson(url(`/candidate/${encodeURIComponent(candidateId)}/committees/`, { per_page: 20 }));
    const committees = data.results || [];
    const principal = committees.find((c) => c.designation === 'P') || committees[0];
    return principal ? principal.committee_id : null;
  });
}

/**
 * Every PAC/committee contribution to a candidate's campaign, fully
 * paginated and aggregated per contributing committee.
 */
async function candidatePacContributions(candidateId, cycle) {
  return cached(`fec:pacs-cand:${candidateId}:${cycle}`, 6 * HOUR, async () => {
    const committeeId = await principalCommitteeId(candidateId);
    if (!committeeId) return [];
    const rows = await fetchScheduleA({
      committee_id: committeeId,
      two_year_transaction_period: cycle,
      is_individual: 'false',
      sort: '-contribution_receipt_amount',
    });
    return aggregateContributors(rows, { limit: 15 });
  });
}

/**
 * Money grouped by the donor's employer — the FEC's own aggregate endpoint.
 *
 * This is the highest-signal "which organizations are behind this candidate"
 * view available without a paid data vendor: PAC checks are capped at $5k and
 * look identical across candidates, but employer totals (individuals giving
 * as employees/members of an organization) vary enormously and are exactly
 * what "industry X funds this candidate" reporting is built on.
 */
async function candidateEmployerMoney(candidateId, cycle) {
  return cached(`fec:employers:${candidateId}:${cycle}`, 6 * HOUR, async () => {
    const committeeId = await principalCommitteeId(candidateId);
    if (!committeeId) return [];
    const data = await fetchJson(url('/schedules/schedule_a/by_employer/', {
      committee_id: committeeId, cycle, sort: '-total', per_page: 15,
    }));
    return (data.results || [])
      .filter((r) => r.employer && !/^(none|n\/a|not employed|retired|self|self employed|self-employed|information requested)$/i.test(r.employer.trim()))
      .map((r) => ({ employer: titleCase(r.employer), total: Math.round(r.total || 0), count: r.count || null }))
      .filter((r) => r.total > 0)
      .slice(0, 10);
  });
}

/** Contribution-size profile: small-dollar base vs. max-out donors. */
async function candidateDonorSizes(candidateId, cycle) {
  return cached(`fec:sizes:${candidateId}:${cycle}`, 6 * HOUR, async () => {
    const committeeId = await principalCommitteeId(candidateId);
    if (!committeeId) return [];
    const data = await fetchJson(url('/schedules/schedule_a/by_size/', {
      committee_id: committeeId, cycle,
    }));
    const LABELS = {
      0: 'Under $200', 200: '$200–$499', 500: '$500–$999',
      1000: '$1,000–$1,999', 2000: '$2,000 and up',
    };
    return (data.results || [])
      .map((r) => ({ size: r.size, label: LABELS[r.size] || `$${r.size}+`, total: Math.round(r.total || 0) }))
      .filter((r) => r.total > 0)
      .sort((a, b) => a.size - b.size);
  });
}

/**
 * Aggregate earmarked/bundled contributions by the conduit that routed them
 * (pure — unit tested).
 *
 * This is how organizations like AIPAC move most of their money: not as a
 * PAC check, but by bundling individual donations earmarked through the
 * organization as a conduit. On the recipient's filings these arrive as
 * individual contributions carrying the conduit's name in the memo text or
 * `donor_committee_name`, so a plain PAC-contribution view misses them
 * entirely.
 */
function aggregateEarmarks(rows, { limit = 10 } = {}) {
  const byConduit = new Map();
  for (const r of rows) {
    const amount = r.contribution_receipt_amount;
    if (!(amount > 0)) continue;
    const memo = String(r.memo_text || '');
    const viaCommittee = r.donor_committee_name ? String(r.donor_committee_name) : '';
    // Only count rows that actually name a conduit.
    let conduit = viaCommittee;
    if (!conduit && /earmark|conduit|bundl/i.test(memo)) {
      const m = memo.match(/(?:earmarked|conduit|bundled)\s*(?:through|via|by)?\s*[:\-]?\s*(.+)$/i);
      conduit = m ? m[1] : '';
    }
    conduit = conduit.replace(/\((?:id|c\d+)[^)]*\)/ig, '').replace(/[.\s]+$/, '').trim();
    if (conduit.length < 3) continue;
    const key = conduit.toLowerCase();
    const entry = byConduit.get(key) || { name: titleCase(conduit), total: 0, count: 0 };
    entry.total += amount;
    entry.count += 1;
    byConduit.set(key, entry);
  }
  return [...byConduit.values()]
    .map((e) => ({ ...e, total: Math.round(e.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** Bundled/earmarked money reaching a candidate, grouped by conduit. */
async function candidateEarmarked(candidateId, cycle) {
  return cached(`fec:earmark:${candidateId}:${cycle}`, 6 * HOUR, async () => {
    const committeeId = await principalCommitteeId(candidateId);
    if (!committeeId) return [];
    const rows = await fetchScheduleA({
      committee_id: committeeId,
      two_year_transaction_period: cycle,
      is_individual: 'true',
      sort: '-contribution_receipt_amount',
    }, { maxPages: 8 });
    return aggregateEarmarks(rows);
  });
}

/**
 * Top recipients of a committee's direct contributions — found from the
 * receiving side (itemized receipts naming this committee as contributor),
 * so it's a top slice of the largest gifts, not a complete total.
 */
async function committeeTopRecipients(committeeName, cycle) {
  return cached(`fec:recips:${committeeName.toLowerCase()}:${cycle}`, 6 * HOUR, async () => {
    const rows = await fetchScheduleA({
      contributor_name: committeeName,
      two_year_transaction_period: cycle,
      sort: '-contribution_receipt_amount',
    }, { maxPages: 8 });
    return aggregateRecipients(rows);
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
  // committees / money tracking
  searchCommitteesByName,
  committeeById,
  committeeTotals,
  committeeTypeLabel,
  candidateIndependentSpending,
  committeeIndependentSpending,
  candidatePacContributions,
  candidateEmployerMoney,
  candidateDonorSizes,
  candidateEarmarked,
  committeeTopRecipients,
  aggregateContributors,
  aggregateRecipients,
  aggregateEarmarks,
  // Exposed for the pagination test harness.
  __fetchScheduleA: fetchScheduleA,
};

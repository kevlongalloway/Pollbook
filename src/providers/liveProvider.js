/**
 * Live provider — composes always-current sources into the provider interface.
 *
 *   Election calendar   computed from statute + state law (src/lib/calendar)
 *   Federal candidates  FEC API, fetched live (src/sources/fec)
 *   Win probabilities   PredictIt prediction markets (src/sources/markets)
 *   Candidate profiles  Wikipedia summary + political-positions section
 *   News coverage       Google News RSS
 *
 * Every network source degrades independently: if one is unreachable the
 * response still renders, with a `sources` status map so the UI can say
 * exactly which panel is missing and why.
 */

const { STATES, getState, registrationUrl } = require('../data/usStates');
const { expandQuery } = require('../data/committeeAliases');
const calendar = require('../lib/calendar');
const fec = require('../sources/fec');
const markets = require('../sources/markets');
const wikipedia = require('../sources/wikipedia');
const news = require('../sources/news');

const OFFICE_NAMES = { S: 'U.S. Senate', H: 'U.S. House', P: 'President' };

const summarize = (e) => ({
  id: e.id, name: e.name, date: e.date, scope: e.scope,
  state: e.state, locality: e.locality, type: e.type,
});

/* ---------------- races for an election ---------------- */

async function buildRaces(stateCode, cycle, sources) {
  const st = getState(stateCode);
  const races = [];

  let senate = [];
  let house = [];
  try {
    [senate, house] = await Promise.all([
      fec.raceCandidates(stateCode, 'S', cycle),
      fec.raceCandidates(stateCode, 'H', cycle),
    ]);
    sources.fec = 'ok';
  } catch (err) {
    sources.fec = 'error';
    sources.fecMessage = err.message;
  }

  if (senate.length) {
    const raceMarkets = await markets.marketsForRace(stateCode, 'S', cycle);
    races.push({
      id: `${stateCode.toLowerCase()}-senate-${cycle}`,
      office: `U.S. Senate — ${st.name}`,
      seats: 1,
      candidates: markets.attachProbabilities(senate, raceMarkets),
      markets: raceMarkets,
    });
  }

  if (st.governor2026 && cycle === 2026) {
    const raceMarkets = await markets.marketsForRace(stateCode, 'G', cycle);
    races.push({
      id: `${stateCode.toLowerCase()}-governor-${cycle}`,
      office: `Governor of ${st.name}`,
      seats: 1,
      candidates: [],
      markets: raceMarkets,
      note: 'State-office candidates file with the state, not the FEC — check your Secretary of State or Ballotpedia for the certified field.',
    });
  }

  // House: one race per district, ordered by district number.
  const byDistrict = new Map();
  for (const c of house) {
    const d = c.district || '00';
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(c);
  }
  for (const [district, candidates] of [...byDistrict.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    races.push({
      id: `${stateCode.toLowerCase()}-house-${district}-${cycle}`,
      office: stateCode === 'DC'
        ? 'Delegate to the U.S. House — DC'
        : `U.S. House — ${stateCode} ${fec.districtLabel(district)}`,
      seats: 1,
      candidates,
      markets: [],
    });
  }

  return races;
}

/* ---------------- provider interface ---------------- */

module.exports = {
  async getAreas() {
    const cycle = calendar.currentCycle();
    return STATES.map((s) => ({
      code: s.code,
      name: s.name,
      governor2026: s.governor2026,
      senate2026: s.senate2026,
      primaryDate: s.primary2026 || null,
      generalDate: calendar.generalElectionDate(cycle),
      registrationUrl: registrationUrl(s.code),
      note: s.note || null,
    }));
  },

  async getElections({ state, scope, upcoming = true } = {}) {
    let list = calendar.allElections({ upcoming });
    if (scope) list = list.filter((e) => e.scope === scope);
    if (state) {
      const code = String(state).toUpperCase();
      // A state's voters also vote in national elections.
      list = list.filter((e) => e.state === code || e.scope === 'national');
    }
    return list.map(summarize);
  },

  async getElectionById(id) {
    const all = calendar.allElections({ upcoming: false });
    const e = all.find((x) => x.id === id);
    if (!e) return null;

    const sources = { calendar: 'ok', markets: 'ok' };
    const cycle = Number(e.id.slice(-4)) || calendar.currentCycle();

    if (e.scope === 'national') {
      let national = [];
      try {
        national = await markets.nationalMarkets();
      } catch { sources.markets = 'error'; }
      return { ...e, races: [], markets: national, sources };
    }

    const races = await buildRaces(e.state, cycle, sources);
    return {
      ...e,
      races,
      sources,
      provenance: 'Federal candidate lists and fundraising: FEC (live). Win probabilities: PredictIt prediction-market prices (live) — market prices, not forecasts.',
    };
  },

  async getCandidateById(id) {
    const sources = {};
    let base = null;
    try {
      base = await fec.candidateById(id);
      sources.fec = 'ok';
    } catch (err) {
      // A 404 from the FEC means the id doesn't exist; anything else means
      // the source is down — say so rather than pretending "not found".
      if (!/HTTP 404\b/.test(err.message)) {
        const e = new Error(`Live candidate data (FEC) is unreachable right now (${err.message}). Try again shortly.`);
        e.status = 503;
        throw e;
      }
    }
    if (!base) return null;

    const st = getState(base.state);
    const officeName = OFFICE_NAMES[base.office] || base.officeFull || 'Federal office';
    const officeLabel = base.office === 'H'
      ? `${officeName} — ${base.state} ${fec.districtLabel(base.district)}`
      : `${officeName} — ${st ? st.name : base.state}`;

    const cycle = calendar.currentCycle();
    // Each funding view fails independently — a missing panel should never
    // take down the rest of the profile.
    const soft = (p) => p.catch(() => { sources.funding = 'partial'; return []; });
    const [finance, wiki, articles, raceMarkets,
      topPacs, independent, employers, donorSizes, earmarked] = await Promise.all([
      fec.candidateFinance(id).catch(() => { sources.finance = 'error'; return null; }),
      wikipedia.profileFor(base.name, { state: st?.name, officeFull: base.officeFull })
        .catch(() => { sources.wikipedia = 'error'; return null; }),
      news.articlesFor(base.name, st ? st.name : ''),
      base.office === 'S' || base.office === 'H'
        ? markets.marketsForRace(base.state, base.office, cycle)
        : Promise.resolve([]),
      soft(fec.candidatePacContributions(id, cycle)),
      soft(fec.candidateIndependentSpending(id, cycle)),
      soft(fec.candidateEmployerMoney(id, cycle)),
      soft(fec.candidateDonorSizes(id, cycle)),
      soft(fec.candidateEarmarked(id, cycle)),
    ]);
    if (!sources.funding) sources.funding = 'ok';

    const [self] = markets.attachProbabilities(
      [{ id: base.id, name: base.name }], raceMarkets
    );

    const latestYear = Math.max(0, ...(base.electionYears || []));
    const electionId = st && latestYear
      ? `${base.state.toLowerCase()}-general-${latestYear}`
      : null;

    return {
      ...base,
      officeLabel,
      stateName: st ? st.name : base.state,
      probability: self.probability ?? null,
      probabilitySource: self.probabilitySource ?? null,
      finance,
      funding: {
        topPacs,
        employers,
        donorSizes,
        earmarked,
        independent: {
          support: independent.filter((r) => r.support),
          oppose: independent.filter((r) => !r.support),
        },
      },
      wiki,
      positions: wiki?.positions || [],
      articles,
      links: [
        { label: 'FEC filings', url: `https://www.fec.gov/data/candidate/${encodeURIComponent(base.id)}/` },
        { label: 'Ballotpedia', url: `https://ballotpedia.org/${encodeURIComponent(base.name.replace(/ /g, '_'))}` },
        { label: 'OpenSecrets', url: `https://www.opensecrets.org/search?q=${encodeURIComponent(base.name)}` },
        ...(wiki ? [{ label: 'Wikipedia', url: wiki.url }] : []),
      ],
      appearances: electionId ? [{
        electionId,
        electionName: `${st.name} General Election`,
        office: officeLabel,
        date: calendar.generalElectionDate(latestYear % 2 ? latestYear + 1 : latestYear),
      }] : [],
      sources,
    };
  },

  async getStats(state) {
    const cycle = calendar.currentCycle();
    const code = state ? String(state).toUpperCase() : null;
    const st = code ? getState(code) : null;
    try {
      const { total, candidates } = await fec.topFundraisers({ state: st ? st.code : undefined, cycle });
      return {
        scope: st ? 'state' : 'national',
        state: st ? st.code : null,
        stateName: st ? st.name : 'United States',
        cycle,
        totalCandidates: total,
        topFundraisers: candidates,
        source: 'FEC candidate fundraising totals, fetched live',
        note: st
          ? `Every federal candidate who has filed to run in ${st.name} for ${cycle}, ranked by money raised. State and local candidates file with the state and are not shown.`
          : `The ${cycle} cycle’s top-funded federal campaigns nationwide. Pick a state to see its races.`,
      };
    } catch (err) {
      return {
        scope: st ? 'state' : 'national',
        state: st ? st.code : null,
        stateName: st ? st.name : 'United States',
        cycle,
        error: `Live FEC data is unreachable right now (${err.message}).`,
      };
    }
  },

  async searchCandidates(q) {
    return fec.searchCandidates(q);
  },

  async getNationalMarkets() {
    return markets.nationalMarkets();
  },

  async searchCommittees(q) {
    const { terms, expansions } = expandQuery(q);
    if (!terms.length) return { query: q, expansions: [], results: [] };
    const batches = await Promise.all(terms.map((t) =>
      fec.searchCommitteesByName(t).catch(() => [])));
    const seen = new Set();
    const results = [];
    for (const batch of batches) {
      for (const c of batch) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        results.push(c);
      }
    }
    return { query: q, expansions, results: results.slice(0, 25) };
  },

  async getCommitteeById(id) {
    const sources = {};
    let info = null;
    try {
      info = await fec.committeeById(id);
      sources.fec = 'ok';
    } catch (err) {
      if (!/HTTP 404\b/.test(err.message)) {
        const e = new Error(`Live committee data (FEC) is unreachable right now (${err.message}). Try again shortly.`);
        e.status = 503;
        throw e;
      }
    }
    if (!info) return null;

    const cycle = calendar.currentCycle();
    const [totals, independent, topRecipients] = await Promise.all([
      fec.committeeTotals(id).catch(() => { sources.totals = 'error'; return null; }),
      fec.committeeIndependentSpending(id, cycle)
        .catch(() => { sources.independent = 'error'; return []; }),
      fec.committeeTopRecipients(info.name, cycle)
        .catch(() => { sources.recipients = 'error'; return []; }),
    ]);

    return {
      ...info,
      cycle,
      totals,
      independent: {
        support: independent.filter((r) => r.support),
        oppose: independent.filter((r) => !r.support),
      },
      topRecipients,
      links: [
        { label: 'Full FEC profile', url: `https://www.fec.gov/data/committee/${encodeURIComponent(id)}/` },
        { label: 'OpenSecrets', url: `https://www.opensecrets.org/search?q=${encodeURIComponent(info.name)}` },
      ],
      sources,
      provenance: 'All figures from FEC filings, fetched live. Direct-contribution recipients are aggregated from the largest itemized receipts naming this committee — see the full FEC profile for complete totals.',
    };
  },
};

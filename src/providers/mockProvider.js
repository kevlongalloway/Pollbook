const { ELECTIONS, RACES, CANDIDATES } = require('../data/mockData');
const { STATES, registrationUrl } = require('../data/usStates');
const calendar = require('../lib/calendar');

const candidateSummary = (id) => {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) return null;
  return { id: c.id, name: c.name, party: c.party, incumbent: c.incumbent };
};

const electionSummary = (e) => ({
  id: e.id,
  name: e.name,
  date: e.date,
  scope: e.scope,
  state: e.state,
  locality: e.locality,
  type: e.type,
  raceCount: e.raceIds.length,
});

module.exports = {
  async getAreas() {
    // Full 51-area list so the picker matches live mode; only GA/TX/CA/OH
    // have seeded elections attached.
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
    const today = new Date().toISOString().slice(0, 10);
    let list = ELECTIONS;

    if (upcoming) list = list.filter((e) => e.date >= today);
    if (scope) list = list.filter((e) => e.scope === scope);
    if (state) {
      // Include national elections alongside a state's own — a Georgia voter
      // still votes in the midterms.
      list = list.filter((e) => e.state === state || e.scope === 'national');
    }

    return list
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(electionSummary);
  },

  async getElectionById(id) {
    const e = ELECTIONS.find((x) => x.id === id);
    if (!e) return null;

    const races = e.raceIds
      .map((rid) => RACES.find((r) => r.id === rid))
      .filter(Boolean)
      .map((r) => ({
        id: r.id,
        office: r.office,
        seats: r.seats,
        candidates: r.candidateIds.map(candidateSummary).filter(Boolean),
      }));

    return { ...e, races: races.map((r) => ({ ...r, markets: [] })), sources: { mock: 'ok' } };
  },

  async getCandidateById(id) {
    const c = CANDIDATES.find((x) => x.id === id);
    if (!c) return null;

    // Attach the races/elections this candidate appears in.
    const appearances = RACES.filter((r) => r.candidateIds.includes(id)).map((r) => {
      const e = ELECTIONS.find((x) => x.id === r.electionId);
      return { raceId: r.id, office: r.office, electionId: e?.id, electionName: e?.name, date: e?.date };
    });

    // Deterministic fictional funding so the money UI is exercisable offline.
    const seed = c.id.length + c.name.length;
    return {
      ...c,
      officeLabel: c.office,
      positions: (c.coreValues || []).map((v) => ({ topic: v, text: '' })),
      funding: {
        topPacs: [
          { name: 'Placeholder Growth PAC', committeeId: 'mock-pac-growth', total: 5000 + seed * 100, count: 2 },
          { name: 'Fictional Futures Committee', committeeId: 'mock-pac-futures', total: 2500 + seed * 50, count: 1 },
        ],
        independent: {
          support: [{ committeeId: 'mock-super-blue', committee: 'Placeholder Priorities Super PAC', total: 240000 + seed * 1000, support: true }],
          oppose: seed % 2
            ? [{ committeeId: 'mock-super-red', committee: 'Imaginary Values Fund', total: 180000 + seed * 900, support: false }]
            : [],
        },
      },
      links: [{ label: 'Campaign site', url: c.website }],
      appearances,
      sources: { mock: 'ok' },
    };
  },

  async getStats(state) {
    // Fundraising-shaped payload matching the live provider's contract,
    // synthesized deterministically from the seed candidates.
    const code = state ? String(state).toUpperCase() : null;
    const pool = CANDIDATES.filter((c) => {
      if (!code) return true;
      return RACES.some((r) => r.candidateIds.includes(c.id) &&
        ELECTIONS.some((e) => e.id === r.electionId && e.state === code));
    });
    const fundraisers = pool.map((c, i) => ({
      id: c.id, name: c.name, party: c.party, office: c.office,
      district: null, incumbent: c.incumbent,
      receipts: 4200000 - i * 310000, disbursements: 2900000 - i * 240000,
    })).sort((a, b) => b.receipts - a.receipts).slice(0, 12);
    return {
      scope: code ? 'state' : 'national',
      state: code,
      stateName: code ? (STATES.find((s) => s.code === code)?.name || code) : 'United States',
      cycle: 2026,
      totalCandidates: pool.length,
      topFundraisers: fundraisers,
      source: 'Fictional seed data (DATA_PROVIDER=mock)',
      note: 'These figures are placeholders. Run with DATA_PROVIDER=live for real FEC fundraising totals.',
    };
  },

  async searchCandidates(q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    return CANDIDATES.filter((c) => c.name.toLowerCase().includes(needle)).map((c) => ({
      id: c.id, name: c.name, party: c.party, office: 'H', officeFull: c.office,
      state: null, district: null, incumbent: c.incumbent, electionYears: [2026],
    }));
  },

  async getNationalMarkets() {
    return [];
  },

  async searchCommittees(q) {
    const needle = String(q || '').trim().toLowerCase();
    const all = [
      { id: 'mock-pac-growth', name: 'Placeholder Growth PAC', type: 'Q', typeLabel: 'PAC', designation: 'Unauthorized', party: null, state: 'GA' },
      { id: 'mock-super-blue', name: 'Placeholder Priorities Super PAC', type: 'O', typeLabel: 'Super PAC', designation: 'Unauthorized', party: null, state: 'DC' },
    ];
    return {
      query: q,
      expansions: [],
      results: needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all,
    };
  },

  async getCommitteeById(id) {
    if (!id.startsWith('mock-')) return null;
    const isSuper = id.includes('super');
    return {
      id,
      name: isSuper ? 'Placeholder Priorities Super PAC' : 'Placeholder Growth PAC',
      type: isSuper ? 'O' : 'Q',
      typeLabel: isSuper ? 'Super PAC' : 'PAC',
      designation: 'Unauthorized',
      party: null,
      state: isSuper ? 'DC' : 'GA',
      cycle: 2026,
      totals: { cycle: 2026, receipts: 4800000, disbursements: 3900000, independentExpenditures: isSuper ? 3600000 : 0, contributionsToCandidates: isSuper ? 0 : 410000 },
      independent: {
        support: isSuper ? [{ committeeId: id, committee: 'Placeholder Priorities Super PAC', candidateId: 'cand-mwhitfield', candidate: 'Marcus Whitfield', total: 2400000, support: true }] : [],
        oppose: isSuper ? [{ committeeId: id, committee: 'Placeholder Priorities Super PAC', candidateId: 'cand-dokafor', candidate: 'Diane Okafor', total: 1200000, support: false }] : [],
      },
      topRecipients: isSuper ? [] : [
        { name: 'Whitfield For Georgia', committeeId: 'mock-cc-1', total: 10000, count: 2 },
        { name: 'Mercer For Congress', committeeId: 'mock-cc-2', total: 7500, count: 2 },
      ],
      links: [],
      sources: { mock: 'ok' },
      provenance: 'Fictional seed data (DATA_PROVIDER=mock).',
    };
  },
};

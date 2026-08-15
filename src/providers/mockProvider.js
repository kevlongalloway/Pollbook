const { ELECTIONS, RACES, CANDIDATES } = require('../data/mockData');
const { STATES, registrationUrl } = require('../data/usStates');
const calendar = require('../lib/calendar');
const { buildMoneyFlow } = require('../lib/moneyFlow');

const candidateSummary = (id) => {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) return null;
  return { id: c.id, name: c.name, party: c.party, incumbent: c.incumbent };
};

/**
 * Fictional bills, shaped exactly like the Congress.gov payloads the live
 * provider returns. Marked [SAMPLE] like every other seed record so a mock
 * deploy can never be mistaken for the legislative record.
 */
const MOCK_BILLS = [
  {
    id: '119-hr-9001', congress: 119, type: 'hr', number: '9001',
    label: 'H.R. 9001', title: '[SAMPLE] Placeholder Voter Access Act',
    originChamber: 'House', introducedDate: '2025-02-11',
    latestAction: { date: '2026-05-14', text: 'Passed/agreed to in House' },
    policyArea: 'Government Operations and Politics',
    stage: { key: 'one-chamber', label: 'Passed the House', step: 3 },
    url: 'https://www.congress.gov/',
    summary: {
      text: 'This fictional bill exists so the bills UI can be exercised offline. It would do nothing, because it is not a real bill.',
      asOf: '2025-02-11', stageDesc: 'Introduced in House',
    },
    sponsor: { name: '[SAMPLE] Rep. Placeholder', party: 'D', state: 'GA', bioguideId: null },
    cosponsors: { count: 44, partySplit: { D: 40, R: 4, other: 0 } },
    subjects: ['Elections, voting, political campaign regulation'],
    actions: [{ date: '2026-05-14', text: 'Passed/agreed to in House', chamber: 'House' }],
    committees: 2, laws: [],
  },
  {
    id: '119-s-4002', congress: 119, type: 's', number: '4002',
    label: 'S. 4002', title: '[SAMPLE] Placeholder Campaign Finance Disclosure Act',
    originChamber: 'Senate', introducedDate: '2025-06-03',
    latestAction: { date: '2026-04-02', text: 'Read twice and referred to the Committee on Rules and Administration.' },
    policyArea: 'Government Operations and Politics',
    stage: { key: 'introduced', label: 'Introduced — in committee', step: 1 },
    url: 'https://www.congress.gov/',
    summary: {
      text: 'A second fictional bill, present only so the list view has more than one row offline.',
      asOf: '2025-06-03', stageDesc: 'Introduced in Senate',
    },
    sponsor: { name: '[SAMPLE] Sen. Placeholder', party: 'R', state: 'OH', bioguideId: null },
    cosponsors: { count: 9, partySplit: { D: 1, R: 8, other: 0 } },
    subjects: ['Campaign funding and finance'],
    actions: [{ date: '2026-04-02', text: 'Read twice and referred to committee.', chamber: 'Senate' }],
    committees: 1, laws: [],
  },
];

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

    // Fictional funding so the money UI is exercisable offline. Names are
    // explicitly marked SAMPLE so seed figures can never be read as filings.
    const seed = c.id.length + c.name.length;

    const fromIndividuals = 930000 + seed * 1300;
    const finance = {
      cycle: 2026,
      coverageEnd: '2026-06-30',
      receipts: fromIndividuals + 46000 + 90000 + 120000,
      disbursements: 740000 + seed * 800,
      cashOnHand: 380000 + seed * 400,
      fromIndividuals,
      fromPacs: 46000,
      fromParty: 90000,
    };
    const funding = {
      topPacs: [
        { name: '[SAMPLE] Growth PAC', committeeId: 'mock-pac-growth', total: 10000, count: 2 },
        { name: '[SAMPLE] Futures Committee', committeeId: 'mock-pac-futures', total: 5000, count: 1 },
      ],
      employers: [
        { employer: '[SAMPLE] Regional Health System', total: 82000 + seed * 700, count: 140 },
        { employer: '[SAMPLE] State University', total: 51000 + seed * 400, count: 96 },
      ],
      donorSizes: [
        { size: 0, label: 'Under $200', total: 320000 + seed * 900 },
        { size: 2000, label: '$2,000 and up', total: 610000 + seed * 400 },
      ],
      earmarked: [
        { name: '[SAMPLE] Advocacy Network', total: 145000 + seed * 500, count: 210 },
      ],
      independent: {
        support: [{ committeeId: 'mock-super-blue', committee: '[SAMPLE] Priorities Super PAC', total: 240000 + seed * 1000, support: true }],
        oppose: seed % 2
          ? [{ committeeId: 'mock-super-red', committee: '[SAMPLE] Values Fund', total: 180000 + seed * 900, support: false }]
          : [],
      },
    };

    return {
      ...c,
      officeLabel: c.office,
      positions: (c.coreValues || []).map((v) => ({ topic: v, text: '' })),
      finance,
      funding,
      moneyFlow: buildMoneyFlow({ finance, funding }),
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

  async getBills({ q } = {}) {
    const query = String(q || '').trim().toLowerCase();
    const bills = MOCK_BILLS.filter((b) =>
      !query || b.title.toLowerCase().includes(query) || b.label.toLowerCase().includes(query));
    return {
      query: q || '',
      congress: 119,
      mode: query ? 'search' : 'feed',
      coverage: MOCK_BILLS.length,
      bills,
      sources: { mock: 'ok' },
    };
  },

  async getBillById(congressNum, type, number) {
    return MOCK_BILLS.find((b) =>
      b.congress === Number(congressNum)
      && b.type === String(type).toLowerCase()
      && b.number === String(number)) || null;
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

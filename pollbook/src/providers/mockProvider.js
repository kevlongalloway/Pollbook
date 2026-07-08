const { AREAS, ELECTIONS, RACES, CANDIDATES, STATS } = require('../data/mockData');

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
    return AREAS;
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

    return { ...e, races };
  },

  async getCandidateById(id) {
    const c = CANDIDATES.find((x) => x.id === id);
    if (!c) return null;

    // Attach the races/elections this candidate appears in.
    const appearances = RACES.filter((r) => r.candidateIds.includes(id)).map((r) => {
      const e = ELECTIONS.find((x) => x.id === r.electionId);
      return { raceId: r.id, office: r.office, electionId: e?.id, electionName: e?.name, date: e?.date };
    });

    return { ...c, appearances };
  },

  async getStats(state) {
    if (state && STATS[state]) return { [state]: STATS[state] };
    return STATS;
  },
};

/**
 * Election service — the only module the routes talk to.
 *
 * Swap data sources by setting DATA_PROVIDER:
 *   DATA_PROVIDER=live          (default — FEC + PredictIt + Wikipedia + news, all fetched live)
 *   DATA_PROVIDER=mock          (fictional seed data, works offline)
 *   DATA_PROVIDER=google-civic  (stub in providers/googleCivicProvider.js)
 *
 * Every provider must implement the same interface:
 *   getAreas() → [AreaInfo]                      states + key dates
 *   getElections({ state, scope, upcoming }) → [ElectionSummary]
 *   getElectionById(id) → ElectionDetail | null  races, candidates, odds
 *   getCandidateById(id) → CandidateDetail | null
 *   getStats(state) → StatsPayload               campaign-finance snapshot
 *   searchCandidates(q) → [CandidateMatch]
 *   getNationalMarkets() → [Market]              balance-of-power odds
 *   getBills({ q }) → BillsPayload               bills before Congress
 *   getBillById(congress, type, number) → BillDetail | null
 */

const providers = {
  live: require('../providers/liveProvider'),
  mock: require('../providers/mockProvider'),
  'google-civic': require('../providers/googleCivicProvider'),
};

const active = providers[process.env.DATA_PROVIDER || 'live'];

if (!active) {
  throw new Error(`Unknown DATA_PROVIDER "${process.env.DATA_PROVIDER}"`);
}

module.exports = active;

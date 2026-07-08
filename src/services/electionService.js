/**
 * Election service — the only module the routes talk to.
 *
 * Swap data sources by setting DATA_PROVIDER:
 *   DATA_PROVIDER=mock          (default, ships with seed data)
 *   DATA_PROVIDER=google-civic  (stub in providers/googleCivicProvider.js)
 *
 * Every provider must implement the same interface:
 *   getAreas() → [{ code, name, localities: [] }]
 *   getElections({ state, scope, upcoming }) → [ElectionSummary]
 *   getElectionById(id) → ElectionDetail | null
 *   getCandidateById(id) → CandidateDetail | null
 *   getStats(state) → StatsPayload
 */

const providers = {
  mock: require('../providers/mockProvider'),
  'google-civic': require('../providers/googleCivicProvider'),
};

const active = providers[process.env.DATA_PROVIDER || 'mock'];

if (!active) {
  throw new Error(`Unknown DATA_PROVIDER "${process.env.DATA_PROVIDER}"`);
}

module.exports = active;

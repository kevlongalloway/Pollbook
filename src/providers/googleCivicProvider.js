/**
 * Google Civic Information API provider — STUB.
 *
 * Wire this up later and the rest of the app doesn't change.
 * Set DATA_PROVIDER=google-civic and GOOGLE_CIVIC_API_KEY in env.
 *
 * Endpoint mapping plan:
 *
 *   getElections()
 *     GET https://www.googleapis.com/civicinfo/v2/elections?key=KEY
 *     → map response.elections[] to ElectionSummary
 *       { id: election.id, name: election.name, date: election.electionDay,
 *         scope: infer from ocdDivisionId, state: parse from ocdDivisionId }
 *
 *   getElectionById(id) + ballot contents
 *     GET https://www.googleapis.com/civicinfo/v2/voterinfo?address=ADDR&electionId=ID&key=KEY
 *     → response.contests[] gives races; contest.candidates[] gives
 *       { name, party, candidateUrl, channels } per candidate.
 *     Note: voterinfo requires a voter address, so the frontend's area picker
 *     should collect at least city + state (or full address) before calling.
 *
 *   Candidate values + articles
 *     Google Civic does NOT return platform/values or news. Plan:
 *       - Vote Smart API (votesmart.org) for issue positions
 *       - A news API (or your own curation table in Postgres) for articles
 *     Keep the CandidateDetail shape from mockProvider as the contract.
 *
 *   getStats()
 *     No Civic API equivalent — source from state SoS data files or the
 *     U.S. Census CPS voting supplement, cached in Postgres.
 */

const NOT_IMPLEMENTED = () => {
  throw new Error(
    'googleCivicProvider is a stub. Set DATA_PROVIDER=mock or implement the mapping in src/providers/googleCivicProvider.js'
  );
};

module.exports = {
  getAreas: NOT_IMPLEMENTED,
  getElections: NOT_IMPLEMENTED,
  getElectionById: NOT_IMPLEMENTED,
  getCandidateById: NOT_IMPLEMENTED,
  getStats: NOT_IMPLEMENTED,
  searchCandidates: NOT_IMPLEMENTED,
  getNationalMarkets: NOT_IMPLEMENTED,
};

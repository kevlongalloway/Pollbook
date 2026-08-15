# Pollbook

Election awareness app covering **all 50 states + DC** — upcoming elections, who's on the ticket, campaign money, market-implied win odds, and candidate policy positions. Nonpartisan, dynamically sourced.

## Run

```bash
npm install
npm start          # http://localhost:3000 — live data, works with zero config
npm run dev        # auto-restart on change (Node 18+)
npm test           # offline unit tests (calendar math, parsers)
```

Deploys straight to Render as a Node web service (`npm start`, port from `PORT` env).

## Data sources (all fetched live, cached in memory)

| What | Source | Key needed |
|---|---|---|
| Election calendar | Computed from statute (2 U.S.C. §7) + state primary law | none |
| Federal candidates + fundraising | [FEC API](https://api.open.fec.gov/developers/) | ships with `DEMO_KEY`; set `FEC_API_KEY` (free, instant) for real rate limits |
| Win probabilities | [PredictIt](https://www.predictit.org) market prices | none |
| Candidate bios + policy positions | Wikipedia (lead summary + "Political positions" section) | none |
| News coverage | Google News RSS | none |
| Voter registration | Links to [vote.gov](https://vote.gov) per state | none |

Every source degrades independently — if one is unreachable the page still renders and says which panel is missing. Failed fetches fall back to the last good cached copy.

**Honest-data notes baked into the UI:** win probabilities are prediction-market prices (what traders pay), labeled as such — not forecasts. Wikipedia content is attributed and linked. Governor and other state-office candidates file with states, not the FEC, so those races link out to official sources. Primary dates are statutory but legislatures move them; the footer tells users to confirm with their election office.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_PROVIDER` | `live` | `live`, `mock` (offline fictional seed data), or `google-civic` (stub) |
| `FEC_API_KEY` | `DEMO_KEY` | OpenFEC key — get one free at api.open.fec.gov/developers |

## Architecture

```
server.js                          Express entry
src/routes/api.js                  REST endpoints
src/services/electionService.js    Picks the data provider (DATA_PROVIDER env)
src/providers/liveProvider.js      Composes the live sources (default)
src/providers/mockProvider.js      Fictional seed data, works offline
src/providers/googleCivicProvider.js  Stub with endpoint mapping plan
src/data/usStates.js               50 states + DC: primaries, 2026 races, registration links
src/lib/calendar.js                Statutory election-date math
src/lib/cache.js                   TTL cache, stale-on-error
src/sources/fec.js                 FEC candidates, finance, search
src/sources/markets.js             PredictIt odds + candidate matching
src/sources/wikipedia.js           Bio + political-positions extraction
src/sources/news.js                Google News RSS
public/                            Vanilla frontend (hash-routed SPA)
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/areas` | All 51 areas with key dates, 2026 races, registration links |
| `GET /api/elections?state=GA&scope=state` | Upcoming election summaries |
| `GET /api/elections/:id` | Detail with races, candidates, fundraising, market odds |
| `GET /api/candidates/:id` | Bio, policy positions, finance, news, odds, links |
| `GET /api/stats?state=GA` | Campaign-finance snapshot (top fundraisers) |
| `GET /api/search?q=name` | Candidate search across all filed federal candidates |
| `GET /api/markets/national` | Balance-of-power prediction markets |

Election IDs are stable and derived: `ga-general-2026`, `wy-primary-2026`, `us-general-2026`. Candidate IDs are FEC candidate IDs in live mode.

## Extending

- **State/local races**: the provider interface is the contract — implement it against Google Civic (`googleCivicProvider.js` has the endpoint mapping plan), a state SoS scraper, or your own Postgres curation and set `DATA_PROVIDER`.
- **More odds sources**: `src/sources/markets.js` isolates the PredictIt schema; add Polymarket or election forecasters behind the same `marketsForRace` shape.
- **2028 and beyond**: general-election dates roll over automatically after election day; add the next cycle's statutory primary dates to `usStates.js` when states publish them.

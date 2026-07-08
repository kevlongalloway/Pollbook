# Pollbook

Election awareness app — surfaces every election a person can vote in, from school board to the presidency. Nonpartisan, local-first.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # auto-restart on change (Node 18+)
```

Deploys straight to Render as a Node web service (`npm start`, port from `PORT` env).

## Architecture

```
server.js                          Express entry
src/routes/api.js                  REST endpoints
src/services/electionService.js    Picks the data provider (DATA_PROVIDER env)
src/providers/mockProvider.js      Seed data provider (default)
src/providers/googleCivicProvider.js  Stub with full endpoint mapping plan
src/data/mockData.js               Fictional seed elections/candidates/stats
public/                            Vanilla frontend (hash-routed SPA)
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/areas` | States + localities for browsing |
| `GET /api/elections?state=GA&scope=local` | Election summaries (upcoming by default) |
| `GET /api/elections/:id` | Full detail with races + candidates |
| `GET /api/candidates/:id` | Bio, party, core values, articles, appearances |
| `GET /api/stats?state=GA` | Turnout by election type, registration data |

## Swapping in a live data source

The frontend and routes only ever talk to `electionService`, which delegates to whichever provider `DATA_PROVIDER` names. To go live:

1. Implement the interface in `src/providers/googleCivicProvider.js` — the file contains the endpoint-by-endpoint mapping plan (Civic `elections` + `voterinfo` for ballots, Vote Smart for issue positions, a news API or your own Postgres curation table for articles).
2. `DATA_PROVIDER=google-civic GOOGLE_CIVIC_API_KEY=... npm start`

Notes for the live build:
- Google Civic's `voterinfo` requires a voter address — the area picker will need to collect at least city + state before ballot contents can load.
- Civic returns candidate name/party/URL but **not** platform values or news. Keep the mock provider's `CandidateDetail` shape as the contract and compose it from Vote Smart + your own curation.
- Turnout stats have no Civic equivalent — source from state SoS exports or the Census CPS voting supplement, cached in Postgres.

## Seed data

All candidates, outlets, and articles in `mockData.js` are fictional placeholders. Dates are staged around mid-2026 so upcoming/countdown states demo correctly.

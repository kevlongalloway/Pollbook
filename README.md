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
| Who funds a candidate | FEC — Schedule E (super-PAC independent expenditures), Schedule A fully paginated (PAC contributions, bundled/earmarked money), `by_employer` and `by_size` aggregates | same FEC key |
| News coverage | Google News RSS | none |
| Voter registration | Links to [vote.gov](https://vote.gov) per state | none |

Every source degrades independently — if one is unreachable the page still renders and says which panel is missing. Failed fetches fall back to the last good cached copy.

**Honest-data notes baked into the UI:** win probabilities are prediction-market prices (what traders pay), labeled as such — not forecasts. Wikipedia content is attributed and linked. Governor and other state-office candidates file with states, not the FEC, so those races link out to official sources. Primary dates are statutory but legislatures move them; the footer tells users to confirm with their election office.

### Money tracking — how to read it

Organizational money reaches a candidate three ways, and only showing one of them is misleading. Every candidate page covers all three, ordered by how much signal each carries:

1. **Independent expenditures** (Schedule E) — unlimited super-PAC spending *for* or *against* a candidate, never touching the campaign's books. This is where the millions are, and where a group like AIPAC's United Democracy Project shows up.
2. **Bundled / earmarked donations** — individual gifts routed through an organization acting as a conduit. This is how AIPAC and similar groups move most of their money; it arrives as *individual* contributions, so a PAC-only view misses it entirely. Aggregated per conduit from Schedule A memo text and `donor_committee_name`.
3. **Direct PAC contributions** — capped by law at $5,000 per election, so these are small and look nearly identical across candidates. Shown last, with that caveat on the page.

Plus the campaign's **money mix** (individuals vs. PACs vs. party, with a small-donor share) and **top donor employers** (`by_employer`), the clearest available signal of which industries and institutions are behind a campaign.

> **Implementation note:** the FEC rejects deep page-number paging on itemized schedules, so Schedule A is walked with keyset pagination (`pagination.last_indexes`). Aggregating a single page — as an early version did — returns an arbitrary slice of identically-sized max-out checks and produces near-identical totals for every candidate. `test/pagination.js` guards this against a local stub that mimics the cursor behaviour.

The PAC tracker searches any committee and shows who it funds and opposes. Committee-name searches expand through a small, documented alias table of publicly reported affiliations (e.g. AIPAC ↔ United Democracy Project) so an organization's whole footprint surfaces. Registered *lobbying* (LDA filings — who lobbies Congress on which bills) is a separate disclosure system; the tracker links to lda.senate.gov and OpenSecrets for that.

**If figures look fake, check the provider.** `GET /api/meta` reports which provider is serving the instance, and the UI shows a red banner across every page when it isn't `live`. Seed data is additionally prefixed `[SAMPLE]`.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_PROVIDER` | `live` | `live`, `mock` (offline fictional seed data), or `google-civic` (stub). **If your deploy sets this to `mock`, unset it** — every figure will be fictional. |
| `FEC_API_KEY` | `DEMO_KEY` | OpenFEC key — get one free at api.open.fec.gov/developers. Strongly recommended: the funding panels make several FEC calls per candidate page, and `DEMO_KEY` allows only 30/hour across all users. |
| `FEC_API_BASE` | OpenFEC v1 | Override the API base — used by `test/pagination.js` to run against a stub. |
| `GROQ_API_KEY` | none | Enables the "Ask about this candidate" AI panel. Free key at [console.groq.com/keys](https://console.groq.com/keys). Without it, that panel returns a plain error and the rest of the app is unaffected. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model used for candidate Q&A. Must support tool calling, or web search silently never fires. |
| `GROQ_API_BASE` | Groq's OpenAI-compatible endpoint | Override the API base (e.g. for testing against a stub). |
| `TAVILY_API_KEY` | none | Enables real web search for the Q&A panel. Free key at [tavily.com](https://tavily.com). Without it the panel falls back to keyless Google News RSS — headlines only, no page text. |
| `TAVILY_API_BASE` | `https://api.tavily.com` | Override the search API base — used by `test/qa.js` to run against a stub. |
| `QA_BUDGET_MS` | `25000` | Total wall-clock budget for one AI answer, searches included. The route is a blocking POST, so this is what stands between a slow model and a proxy timeout. |
| `PUBLIC_BASE_URL` | inferred per request | Canonical origin (e.g. `https://pollbook.example`) used for the OpenGraph/canonical URLs. Unset, the server derives it from the request's forwarded host — correct on Render, but pin it if you serve the app behind a CDN or a custom domain alias. |

### Candidate Q&A (AI)

Every candidate page has an "Ask about this candidate" panel, backed by [Groq](https://groq.com) (free-tier chat completions). It's grounded in that candidate's Pollbook profile — FEC filings, Wikipedia bio/positions, recent headlines — and a system prompt that keeps it strictly nonpartisan and scoped to U.S. elections: any question outside U.S. elections/candidates gets a fixed refusal ("I only give information on United States elections and their candidates.") instead of an answer. Conversation history is kept in the browser's `localStorage` only (`pb-ai-<candidateId>`) — nothing is stored server-side, and there's a "Clear conversation" button per candidate.

**Web search.** The profile is a thin slice of a candidate — a bio, a few positions, five headlines — so grounding the model in it alone meant most real questions ("what's the latest polling?", "how did she vote on that bill?") hit the anti-hallucination rule and came back as *"I don't have that information."* The model is now given a `search_web` tool and decides for itself when to reach for it: profile-answerable questions cost one completion as before, and only questions that need current information pay for a search. Searches are capped at 2 per question, results cached for 15 minutes, and the whole exchange is bounded by `QA_BUDGET_MS`. Out-of-scope questions are refused *before* a search is spent.

Answers come back with the sources consulted, rendered as links under the reply and persisted with the conversation — on a nonpartisan election site, a claim the model pulled off the open web should be checkable.

**Treating search results as hostile.** Anyone who can rank for a candidate's name can put text in front of this model, and the realistic harm here is a partisan claim laundered through an assistant users expect to be neutral. Retrieved text is fenced accordingly: it enters only as a `role: "tool"` message (never as a system or user turn), between sentinels that label it untrusted data; control characters, zero-width characters and chat-template tokens (`<|im_start|>`, `[INST]`) are stripped at the source; snippets are capped at 500 characters and each tool message at 4,000; and non-`http(s)` URLs are dropped both server-side and again before any `href` is rendered. This is mitigation, not a guarantee — the visible source list is the part that makes a bad answer auditable.

## Brand assets and link previews

`public/logo.svg` is the master mark — a filled ballot oval in signage yellow on a
civic-blue field, the same oval the UI uses as its signature element. Everything
raster is generated from it, so the SVG is the only file to edit:

```bash
npm install --no-save playwright && node scripts/generate-assets.js
```

That script (headless Chromium, webfonts inlined so the render is deterministic)
rewrites `favicon.ico` (16/32/48), `apple-touch-icon.png` (180), `icon-192.png`,
`icon-512.png`, and `og-image.png` — the 1200×630 card, whose layout lives in
`scripts/og-template.html`. Playwright is intentionally *not* a package
dependency: it's a one-off authoring tool, not something a deploy should install.

Link previews (iMessage, Slack, Signal, WhatsApp, X, Facebook) need **absolute**
URLs — Apple's fetcher silently drops a relative `og:image`, which is the usual
reason a shared link arrives as a bare grey bubble. The origin isn't knowable at
build time, so `index.html` carries a `__BASE_URL__` placeholder that `server.js`
substitutes on each render, from `PUBLIC_BASE_URL` when set and otherwise from
the request's `X-Forwarded-Proto`/`X-Forwarded-Host`. The `Host` header is
caller-controlled, so anything that isn't a plain `host:port` is dropped rather
than reflected into the page.

## Architecture

```
server.js                          Express entry; injects absolute OG/canonical URLs
src/routes/api.js                  REST endpoints
src/services/electionService.js    Picks the data provider (DATA_PROVIDER env)
src/providers/liveProvider.js      Composes the live sources (default)
src/providers/mockProvider.js      Fictional seed data, works offline
src/providers/googleCivicProvider.js  Stub with endpoint mapping plan
src/data/usStates.js               50 states + DC: primaries, 2026 races, registration links
src/data/committeeAliases.js       Publicly-reported PAC affiliations (AIPAC ↔ United Democracy Project)
src/lib/calendar.js                Statutory election-date math
src/lib/cache.js                   TTL cache, stale-on-error
src/lib/groq.js                    Groq chat-completions client (GROQ_API_KEY)
src/lib/candidateQa.js             Candidate Q&A: grounds Groq in the candidate profile, enforces scope
src/sources/fec.js                 FEC candidates, finance, search
src/sources/markets.js             PredictIt odds + candidate matching
src/sources/wikipedia.js           Bio + political-positions extraction
src/sources/news.js                Google News RSS
src/sources/webSearch.js           Web search for Q&A (Tavily, Google News RSS fallback)
public/                            Vanilla frontend (hash-routed SPA)
public/logo.svg                    Master mark — source for every icon
scripts/generate-assets.js         Regenerates favicons + og-image.png from it
scripts/og-template.html           Layout of the 1200×630 link-preview card
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/areas` | All 51 areas with key dates, 2026 races, registration links |
| `GET /api/elections?state=GA&scope=state` | Upcoming election summaries |
| `GET /api/elections/:id` | Detail with races, candidates, fundraising, market odds |
| `GET /api/candidates/:id` | Bio, policy positions, finance, news, odds, links |
| `POST /api/candidates/:id/ask` | AI answer to a question about this candidate (Groq, needs `GROQ_API_KEY`). Body: `{ question, history }`; history stays client-side. Returns `{ answer, sources }`, where `sources` are the web pages consulted (empty when the profile alone sufficed). |
| `GET /api/stats?state=GA` | Campaign-finance snapshot (top fundraisers) |
| `GET /api/search?q=name` | Candidate search across all filed federal candidates |
| `GET /api/committees?q=aipac` | PAC/super-PAC search (alias-aware: AIPAC also finds United Democracy Project) |
| `GET /api/committees/:id` | Committee detail: totals, spending for/against candidates, top recipients |
| `GET /api/markets/national` | Balance-of-power prediction markets |
| `GET /api/meta` | Active data provider — use this to confirm you're seeing live data |

Election IDs are stable and derived: `ga-general-2026`, `wy-primary-2026`, `us-general-2026`. Candidate IDs are FEC candidate IDs in live mode.

## Extending

- **State/local races**: the provider interface is the contract — implement it against Google Civic (`googleCivicProvider.js` has the endpoint mapping plan), a state SoS scraper, or your own Postgres curation and set `DATA_PROVIDER`.
- **More odds sources**: `src/sources/markets.js` isolates the PredictIt schema; add Polymarket or election forecasters behind the same `marketsForRace` shape.
- **2028 and beyond**: general-election dates roll over automatically after election day; add the next cycle's statutory primary dates to `usStates.js` when states publish them.

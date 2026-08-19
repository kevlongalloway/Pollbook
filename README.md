# Pollbook

Election awareness app covering **all 50 states + DC** — upcoming elections, who's on the ticket, campaign money, market-implied win odds, candidate policy positions, and the election bills moving through Congress. Nonpartisan, dynamically sourced.

## Run

```bash
npm install
npm start          # http://localhost:3000 — live data, works with zero config
npm run dev        # auto-restart on change (Node 20+)
npm test           # 151 tests, fully offline — every upstream is stubbed
```

The suite never touches the network: `unit` covers date math and parsers,
`pagination` and `bills` run the FEC and Congress.gov sources against local
stubs, `qa` does the same for the AI panels, `cache` pins the behaviour under
upstream failure, `subjects` and `nonpartisan` cover the subscription grammar
and the neutrality rules, `auth` and `notify` run the crypto and the messaging
adapters against locally generated keys and stub servers, and `routes`
exercises the real Express app end to end.

Optional, and skipped by default so `npm test` needs nothing configured:

```bash
npm run migrate                                  # apply the schema
TEST_DATABASE_URL=postgres://… npm run test:db   # 27 tests against real Postgres
```

Accounts, alerts and the staff API are additive — with no `DATABASE_URL`
everything above works exactly as it always has. See **Accounts and alerts**
below, and `.env.example` for every key.

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
| Bills before Congress | [Congress.gov API](https://api.congress.gov) — status, sponsor, actions, CRS summaries | ships with `DEMO_KEY`; set `CONGRESS_API_KEY` (free, instant) for real rate limits |
| Voter registration | Links to [vote.gov](https://vote.gov) per state | none |

Every source degrades independently — if one is unreachable the page still renders and says which panel is missing. Failed fetches fall back to the last good cached copy.

**Honest-data notes baked into the UI:** win probabilities are prediction-market prices (what traders pay), labeled as such — not forecasts. Wikipedia content is attributed and linked. Governor and other state-office candidates file with states, not the FEC, so those races link out to official sources. Primary dates are statutory but legislatures move them; the footer tells users to confirm with their election office.

### Money tracking — how to read it

Organizational money reaches a candidate three ways, and only showing one of them is misleading. Every candidate page covers all three, ordered by how much signal each carries:

1. **Independent expenditures** (Schedule E) — unlimited super-PAC spending *for* or *against* a candidate, never touching the campaign's books. This is where the millions are, and where a group like AIPAC's United Democracy Project shows up.
2. **Bundled / earmarked donations** — individual gifts routed through an organization acting as a conduit. This is how AIPAC and similar groups move most of their money; it arrives as *individual* contributions, so a PAC-only view misses it entirely. Aggregated per conduit from Schedule A memo text and `donor_committee_name`.
3. **Direct PAC contributions** — capped by law at $5,000 per election, so these are small and look nearly identical across candidates. Shown last, with that caveat on the page.

Plus the campaign's **money mix** (individuals vs. PACs vs. party, with a small-donor share) and **top donor employers** (`by_employer`), the clearest available signal of which industries and institutions are behind a campaign.

### The money-flow diagram

Every candidate page opens its money section with a flow diagram: donor
channels on the left, the campaign as a single node on the right, ribbons
sized by dollars. Two properties are what make it worth drawing rather than
decorative, and both are enforced in `src/lib/moneyFlow.js` and covered by
tests:

**Outside spending is a second track with no ribbon to the campaign.**
Independent expenditures never touch a campaign's books. A chart that totals
"money behind this candidate" into one number implies coordination that is
illegal and, more importantly, isn't happening — so super-PAC money sits below
a dashed rule, flowing at the race rather than at the campaign.

**Both tracks share one pixels-per-dollar scale.** When outside groups outspend
the campaign itself — routinely, in a competitive Senate race — the outside
stack is visibly taller. That single comparison is the reason the diagram
exists, and it only survives if neither track is normalized on its own.

Conduit money is drawn as hatching *inside* the individual-donor bands rather
than as an inflow of its own, because that is precisely what it is: individual
donations routed through an organization. Giving it a ribbon would double-count
it against `fromIndividuals` and inflate the total the campaign reported
raising. Where a figure can't be derived honestly — the FEC's donor-size
aggregate covers a different window than the individual total and can exceed
it — the split is dropped rather than forced, and the reason is printed under
the chart.

Race pages carry a **side-by-side comparison** of the money behind every
candidate in a race, on one shared scale — raised by the campaign, spent for
them from outside, spent against them. A single candidate's diagram answers
"where does their money come from"; this answers the question people actually
arrive with, which is who is being carried by outside money and who is being
buried by it. It loads on demand, since a full profile is several FEC calls
and most visitors to a race page never ask.

The diagram is mirrored by a visually-hidden data table. A long `aria-label`
is a poor substitute for a chart — it's read as one unstoppable sentence with
no way to navigate between figures — and the distinction the diagram exists to
make, money *into* the campaign versus money spent *about* the candidate,
survives in the table as two labelled sections.

> **Implementation note:** the FEC rejects deep page-number paging on itemized schedules, so Schedule A is walked with keyset pagination (`pagination.last_indexes`). Aggregating a single page — as an early version did — returns an arbitrary slice of identically-sized max-out checks and produces near-identical totals for every candidate. `test/pagination.js` guards this against a local stub that mimics the cursor behaviour.

The PAC tracker searches any committee and shows who it funds and opposes. Committee-name searches expand through a small, documented alias table of publicly reported affiliations (e.g. AIPAC ↔ United Democracy Project) so an organization's whole footprint surfaces. Registered *lobbying* (LDA filings — who lobbies Congress on which bills) is a separate disclosure system; the tracker links to lda.senate.gov and OpenSecrets for that.

**If figures look fake, check the provider.** `GET /api/meta` reports which provider is serving the instance, and the UI shows a red banner across every page when it isn't `live`. Seed data is additionally prefixed `[SAMPLE]`.

`/api/meta` also reports whether each metered upstream is running on its own key or the shared demo one:

```json
{ "provider": "live", "live": true, "fecKey": "configured", "congressKey": "configured", "webSearch": "tavily" }
```

`"congressKey": "DEMO_KEY"` means `CONGRESS_API_KEY` isn't reaching the process — check it after a deploy, since the demo key's 30-requests-per-hour ceiling shows up as a bills page that intermittently comes back empty rather than as an obvious error. The Bills page says so itself in that state.

## Bills before Congress

Elections aren't only decided at the ballot box — Congress writes the rules for
how you register, how you vote, and how campaigns are funded. The Bills page
tracks that legislation live from [Congress.gov](https://api.congress.gov), the
Library of Congress's official API: status, sponsor, cosponsor party split,
action history, and the Congressional Research Service summary of what each
bill actually does. CRS summaries are written by nonpartisan Library of
Congress staff, which makes them the right neutral answer to "what would this
do?" on a site like this one.

**Congress.gov has no keyword search.** The v3 API addresses bills by congress,
type and number and lists them by update date; there is no `q` parameter. So
discovery runs on three channels, and the page says which one found what:

1. **Titles** of the most recently-updated bills. Cheap and current, but coarse
   — it only catches bills that announce themselves as election bills. The
   matcher is word-boundary anchored so "Natural Selection Research Act"
   doesn't match "election".
2. **CRS summary text** of recently-published summaries. This is what catches
   the bills that matter most: an election provision folded into an
   appropriations package names nothing in its title, and those are precisely
   the ones that pass. Summary matches are labelled in the UI, because a phrase
   can be incidental to a bill that is mostly about something else. Summaries
   lag introduction by weeks, so this complements titles rather than replacing
   them — a bill has no summary until CRS writes one.
3. **Bill-number lookup** resolves any bill directly, however long it has been
   sitting. `HR 22`, `H.R. 22`, `hr22` and `S.J.Res. 2` all parse. This is what
   makes a specific bill findable when it has dropped out of the window.

The two window channels fail independently: losing either leaves the page
working on whatever the other found.

A small watchlist (`src/data/electionBills.js`) pins landmark bills — the SAVE
Act among them — so they stay on the page after they go quiet. Only the bill
*number* is stored; every fact shown is fetched live. Because bill numbers are
recycled each Congress, each entry carries an `expect` pattern that the live
title must match, and an entry that fails verification is dropped rather than
rendered. A missing bill is a much better failure than an unrelated one
presented as the official record.

Status labels ("Passed the House", "Enacted") are derived from the latest
action text, since Congress.gov reports actions as prose rather than a status
enum. They're a summary for orientation; congress.gov is authoritative and is
linked from every bill page.

### Ask about this bill (AI)

Every bill page carries the same Q&A panel as candidate pages, sharing its
retrieval and prompt-fencing code (`src/lib/retrieval.js` — one copy, since two
copies of a prompt boundary drift and the copy that drifts is the one nobody
re-reads). It's grounded in the bill's official record and searches the web on
every question for current status and reaction.

The scope is wider than the candidate panel's, deliberately: "what would this
change for me?" and "who opposes it?" are the questions people actually have
about a bill, and both are legislative rather than electoral. Refusing them
would make the panel useless. What it will not do is argue for or against the
bill, and it's instructed to present contested effects as claims held by
particular people ("supporters say…") rather than as settled fact — the line
that matters on a nonpartisan site. Anything outside U.S. legislation and
elections gets a fixed refusal.

## Staying up under load and outage

Two properties that took real bugs to get right, both covered by tests.

**The AI endpoints are rate limited.** `/ask` reaches Groq and a search
provider on every request — both metered, neither behind auth — so a loop
against one page could drain the day's quota and take the panels down for
everyone. Two ceilings apply: per-IP, which stops one caller monopolizing the
service, and a global cap, which is what actually protects the quota since
per-IP limits do nothing against a botnet. Both Q&A panels share one budget,
so the ceiling doesn't double each time a panel is added, and read endpoints
have their own generous limit so browsing keeps working once the AI budget is
spent.

This depends on `trust proxy` being set correctly (`server.js`). Without it
`req.ip` is the load balancer's address and every visitor shares one bucket;
trusting *every* hop instead would let a caller spoof `X-Forwarded-For` and
mint a fresh bucket per request. It's set to `1` — trust exactly one hop —
which is right for Render and for most single-proxy hosts.

**The cache doesn't amplify an outage.** It used to: a failed fetch deleted the
entry, so the next request retried immediately. Against a 429 that meant every
page load spent another request on an already-exhausted limit, and traffic made
the outage worse instead of riding it out. Demo keys allow 30 requests an hour,
so this was reachable in ordinary use. Failures now hold a short cooldown, and
the stale-on-error path holds its value for that cooldown too rather than
restoring an already-past expiry — the same bug in a second place, which the
tests caught and prose review had not.

A debounced snapshot on disk means a restart starts warm instead of hammering
every upstream at once. It's written atomically and size-capped, and a
read-only or full disk simply falls back to starting cold. By default it lives
in the OS temp directory, which survives a process restart within a container
but not a redeploy — point `CACHE_FILE` at a mounted volume if you want it to.

## Configuration

`.env.example` is the full list, grouped by what it enables and annotated with
what breaks without it. The table below covers the data-and-AI half; the
accounts half is documented in **Accounts and alerts**.

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | none | Enables accounts, alerts and the staff API. Without it the site is exactly what it was before: fully working, entirely anonymous. |
| `SESSION_SECRET` | none | Signs session and unsubscribe tokens. **Required in production** — the process refuses to boot without it rather than sign cookies with a key that changes on every deploy. |
| `MAILING_ADDRESS` | none | Physical postal address, required by CAN-SPAM in every message. Rendering throws in production without it rather than quietly omitting it. |
| `ENABLE_JOBS` | off | Runs the background jobs (deadline reminders, the send queue, retention). Safe on every instance — each job claims work with `FOR UPDATE SKIP LOCKED`. |
| `SEND_ENABLED` | on | Set `0` to stop everything leaving the queue. The kill switch that survives a restart. |
| `SMS_ENABLED` | off | The deliberate second switch for SMS, so a deploy carrying Twilio credentials cannot start texting before A2P 10DLC registration is approved. |
| `DATA_PROVIDER` | `live` | `live`, `mock` (offline fictional seed data), or `google-civic` (stub). **If your deploy sets this to `mock`, unset it** — every figure will be fictional. |
| `FEC_API_KEY` | `DEMO_KEY` | OpenFEC key — get one free at api.open.fec.gov/developers. Strongly recommended: the funding panels make several FEC calls per candidate page, and `DEMO_KEY` allows only 30/hour across all users. |
| `FEC_API_BASE` | OpenFEC v1 | Override the API base — used by `test/pagination.js` to run against a stub. |
| `CONGRESS_API_KEY` | `DEMO_KEY` | Congress.gov key — free at [api.congress.gov/sign-up](https://api.congress.gov/sign-up/). Recommended: the bills feed makes several calls per refresh, and api.data.gov's `DEMO_KEY` allows only 30/hour per IP. |
| `CONGRESS_API_BASE` | Congress.gov v3 | Override the API base — used by `test/bills.js` to run against a stub. |
| `CONGRESS_FEED_PAGES` | `3` | Pages of 250 bills scanned by title to build the feed. Each page is one API call: more pages means better coverage and a bigger key budget. |
| `CONGRESS_SUMMARY_PAGES` | `2` | Pages of 250 CRS summaries scanned as the second discovery channel (see below). Same cost/coverage trade. |
| `ASK_RATE_LIMIT` | `12` | AI questions allowed per IP per 10 minutes, across both Q&A panels combined. |
| `ASK_RATE_LIMIT_GLOBAL` | `240` | AI questions allowed per 10 minutes across all callers — the ceiling that actually protects the Groq quota. |
| `API_RATE_LIMIT` | `240` | Requests per IP per minute for everything else. Set to catch scrapers, not to shape ordinary use. |
| `CACHE_PERSIST` | on | Set `0` to disable the on-disk cache snapshot. Tests set this automatically. |
| `CACHE_FILE` | temp dir | Where the snapshot lives. Point it at a mounted volume to survive redeploys, not just restarts. |
| `CACHE_FAILURE_TTL_MS` | `30000` | How long a failed upstream call is remembered before it's retried. |
| `GROQ_API_KEY` | none | Enables the "Ask about this candidate" AI panel. Free key at [console.groq.com/keys](https://console.groq.com/keys). Without it, that panel returns a plain error and the rest of the app is unaffected. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model used for candidate Q&A. Any chat model works — search runs before the model is called, so tool-calling support is not required. |
| `GROQ_API_BASE` | Groq's OpenAI-compatible endpoint | Override the API base (e.g. for testing against a stub). |
| `TAVILY_API_KEY` | none | Real web search for the Q&A panel. Free key at [tavily.com](https://tavily.com). Without it the panel falls back to keyless Google News RSS — headlines only, no page text, so answers are noticeably thinner. |
| `TAVILY_API_BASE` | `https://api.tavily.com` | Override the search API base — used by `test/qa.js` to run against a stub. |
| `QA_BUDGET_MS` | `25000` | Total wall-clock budget for one AI answer, search included. The route is a blocking POST, so this is what stands between a slow upstream and a proxy timeout. |
| `PUBLIC_BASE_URL` | inferred per request | Canonical origin (e.g. `https://pollbook.example`) used for the OpenGraph/canonical URLs. Unset, the server derives it from the request's forwarded host — correct on Render, but pin it if you serve the app behind a CDN or a custom domain alias. |

### Candidate Q&A (AI)

Every candidate page has an "Ask about this candidate" panel, backed by [Groq](https://groq.com) (free-tier chat completions). It's grounded in that candidate's Pollbook profile — FEC filings, Wikipedia bio/positions, recent headlines — and a system prompt that keeps it strictly nonpartisan and scoped to U.S. elections: any question outside U.S. elections/candidates gets a fixed refusal ("I only give information on United States elections and their candidates.") instead of an answer. Conversation history is kept in the browser's `localStorage` only (`pb-ai-<candidateId>`) — nothing is stored server-side, and there's a "Clear conversation" button per candidate.

**Web search.** The profile is a thin slice of a candidate — a bio, a few positions, five headlines — so grounding the model in it alone meant most real questions ("what's the latest polling?", "how did she vote on that bill?") hit the anti-hallucination rule and came back as *"I don't have that information."*

Every question now runs a web search first, and the results go into the prompt alongside the profile. One completion, no tool calling. An earlier version did hand the model a `search_web` tool and let it decide when to call it — it mostly didn't, answering from the profile instead, so the original complaint survived the fix. Making the search unconditional takes the decision away from the model, which also means it behaves identically on any `GROQ_MODEL`, tool support or not.

The tradeoff is that every question costs a search, including ones the profile could have answered and out-of-scope ones that end in a refusal. Results are cached for 15 minutes to blunt that, and the whole exchange is bounded by `QA_BUDGET_MS`. The search query is the candidate's name and state plus the question — anchoring on the candidate is what makes pronoun follow-ups ("what are *her* views on healthcare?") searchable at all.

Answers come back with the sources consulted, rendered as links under the reply and persisted with the conversation — on a nonpartisan election site, a claim the model pulled off the open web should be checkable.

**Treating search results as hostile.** Anyone who can rank for a candidate's name can put text in front of this model, and the realistic harm here is a partisan claim laundered through an assistant users expect to be neutral. Retrieved text is fenced accordingly: it rides in the user turn, never the system prompt, so the rules are established before any untrusted content appears; it sits between sentinels that label it untrusted data; control characters, zero-width characters and chat-template tokens (`<|im_start|>`, `[INST]`) are stripped at the source; snippets are capped at 500 characters and the whole retrieved block at 4,000; and non-`http(s)` URLs are dropped both server-side and again before any `href` is rendered. This is mitigation, not a guarantee — the visible source list is the part that makes a bad answer auditable.

## Accounts and alerts

Pollbook is stateless by default and stays that way. **With no `DATABASE_URL`,
nothing above changes** — every page, every endpoint, every anonymous visitor
behaves exactly as it did before accounts existed. Account routes answer `503`
with an explanation instead of failing, and `test/routes.js` boots the real
server with no database to keep that true.

An account adds one thing: "Track this election" stops being a note to
yourself in `localStorage` and becomes an actual reminder to check your
registration and to vote.

```bash
cp .env.example .env        # every key, grouped, with what breaks without it
npm run migrate             # or let it run at boot; RUN_MIGRATIONS=0 to opt out
npm start
```

With a database and **no messaging keys at all**, the whole flow is
exercisable locally: the sign-in link prints to stdout. That property is why
magic-link sign-in was built first rather than last.

### Signing in

Three ways in, all landing on the same session cookie: **Google**, **Sign in
with Apple**, and a **passwordless email link**. There are no passwords
anywhere — no hash to leak, no reuse risk, no native bcrypt build.

`pg` is the only dependency this added. JWT signing and verification, PKCE,
webhook HMACs and cookie signing are all `node:crypto` — see `src/lib/jwt.js`,
which exists anyway because Apple makes you sign your own client secret.

Three details cost an afternoon each and are worth knowing before you touch
that code:

- **Apple's ES256 signature must be raw `r||s`**, so `dsaEncoding:
  'ieee-p1363'`. Node's default DER encoding is rejected as `invalid_client`,
  which reads exactly like a wrong key ID.
- **Apple's callback is a cross-site POST** (`response_mode=form_post`), so a
  `SameSite=Lax` cookie is never sent with it. The OAuth transaction lives in
  Postgres instead, which also lets the callback land on a different instance
  than the one that started the flow.
- **Mail scanners fetch every link in an inbound message**, burning
  single-use tokens before a human clicks. The emailed link renders a page
  with a button that POSTs, rather than acting on the `GET`.

Sessions are opaque, revocable rows rather than JWTs: offboarding, "sign out
everywhere" and the step-up window that gates subscriber data all need the
server to be able to say no *now*, and every authenticated request already
touches Postgres.

### Roles

Ten roles, and everything checks a **permission**, never a role name. Two
separations are deliberate and are the point of the model:

| Role | Holds | Notably does **not** hold |
|---|---|---|
| `subscriber` | Their own data, export, deletion | — |
| `viewer` | Aggregates, drafts, read-only | Anything that writes |
| `editor` | `broadcast.draft`, `template.draft`, `taxonomy.propose` | Any subscriber data; sending; approving |
| `analyst` | Aggregate export, deliverability | Any subscriber data |
| `support` | `pii.read_single` (one exact address, audited), `suppression.add` | Listing or exporting subscribers |
| `approver` | `broadcast.approve` | **`broadcast.draft`** — cannot approve their own words |
| `sender` | `broadcast.send`, the kill switch | Drafting, approving |
| `compliance` | Consent, audit, retention, DSARs | Sending anything |
| `admin` | Config, jobs, `roles.grant`, audit | **Sending broadcasts, and subscriber PII** |
| `owner` | `roles.grant_any` | — |

**`admin` cannot send a message or read a subscriber record.** A compromised
engineering account should not be able to text forty thousand people, and
should not be able to download the list either.

**`pii.export_bulk` is granted to no role at all.** Holding it requires an
owner making a deliberate grant to one named person, and `lib/permissions.js`
refuses to resolve it from a grant with no expiry. There is no standing
ability to export the subscriber list, and no button for it.

### What we collect, and what we refuse to

Collected: email; phone only with its own separate consent; state, and
optionally ZIP5; IANA timezone (for quiet hours); which races and issues you
follow; how often you want to hear from us; and an immutable consent record —
the verbatim words shown, their version and hash, the IP, and the timestamp.

**Not collected, deliberately: party affiliation or registration, political
views, voting history, voter-file matches, home address, or date of birth.**
There is no database column for any of them. `test/nonpartisan.js` reads the
migration files and fails the build if one appears.

That is the difference between a nonpartisan claim you have to trust and one
that is structurally true: you cannot target on data you never stored, and it
cannot leak.

`GET /api/me/export` returns everything held about one person, consent history
included. `POST /api/me/delete` removes it, leaving only a suppression
tombstone — which is what makes "delete my account" and "never contact me
again" compatible rather than contradictory.

### How the nonpartisan rules are enforced

Not a policy document. `src/lib/nonpartisan.js` runs at draft, at approval,
and again on the finished bytes inside the sender, because copy can change in
between:

- **Express advocacy is blocked** on the *Buckley v. Valeo* magic-words test —
  "vote for", "defeat", "elect" near a name.
- **The balance rule**: a message naming any candidate in a race must name
  every qualifying candidate, **in alphabetical order by surname**. Qualifying
  is objective and published — an incumbent, or a prediction market, or 1% of
  everything raised in the race. The ordering check is the part people are
  surprised by and the part that matters most: listing the front-runner first
  is a thumb on the scale nobody consciously notices.
- **Fundraising links are blocked outright**, in the body and in the sources.
  A civic reminder that links to a donation page is a fundraising email in a
  costume.
- **Odds copy has no free-text path.** "Market price" cannot become "likely to
  win"; the sentence is generated.

And four things the database enforces, where no `if` statement can be removed
in a hurry:

- `broadcasts`: `CHECK (approved_by <> created_by)`.
- `notification_events`: `auto_send` is constrained to logistics categories,
  so anything editorial must pass a human.
- Every broadcast and event must carry at least one source.
- `audit_log` and `consent_records` are append-only via triggers **and**
  hash-chained, so tampering is detectable by someone holding database
  credentials. A daily job walks the chain.

`broadcast_audience` has six columns and no JSON escape hatch: races, issues,
states, channels, seat rollup, recency. There is nowhere to type "Republicans
in Georgia", and nothing to type it against.

Everything sent is published at `GET /api/transparency/broadcasts` and on
`#/transparency`, with sources, audience criteria and recipient counts.
`/api/transparency/balance` reports party-mention ratios month by month.
Publishing your own send log is the only one of these safeguards that still
works if the people running Pollbook stop wanting it to.

### The notification pipeline

An **event** is a fact about the world; an **outbox row** is one message to
one person on one channel. Everything hard falls out of the database enforcing
that split:

- Never twice — `UNIQUE (event_id, user_id, channel)`.
- Never at 3am — `send_after` is computed in the recipient's timezone and
  re-checked at claim, because a row retrying since yesterday carries a stale
  answer. An unknown timezone falls back to the narrowest safe window, never
  the broadest.
- Never on two instances — claiming uses `FOR UPDATE SKIP LOCKED`, so
  `ENABLE_JOBS=1` is safe everywhere. No Redis, no leader election.
- Never after a STOP — suppression and consent are re-checked immediately
  before dispatch, not just at fanout. That is what stops the "one more email
  after unsubscribing" that people actually complain about.

Every email carries a one-click unsubscribe with the RFC 8058 headers Gmail
and Yahoo now require, the CAN-SPAM postal address, and the funding line —
added by `src/notify/render.js` rather than by each template, because a
requirement that depends on an author remembering it will eventually be
missing from the one message that matters.

### Two prerequisites with real lead times

Neither is code. Both gate launch.

1. **A2P 10DLC registration** for SMS: weeks, and the Political use case is
   vetted against your entity type — a general commercial LLC often cannot
   register for it and needs a different campaign class. `SMS_ENABLED` is a
   deliberate second switch so a deploy carrying Twilio credentials cannot
   start texting before the registration that permits it exists.
2. **Apple Private Email Relay** domain registration: without it, mail to
   Sign-in-with-Apple users is dropped silently, with no bounce.

### One thing the reminders deliberately do not say

There is no sourced, per-state voter-registration deadline table in this
repo. `usStates.js` has primary and general dates derived from statute and a
vote.gov link, and nothing more.

So deadline reminders anchor on the **election date**, which is defensible,
and send the reader to their state for the deadline itself — rather than
asserting "register by October 6" from a constant nobody can cite. That is
the same discipline as the watchlist in `electionBills.js`, which drops a bill
rather than render an unverified one, and the money-flow diagram, which drops
a figure rather than force it.

When a sourced table exists — one citation per row, rendered in the message —
the templates get a version 2 that names the date.

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
src/data/electionBills.js          Watchlist of landmark election bills (numbers only, verified live)
src/lib/calendar.js                Statutory election-date math + congress numbering
src/lib/cache.js                   TTL cache, stale-on-error
src/lib/moneyFlow.js               Money-flow model: donor channels vs. outside spending, no double-counting
src/lib/rateLimit.js               Per-IP and global ceilings on the metered AI endpoints
src/lib/groq.js                    Groq chat-completions client (GROQ_API_KEY)
src/lib/retrieval.js               Shared Q&A plumbing: untrusted-text fencing, history sanitizing
src/lib/candidateQa.js             Candidate Q&A: grounds Groq in the candidate profile, enforces scope
src/lib/billQa.js                  Bill Q&A: grounds Groq in the Congress.gov record, enforces scope
src/sources/fec.js                 FEC candidates, finance, search
src/sources/congress.js            Congress.gov bills: feed, detail, CRS summaries, bill-number parsing
src/sources/markets.js             PredictIt odds + candidate matching
src/sources/wikipedia.js           Bio + political-positions extraction
src/sources/news.js                Google News RSS
src/sources/webSearch.js           Web search for Q&A (Tavily, Google News RSS fallback)

  — everything below is inert without DATABASE_URL —

src/db/index.js                    pg pool; enabled() gates every account feature
src/db/migrate.js                  Migration runner: advisory lock, checksums, per-file transaction
src/db/migrations/*.sql            The schema, in order. 001 explains what it deliberately omits
src/lib/nonpartisan.js             The neutrality linter, balance rule, and closed audience schema
src/lib/subjects.js                Grammar for trackable races/elections; seats carry across cycles
src/lib/session.js                 Opaque revocable sessions; step-up for PII and sending
src/lib/permissions.js             Roles → permissions; expiring grants
src/lib/consent.js                 Append-only consent log + the suppression list
src/lib/audit.js                   Hash-chained audit writes, PII-scrubbed
src/lib/errors.js                  Keeps Postgres row values and OAuth codes out of logs
src/lib/jwt.js                     ES256 signing (Apple) + RS256/ES256 verification, node:crypto
src/auth/{google,apple,magicLink}.js  The three ways in
src/notify/render.js               The only path to a sendable message; adds the required footers
src/notify/outbox.js               Fanout, claiming, retry, quiet hours
src/notify/providers/              Resend, Twilio, and console/memory for local work
src/workers/                       Scheduler + producers (deadlines, odds, news, reconcile, retention)
src/routes/{auth,account,admin,transparency,webhooks}.js
src/services/{subscriberService,broadcastService}.js
portal/                            Staff frontend — scaffold only; README documents the API it calls

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
| `GET /api/candidates/:id` | Bio, policy positions, finance, news, odds, links, `moneyFlow` diagram model |
| `POST /api/candidates/:id/ask` | AI answer to a question about this candidate (Groq, needs `GROQ_API_KEY`). Body: `{ question, history }`; history stays client-side. Returns `{ answer, sources }`, where `sources` are the web pages consulted (empty when the profile alone sufficed). |
| `GET /api/stats?state=GA` | Campaign-finance snapshot (top fundraisers) |
| `GET /api/search?q=name` | Candidate search across all filed federal candidates |
| `GET /api/committees?q=aipac` | PAC/super-PAC search (alias-aware: AIPAC also finds United Democracy Project) |
| `GET /api/committees/:id` | Committee detail: totals, spending for/against candidates, top recipients |
| `GET /api/bills?q=hr+22` | Election bills before Congress. A query that parses as a bill number resolves that bill directly; otherwise it's a title search over the scanned window (`coverage` reports how many bills that was) |
| `GET /api/bills/:congress/:type/:number` | Bill detail: status, sponsor, cosponsor split, actions, subjects, CRS summary |
| `POST /api/bills/:congress/:type/:number/ask` | AI answer about this bill (Groq, needs `GROQ_API_KEY`). Body: `{ question, history }`; history stays client-side. Returns `{ answer, sources }` |
| `GET /api/markets/national` | Balance-of-power prediction markets |
| `GET /api/meta` | Active data provider — use this to confirm you're seeing live data |

Election IDs are stable and derived: `ga-general-2026`, `wy-primary-2026`, `us-general-2026`. Candidate IDs are FEC candidate IDs in live mode. Bills are addressed by their real coordinates — `119/hr/22` is H.R. 22 in the 119th Congress.

## Extending

Larger planned work — SEO and real URLs, voting records, accounts and alerts,
state-level coverage — is written up in [ROADMAP.md](ROADMAP.md), one section
each with the reasoning and what's already in place.

- **State/local races**: the provider interface is the contract — implement it against Google Civic (`googleCivicProvider.js` has the endpoint mapping plan), a state SoS scraper, or your own Postgres curation and set `DATA_PROVIDER`.
- **More odds sources**: `src/sources/markets.js` isolates the PredictIt schema; add Polymarket or election forecasters behind the same `marketsForRace` shape.
- **2028 and beyond**: general-election dates roll over automatically after election day; add the next cycle's statutory primary dates to `usStates.js` when states publish them. The congress number advances on its own (`calendar.currentCongress`), so the bills feed follows a new Congress without a code change — but watchlist entries in `electionBills.js` are pinned to a congress and will simply stop appearing, which is the intended failure. Add the new Congress's entries when its bills are numbered.
- **State-level election bills**: this covers Congress only. State legislatures write most election law, and their bills are not in the Congress.gov API — [Open States](https://openstates.org/) is the usual source, and would slot in as another module under `src/sources/` behind the same bill shape.

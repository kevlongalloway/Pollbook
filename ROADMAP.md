# Roadmap — work that needs its own session

Each item below is too large to share a prompt with anything else: they touch
many files, need design decisions made as the work goes, or depend on
infrastructure that doesn't exist yet. Every one has a ready-to-paste prompt.

Ordered by leverage, not by effort.

---

## 1. Real URLs and server-side rendering (SEO)

**Why it matters most.** Ballotpedia's moat isn't data quality — it's owning
the Google result for "[candidate name]". Pollbook currently cannot compete for
that at all: hash routing means every candidate and bill page is the *same URL*
to a crawler. `#/candidate/H8GA05123` is invisible. For a civic site, organic
search is the whole acquisition channel, so this is probably worth more than
any feature on this list.

**Why its own session.** It's the one architectural change here. Routing moves
from hash to path, every internal link changes, the server has to render real
`<title>`/meta/summary content per page, old hash URLs need redirecting so
existing links survive, and a sitemap has to be generated from live data.

**Already in place:** `server.js` has `app.get('*', sendIndex)`, so paths like
`/candidate/H8GA05123` already resolve — and the `__BASE_URL__` substitution
machinery for absolute OG tags is built and working.

> Move Pollbook from hash routing to real paths and server-render enough of
> each page for search engines and link previews. Candidate, bill, election,
> and committee pages should each have their own URL, their own `<title>` and
> meta description, and their content in the initial HTML — not just after
> the JS boots. Redirect old `#/...` URLs to the new paths so existing links
> keep working, and generate `/sitemap.xml` from live data. Keep the SPA feel
> for in-app navigation.

---

## 2. Voting records — join the candidate and bill halves

**Why it matters.** Candidate pages know FEC data; bill pages know legislative
data; they don't talk. Connect a candidate to their Congress.gov `bioguideId`
and you get: how an incumbent actually voted on the election bills users are
reading about, how a user's own delegation voted on a given bill, and — the
investigative one — top donor industries cross-referenced against votes
affecting them. OpenSecrets has the money and GovTrack has the votes; nobody
does the join.

**Why its own session.** The FEC-ID ↔ bioguide-ID join is fuzzy name/state/
district matching with real failure modes, and it has to fail closed — showing
the wrong member's votes is worse than showing none. It also needs API
reconnaissance: `/member/{bioguideId}/sponsored-legislation` and
`/cosponsored-legislation` are solid, but roll-call vote coverage in the
Congress.gov v3 API is newer and Senate roll calls are published separately as
XML on senate.gov. Confirm what's actually available before designing the UI.

**Already in place:** `src/sources/congress.js` and its offline test harness;
`markets.attachProbabilities` solves the same shape of fuzzy-matching problem
and is worth reading first.

> Connect Pollbook's candidates to their Congress.gov member records so
> incumbent pages can show what they've sponsored, cosponsored, and voted on —
> especially on the election bills already tracked in the Bills section. Start
> by confirming what roll-call vote data the Congress.gov API actually exposes
> today. The FEC-to-bioguide match must fail closed: when the match isn't
> confident, show nothing rather than risk attributing another member's record
> to this candidate. Follow the existing pattern of stubbing upstreams in
> tests.

---

## 3. Accounts, saved ballots, and alerts

**Why it matters.** This is the actual SaaS layer. "Track this election" is
currently a `localStorage` toggle that does nothing (`app.js`). Real accounts
turn it into email/SMS alerts on filing deadlines, debates, and big outside
spending against a tracked candidate — the recurring engagement a subscription
needs to justify itself.

**Why its own session — probably two or three.** It's the first stateful thing
in the codebase: a database, schema, auth, session handling, an email/SMS
provider, and a scheduler all arrive at once. Treat auth and the alerting
pipeline as separate sessions from the data model.

**Note:** the app is currently stateless by design and degrades well because of
it. That's worth preserving where possible — anonymous browsing should stay
fully functional without an account.

> Add user accounts to Pollbook and make "Track this election" real, persisting
> server-side instead of in localStorage. Start with just the data model and
> auth — no alerting yet. Keep all existing anonymous browsing working exactly
> as it does now; an account should add capability, never gate what's already
> free. Propose the schema and auth approach before writing code.

---

## 4. Odds history

**Why it matters.** PredictIt is polled live and thrown away. Store snapshots
and you get odds-over-time sparklines on candidate and race pages — movement
nobody else surfaces well, and the most compelling thing you can show on a race
page that isn't money.

**Why its own session.** Needs somewhere durable to write. Small once item 3
exists; standalone it needs its own storage decision.

> Store a time series of PredictIt prices so Pollbook can show how a race's
> odds have moved, as a sparkline on candidate and race pages. Keep the
> existing honesty framing — these are market prices, not forecasts.

---

## 5. State and local coverage (Open States)

**Why it matters.** FEC data is federal-only, so every state and local race is
a dead end — `liveProvider.js` literally tells users to *"check your Secretary
of State or Ballotpedia"*, sending them to the competitor. It matters doubly
now: state legislatures write most election law, and the Bills page covers
Congress only.

**Why its own session.** A whole new data domain behind the provider interface:
state legislators, state races, state bills, each with their own shapes and
coverage gaps. It's also the item that competes most directly with Ballotpedia's
real strength, so sequence it after the cheaper wins.

> Add state-level coverage to Pollbook using the Open States API — state
> legislators, state races, and state election bills — behind the existing
> provider interface. Federal data should keep coming from the FEC and
> Congress.gov; this fills the gap where those return nothing. Follow the
> established source module pattern with an overridable API base and offline
> stub tests.

---

## 6. Stream the AI answers

**Why it matters.** Both Q&A panels are blocking POSTs with a 25-second budget.
A 15-second wait behind a "Thinking…" placeholder reads as broken even when
it's working.

**Why its own session.** Changes the response contract: `groq.js` has to
stream, both `/ask` routes become SSE, the frontend needs incremental
rendering, and the existing Q&A tests assert on a JSON body. Contained, but not
a drive-by.

> Stream the AI answers in Pollbook's candidate and bill Q&A panels so text
> appears as it's generated instead of after a 25-second wait. Keep the source
> citations working and update the existing tests, which currently assert on a
> single JSON response body.

---

## 7. "My Ballot" — address-based sample ballot

**Why it matters.** The single most-searched thing in this category: "what's on
my ballot". Precinct-level races and measures for an address, printable to take
into the booth. It's the biggest user-facing gap against Ballotpedia.

**Why its own session.** Needs an address→district resolver (Google Civic's
`voterinfo`, or Census geocoding plus district shapefiles), address handling
and its privacy implications, and a print stylesheet.

**Already in place:** `src/providers/googleCivicProvider.js` is a documented
stub with the endpoint mapping already planned out — read it first.

> Build a "My Ballot" feature for Pollbook: the user enters an address and gets
> every race and ballot measure they can actually vote in, in a form they can
> print and take to the polls. See the endpoint mapping already sketched in
> `src/providers/googleCivicProvider.js`. Don't store addresses server-side
> without saying so explicitly.

---

## Smaller leftovers

Not worth a session each — fold into whatever session touches that area.

- **Cookie consent for AdSense.** `index.html` loads AdSense with no consent
  management. CCPA applies to California visitors; GDPR if you ever get EU
  traffic. Fold into the SEO session, which is already in that file.
- **Persistent cache across redeploys.** The snapshot lives in the OS temp
  directory, which survives a restart but not a redeploy. Point `CACHE_FILE`
  at a mounted volume on the host to fix — configuration, not code.
- **Watchlist upkeep.** `src/data/electionBills.js` pins bills per Congress.
  Entries stop appearing when a new Congress convenes — that's the intended
  failure, but it means adding the new numbers each cycle.

-- What a person can follow, and the issues they care about.
--
-- The hard part: races and elections have no table anywhere in Pollbook. They
-- are *derived strings*, computed per request by lib/calendar.js and
-- liveProvider.buildRaces() — `ga-senate-2026`, `ga-general-2026`,
-- `ga-house-04-2026`. There is nothing to foreign-key to, and three
-- properties make that awkward:
--
--   - They embed a cycle year, so every one of them expires. Somebody who
--     follows `ga-senate-2026` hears nothing in 2028.
--   - They can vanish and come back: buildRaces only emits a Senate race when
--     the FEC returned candidates, so an upstream outage deletes it briefly.
--   - They are user-supplied strings arriving on a URL.
--
-- The answer has three parts. Keys are grammar-checked before they are stored
-- (lib/subjects.js, in the spirit of billParams() in routes/api.js), so a
-- malformed or hostile key never reaches this table. Every race key also
-- yields a cycle-free **seat** key — `seat:ga-senate` — and tracking a race
-- also creates a standing subscription to its seat, which is what carries a
-- subscriber across cycles. And this table is a *cache with a label snapshot*,
-- never the source of truth: rows are never deleted, so a subscription
-- survives an upstream outage and renders from `label` while it lasts.

CREATE TABLE subjects (
  key              text PRIMARY KEY,            -- 'race:ga-senate-2026' — grammar-validated in app
  type             text NOT NULL CHECK (type IN
                     ('election', 'race', 'seat', 'candidate', 'committee', 'bill', 'state', 'issue')),
  -- Races point at their cycle-free seat. Seats point at nothing.
  seat_key         text REFERENCES subjects(key),
  state_code       char(2),
  cycle            integer,
  -- A snapshot, so a tracked-list page renders when the FEC is unreachable.
  -- Refreshed by the reconcile job; never treated as authoritative.
  label            text NOT NULL,
  label_updated_at timestamptz NOT NULL DEFAULT now(),
  -- 'unresolved' means the provider stopped returning it, which is usually an
  -- outage and occasionally a real change. Never auto-deleted: a subscription
  -- must outlive a bad afternoon at the FEC.
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'unresolved', 'retired')),
  last_verified_at timestamptz,
  unresolved_since timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subjects_seat_shape CHECK (seat_key IS NULL OR type = 'race')
);
CREATE INDEX subjects_seat_idx   ON subjects (seat_key);
CREATE INDEX subjects_state_idx  ON subjects (state_code, type);
CREATE INDEX subjects_status_idx ON subjects (status);

-- Genuine ID-shape changes — a district renumbered by redistricting, say.
-- Fanout follows these transitively, depth-capped in app code.
CREATE TABLE subject_aliases (
  old_key    text PRIMARY KEY,
  new_key    text NOT NULL REFERENCES subjects(key),
  reason     text NOT NULL,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (old_key <> new_key)
);

CREATE TABLE subscriptions (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_key text NOT NULL REFERENCES subjects(key) ON DELETE RESTRICT,
  -- 'derived' marks the seat subscription created alongside an explicit race
  -- one, so the account page can show "you follow this race" without also
  -- listing the machinery that keeps it alive next cycle.
  source      text NOT NULL DEFAULT 'explicit'
              CHECK (source IN ('explicit', 'derived', 'imported')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  muted_until timestamptz,
  UNIQUE (user_id, subject_key)
);
CREATE INDEX subscriptions_subject_idx ON subscriptions (subject_key);
CREATE INDEX subscriptions_user_idx    ON subscriptions (user_id);

-- The issue taxonomy.
--
-- An issue is a SUBJECT, never a POSITION. "Voting access" is a subject;
-- "election integrity" and "ballot security" are positions wearing a subject's
-- clothes, and picking between those two names is itself a partisan act. So
-- the vocabulary is reviewed: an editor proposes, compliance approves, and
-- lib/nonpartisan.js lints the name and description on the way in.
CREATE TABLE issues (
  slug        text PRIMARY KEY,                 -- 'voting-access'
  name        text NOT NULL,
  description text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Which issues a person wants information about.
--
-- There is deliberately no `stance`, `position`, `support`, or `oppose`
-- column. We record that somebody wants to hear about redistricting. We do
-- not record, infer, or store what they think about it — that is the field
-- that would turn this table into a targeting database.
CREATE TABLE user_issues (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_slug text NOT NULL REFERENCES issues(slug) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, issue_slug)
);
CREATE INDEX user_issues_issue_idx ON user_issues (issue_slug);

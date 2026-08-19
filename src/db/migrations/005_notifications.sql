-- The notification pipeline: templates, events, the outbox, delivery records,
-- provider callbacks, and the scheduler.
--
-- The shape that makes this work is the split between an **event** (a fact
-- about the world: "Georgia's registration deadline is in 14 days") and an
-- **outbox row** (one message to one person on one channel). Producers create
-- events and are idempotent on `dedup_key`; fanout expands an event into
-- outbox rows and is idempotent on the unique constraint below. Neither
-- depends on worker logic being correct under concurrency, which matters
-- because Render runs more than one instance and a duplicate election
-- reminder is the kind of mistake people unsubscribe over.

-- Versioned, reviewed copy. Free text in a send path is where neutrality
-- dies, so the only thing the pipeline can send is a template that a human
-- other than its author approved.
CREATE TABLE message_templates (
  key            text PRIMARY KEY,              -- 'deadline.registration.t14'
  channel        text NOT NULL CHECK (channel IN ('email', 'sms', 'both')),
  category       text NOT NULL,
  subject_tpl    text,
  body_tpl       text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  body_sha256    bytea NOT NULL,
  lint_report    jsonb,
  lint_passed_at timestamptz,
  created_by     bigint REFERENCES users(id),
  approved_by    bigint REFERENCES users(id),
  approved_at    timestamptz,
  active         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Two-person rule, at the database. Seeded templates have NULL for both and
  -- are reviewed in the migration diff instead.
  CONSTRAINT tpl_two_person CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- One row per fact about the world.
CREATE TABLE notification_events (
  id            bigserial PRIMARY KEY,
  dedup_key     text NOT NULL UNIQUE,           -- 'deadline:GA:reg:2026-10-05:T-14'
  category      text NOT NULL CHECK (category IN
                  ('deadlines', 'odds', 'news', 'filings', 'product')),
  subject_key   text REFERENCES subjects(key),
  state_code    char(2),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_key  text NOT NULL REFERENCES message_templates(key),
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label, url}]
  broadcast_id  bigint,                         -- FK added in 006, after broadcasts exists
  -- The load-bearing safeguard, expressed as a constraint rather than a
  -- policy sentence: only logistics can be sent without a human approving the
  -- words. Anything editorial — odds movement, news, new filings — has to go
  -- through the broadcast approval workflow, where the neutrality linter, the
  -- candidate-balance rule and a second person all stand in the way.
  auto_send     boolean NOT NULL DEFAULT false,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  fanned_out_at timestamptz,
  CONSTRAINT ev_sources_present CHECK (jsonb_array_length(sources) >= 1),
  CONSTRAINT ev_autosend_scope  CHECK (auto_send = false OR category IN ('deadlines', 'product'))
);
CREATE INDEX events_pending_idx ON notification_events (occurred_at) WHERE fanned_out_at IS NULL;
CREATE INDEX events_subject_idx ON notification_events (subject_key, occurred_at DESC);

-- The queue. The UNIQUE below is the entire "never the same alert twice"
-- guarantee, and it is the database's job rather than the worker's.
CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  event_id         bigint NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id       bigint NOT NULL REFERENCES contact_channels(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('email', 'sms')),
  -- NULL sends immediately; otherwise 'u42:2026-10-05', collapsed by the
  -- digest worker into one message at the user's local morning.
  digest_bucket    text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN
                     ('pending', 'claimed', 'sent', 'failed', 'suppressed',
                      'cancelled', 'digested')),
  -- Quiet-hours-adjusted at enqueue, and re-checked at claim: a row that
  -- retries after three failures must not fire at 3am because its send_after
  -- was computed yesterday.
  send_after       timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  locked_by        text,
  attempts         smallint NOT NULL DEFAULT 0,
  last_error       text,
  rendered_subject text,
  rendered_body    text,                        -- PII-adjacent: names their state and races
  body_sha256      bytea,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  UNIQUE (event_id, user_id, channel)
);
CREATE INDEX outbox_claim_idx  ON outbox (send_after, id) WHERE status = 'pending';
CREATE INDEX outbox_digest_idx ON outbox (digest_bucket) WHERE status = 'pending';
CREATE INDEX outbox_user_idx   ON outbox (user_id, created_at DESC);

CREATE TABLE deliveries (
  id              bigserial PRIMARY KEY,
  outbox_id       bigint REFERENCES outbox(id) ON DELETE SET NULL,
  user_id         bigint REFERENCES users(id) ON DELETE SET NULL,
  -- The address itself is not duplicated here; the hash is enough to join
  -- suppression and enough to answer "did this address get this message".
  address_hash    bytea NOT NULL,
  channel         text NOT NULL,
  provider        text NOT NULL,                -- 'resend' | 'twilio' | 'console' | 'memory'
  provider_msg_id text,
  status          text NOT NULL CHECK (status IN
                    ('queued', 'sent', 'delivered', 'bounced', 'complained',
                     'failed', 'undelivered')),
  status_at       timestamptz NOT NULL DEFAULT now(),
  segments        smallint,                     -- SMS billing segments
  error_code      text,
  raw             jsonb
);
CREATE INDEX deliveries_provider_idx ON deliveries (provider, provider_msg_id);
CREATE INDEX deliveries_user_idx     ON deliveries (user_id, status_at DESC);
CREATE INDEX deliveries_recent_idx   ON deliveries (status_at DESC);

-- Raw provider callbacks, stored before they are processed. The UNIQUE makes
-- replays free, and keeping the raw body means a processing bug can be
-- replayed rather than reconstructed from logs.
CREATE TABLE webhook_events (
  id                bigserial PRIMARY KEY,
  provider          text NOT NULL,
  provider_event_id text,
  signature_ok      boolean NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  process_error     text,
  headers           jsonb NOT NULL DEFAULT '{}'::jsonb,
  body              jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX webhook_unprocessed_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

-- The scheduler.
--
-- Cron expressions do not survive multiple instances — every instance would
-- run every job. A row per job plus FOR UPDATE SKIP LOCKED does: exactly one
-- instance claims a due job, and a crashed instance's claim simply becomes
-- available again when locked_until passes. No Redis, no leader election, no
-- dedicated worker dyno.
CREATE TABLE scheduled_jobs (
  key                  text PRIMARY KEY,        -- 'producer.deadlines'
  interval_ms          integer NOT NULL,
  next_run_at          timestamptz NOT NULL DEFAULT now(),
  locked_until         timestamptz,
  locked_by            text,
  last_run_at          timestamptz,
  last_status          text,
  last_error           text,
  last_duration_ms     integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  enabled              boolean NOT NULL DEFAULT true
);

-- Prediction-market history.
--
-- PredictIt is polled live and thrown away today. Keeping snapshots is what
-- makes an odds-movement alert possible at all, and it incidentally gives
-- race and candidate pages the odds-over-time sparkline in ROADMAP item 4.
CREATE TABLE market_snapshots (
  id            bigserial PRIMARY KEY,
  market_id     integer NOT NULL,
  subject_key   text REFERENCES subjects(key),
  contract_name text NOT NULL,
  price         numeric(5, 4) NOT NULL CHECK (price BETWEEN 0 AND 1),
  captured_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_snap_idx    ON market_snapshots (market_id, contract_name, captured_at DESC);
CREATE INDEX market_subject_idx ON market_snapshots (subject_key, captured_at DESC);

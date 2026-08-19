-- Human-authored messages, and the workflow that stands between somebody
-- writing words and forty thousand people reading them.
--
-- Everything in this file exists because a nonpartisan claim that rests on
-- good intentions is worth nothing. The constraints here hold when the people
-- running the product are tired, in a hurry, or would quite like to put a
-- thumb on the scale.

CREATE TABLE broadcasts (
  id              bigserial PRIMARY KEY,
  public_id       uuid NOT NULL UNIQUE,
  title           text NOT NULL,                -- internal name, never sent
  category        text NOT NULL CHECK (category IN
                    ('odds', 'news', 'filings', 'product', 'deadlines')),
  channel         text NOT NULL CHECK (channel IN ('email', 'sms', 'both')),
  subject_key     text REFERENCES subjects(key),
  subject_line    text,
  body            text NOT NULL,
  -- Recomputed at send and compared. Approved copy cannot be edited after
  -- approval and slipped out: a mismatch aborts the send.
  body_sha256     bytea NOT NULL,
  sources         jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_assisted     boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft', 'lint_failed', 'pending_approval', 'approved',
                     'scheduled', 'sending', 'sent', 'rejected', 'cancelled')),
  lint_report     jsonb,
  lint_passed_at  timestamptz,
  -- Which candidates the copy named, which the balance rule required, and in
  -- what order they appeared. Shown to the approver, and published.
  balance_report  jsonb,
  created_by      bigint NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     bigint REFERENCES users(id),
  approved_at     timestamptz,
  sent_by         bigint REFERENCES users(id),
  sent_at         timestamptz,
  scheduled_for   timestamptz,
  recipient_count integer,
  -- Every sent broadcast is published at /api/transparency/broadcasts.
  -- Nothing disciplines copy like knowing the other side will read it.
  published_at    timestamptz,
  CONSTRAINT bc_sources_present CHECK (jsonb_array_length(sources) >= 1),
  -- The two-person rule, as a database constraint rather than an app check,
  -- because an app check is one `if` away from being removed by somebody in a
  -- hurry and this one should cost a migration and a code review.
  CONSTRAINT bc_two_person     CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT bc_approved_lint  CHECK (status <> 'approved' OR lint_passed_at IS NOT NULL)
);
CREATE INDEX broadcasts_status_idx ON broadcasts (status, created_at DESC);
CREATE INDEX broadcasts_sent_idx   ON broadcasts (sent_at DESC) WHERE status = 'sent';

ALTER TABLE notification_events
  ADD CONSTRAINT events_broadcast_fk
  FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE SET NULL;

-- The audience selector.
--
-- **This schema is the enforcement mechanism.** The only dimensions that can
-- be expressed are what somebody chose to follow, what issues they asked
-- about, where they are, which channel they use, and how recently they were
-- active. There is no `filter` column, no raw-SQL column, no jsonb escape
-- hatch, and no saved-segment table. If somebody wants to mail "Republicans
-- in Georgia" there is nowhere to type it — and since users.party does not
-- exist either, there would be nothing to type it against.
CREATE TABLE broadcast_audience (
  broadcast_id        bigint PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  subject_keys        text[] NOT NULL DEFAULT '{}',
  -- Follow the seat as well as the pinned race, so people who started
  -- following in a previous cycle are included.
  include_seat_rollup boolean NOT NULL DEFAULT true,
  issue_slugs         text[] NOT NULL DEFAULT '{}',
  state_codes         char(2)[] NOT NULL DEFAULT '{}',
  channels            text[] NOT NULL DEFAULT '{email}',
  active_since_days   integer,
  CONSTRAINT aud_channels CHECK (channels <@ ARRAY['email', 'sms']::text[]),
  CONSTRAINT aud_nonempty CHECK (
    cardinality(subject_keys) + cardinality(issue_slugs) + cardinality(state_codes) > 0)
);

CREATE TABLE broadcast_approvals (
  id           bigserial PRIMARY KEY,
  broadcast_id bigint NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  actor_id     bigint NOT NULL REFERENCES users(id),
  decision     text NOT NULL CHECK (decision IN ('approve', 'reject', 'request_changes')),
  note         text,
  -- What they actually read. If the body changed after the approval, this
  -- hash no longer matches and the send is refused.
  body_sha256  bytea NOT NULL,
  -- Warnings the linter raised that the approver consciously accepted, with
  -- their reason. A warning cannot be silently ignored.
  acknowledged jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broadcast_approvals_bc_idx ON broadcast_approvals (broadcast_id, decided_at DESC);

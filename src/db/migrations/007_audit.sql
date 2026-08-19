-- The audit log.
--
-- Append-only and hash-chained, for a specific reason: the interesting
-- question is not "what did the app do" — logs answer that — but "did anybody
-- quietly change who a message went to, or read a subscriber's record and
-- then remove the trace." That threat model includes somebody holding
-- database credentials, so the integrity guarantee cannot depend on the
-- application being the only writer.
--
-- Each row commits to its predecessor's hash. Removing or editing a row
-- breaks the chain at that point and every row after it, which a daily
-- verification job detects. 012_lockdown.sql additionally revokes UPDATE,
-- DELETE and TRUNCATE from the application role, so the ordinary path cannot
-- do it at all.
--
-- `detail` never contains raw PII values — it records *that* an address was
-- read, not what it was.

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  actor_user_id   bigint REFERENCES users(id),
  actor_role      text,
  action          text NOT NULL,                -- 'pii.read' | 'broadcast.send' | 'role.grant'
  object_type     text NOT NULL,
  object_id       text,
  subject_user_id bigint REFERENCES users(id),  -- whose data was touched
  outcome         text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'denied', 'error')),
  ip              inet,                         -- PII
  user_agent      text,                         -- PII
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  prev_hash       bytea,
  row_hash        bytea NOT NULL
);
CREATE INDEX audit_actor_idx   ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_subject_idx ON audit_log (subject_user_id, occurred_at DESC);
CREATE INDEX audit_action_idx  ON audit_log (action, occurred_at DESC);
CREATE INDEX audit_time_idx    ON audit_log (occurred_at DESC);

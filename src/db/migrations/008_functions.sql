-- Functions and triggers: quiet-hours arithmetic, append-only enforcement,
-- and the hash chains that make the audit and consent logs tamper-evident.

/* ---------------- quiet hours ----------------

   The TCPA window is 8am–9pm in the *recipient's* local time, and "local"
   means their timezone, not the server's and not the state's — which is why
   users.timezone is captured from the browser at signup rather than guessed.

   Returns the earliest instant at or after `ts` that falls inside the
   window. Called at enqueue to set outbox.send_after, and again inside the
   claim query, because a row that has been retrying since yesterday would
   otherwise fire at 3am on the strength of a stale send_after.               */

CREATE OR REPLACE FUNCTION next_allowed_send(
  ts          timestamptz,
  tz          text,
  start_hour  smallint,
  end_hour    smallint
) RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  local_ts  timestamp;
  local_day date;
  hour_now  smallint;
BEGIN
  -- An unknown timezone must never mean "send at any hour". Fall back to
  -- Eastern, which is the narrowest safe choice for a US audience: it opens
  -- last relative to every zone west of it.
  BEGIN
    local_ts := ts AT TIME ZONE tz;
  EXCEPTION WHEN OTHERS THEN
    tz := 'America/New_York';
    local_ts := ts AT TIME ZONE tz;
  END;

  local_day := local_ts::date;
  hour_now  := EXTRACT(hour FROM local_ts)::smallint;

  IF hour_now >= start_hour AND hour_now < end_hour THEN
    RETURN ts;                                   -- already inside the window
  END IF;

  IF hour_now < start_hour THEN
    RETURN (local_day + make_interval(hours => start_hour)) AT TIME ZONE tz;
  END IF;

  -- After the window closed: the start of tomorrow's.
  RETURN (local_day + 1 + make_interval(hours => start_hour)) AT TIME ZONE tz;
END;
$$;

/* ---------------- append-only enforcement ----------------

   A trigger rather than only a REVOKE, because the REVOKE in 012 applies to
   the application role and a migration or a psql session runs as the owner.
   This one stops everybody, including a tired engineer at 1am.              */

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. A correction is a new row.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

/* consent_records permits exactly one mutation: erasing the plaintext
   address on account deletion. The hash stays, so suppression keeps working
   and the chain stays verifiable — the row is redacted, never removed.      */

CREATE OR REPLACE FUNCTION consent_records_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_records is append-only: DELETE is not permitted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The only legal update: address -> NULL, everything else untouched.
  IF NEW.address IS NOT NULL
     OR OLD.address IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.address_hash IS DISTINCT FROM OLD.address_hash
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.consent_type IS DISTINCT FROM OLD.consent_type
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.consent_text IS DISTINCT FROM OLD.consent_text
     OR NEW.consent_text_version IS DISTINCT FROM OLD.consent_text_version
     OR NEW.consent_text_sha256 IS DISTINCT FROM OLD.consent_text_sha256
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
     OR NEW.row_hash IS DISTINCT FROM OLD.row_hash
  THEN
    RAISE EXCEPTION
      'consent_records is append-only: the only permitted update is redacting address on erasure.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_records_append_only
  BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_records_guard();

/* ---------------- hash chains ----------------

   row_hash = sha256(prev_hash || canonical_json(row without the hashes))

   The advisory lock serializes appends so two concurrent inserts cannot both
   chain off the same predecessor and silently fork the chain. Both tables are
   low-volume — a lock here costs nothing and buys an invariant that is
   otherwise only probably true.                                             */

CREATE OR REPLACE FUNCTION chain_hash_row() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous bytea;
  body     jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME));

  EXECUTE format('SELECT row_hash FROM %I ORDER BY id DESC LIMIT 1', TG_TABLE_NAME)
    INTO previous;

  body := to_jsonb(NEW) - 'row_hash' - 'prev_hash' - 'id';

  NEW.prev_hash := previous;
  NEW.row_hash  := sha256(COALESCE(previous, ''::bytea) || convert_to(body::text, 'UTF8'));
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION chain_hash_row();

CREATE TRIGGER consent_records_chain
  BEFORE INSERT ON consent_records
  FOR EACH ROW EXECUTE FUNCTION chain_hash_row();

/* ---------------- updated_at ---------------- */

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch      BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER issues_touch     BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER broadcasts_touch BEFORE UPDATE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

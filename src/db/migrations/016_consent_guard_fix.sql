-- Let a consent record outlive the account it belonged to.
--
-- `consent_records.user_id` is declared ON DELETE SET NULL on purpose: the
-- record of what somebody agreed to has to survive their account being
-- removed, or a deleted address could be re-imported and mailed again — which
-- is precisely what the person was trying to prevent.
--
-- But the append-only guard from migration 008 refused every UPDATE except
-- redacting the address, so the foreign key's own `user_id := NULL` was
-- blocked and a hard DELETE of a user failed outright. The soft-delete path in
-- subscriberService never hit it; a retention job or an operator running DELETE
-- would have.
--
-- So the guard now permits exactly two mutations, both of them severances
-- rather than edits, and both of which leave every substantive field alone:
--
--   * address  -> NULL   (erasure: the hash and the evidence stay)
--   * user_id  -> NULL   (the account went away; the consent record does not)
--
-- What the guarantee actually is, stated plainly: the trigger prevents any
-- field of a consent record from being rewritten, and the hash chain detects
-- rows being inserted, removed or reordered. Together those mean a consent
-- record cannot be forged or quietly deleted. Neither mechanism claims that
-- row_hash still matches the row's current bytes after a permitted redaction —
-- it does not, and verifyChain checks linkage rather than content for exactly
-- that reason.

CREATE OR REPLACE FUNCTION consent_records_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_records is append-only: DELETE is not permitted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Every field that carries meaning must be untouched.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.address_hash IS DISTINCT FROM OLD.address_hash
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.consent_type IS DISTINCT FROM OLD.consent_type
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.consent_text IS DISTINCT FROM OLD.consent_text
     OR NEW.consent_text_version IS DISTINCT FROM OLD.consent_text_version
     OR NEW.consent_text_sha256 IS DISTINCT FROM OLD.consent_text_sha256
     OR NEW.page_url IS DISTINCT FROM OLD.page_url
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
     OR NEW.row_hash IS DISTINCT FROM OLD.row_hash
  THEN
    RAISE EXCEPTION
      'consent_records is append-only: a correction is a new row, never an edit.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The only permitted changes are severances, and only in one direction.
  IF NEW.address IS DISTINCT FROM OLD.address AND NEW.address IS NOT NULL THEN
    RAISE EXCEPTION
      'consent_records: address may only be cleared, never rewritten.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL THEN
    RAISE EXCEPTION
      'consent_records: user_id may only be cleared, never reassigned.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

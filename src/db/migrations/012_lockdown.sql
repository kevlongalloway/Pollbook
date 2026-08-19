-- @no-transaction
-- Revoke mutation on the append-only tables from the application role.
--
-- The triggers in 008 already refuse UPDATE and DELETE, and they refuse it for
-- everybody including the schema owner. This adds a second, independent layer:
-- if a future migration drops a trigger — deliberately or by accident — the
-- application's own credentials still cannot rewrite history.
--
-- It only does anything when a separate, non-owning role exists for the app,
-- because a role that owns a table keeps implicit rights over it no matter
-- what you revoke. The common one-role setup therefore gets the triggers only,
-- which is still a real guarantee; on Render, create a second role for the
-- application and this becomes defence in depth. The role is found either by
-- the conventional name `pollbook_app` or by a database-level setting:
--
--   ALTER DATABASE pollbook SET pollbook.app_role = 'whatever_you_called_it';
--
-- Note what is NOT revoked: UPDATE on consent_records. Erasing a subscriber's
-- plaintext address on a deletion request is an UPDATE, and it is the one
-- mutation the guard trigger in 008 permits — the row is redacted in place so
-- the hash chain and the suppression entry both survive. Revoking it here
-- would make honouring a deletion request impossible.
--
-- Runs outside a transaction so a failure cannot roll back the record of the
-- migrations applied alongside it.

DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('pollbook.app_role', true), ''), 'pollbook_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE
      'lockdown: no separate application role (looked for %). The append-only triggers '
      'still apply to everyone; create a non-owning role and re-run to add the REVOKE layer.',
      app_role;
    RETURN;
  END IF;

  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM %I', app_role);
  EXECUTE format('REVOKE DELETE, TRUNCATE ON consent_records FROM %I', app_role);

  RAISE NOTICE 'lockdown: revoked history-rewriting privileges on the append-only tables from %.',
    app_role;
END;
$$;

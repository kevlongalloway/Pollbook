-- Per-user permission grants, for the permissions no role carries.
--
-- `pii.export_bulk` is the reason this table exists. It is seeded into
-- `permissions` and attached to no role, so the only way to hold it is a
-- deliberate grant to one named person — and lib/permissions.js refuses to
-- resolve it from a grant with no `expires_at`, so it is always temporary.
--
-- The effect: there is no standing ability to download the subscriber list.
-- Getting one takes an owner, a reason, an expiry, and a row in the audit log
-- that nobody can delete.

CREATE TABLE user_permissions (
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted_by     bigint REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  reason         text NOT NULL,
  PRIMARY KEY (user_id, permission_key)
);
CREATE INDEX user_permissions_expiry_idx ON user_permissions (expires_at)
  WHERE expires_at IS NOT NULL;

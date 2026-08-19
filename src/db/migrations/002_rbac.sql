-- Roles and permissions.
--
-- The organising principle: **reaching a subscriber and knowing who a
-- subscriber is are separate grants, and neither is bundled into "admin".**
-- An engineering account that gets compromised should not be able to text
-- forty thousand people about an election, and should not be able to download
-- the list either. Both of those need roles an engineer does not hold.
--
-- The rows themselves are seeded in 009_seed_rbac.sql so the whole permission
-- model shows up in a diff and is identical in every environment.

CREATE TABLE permissions (
  key         text PRIMARY KEY,                 -- 'broadcast.send'
  description text NOT NULL,
  -- Permissions that touch a person's data or reach their inbox require a
  -- recent re-authentication (sessions.elevated_until).
  needs_step_up boolean NOT NULL DEFAULT false
);

CREATE TABLE roles (
  key         text PRIMARY KEY,                 -- 'editor'
  name        text NOT NULL,
  description text NOT NULL,
  is_staff    boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100
);

CREATE TABLE role_permissions (
  role_key       text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE user_roles (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key   text NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
  granted_by bigint REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- Time-boxed elevation is a first-class feature, not an afterthought.
  -- Campaign-season surge staffing gets a 90-day grant that expires on its
  -- own, and the one permission that can export the subscriber list can only
  -- ever be granted with an expiry.
  expires_at timestamptz,
  note       text,
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX user_roles_role_idx   ON user_roles (role_key);
CREATE INDEX user_roles_expiry_idx ON user_roles (expires_at) WHERE expires_at IS NOT NULL;

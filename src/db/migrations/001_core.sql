-- Core identity: accounts, provider links, sessions, and the short-lived
-- credentials that mint them.
--
-- Deliberately absent from this file, and from every other one: any column
-- recording a person's party, party registration, ideology, political lean,
-- vote history, or modeled political score. Pollbook cannot target by those
-- because it never learns them. test/nonpartisan.js asserts this by scanning
-- the applied schema, so the omission is enforced rather than remembered.

CREATE TABLE users (
  id                bigserial PRIMARY KEY,
  -- The API never exposes the bigint. Sequential IDs leak subscriber counts
  -- and growth rate to anyone who signs up and reads their own record.
  public_id         uuid NOT NULL UNIQUE,
  email             text NOT NULL,              -- PII: as the user typed it
  email_normalized  text NOT NULL,              -- PII: lower(trim(email)); the uniqueness key
  email_verified_at timestamptz,
  display_name      text,                       -- PII: optional, shown only back to them
  state_code        char(2),                    -- validated in app against data/usStates.js
  zip5              char(5),                    -- PII: never ZIP+4, which resolves to a household
  timezone          text NOT NULL DEFAULT 'America/New_York',
  locale            text NOT NULL DEFAULT 'en-US',
  -- Self-attested 16+. COPPA's line is 13; 16 leaves margin and matches the
  -- age several states allow pre-registration to vote.
  age_attested_at   timestamptz,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deleted')),
  signup_source     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {path, ref, utm_*}
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz,
  deleted_at        timestamptz,
  CONSTRAINT users_zip5_digits  CHECK (zip5 IS NULL OR zip5 ~ '^[0-9]{5}$'),
  CONSTRAINT users_state_upper  CHECK (state_code IS NULL OR state_code ~ '^[A-Z]{2}$'),
  CONSTRAINT users_email_lower  CHECK (email_normalized = lower(email_normalized))
);

-- Partial, so a deleted account's address can be reused by a genuine
-- re-signup while the tombstone row stays for the audit trail.
CREATE UNIQUE INDEX users_email_norm_uq ON users (email_normalized) WHERE deleted_at IS NULL;
CREATE INDEX users_state_idx  ON users (state_code) WHERE status = 'active';
CREATE INDEX users_status_idx ON users (status);

-- One account, many sign-in methods. The (provider, subject) pair is the
-- identity key — never the email, which Apple may rotate behind a relay.
CREATE TABLE user_identities (
  id                bigserial PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('google', 'apple', 'email')),
  provider_subject  text NOT NULL,              -- PII: the `sub` claim
  email_at_provider text,                       -- PII: may be an Apple private-relay address
  is_private_relay  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- Opaque session IDs, not JWTs. Revocation matters more than statelessness
-- here: offboarding an employee, "sign out everywhere", and the step-up
-- window for reading subscriber data all need the server to be able to say no
-- immediately. Only the SHA-256 of the token is stored, so a database dump
-- does not hand over live sessions.
CREATE TABLE sessions (
  id             bigserial PRIMARY KEY,
  public_id      uuid NOT NULL UNIQUE,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason text,
  ip             inet,                          -- PII: address at first sight
  user_agent     text,                          -- PII: truncated to 300 chars in app
  -- Step-up window. Reading subscriber data or sending a broadcast requires a
  -- recent re-authentication, so a session stolen from an idle laptop cannot
  -- immediately reach the things that matter.
  elevated_until timestamptz
);
CREATE INDEX sessions_user_idx   ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Magic links and email-verification codes. Hashed at rest for the same
-- reason as sessions, single-use by a conditional UPDATE rather than a
-- SELECT-then-UPDATE, which two instances would both win.
CREATE TABLE login_tokens (
  id               bigserial PRIMARY KEY,
  email_normalized text NOT NULL,               -- PII: not a FK; may pre-date the user row
  token_hash       bytea NOT NULL UNIQUE,
  purpose          text NOT NULL
                   CHECK (purpose IN ('login', 'email_verify', 'email_change')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  request_ip       inet,                        -- PII
  user_agent       text,                        -- PII
  redirect_to      text                         -- app-relative path only, validated in app
);
CREATE INDEX login_tokens_email_idx   ON login_tokens (email_normalized, created_at DESC);
CREATE INDEX login_tokens_expiry_idx  ON login_tokens (expires_at) WHERE consumed_at IS NULL;

-- In-flight OAuth transactions: PKCE verifier, state, nonce.
--
-- These live in Postgres rather than a cookie for a specific reason. Sign in
-- with Apple uses response_mode=form_post, which means the callback is a
-- cross-site POST from appleid.apple.com — and a SameSite=Lax cookie is not
-- sent on one. A cookie-based state parameter simply does not arrive. The
-- `state` value in the form body is the correlator instead, and putting it
-- here also makes the flow survive landing on a different Render instance
-- than the one that started it.
CREATE TABLE auth_transactions (
  state         text PRIMARY KEY,               -- 32 random bytes, base64url
  provider      text NOT NULL CHECK (provider IN ('google', 'apple')),
  code_verifier text NOT NULL,
  nonce         text NOT NULL,
  redirect_to   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX auth_transactions_expiry_idx ON auth_transactions (expires_at);

-- Cross-instance throttle for credential issuance.
--
-- lib/rateLimit.js documents itself as per-process, which is the right call
-- for protecting an AI quota but the wrong one for minting login links: two
-- instances behind a load balancer would allow double, and the whole point of
-- the limit is that it is absolute.
CREATE TABLE auth_attempts (
  bucket       text NOT NULL,                   -- 'magic:<sha256(email)>' | 'ip:<addr>'
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX auth_attempts_window_idx ON auth_attempts (window_start);

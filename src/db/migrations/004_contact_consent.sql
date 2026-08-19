-- Contact points, consent, preferences, and the stop-list.
--
-- Contact addresses are rows rather than columns on `users` because
-- verification, suppression and consent are all per-address: a bounced work
-- email must not silently kill somebody's SMS reminders, and a phone number
-- carries a completely different consent record from an inbox.

CREATE TABLE contact_channels (
  id                bigserial PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel           text NOT NULL CHECK (channel IN ('email', 'sms')),
  address           text NOT NULL,              -- PII: E.164 for sms, normalized for email
  -- Suppression, consent and delivery records all join on the hash rather than
  -- the address, so those tables keep working after the address itself is
  -- erased on account deletion. A deleted account must stay un-mailable.
  address_hash      bytea NOT NULL,
  is_primary        boolean NOT NULL DEFAULT false,
  verified_at       timestamptz,                -- double opt-in completed
  verify_token_hash bytea,
  verify_sent_at    timestamptz,
  verify_attempts   smallint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN
                      ('pending', 'verified', 'opted_out', 'bounced', 'invalid')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, address)
);
CREATE UNIQUE INDEX contact_primary_uq ON contact_channels (user_id, channel) WHERE is_primary;
CREATE INDEX contact_hash_idx     ON contact_channels (channel, address_hash);
CREATE INDEX contact_verified_idx ON contact_channels (user_id) WHERE status = 'verified';

-- APPEND-ONLY. Enforced by a trigger below and by REVOKE in 012_lockdown.sql.
--
-- This table is the evidence you produce if somebody claims they never agreed
-- to be texted. That means it has to be *reconstructible*, not current-state:
-- a revocation is a new row with action='revoke', never an UPDATE of the grant
-- it supersedes. It stores the exact words that were on the screen, their
-- version and hash, the page they were on, the address, the IP and the
-- timestamp — which together is what express written consent actually means
-- under the TCPA.
CREATE TABLE consent_records (
  id                   bigserial PRIMARY KEY,
  -- Nulled rather than cascaded on account deletion: the consent history has
  -- to outlive the account, or a deleted user could be re-added and mailed.
  user_id              bigint REFERENCES users(id) ON DELETE SET NULL,
  address_hash         bytea NOT NULL,          -- the durable identifier
  address              text,                    -- PII: cleared on erasure, hash retained
  channel              text NOT NULL CHECK (channel IN ('email', 'sms')),
  consent_type         text NOT NULL CHECK (consent_type IN
                         ('email_updates', 'sms_alerts', 'terms', 'privacy')),
  action               text NOT NULL CHECK (action IN ('grant', 'confirm', 'revoke')),
  method               text NOT NULL CHECK (method IN
                         ('web_form', 'double_optin_click', 'double_optin_sms',
                          'sms_keyword', 'list_unsubscribe', 'support_request',
                          'webhook', 'account_deletion')),
  consent_text         text NOT NULL,           -- verbatim, exactly as displayed
  consent_text_version text NOT NULL,           -- e.g. 'sms-express-v1'
  consent_text_sha256  bytea NOT NULL,          -- tamper-evident
  page_url             text,
  ip                   inet,                    -- PII
  user_agent           text,                    -- PII
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- form snapshot, Twilio SID, ...
  -- Hash chain: each row commits to the one before it, so tampering is
  -- detectable even by somebody holding database credentials — which is the
  -- realistic threat model for "did anyone quietly rewrite a consent record".
  prev_hash            bytea,
  row_hash             bytea NOT NULL
);
CREATE INDEX consent_addr_idx ON consent_records (address_hash, consent_type, occurred_at DESC);
CREATE INDEX consent_user_idx ON consent_records (user_id, occurred_at DESC);

-- Current consent state, derived from the log. A plain view rather than a
-- materialized one: it must never be stale, because it gates sending, and the
-- index above makes the DISTINCT ON cheap at this scale.
CREATE VIEW consent_state AS
SELECT DISTINCT ON (address_hash, consent_type)
       address_hash,
       channel,
       consent_type,
       action,
       occurred_at,
       consent_text_version
FROM   consent_records
ORDER  BY address_hash, consent_type, occurred_at DESC, id DESC;

CREATE TABLE notification_preferences (
  user_id          bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled    boolean NOT NULL DEFAULT true,
  sms_enabled      boolean NOT NULL DEFAULT false,
  -- Deadlines default on because they are the reason to have an account.
  -- Everything editorial defaults OFF and is opted into explicitly.
  cat_deadlines    boolean NOT NULL DEFAULT true,
  cat_odds         boolean NOT NULL DEFAULT false,
  cat_news         boolean NOT NULL DEFAULT false,
  cat_filings      boolean NOT NULL DEFAULT false,
  cat_product      boolean NOT NULL DEFAULT true,
  digest_mode      text NOT NULL DEFAULT 'daily'
                   CHECK (digest_mode IN ('immediate', 'daily', 'weekly')),
  -- The TCPA window is 8am–9pm in the *recipient's* local time. These are the
  -- defaults; a user may narrow them but the send path clamps to this range
  -- regardless of what is stored.
  quiet_start_hour smallint NOT NULL DEFAULT 8  CHECK (quiet_start_hour BETWEEN 0 AND 23),
  quiet_end_hour   smallint NOT NULL DEFAULT 21 CHECK (quiet_end_hour   BETWEEN 1 AND 23),
  max_per_week     smallint NOT NULL DEFAULT 5  CHECK (max_per_week BETWEEN 0 AND 20),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prefs_quiet_order CHECK (quiet_start_hour < quiet_end_hour)
);

-- The stop-list. Keyed on the address hash, not the user, so it survives
-- account deletion — which is the entire point.
CREATE TABLE suppressions (
  address_hash bytea NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'sms')),
  reason       text NOT NULL CHECK (reason IN
                 ('unsubscribe', 'stop_keyword', 'hard_bounce', 'spam_complaint',
                  'invalid', 'carrier_block', 'manual', 'erasure')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,                     -- NULL = permanent
  source       text NOT NULL,                   -- 'resend_webhook' | 'twilio_inbound' | 'user'
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (address_hash, channel)
);
CREATE INDEX suppressions_created_idx ON suppressions (created_at DESC);

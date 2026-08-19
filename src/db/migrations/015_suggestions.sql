-- Machine-composed drafts, waiting for a person to adopt them.
--
-- `broadcasts.created_by` is NOT NULL on purpose: a machine cannot author a
-- message to forty thousand people, and every sent message has a human name
-- attached to it. But the odds and news producers genuinely do notice things
-- worth telling people about, and losing that would mean either a person
-- watching a dashboard all day or a service account pretending to be an
-- author.
--
-- So they write here instead. A suggestion is inert — it has no audience, it
-- cannot be approved, and nothing fans it out. An editor reads it, decides
-- whether it is worth sending, and adopting it creates an ordinary broadcast
-- with their name on it, which then goes through the whole workflow: lint,
-- balance, a second person's approval, hash-at-approval.
--
-- The composed body is kept verbatim so the portal can show what the machine
-- actually proposed alongside whatever the editor changed.

CREATE TABLE broadcast_suggestions (
  id            bigserial PRIMARY KEY,
  public_id     uuid NOT NULL UNIQUE,
  producer      text NOT NULL,                  -- 'odds' | 'news' | 'filings'
  dedup_key     text NOT NULL UNIQUE,           -- one suggestion per thing noticed
  category      text NOT NULL CHECK (category IN ('odds', 'news', 'filings')),
  subject_key   text REFERENCES subjects(key),
  subject_line  text,
  body          text NOT NULL,
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the numbers behind it
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'adopted', 'dismissed', 'expired')),
  adopted_by    bigint REFERENCES users(id),
  adopted_as    bigint REFERENCES broadcasts(id),
  dismissed_by  bigint REFERENCES users(id),
  dismiss_note  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  CONSTRAINT sug_sources_present CHECK (jsonb_array_length(sources) >= 1)
);
CREATE INDEX suggestions_open_idx ON broadcast_suggestions (created_at DESC) WHERE status = 'open';

-- The wrapper a human-written broadcast renders inside.
--
-- The body is `{{headline}}` and `{{sourceList}}` rather than free text at
-- send time, so a broadcast still travels through the same substitution and
-- the same footer machinery as every automated message. That is what
-- guarantees the unsubscribe link, the postal address and the funding line
-- appear on a hand-written message too — the one place they are most likely
-- to be forgotten.
--
-- Sources are rendered into the body rather than left as metadata, because a
-- citation nobody can see is not a citation.

INSERT INTO message_templates (key, channel, category, subject_tpl, body_tpl, body_sha256, active)
VALUES

('broadcast.email', 'email', 'product',
 '{{headline}}',
 '{{messageBody}}

Sources:
{{sourceList}}',
 sha256(convert_to('broadcast.email.v1', 'UTF8')), true),

('broadcast.sms', 'sms', 'product',
 NULL,
 '{{messageBody}}',
 sha256(convert_to('broadcast.sms.v1', 'UTF8')), true);

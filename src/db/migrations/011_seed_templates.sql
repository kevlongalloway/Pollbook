-- Message templates and the job schedule.
--
-- Note what the deadline templates do NOT say. Pollbook does not hold a
-- sourced, per-state voter-registration deadline table — usStates.js has
-- primary and general dates computed from statute, and a vote.gov link, and
-- that is all. Asserting "register by October 6" from a constant nobody can
-- cite is exactly the failure this codebase avoids everywhere else (see the
-- watchlist verification in data/electionBills.js, and the money-flow caveats
-- that drop a figure rather than force it).
--
-- So these messages are anchored on the election date, which IS derived from
-- statute and is therefore defensible, and they send the reader to the
-- official source for the deadline itself. That is both honest and more
-- useful than a number we would have to hedge. When a sourced deadline table
-- exists — one URL per row, rendered in the message — these templates get a
-- version 2 that names the date.

INSERT INTO message_templates (key, channel, category, subject_tpl, body_tpl, body_sha256, active)
VALUES

('deadline.register.t30', 'email', 'deadlines',
 'Check your registration before the {{electionName}}',
 'The {{electionName}} is on {{electionDateLong}} — about {{daysUntil}} days away.

Most states close voter registration between 15 and 30 days before election day, and some require you to re-register after a move or a name change. Now is the point in the calendar where checking costs nothing and fixing a problem is still easy.

Check your registration and {{stateName}}''s exact deadline: {{registrationUrl}}

You are getting this because you follow {{subjectLabel}} on Pollbook.',
 sha256(convert_to('deadline.register.t30.v1', 'UTF8')), true),

('deadline.register.t30.sms', 'sms', 'deadlines',
 NULL,
 'Pollbook: the {{electionName}} is {{daysUntil}} days away. Most states close registration 15-30 days before. Check yours: {{registrationUrl}} Reply STOP to opt out.',
 sha256(convert_to('deadline.register.t30.sms.v1', 'UTF8')), true),

('deadline.election.t7', 'email', 'deadlines',
 '{{electionName}} — one week out',
 'The {{electionName}} is on {{electionDateLong}}, one week from now.

Worth confirming this week: that you are registered, where your polling place is, what identification {{stateName}} asks for, and whether early or mail voting is still open. Your state or county election office is the authority on all four.

Start here: {{registrationUrl}}

See what is on the ballot: {{subjectUrl}}

You are getting this because you follow {{subjectLabel}} on Pollbook.',
 sha256(convert_to('deadline.election.t7.v1', 'UTF8')), true),

('deadline.election.t1', 'email', 'deadlines',
 '{{electionName}} is tomorrow',
 'The {{electionName}} is tomorrow, {{electionDateLong}}.

Confirm your polling place and its hours with your county election office before you go — locations change, and the hours are set by state law rather than by us.

If you are in line when polls close, you are entitled to vote. Stay in line.

Your state''s election information: {{registrationUrl}}

You are getting this because you follow {{subjectLabel}} on Pollbook.',
 sha256(convert_to('deadline.election.t1.v1', 'UTF8')), true),

('deadline.election.t1.sms', 'sms', 'deadlines',
 NULL,
 'Pollbook: the {{electionName}} is tomorrow. Confirm your polling place and hours with your county election office: {{registrationUrl}} If you are in line when polls close, stay in line. Reply STOP to opt out.',
 sha256(convert_to('deadline.election.t1.sms.v1', 'UTF8')), true),

('deadline.election.day.sms', 'sms', 'deadlines',
 NULL,
 'Pollbook: today is the {{electionName}}. Polling place and hours: {{registrationUrl}} If you are in line when polls close, stay in line. Reply STOP to opt out.',
 sha256(convert_to('deadline.election.day.sms.v1', 'UTF8')), true),

-- Transactional. These are not marketing and do not carry the category
-- toggles, but they still render through the same footer machinery so the
-- unsubscribe, the postal address and the funding line cannot be forgotten.
('product.signin', 'email', 'product',
 'Your Pollbook sign-in link',
 'Use this link to sign in to Pollbook. It works once and expires in 15 minutes.

{{actionUrl}}

If you did not ask to sign in, you can ignore this — the link is useless without this inbox, and nobody has been given access to your account.',
 sha256(convert_to('product.signin.v1', 'UTF8')), true),

('product.verify', 'email', 'product',
 'Confirm your email for Pollbook alerts',
 'Confirm this address so Pollbook can send you the election reminders you asked for:

{{actionUrl}}

If you did not sign up, ignore this message and nothing will be sent to you.',
 sha256(convert_to('product.verify.v1', 'UTF8')), true),

('product.welcome', 'email', 'product',
 'You are set up on Pollbook',
 'Your email is confirmed. Here is what you will get, and nothing else:

- Reminders to check your registration and to vote, for the elections you follow.
- Alerts on the issues and races you picked, if you turned those on.

You chose to follow: {{subjectSummary}}

Change what you get, or stop it entirely, any time: {{preferencesUrl}}

Pollbook is nonpartisan. We will never tell you who to vote for, we do not ask your party, and we do not have a field to store it in.',
 sha256(convert_to('product.welcome.v1', 'UTF8')), true),

('product.sms_confirm', 'sms', 'product',
 NULL,
 'Pollbook: reply YES to confirm text alerts about the elections you follow. Recurring msgs, msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to cancel.',
 sha256(convert_to('product.sms_confirm.v1', 'UTF8')), true),

('product.sms_welcome', 'sms', 'product',
 NULL,
 'Pollbook: you are confirmed for election reminders. Recurring msgs, frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to cancel. Manage: {{preferencesUrl}}',
 sha256(convert_to('product.sms_welcome.v1', 'UTF8')), true);


-- The job schedule. Rows rather than cron expressions, because a cron
-- expression in a process runs on every instance and this needs to run on
-- exactly one. See workers/index.js.
INSERT INTO scheduled_jobs (key, interval_ms, enabled) VALUES
  ('producer.deadlines',  3600000,  true),   -- hourly: the calendar moves slowly
  ('producer.reconcile',  86400000, true),   -- daily: re-derive subject keys
  ('producer.odds',       900000,   true),   -- 15 min: snapshot PredictIt
  ('producer.news',       1800000,  false),  -- 30 min: off until phase 8
  ('worker.fanout',       60000,    true),
  ('worker.sender',       30000,    true),
  ('worker.digest',       900000,   true),
  ('worker.retention',    86400000, true),
  ('worker.verify_chain', 86400000, true);   -- daily audit/consent chain check

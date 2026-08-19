-- The permission model, seeded as data so the whole thing shows up in a diff.
--
-- Two separations do most of the work here, and both are deliberate
-- departures from the usual "admin can do everything" shape:
--
--   1. **`admin` cannot send a broadcast and cannot read subscriber PII.**
--      Those need `sender` and `support`. A compromised engineering account
--      should not be able to text forty thousand people, and should not be
--      able to download the list either.
--
--   2. **`approver` deliberately lacks `broadcast.draft`.** The two-person
--      rule is a CHECK constraint on the broadcasts table, but a role model
--      that lets one person hold both legs makes the constraint a formality.
--      Stacking them takes an explicit grant that shows up in the audit log.

INSERT INTO permissions (key, description, needs_step_up) VALUES
  ('self.read',                'Read your own account, subscriptions and preferences', false),
  ('self.write',               'Change your own account, subscriptions and preferences', false),
  ('self.export',              'Download a copy of your own data', false),
  ('self.delete',              'Delete your own account', false),

  ('metrics.read',             'View aggregate metrics (minimum cell size applies)', false),
  ('metrics.export_aggregate', 'Export aggregate metrics as a file', false),
  ('deliverability.read',      'View bounce, complaint and delivery rates', false),

  ('content.read',             'View editorial content and drafts', false),
  ('content.edit',             'Edit editorial content', false),
  ('taxonomy.propose',         'Propose changes to the issue taxonomy', false),
  ('taxonomy.approve',         'Approve changes to the issue taxonomy', false),
  ('subject.annotate',         'Correct the display label of a tracked race or election', false),
  ('subject.manage',           'Retire subjects and create aliases across cycles', false),

  ('broadcast.read',           'View broadcasts and their audiences', false),
  ('broadcast.draft',          'Write a broadcast draft', false),
  ('broadcast.approve',        'Approve a broadcast for sending', true),
  ('broadcast.send',           'Send an approved broadcast', true),
  ('broadcast.cancel',         'Cancel a scheduled or sending broadcast', false),
  ('template.draft',           'Write a message template', false),
  ('template.approve',         'Approve a message template', true),

  -- Reading one subscriber is a different power from listing them all, and
  -- the second one is not granted to any role by default. See below.
  ('pii.read_single',          'Look up one subscriber by exact email or phone', true),
  ('pii.export_bulk',          'Export subscriber records in bulk', true),
  ('subscription.edit_on_behalf', 'Change a subscriber''s settings at their request', true),
  ('suppression.add',          'Add an address to the do-not-contact list', false),
  ('suppression.manage',       'Remove or amend do-not-contact entries', true),

  ('consent.read',             'Read consent records', true),
  ('audit.read',               'Read the audit log', false),
  ('dsar.process',             'Process a data subject access request', true),
  ('dsar.erase',               'Erase a subscriber''s personal data on request', true),
  ('retention.run',            'Run the data retention job manually', false),

  ('send.pause',               'Pause the outbound queue', false),
  ('send.killswitch',          'Stop all outbound messaging immediately', false),
  ('job.manage',               'Enable, disable and reschedule background jobs', false),
  ('provider.configure',       'View and change messaging provider configuration', true),
  ('roles.grant',              'Grant and revoke roles below admin', true),
  ('roles.grant_any',          'Grant and revoke any role, including admin', true);

INSERT INTO roles (key, name, description, is_staff, sort_order) VALUES
  ('subscriber', 'Subscriber', 'Anyone with an account. Manages only their own data.', false, 10),
  ('viewer',     'Viewer',     'Read-only access to aggregates and drafts. New staff, contractors, board members.', true, 20),
  ('editor',     'Editor',     'Writes drafts and proposes taxonomy changes. No subscriber data, cannot send.', true, 30),
  ('analyst',    'Analyst',    'Aggregate metrics and deliverability. No subscriber data.', true, 40),
  ('support',    'Support',    'Looks up one subscriber at a time to action their request. Every lookup is logged.', true, 50),
  ('approver',   'Approver',   'Approves broadcasts and templates. Cannot write the copy they approve.', true, 60),
  ('sender',     'Sender',     'Sends approved broadcasts and holds the kill switch. Cannot draft or approve.', true, 70),
  ('compliance', 'Compliance', 'Consent, audit, retention and data-subject requests. Cannot send anything.', true, 80),
  ('admin',      'Admin',      'Operations and configuration. Cannot send broadcasts or read subscriber data.', true, 90),
  ('owner',      'Owner',      'Grants admin. One or two people.', true, 100);

INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('subscriber', 'self.read'),
  ('subscriber', 'self.write'),
  ('subscriber', 'self.export'),
  ('subscriber', 'self.delete'),

  ('viewer', 'metrics.read'),
  ('viewer', 'broadcast.read'),
  ('viewer', 'content.read'),

  ('editor', 'metrics.read'),
  ('editor', 'broadcast.read'),
  ('editor', 'content.read'),
  ('editor', 'content.edit'),
  ('editor', 'broadcast.draft'),
  ('editor', 'template.draft'),
  ('editor', 'taxonomy.propose'),
  ('editor', 'subject.annotate'),

  ('analyst', 'metrics.read'),
  ('analyst', 'broadcast.read'),
  ('analyst', 'content.read'),
  ('analyst', 'metrics.export_aggregate'),
  ('analyst', 'deliverability.read'),

  ('support', 'metrics.read'),
  ('support', 'broadcast.read'),
  ('support', 'content.read'),
  ('support', 'pii.read_single'),
  ('support', 'subscription.edit_on_behalf'),
  ('support', 'suppression.add'),

  ('approver', 'metrics.read'),
  ('approver', 'broadcast.read'),
  ('approver', 'content.read'),
  ('approver', 'broadcast.approve'),
  ('approver', 'template.approve'),

  ('sender', 'broadcast.read'),
  ('sender', 'broadcast.send'),
  ('sender', 'broadcast.cancel'),
  ('sender', 'send.pause'),
  ('sender', 'send.killswitch'),
  ('sender', 'deliverability.read'),

  ('compliance', 'metrics.read'),
  ('compliance', 'broadcast.read'),
  ('compliance', 'content.read'),
  ('compliance', 'consent.read'),
  ('compliance', 'audit.read'),
  ('compliance', 'dsar.process'),
  ('compliance', 'dsar.erase'),
  ('compliance', 'retention.run'),
  ('compliance', 'suppression.add'),
  ('compliance', 'suppression.manage'),
  ('compliance', 'taxonomy.approve'),

  ('admin', 'metrics.read'),
  ('admin', 'metrics.export_aggregate'),
  ('admin', 'deliverability.read'),
  ('admin', 'broadcast.read'),
  ('admin', 'content.read'),
  ('admin', 'audit.read'),
  ('admin', 'subject.manage'),
  ('admin', 'subject.annotate'),
  ('admin', 'job.manage'),
  ('admin', 'provider.configure'),
  ('admin', 'roles.grant'),
  ('admin', 'send.pause'),
  ('admin', 'send.killswitch'),

  ('owner', 'roles.grant'),
  ('owner', 'roles.grant_any'),
  ('owner', 'audit.read'),
  ('owner', 'metrics.read'),
  ('owner', 'broadcast.read'),
  ('owner', 'content.read');

-- `pii.export_bulk` is intentionally granted to NO role.
--
-- There is no standing ability to download the subscriber list. Getting it
-- takes an `owner` making a deliberate, audited, time-boxed grant — and
-- lib/permissions.js refuses to resolve it from a grant with no expiry.

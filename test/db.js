/**
 * Everything that genuinely needs Postgres.
 *
 * **Skips cleanly when there is no database.** `npm test` has always run fully
 * offline on any laptop and that should not change because accounts arrived —
 * so with no `DATABASE_URL` this prints one line and exits 0. Run it for real
 * with `npm run test:db`, which fails loudly instead of skipping.
 *
 * What is tested here is the set of guarantees that only exist because the
 * database enforces them: dedup, quiet hours, concurrent claiming, the
 * append-only logs, and the two-person rule.
 *
 * Run: node test/db.js  |  DATABASE_URL=... node test/db.js --require-database
 */

process.env.CACHE_PERSIST = '0';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a-test-signing-key-of-at-least-32-chars!!';
process.env.MESSAGING_PROVIDER = 'memory';
process.env.MAILING_ADDRESS = process.env.MAILING_ADDRESS || 'Nolvek Technologies, 1 Example St, Atlanta GA';

const assert = require('node:assert');

const REQUIRED = process.argv.includes('--require-database');
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!URL) {
  if (REQUIRED) {
    console.error('db: TEST_DATABASE_URL (or DATABASE_URL) is required for npm run test:db');
    process.exit(1);
  }
  console.log('db: skipped — set TEST_DATABASE_URL to run the database tests');
  process.exit(0);
}

process.env.DATABASE_URL = URL;

const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const consent = require('../src/lib/consent');
const audit = require('../src/lib/audit');
const outbox = require('../src/notify/outbox');
const subscribers = require('../src/services/subscriberService');
const permissions = require('../src/lib/permissions');

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push({ name, fn });

/** A throwaway account. Everything is namespaced so runs cannot collide. */
let seq = 0;
async function makeUser(over = {}) {
  seq += 1;
  const email = `t${Date.now()}-${seq}@dbtest.invalid`;
  const { userId } = await subscribers.findOrCreateFromEmail(email, { req: null });
  await subscribers.confirmEmail(userId, email, { req: null });
  if (over.timezone) {
    await db.query('UPDATE users SET timezone = $2 WHERE id = $1', [userId, over.timezone]);
  }
  return { userId, email };
}

/* ---------------- migrations ---------------- */

test('migrations are idempotent', async () => {
  const again = await migrate({ log: () => {} });
  assert.deepEqual(again.applied, [], 'a second run must apply nothing');
});

test('an edited migration is caught rather than silently ignored', async () => {
  // The database and the checkout disagreeing about the schema is the failure
  // mode this checksum exists to make loud.
  await db.query(
    `UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001'`
  );
  await assert.rejects(() => migrate({ log: () => {} }), /has changed since it was applied/);
  // Put it back so the rest of the suite runs.
  const { migrationFiles } = require('../src/db/migrate');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const file = migrationFiles().find((f) => f.startsWith('001'));
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', file), 'utf8');
  await db.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
    crypto.createHash('sha256').update(sql, 'utf8').digest('hex'), '001',
  ]);
});

/* ---------------- accounts ---------------- */

test('a new account gets the subscriber role and default preferences', async () => {
  const { userId } = await makeUser();
  const { roles, permissions: held } = await permissions.resolve(userId);
  assert.ok(roles.includes('subscriber'));
  assert.ok(held.has('self.write'));
  // The separations that matter.
  assert.ok(!held.has('broadcast.send'));
  assert.ok(!held.has('pii.read_single'));

  const prefs = await db.one('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  assert.equal(prefs.cat_deadlines, true, 'deadlines are the reason to have an account');
  assert.equal(prefs.cat_odds, false, 'editorial categories are opt-in');
  assert.equal(prefs.sms_enabled, false);
  assert.equal(prefs.quiet_start_hour, 8);
  assert.equal(prefs.quiet_end_hour, 21);
});

test('signing in twice does not create two accounts', async () => {
  const { userId, email } = await makeUser();
  const again = await subscribers.findOrCreateFromEmail(email, { req: null });
  assert.equal(again.userId, userId);
  assert.equal(again.created, false);
});

test('pii.export_bulk is granted to no role', async () => {
  // There is no standing ability to download the subscriber list.
  const rows = await db.rows(
    "SELECT role_key FROM role_permissions WHERE permission_key = 'pii.export_bulk'"
  );
  assert.equal(rows.length, 0);
});

test('a grant with no expiry cannot confer pii.export_bulk', async () => {
  const { userId } = await makeUser();
  await db.query(
    `INSERT INTO user_permissions (user_id, permission_key, reason) VALUES ($1,'pii.export_bulk','test')`,
    [userId]
  );
  permissions.invalidate(userId);
  let held = (await permissions.resolve(userId)).permissions;
  assert.ok(!held.has('pii.export_bulk'), 'an open-ended grant must not resolve');

  await db.query(
    `UPDATE user_permissions SET expires_at = now() + interval '1 hour' WHERE user_id = $1`,
    [userId]
  );
  permissions.invalidate(userId);
  held = (await permissions.resolve(userId)).permissions;
  assert.ok(held.has('pii.export_bulk'), 'a time-boxed grant should work');
});

test('an expired role confers nothing', async () => {
  const { userId } = await makeUser();
  await db.query(
    `INSERT INTO user_roles (user_id, role_key, expires_at) VALUES ($1,'editor', now() - interval '1 day')`,
    [userId]
  );
  permissions.invalidate(userId);
  const { permissions: held } = await permissions.resolve(userId);
  assert.ok(!held.has('broadcast.draft'));
});

/* ---------------- subscriptions and the seat model ---------------- */

test('following a race also creates its cycle-free seat', async () => {
  const { userId } = await makeUser();
  const result = await subscribers.subscribe(userId, 'race:ga-senate-2026', {
    label: 'U.S. Senate — Georgia (2026)', req: null,
  });
  assert.equal(result.seatKey, 'seat:ga-senate');

  const rows = await db.rows(
    'SELECT subject_key, source FROM subscriptions WHERE user_id = $1 ORDER BY source',
    [userId]
  );
  assert.deepEqual(rows.map((r) => `${r.source}:${r.subject_key}`),
    ['derived:seat:ga-senate', 'explicit:race:ga-senate-2026']);

  // The label snapshot is what renders the tracked list when the FEC is down.
  const seat = await db.one("SELECT label FROM subjects WHERE key = 'seat:ga-senate'");
  assert.ok(seat.label && !seat.label.includes('2026'), 'the seat label drops the cycle');
});

test('unfollowing one cycle keeps a seat another cycle still needs', async () => {
  const { userId } = await makeUser();
  await subscribers.subscribe(userId, 'race:ga-senate-2026', { req: null });
  await subscribers.subscribe(userId, 'race:ga-senate-2028', { req: null });
  await subscribers.unsubscribeFrom(userId, 'race:ga-senate-2026', { req: null });

  const seat = await db.one(
    "SELECT 1 FROM subscriptions WHERE user_id = $1 AND subject_key = 'seat:ga-senate'",
    [userId]
  );
  assert.ok(seat, 'the seat must survive while another race on it is followed');
});

test('a malformed subject key never reaches the database', async () => {
  const { userId } = await makeUser();
  await assert.rejects(
    () => subscribers.subscribe(userId, 'race:zz-senate-9999', { req: null }),
    /not something Pollbook can follow/
  );
});

/* ---------------- consent ---------------- */

test('a revocation is a new row, and the view reflects it immediately', async () => {
  const { userId, email } = await makeUser();
  assert.equal(await consent.has(email, 'email_updates'), true);

  await consent.record({
    userId, address: email, channel: 'email', consentType: 'email_updates',
    action: 'revoke', method: 'list_unsubscribe',
  });

  assert.equal(await consent.has(email, 'email_updates'), false);
  const history = await consent.history(email);
  assert.ok(history.length >= 2, 'the grant must still be there alongside the revocation');
  assert.equal(history.at(-1).action, 'revoke');
});

test('the exact consent wording is stored verbatim', async () => {
  const { email } = await makeUser();
  const [first] = await consent.history(email);
  // The question a regulator asks is what the screen said, not which version
  // string it had.
  assert.ok(first.consent_text.length > 40);
  assert.ok(first.consent_text.includes('Pollbook'));
  assert.ok(first.consent_text_version);
});

test('a suppression outlives the account it belonged to', async () => {
  const { userId, email } = await makeUser();
  await subscribers.deleteAccount(userId, { req: null });

  assert.equal(await consent.isSuppressed(email, 'email'), 'erasure');

  const user = await db.one('SELECT status, display_name, zip5 FROM users WHERE id = $1', [userId]);
  assert.equal(user.status, 'deleted');
  assert.equal(user.display_name, null);

  // The consent record stays, redacted — that is what makes "delete me" and
  // "never contact me again" compatible rather than contradictory.
  const rows = await db.rows(
    'SELECT address, consent_text FROM consent_records WHERE user_id = $1', [userId]
  );
  assert.ok(rows.length >= 1, 'the consent history must survive the deletion');
  assert.ok(rows.every((r) => r.address === null), 'the address must be redacted');
  assert.ok(rows.every((r) => r.consent_text.length > 0), 'the wording agreed to must remain');
});

test('lifting a suppression requires a fresh consent record', async () => {
  const { email } = await makeUser();
  await consent.suppress(email, 'email', 'unsubscribe', { source: 'test' });
  await consent.record({
    address: email, channel: 'email', consentType: 'email_updates',
    action: 'revoke', method: 'list_unsubscribe',
  });
  await assert.rejects(() => consent.unsuppress(email, 'email'), /without a new consent record/);
});

/* ---------------- the audit log ---------------- */

test('the audit log is append-only and chained', async () => {
  const { userId } = await makeUser();
  const id = await audit.write({
    actorUserId: userId, action: 'test.event', objectType: 'test', objectId: 'x',
  });
  assert.ok(id);

  await assert.rejects(
    () => db.query('UPDATE audit_log SET action = $2 WHERE id = $1', [id, 'tampered']),
    /append-only/
  );
  await assert.rejects(() => db.query('DELETE FROM audit_log WHERE id = $1', [id]), /append-only/);

  const chain = await audit.verifyChain('audit_log', { limit: 500 });
  assert.equal(chain.ok, true, `chain broken at ${chain.brokenAt}`);
});

test('the audit log never stores a raw address', async () => {
  const { userId, email } = await makeUser();
  await audit.write({
    actorUserId: userId, action: 'test.pii', objectType: 'test',
    detail: { email, nested: { address: email }, count: 3 },
  });
  const row = await db.one(
    "SELECT detail FROM audit_log WHERE action = 'test.pii' ORDER BY id DESC LIMIT 1"
  );
  const serialized = JSON.stringify(row.detail);
  assert.ok(!serialized.includes(email), 'an address reached the audit log');
  assert.ok(serialized.includes('redacted:'));
  assert.equal(row.detail.count, 3, 'non-PII fields survive');
});

/* ---------------- the outbox ---------------- */

/** A deadline event, ready to fan out. */
async function makeEvent(dedupKey, over = {}) {
  await db.query(
    `INSERT INTO subjects (key, type, state_code, cycle, label)
     VALUES ('election:ga-general-2026','election','GA',2026,'Georgia General Election')
     ON CONFLICT (key) DO NOTHING`
  );
  return db.one(
    `INSERT INTO notification_events
       (dedup_key, category, subject_key, state_code, payload, template_key, sources, auto_send)
     VALUES ($1,'deadlines','election:ga-general-2026','GA',$2,$3,$4,true)
     RETURNING id`,
    [
      dedupKey,
      JSON.stringify({
        stateName: 'Georgia',
        electionName: 'Georgia General Election',
        electionDateLong: 'Tuesday, November 3, 2026',
        daysUntil: '30',
        registrationUrl: 'https://vote.gov/register/ga',
        subjectLabel: 'Georgia General Election',
        ...over.payload,
      }),
      over.template || 'deadline.register.t30',
      JSON.stringify([{ label: 'vote.gov', url: 'https://vote.gov' }]),
    ]
  );
}

test('fanout reaches a subscriber once, and twice never', async () => {
  const { userId } = await makeUser();
  await subscribers.subscribe(userId, 'election:ga-general-2026', {
    label: 'Georgia General Election', req: null,
  });

  const event = await makeEvent(`test:dedup:${Date.now()}`);
  const first = await outbox.fanout(event.id);
  assert.ok(first.inserted >= 1);

  // The unique constraint, not worker logic, is what guarantees this — which
  // is why running fanout twice, or on two instances, is safe.
  await db.query('UPDATE notification_events SET fanned_out_at = NULL WHERE id = $1', [event.id]);
  const second = await outbox.fanout(event.id);
  assert.equal(second.inserted, 0, 'a second fanout must insert nothing');

  const rows = await db.rows(
    'SELECT count(*)::int AS n FROM outbox WHERE event_id = $1 AND user_id = $2',
    [event.id, userId]
  );
  assert.equal(rows[0].n, 1);
});

test('an SMS-worded event never reaches an email address', async () => {
  // Without the channel filter, "Reply STOP to opt out" arrives by email.
  const { userId } = await makeUser();
  await subscribers.subscribe(userId, 'election:ga-general-2026', { req: null });

  const event = await makeEvent(`test:sms:${Date.now()}`, { template: 'deadline.register.t30.sms' });
  await outbox.fanout(event.id);

  const rows = await db.rows('SELECT channel FROM outbox WHERE event_id = $1', [event.id]);
  assert.ok(rows.every((r) => r.channel === 'sms'), `got channels: ${rows.map((r) => r.channel)}`);
});

test('an unverified or suppressed address is never queued', async () => {
  const { userId, email } = await makeUser();
  await subscribers.subscribe(userId, 'election:ga-general-2026', { req: null });
  await consent.suppress(email, 'email', 'unsubscribe', { source: 'test' });

  const event = await makeEvent(`test:suppressed:${Date.now()}`);
  await outbox.fanout(event.id);

  const row = await db.one(
    'SELECT count(*)::int AS n FROM outbox WHERE event_id = $1 AND user_id = $2',
    [event.id, userId]
  );
  assert.equal(row.n, 0);
});

test('quiet hours push a send into the recipients own morning', async () => {
  const row = await db.one(
    `SELECT next_allowed_send($1::timestamptz, 'America/New_York', 8::smallint, 21::smallint) AS t`,
    ['2026-10-05T06:00:00Z']  // 02:00 in New York
  );
  assert.equal(new Date(row.t).toISOString(), '2026-10-05T12:00:00.000Z', '08:00 New York');

  const inside = await db.one(
    `SELECT next_allowed_send($1::timestamptz, 'America/New_York', 8::smallint, 21::smallint) AS t`,
    ['2026-10-05T18:00:00Z']
  );
  assert.equal(new Date(inside.t).toISOString(), '2026-10-05T18:00:00.000Z', 'already inside the window');
});

test('an unknown timezone falls back to the narrowest safe window', async () => {
  // Never "send at any hour". Eastern opens last relative to every zone west
  // of it, so it is the safe default.
  const row = await db.one(
    `SELECT next_allowed_send($1::timestamptz, 'Mars/Olympus', 8::smallint, 21::smallint) AS t`,
    ['2026-10-05T06:00:00Z']
  );
  assert.equal(new Date(row.t).toISOString(), '2026-10-05T12:00:00.000Z');
});

test('two senders draining one queue take different rows', async () => {
  const { userId } = await makeUser();
  await subscribers.subscribe(userId, 'election:ga-general-2026', { req: null });
  const event = await makeEvent(`test:claim:${Date.now()}`);
  await outbox.fanout(event.id);

  // FOR UPDATE SKIP LOCKED is the entire multi-instance story.
  const [a, b] = await Promise.all([outbox.claim({ limit: 10 }), outbox.claim({ limit: 10 })]);
  const overlap = a.filter((row) => b.some((other) => other.id === row.id));
  assert.equal(overlap.length, 0, 'the same row was claimed twice');
});

test('a send in the middle of the recipients night is held, not sent', async () => {
  // Fanout computes send_after in the recipient's own timezone. Whether this
  // is in the future depends on when the suite runs, which is the point —
  // so assert the relationship rather than a clock reading.
  const { userId } = await makeUser({ timezone: 'America/New_York' });
  await subscribers.subscribe(userId, 'election:ga-general-2026', { req: null });
  const event = await makeEvent(`test:quiet:${Date.now()}`);
  await outbox.fanout(event.id);

  const row = await db.one(
    `SELECT o.send_after,
            EXTRACT(hour FROM timezone(u.timezone, o.send_after))::int AS local_hour
       FROM outbox o JOIN users u ON u.id = o.user_id
      WHERE o.event_id = $1 AND o.user_id = $2`,
    [event.id, userId]
  );
  assert.ok(row, 'nothing was queued');
  assert.ok(row.local_hour >= 8 && row.local_hour < 21,
    `queued for ${row.local_hour}:00 local, outside the 8am-9pm window`);
});

test('a message actually sends, with its footers intact', async () => {
  const local = require('../src/notify/providers/local');
  local.reset();

  const { userId } = await makeUser();
  await subscribers.subscribe(userId, 'election:ga-general-2026', { req: null });
  const event = await makeEvent(`test:send:${Date.now()}`);
  await outbox.fanout(event.id);

  // Quiet hours are covered by the two tests above; release the row so this
  // one tests the send path rather than the clock.
  await db.query('UPDATE outbox SET send_after = now() WHERE event_id = $1', [event.id]);
  await outbox.drain({ limit: 10 });

  const sent = local.outbox().find((m) => m.subject?.includes('Georgia'));
  assert.ok(sent, 'nothing was sent');
  assert.ok(sent.body.includes('Nolvek Technologies'));
  assert.ok(sent.body.includes('Unsubscribe'));
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const row = await db.one(
    "SELECT status FROM outbox WHERE event_id = $1 AND status = 'sent' LIMIT 1", [event.id]
  );
  assert.ok(row, 'the outbox row was not marked sent');
});

/* ---------------- the two-person rule ---------------- */

test('nobody can approve their own broadcast', async () => {
  const { userId } = await makeUser();
  await assert.rejects(
    () => db.query(
      `INSERT INTO broadcasts
         (public_id, title, category, channel, body, body_sha256, sources,
          created_by, approved_by, lint_passed_at, status)
       VALUES (gen_random_uuid(),'t','news','email','b', sha256('b'::bytea),
               '[{"url":"https://vote.gov"}]'::jsonb, $1, $1, now(), 'approved')`,
      [userId]
    ),
    /bc_two_person/
  );
});

test('an editorial category cannot bypass human approval', async () => {
  await assert.rejects(
    () => db.query(
      `INSERT INTO notification_events (dedup_key, category, payload, template_key, sources, auto_send)
       VALUES ($1,'odds','{}'::jsonb,'broadcast.email','[{"url":"https://x.gov"}]'::jsonb, true)`,
      [`test:autosend:${Date.now()}`]
    ),
    /ev_autosend_scope/
  );
});

test('a message with no source cannot be created', async () => {
  await assert.rejects(
    () => db.query(
      `INSERT INTO notification_events (dedup_key, category, payload, template_key, sources, auto_send)
       VALUES ($1,'deadlines','{}'::jsonb,'deadline.register.t30','[]'::jsonb, true)`,
      [`test:nosource:${Date.now()}`]
    ),
    /ev_sources_present/
  );
});

/* ---------------- runner ---------------- */

(async () => {
  try {
    await migrate({ log: () => {} });
  } catch (err) {
    console.error('db: could not migrate —', err.message);
    process.exit(1);
  }

  for (const { name, fn } of checks) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      console.error(`✗ ${name}\n  ${err.message}`);
      process.exitCode = 1;
    }
  }

  await db.close();
  console.log(`db: ${passed} passed`);
})();

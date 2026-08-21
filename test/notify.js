/**
 * The messaging adapters, against local stub servers.
 *
 * Follows the convention the rest of this suite already uses: point
 * `RESEND_API_BASE` and `TWILIO_API_BASE` at an `http.createServer` and assert
 * on what the adapter actually puts on the wire. No network, no keys, no
 * mocking library.
 *
 * What is worth asserting here is not "does it POST" but the two things that
 * decide whether a real send behaves: the idempotency key that stops a
 * timed-out retry becoming a second copy in somebody's inbox, and the error
 * classification that decides between backing off and suppressing an address
 * forever.
 *
 * Run: node test/notify.js
 */

process.env.CACHE_PERSIST = '0';

const assert = require('node:assert');
const http = require('node:http');

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push({ name, fn });

/** A stub that records what it received and replies however the test wants. */
function stub(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return { server, received };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`)));

/* ---------------- Resend ---------------- */

test('an email carries the right fields, headers and idempotency key', async () => {
  const { server, received } = stub((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'resend-msg-1' }));
  });
  process.env.RESEND_API_BASE = await listen(server);
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'Pollbook <alerts@pollbook.test>';

  delete require.cache[require.resolve('../src/notify/providers/resend')];
  const resend = require('../src/notify/providers/resend');

  const result = await resend.send({
    to: 'voter@example.com',
    subject: 'Your registration',
    body: 'The election is Tuesday.',
    headers: { 'List-Unsubscribe': '<https://pollbook.test/u/1>' },
    idempotencyKey: 'outbox-42',
  });

  assert.equal(result.id, 'resend-msg-1');
  assert.equal(result.provider, 'resend');

  const sent = received[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/emails');
  assert.equal(sent.headers.authorization, 'Bearer re_test_key');
  // Without this, a claim that times out mid-send is retried and the reader
  // gets the message twice.
  assert.equal(sent.headers['idempotency-key'], 'outbox-42');

  const payload = JSON.parse(sent.body);
  assert.deepEqual(payload.to, ['voter@example.com']);
  assert.equal(payload.text, 'The election is Tuesday.');
  assert.equal(payload.headers['List-Unsubscribe'], '<https://pollbook.test/u/1>');

  server.close();
});

test('a 4xx is permanent and a 5xx is not', async () => {
  // The distinction decides between suppressing an address forever and
  // backing off for thirty seconds, so getting it wrong is expensive in
  // both directions.
  for (const [status, permanent] of [[422, true], [429, false], [500, false], [503, false]]) {
    const { server } = stub((req, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: `stub ${status}` }));
    });
    process.env.RESEND_API_BASE = await listen(server);

    delete require.cache[require.resolve('../src/notify/providers/resend')];
    const resend = require('../src/notify/providers/resend');

    await assert.rejects(
      () => resend.send({ to: 'a@b.test', subject: 's', body: 'b' }),
      (err) => {
        assert.equal(err.permanent, permanent, `HTTP ${status} permanent should be ${permanent}`);
        return true;
      }
    );
    server.close();
  }
});

test('only hard bounces and complaints suppress', async () => {
  delete require.cache[require.resolve('../src/notify/providers/resend')];
  const resend = require('../src/notify/providers/resend');

  const hard = resend.parseEvent({
    type: 'email.bounced',
    data: { email_id: 'e1', to: ['a@b.test'], bounce: { type: 'Permanent' } },
  });
  assert.equal(hard.suppress, true);
  assert.equal(hard.reason, 'hard_bounce');

  // A full mailbox on Tuesday is not a reason to stop somebody's election
  // reminders forever.
  const soft = resend.parseEvent({
    type: 'email.bounced',
    data: { email_id: 'e2', to: ['a@b.test'], bounce: { type: 'Transient' } },
  });
  assert.equal(soft.suppress, false);

  const complaint = resend.parseEvent({
    type: 'email.complained', data: { email_id: 'e3', to: ['a@b.test'] },
  });
  assert.equal(complaint.suppress, true);
  assert.equal(complaint.reason, 'spam_complaint');

  assert.equal(resend.parseEvent({ type: 'email.delivered', data: { email_id: 'e4' } }).status, 'delivered');
  assert.equal(resend.parseEvent({ type: 'something.else', data: {} }), null);
});

/* ---------------- Twilio ---------------- */

test('an SMS prefers the Messaging Service and reports segments', async () => {
  const { server, received } = stub((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sid: 'SM123', num_segments: '2' }));
  });
  process.env.TWILIO_API_BASE = await listen(server);
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG_test';

  delete require.cache[require.resolve('../src/notify/providers/twilio')];
  const twilio = require('../src/notify/providers/twilio');

  const result = await twilio.send({
    to: '+14045550142',
    body: 'Election tomorrow. Reply STOP to opt out.',
    statusCallback: 'https://pollbook.test/hooks/twilio/status',
  });

  assert.equal(result.id, 'SM123');
  assert.equal(result.segments, 2);

  const sent = received[0];
  assert.ok(sent.url.includes('/Accounts/AC_test/Messages.json'));
  const params = new URLSearchParams(sent.body);
  // The Messaging Service is what carries the 10DLC campaign registration,
  // so it must win over a bare From number when both are configured.
  assert.equal(params.get('MessagingServiceSid'), 'MG_test');
  assert.equal(params.get('From'), null);
  assert.equal(params.get('To'), '+14045550142');
  assert.equal(params.get('StatusCallback'), 'https://pollbook.test/hooks/twilio/status');

  server.close();
});

test('Twilio error codes classify correctly', async () => {
  const { server } = stub((req, res) => {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 21610, message: 'The recipient has opted out' }));
  });
  process.env.TWILIO_API_BASE = await listen(server);

  delete require.cache[require.resolve('../src/notify/providers/twilio')];
  const twilio = require('../src/notify/providers/twilio');

  await assert.rejects(
    () => twilio.send({ to: '+14045550142', body: 'x' }),
    (err) => {
      assert.equal(err.twilioCode, 21610);
      assert.equal(err.permanent, true, 'a recipient who replied STOP must never be retried');
      return true;
    }
  );
  server.close();
});

test('a status callback with 21610 suppresses', async () => {
  delete require.cache[require.resolve('../src/notify/providers/twilio')];
  const twilio = require('../src/notify/providers/twilio');

  const stopped = twilio.parseStatus({
    MessageSid: 'SM1', MessageStatus: 'undelivered', To: '+14045550142', ErrorCode: '21610',
  });
  assert.equal(stopped.suppress, true);
  assert.equal(stopped.reason, 'stop_keyword');

  const delivered = twilio.parseStatus({ MessageSid: 'SM2', MessageStatus: 'delivered', To: '+1404' });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.suppress, false);

  assert.equal(twilio.parseStatus({ MessageStatus: 'nonsense' }), null);
});

/* ---------------- selection ---------------- */

test('with no keys configured, nothing is sent to a network', async () => {
  // The property that lets the whole account flow be exercised on a laptop
  // with nothing but a database.
  const saved = { ...process.env };
  for (const key of ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_SERVICE_SID', 'MESSAGING_PROVIDER']) delete process.env[key];

  for (const mod of ['../src/notify/index', '../src/notify/providers/resend', '../src/notify/providers/twilio']) {
    delete require.cache[require.resolve(mod)];
  }
  const notify = require('../src/notify/index');

  assert.equal(notify.status().email, 'console');
  assert.ok(notify.describe().includes('console'));
  // SMS stays off until the 10DLC registration is actually done, regardless
  // of whether credentials happen to be present.
  assert.equal(notify.smsEnabled(), false);
  assert.ok(notify.describe().includes('SMS_ENABLED=1'));

  Object.assign(process.env, saved);
});

test('the kill switch is visible in the status line', () => {
  process.env.SEND_ENABLED = '0';
  delete require.cache[require.resolve('../src/notify/index')];
  const notify = require('../src/notify/index');
  assert.equal(notify.sendingEnabled(), false);
  assert.ok(notify.describe().includes('SENDING DISABLED'));
  delete process.env.SEND_ENABLED;
});

test('the memory provider records what it was given', async () => {
  process.env.MESSAGING_PROVIDER = 'memory';
  for (const mod of ['../src/notify/index', '../src/notify/providers/local']) {
    delete require.cache[require.resolve(mod)];
  }
  const notify = require('../src/notify/index');
  const local = require('../src/notify/providers/local');

  local.reset();
  await notify.send({ channel: 'email', to: 'a@b.test', subject: 's', body: 'b' });
  assert.equal(local.outbox().length, 1);
  assert.equal(local.outbox()[0].to, 'a@b.test');
  delete process.env.MESSAGING_PROVIDER;
});

/* ---------------- backoff ---------------- */

test('retry backoff grows and is capped', () => {
  const outbox = require('../src/notify/outbox');
  assert.equal(outbox.backoffMs(1), 30_000);
  assert.equal(outbox.backoffMs(2), 60_000);
  assert.equal(outbox.backoffMs(3), 120_000);
  // Capped, so a long-broken upstream does not push a message a week out.
  assert.equal(outbox.backoffMs(50), 6 * 3_600_000);
});

/* ---------------- runner ---------------- */

(async () => {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      console.error(`✗ ${name}\n  ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`notify: ${passed} passed`);
})();

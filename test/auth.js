/**
 * Auth primitives, offline.
 *
 * Everything here runs with no database and no network: JWT signing and
 * verification against locally generated keys, cookie signing, CSRF, contact
 * normalization, and the error scrubbing that keeps credentials and addresses
 * out of the logs.
 *
 * The JWT tests use real keys rather than fixtures, so they exercise the
 * actual crypto path — including the `dsaEncoding` detail that decides whether
 * Apple accepts our client secret at all.
 *
 * Run: node test/auth.js
 */

process.env.CACHE_PERSIST = '0';
process.env.SESSION_SECRET = 'a-test-signing-key-of-at-least-32-characters';

const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const jwt = require('../src/lib/jwt');
const cookies = require('../src/lib/cookies');
const csrf = require('../src/lib/csrf');
const tokens = require('../src/lib/tokens');
const contacts = require('../src/lib/contacts');
const errors = require('../src/lib/errors');
const { safeRedirect } = require('../src/lib/baseUrl');
const outbox = require('../src/notify/outbox');
const twilio = require('../src/notify/providers/twilio');
const resend = require('../src/notify/providers/resend');

let passed = 0;
const checks = [];
const test = (name, fn) => checks.push({ name, fn });

/* ---------------- Apple's ES256 client secret ---------------- */

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const EC_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });

test('the Apple client secret is a raw r||s ES256 JWT, not DER', () => {
  // The single most expensive detail in this integration. Node's default
  // ECDSA output is DER-wrapped; JOSE requires raw r||s, and Apple rejects
  // the DER form with `invalid_client` — an error that reads like a wrong
  // key id and sends you to the developer portal for an hour.
  const token = jwt.signES256(
    { iss: 'TEAM', aud: 'https://appleid.apple.com', sub: 'com.example.svc', iat: 1, exp: 2 },
    { privateKeyPem: EC_PEM, kid: 'KEY1' }
  );

  const parts = jwt.decode(token);
  assert.equal(parts.header.alg, 'ES256');
  assert.equal(parts.header.kid, 'KEY1');
  assert.equal(parts.signature.length, 64, 'a raw P-256 signature is exactly 64 bytes');

  assert.ok(crypto.verify(
    'sha256', Buffer.from(parts.signingInput),
    { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, parts.signature
  ), 'Apple verifies with ieee-p1363');
});

test('a PEM mangled by an environment variable is repaired', () => {
  // Newlines rarely survive a dashboard paste; they arrive as literal \n.
  const mangled = EC_PEM.replace(/\n/g, '\\n');
  assert.doesNotThrow(() =>
    jwt.signES256({ iss: 'T' }, { privateKeyPem: mangled, kid: 'K' }));
});

test('an empty private key fails clearly', () => {
  assert.throws(() => jwt.signES256({}, { privateKeyPem: '', kid: 'K' }), /Missing private key/);
});

/* ---------------- ID token verification ---------------- */

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_JWK = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' };

/** Sign an RS256 token the way a provider would. */
function signRS256(payload, { kid = 'rsa-1', alg = 'RS256' } = {}) {
  const header = jwt.b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = jwt.b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: rsa.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${jwt.b64url(signature)}`;
}

let jwksServer;
let jwksUrl;

const validClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'test-client-id',
  sub: 'user-123',
  email: 'voter@example.com',
  email_verified: true,
  nonce: 'the-nonce',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
});

const verifyOpts = (over = {}) => ({
  jwksUrl,
  issuer: ['https://accounts.google.com', 'accounts.google.com'],
  audience: 'test-client-id',
  nonce: 'the-nonce',
  ...over,
});

test('a well-formed ID token verifies', async () => {
  const claims = await jwt.verify(signRS256(validClaims()), verifyOpts());
  assert.equal(claims.sub, 'user-123');
  assert.equal(claims.email, 'voter@example.com');
});

test('a tampered payload does not verify', async () => {
  const token = signRS256(validClaims());
  const [h, , sig] = token.split('.');
  const forged = jwt.b64url(JSON.stringify(validClaims({ sub: 'someone-else' })));
  await assert.rejects(
    () => jwt.verify(`${h}.${forged}.${sig}`, verifyOpts()),
    /signature does not verify/
  );
});

test('alg:none is refused', async () => {
  // The oldest JWT vulnerability there is.
  const header = jwt.b64url(JSON.stringify({ alg: 'none', kid: 'rsa-1' }));
  const body = jwt.b64url(JSON.stringify(validClaims()));
  await assert.rejects(() => jwt.verify(`${header}.${body}.`, verifyOpts()), /Unsupported token algorithm/);
});

test('the key decides the algorithm, not the token', async () => {
  // Claiming ES256 over an RS256 key is how an RS256 public key gets used as
  // an HMAC secret in the classic confusion attack.
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims(), { alg: 'ES256' }), verifyOpts()),
    /claims ES256 but key/
  );
});

test('an unknown key id is refused', async () => {
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims(), { kid: 'not-a-key' }), verifyOpts()),
    /No signing key matching/
  );
});

test('the wrong issuer, audience or nonce is refused', async () => {
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims({ iss: 'https://evil.example' })), verifyOpts()),
    /issuer/
  );
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims({ aud: 'another-app' })), verifyOpts()),
    /different application/
  );
  // Without the nonce check, a token captured from another sign-in could be
  // replayed into this one.
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims({ nonce: 'wrong' })), verifyOpts()),
    /nonce does not match/
  );
});

test('an expired token is refused, within a small skew', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims({ exp: now - 3600 })), verifyOpts()),
    /expired/
  );
  // A host whose clock is a minute out should still be able to sign in.
  await assert.doesNotReject(
    () => jwt.verify(signRS256(validClaims({ exp: now - 60 })), verifyOpts())
  );
});

test('an aud array containing us is accepted', async () => {
  const claims = await jwt.verify(
    signRS256(validClaims({ aud: ['other-app', 'test-client-id'] })), verifyOpts()
  );
  assert.equal(claims.sub, 'user-123');
});

test('a token with no subject is refused', async () => {
  await assert.rejects(
    () => jwt.verify(signRS256(validClaims({ sub: undefined })), verifyOpts()),
    /no subject/
  );
});

/* ---------------- cookies and sessions ---------------- */

test('cookie parsing survives junk', () => {
  const parsed = cookies.parse('a=1; b = two ; broken; c=%2Fpath; a=ignored');
  assert.equal(parsed.a, '1', 'first wins, as browsers do');
  assert.equal(parsed.b, 'two');
  assert.equal(parsed.c, '/path');
  assert.equal(parsed.broken, undefined);
  assert.deepEqual(cookies.parse(''), {});
  assert.deepEqual(cookies.parse(undefined), {});
});

test('a value that is not valid percent-encoding is kept, not dropped', () => {
  assert.equal(cookies.parse('a=100%').a, '100%');
});

test('cookie signing round-trips and detects tampering', () => {
  const signed = cookies.sign('abc123');
  assert.equal(cookies.unsign(signed), 'abc123');
  assert.equal(cookies.unsign(`${signed}x`), null);
  assert.equal(cookies.unsign('abc123.notasignature'), null);
  assert.equal(cookies.unsign('nodot'), null);
  assert.equal(cookies.unsign(''), null);
});

test('the session cookie is HttpOnly, Lax and path-scoped', () => {
  const value = cookies.serialize('pb_session', 'x', { maxAge: 60 });
  assert.ok(value.includes('HttpOnly'));
  assert.ok(value.includes('SameSite=Lax'));
  assert.ok(value.includes('Path=/'));
  assert.ok(value.includes('Max-Age=60'));
});

test('the CSRF cookie is deliberately readable', () => {
  // It has to be echoed into a header by our own JavaScript, which is the
  // entire double-submit mechanism. It carries no authority on its own.
  const value = cookies.serialize('pb_csrf', 'x', { httpOnly: false });
  assert.ok(!value.includes('HttpOnly'));
});

/* ---------------- CSRF ---------------- */

const fakeReq = ({ headers = {}, ...over } = {}) => ({
  method: 'POST',
  ...over,
  headers: { host: 'pollbook.test', 'x-forwarded-proto': 'https', ...headers },
});

test('a cross-site Origin is refused', () => {
  assert.equal(csrf.sameOrigin(fakeReq({ headers: { origin: 'https://evil.example' } })), false);
  assert.equal(csrf.sameOrigin(fakeReq({ headers: { origin: 'https://pollbook.test' } })), true);
});

test('a state-changing request with no provenance at all is refused', () => {
  assert.equal(csrf.sameOrigin(fakeReq()), false);
});

test('Referer is the fallback when Origin is absent', () => {
  assert.equal(csrf.sameOrigin(fakeReq({ headers: { referer: 'https://pollbook.test/#/account' } })), true);
  assert.equal(csrf.sameOrigin(fakeReq({ headers: { referer: 'https://evil.example/x' } })), false);
  assert.equal(csrf.sameOrigin(fakeReq({ headers: { referer: 'not a url' } })), false);
});

/* ---------------- token primitives ---------------- */

test('secrets are unique and comparison is length-safe', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(tokens.secret());
  assert.equal(seen.size, 500);

  assert.equal(tokens.equal('abc', 'abc'), true);
  assert.equal(tokens.equal('abc', 'abd'), false);
  // timingSafeEqual throws on a length mismatch; equal() must not.
  assert.equal(tokens.equal('abc', 'abcdef'), false);
  assert.equal(tokens.equal('', ''), true);
  assert.equal(tokens.equal(null, undefined), true);
});

test('hashing is stable and one-way', () => {
  assert.ok(tokens.hash('x').equals(tokens.hash('x')));
  assert.ok(!tokens.hash('x').equals(tokens.hash('y')));
  assert.equal(tokens.hash('x').length, 32);
});

/* ---------------- redirect safety ---------------- */

test('only app-relative redirects are honoured', () => {
  // An open redirect on a login endpoint is a phishing primitive: the
  // attacker borrows our domain for the credential prompt.
  assert.equal(safeRedirect('/#/account'), '/#/account');
  assert.equal(safeRedirect('/admin?x=1'), '/admin?x=1');
  assert.equal(safeRedirect('https://evil.example'), '/');
  assert.equal(safeRedirect('//evil.example'), '/');
  assert.equal(safeRedirect('\\\\evil.example'), '/');
  assert.equal(safeRedirect('javascript:alert(1)'), '/');
  assert.equal(safeRedirect(''), '/');
  assert.equal(safeRedirect(null, '/fallback'), '/fallback');
});

/* ---------------- unsubscribe links ---------------- */

test('an unsubscribe link verifies, and is scoped to its purpose', () => {
  // It has to work from a mail client with no session, so it carries its own
  // authority — and must not be usable for anything else.
  const token = outbox.signLink('unsub', 'public-id-1', 'email');
  const claim = outbox.verifyLink(token, 'unsub');
  assert.equal(claim.publicId, 'public-id-1');
  assert.equal(claim.channel, 'email');

  assert.equal(outbox.verifyLink(token, 'prefs'), null, 'purpose is bound into the signature');
  assert.equal(outbox.verifyLink(`${token}x`, 'unsub'), null);
  assert.equal(outbox.verifyLink('garbage', 'unsub'), null);
  assert.equal(outbox.verifyLink('', 'unsub'), null);
});

/* ---------------- contact normalization ---------------- */

test('emails are lowercased and trimmed, and nothing more', () => {
  assert.equal(contacts.normalizeEmail('  Voter@Example.COM '), 'voter@example.com');
  // Deliberately NOT stripped: Gmail ignores dots and +tags, but the address
  // somebody typed is the one they chose, and rewriting it means they cannot
  // deliberately keep two accounts.
  assert.equal(contacts.normalizeEmail('a.b+tag@gmail.com'), 'a.b+tag@gmail.com');
  assert.equal(contacts.normalizeEmail("o'brien@example.ie"), "o'brien@example.ie");
});

test('obvious junk is refused', () => {
  for (const bad of ['', 'not-an-email', 'a@b', '@example.com', 'a b@example.com', `${'a'.repeat(300)}@x.com`]) {
    assert.equal(contacts.normalizeEmail(bad), null, `should reject "${bad}"`);
  }
});

test('phone numbers normalize to E.164, and placeholders are refused', () => {
  assert.equal(contacts.normalizePhone('(404) 555-0142'), '+14045550142');
  assert.equal(contacts.normalizePhone('404-555-0142'), '+14045550142');
  assert.equal(contacts.normalizePhone('14045550142'), '+14045550142');
  assert.equal(contacts.normalizePhone('+1 404 555 0142'), '+14045550142');
  assert.equal(contacts.normalizePhone('+442071838750'), '+442071838750');

  for (const bad of ['0000000000', '1234567890', '123', '', '911', '404-555-014']) {
    assert.equal(contacts.normalizePhone(bad), null, `should reject "${bad}"`);
  }
});

test('masking shows enough to confirm and not enough to copy', () => {
  assert.equal(contacts.maskPhone('+14045550142'), '•••••0142');
  assert.ok(contacts.maskEmail('voter@example.com').endsWith('@example.com'));
  assert.ok(!contacts.maskEmail('voter@example.com').includes('voter'));
});

test('Apple private relay addresses are recognised', () => {
  assert.equal(contacts.isPrivateRelay('abc123@privaterelay.appleid.com'), true);
  assert.equal(contacts.isPrivateRelay('voter@example.com'), false);
});

/* ---------------- webhook signatures ---------------- */

test('a Twilio signature verifies, and any change breaks it', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  const url = 'https://pollbook.test/hooks/twilio/inbound';
  const params = { From: '+14045550142', Body: 'STOP', MessageSid: 'SM1' };

  const expected = crypto
    .createHmac('sha1', 'test-auth-token')
    .update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url))
    .digest('base64');

  assert.equal(twilio.verifyWebhook(url, params, expected).ok, true);
  assert.equal(twilio.verifyWebhook(url, params, 'wrong').ok, false);
  assert.equal(twilio.verifyWebhook(url, { ...params, Body: 'START' }, expected).ok, false);
  // The URL is part of the signature, which is why lib/baseUrl has to
  // reconstruct the public one from the forwarded headers.
  assert.equal(twilio.verifyWebhook(`${url}x`, params, expected).ok, false);
  assert.equal(twilio.verifyWebhook(url, params, undefined).ok, false);
  delete process.env.TWILIO_AUTH_TOKEN;
});

test('a Resend/Svix signature verifies, and a stale one is refused', () => {
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('super-secret').toString('base64')}`;
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } });
  const id = 'msg_1';

  const sign = (ts) => {
    const key = Buffer.from(Buffer.from('super-secret').toString('base64'), 'base64');
    return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
  };

  const now = Math.floor(Date.now() / 1000);
  const headers = (ts) => ({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sign(ts) });

  assert.equal(resend.verifyWebhook(headers(now), body).ok, true);
  // A captured callback replayed later must not be able to re-suppress.
  assert.equal(resend.verifyWebhook(headers(now - 3600), body).ok, false);
  assert.equal(resend.verifyWebhook({ ...headers(now), 'svix-signature': 'v1,nope' }, body).ok, false);
  assert.equal(resend.verifyWebhook(headers(now), `${body} `).ok, false, 'raw bytes matter');
  assert.equal(resend.verifyWebhook({}, body).ok, false);
  delete process.env.RESEND_WEBHOOK_SECRET;
});

test('carrier keywords are recognised however they are typed', () => {
  for (const word of ['STOP', 'stop', ' Stop! ', 'UNSUBSCRIBE', 'cancel', 'QUIT']) {
    assert.equal(twilio.classifyInbound(word), 'stop', `"${word}"`);
  }
  assert.equal(twilio.classifyInbound('HELP'), 'help');
  assert.equal(twilio.classifyInbound('start'), 'start');
  assert.equal(twilio.classifyInbound('when is the election?'), null);
  assert.equal(twilio.classifyInbound(''), null);
});

test('a recipient who already replied STOP is a permanent failure', () => {
  // 21610 means Twilio is blocking it at their end. Retrying is futile, and
  // it means our own suppression list is out of step with reality.
  assert.equal(twilio.isPermanent(21610, 400), true);
  assert.equal(twilio.isPermanent(21614, 400), true);
  assert.equal(twilio.isPermanent(null, 429), false, 'rate limiting is transient');
  assert.equal(twilio.isPermanent(null, 503), false);
});

/* ---------------- error scrubbing ---------------- */

test('Postgres row values never reach a log', () => {
  // A duplicate-signup error arrives with DETAIL naming the address, so
  // console.error(err) would write a subscriber's email into the log forever.
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'users_email_norm_uq',
    table: 'users',
    detail: 'Key (email_normalized)=(voter@example.com) already exists.',
    where: 'SQL statement "INSERT INTO users ..."',
  });

  const logged = errors.forLog(pgError);
  const serialized = JSON.stringify(logged);
  assert.ok(!serialized.includes('voter@example.com'), 'the address leaked into the log');
  assert.ok(!serialized.includes('already exists'), 'DETAIL leaked into the log');
  // What makes it diagnosable is kept.
  assert.equal(logged.constraint, 'users_email_norm_uq');
  assert.equal(logged.code, '23505');
  assert.deepEqual(logged.redacted, ['detail', 'where']);
});

test('credentials in a message are redacted', () => {
  const scrubbed = errors.scrubMessage(
    'fetch failed for https://oauth2.googleapis.com/token?code=4/abc123&client_secret=shh'
  );
  assert.ok(!scrubbed.includes('4/abc123'));
  assert.ok(!scrubbed.includes('shh'));
  assert.ok(scrubbed.includes('[redacted]'));
});

test('a Postgres SQLSTATE is never forwarded to a client', () => {
  // Telling a caller which constraint they tripped is a map of the schema.
  const { status, body } = errors.forClient(
    Object.assign(new Error('boom'), { code: '23503', status: 500 })
  );
  assert.equal(status, 500);
  assert.equal(body.code, undefined);

  const tagged = errors.forClient(Object.assign(new Error('Sign in to do that.'), {
    status: 401, code: 'PB_UNAUTHENTICATED',
  }));
  assert.equal(tagged.body.error, 'Sign in to do that.');
  assert.equal(tagged.body.code, 'PB_UNAUTHENTICATED');
});

test('an untagged error never shows its message to a client', () => {
  const { status, body } = errors.forClient(new Error('column "party" does not exist'));
  assert.equal(status, 500);
  assert.equal(body.error, 'Something went wrong.');
});

/* ---------------- runner ---------------- */

(async () => {
  jwksServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [RSA_JWK] }));
  });
  await new Promise((r) => jwksServer.listen(0, r));
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/certs`;

  for (const { name, fn } of checks) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      console.error(`✗ ${name}\n  ${err.message}`);
      process.exitCode = 1;
    }
  }

  jwksServer.close();
  console.log(`auth: ${passed} passed`);
})();

/**
 * SMS via Twilio.
 *
 * Two REST calls and an HMAC, so no SDK — same reasoning as the Resend
 * adapter, plus the `TWILIO_API_BASE` override the test suite needs.
 *
 * **Before this works in production** somebody has to complete A2P 10DLC
 * brand and campaign registration, which takes weeks and is not a code task.
 * Political messaging is its own use case with its own vetting, and whether a
 * given entity can register for it depends on the entity type — a general
 * commercial LLC usually cannot, and needs a different campaign class with
 * different throughput and content rules. Start that before you need it; it
 * is the long pole, not this file.
 */

const API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';

const accountSid = () => process.env.TWILIO_ACCOUNT_SID || '';
const authToken = () => process.env.TWILIO_AUTH_TOKEN || '';
const messagingServiceSid = () => process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const fromNumber = () => process.env.TWILIO_FROM_NUMBER || '';

const configured = () =>
  Boolean(accountSid() && authToken() && (messagingServiceSid() || fromNumber()));

/**
 * Send one message.
 *
 * A Messaging Service is preferred over a bare number: it is what carries the
 * 10DLC campaign registration, and it handles number pooling and the sticky
 * sender that keeps a subscriber's thread on one number.
 */
async function send(msg) {
  const { to, body, statusCallback } = msg;

  const params = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid()) params.set('MessagingServiceSid', messagingServiceSid());
  else params.set('From', fromNumber());
  if (statusCallback) params.set('StatusCallback', statusCallback);

  const res = await fetch(`${API_BASE}/2010-04-01/Accounts/${accountSid()}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 300) };
  }

  if (!res.ok) {
    const err = new Error(payload?.message || `Twilio returned HTTP ${res.status}`);
    err.status = res.status;
    err.twilioCode = payload?.code || null;
    err.permanent = isPermanent(payload?.code, res.status);
    throw err;
  }

  return { id: payload.sid || null, provider: 'twilio', segments: Number(payload.num_segments) || 1 };
}

/**
 * Which Twilio errors mean "never try this number again".
 *
 * 21610 is the one that matters most: the recipient has replied STOP. Twilio
 * blocks it at their end, and retrying is both futile and — since it means our
 * own suppression list is out of step with reality — worth fixing immediately
 * rather than backing off.
 */
const PERMANENT_CODES = new Set([
  21211, // invalid 'To' number
  21214, // 'To' number cannot receive SMS
  21610, // recipient has unsubscribed (STOP)
  21612, // unreachable via this route
  21614, // not a mobile number
  30003, // handset unreachable / unavailable
  30005, // unknown destination
  30006, // landline or unreachable carrier
]);

function isPermanent(code, status) {
  if (code && PERMANENT_CODES.has(Number(code))) return true;
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Verify a Twilio webhook signature.
 *
 * HMAC-SHA1 over the full public URL followed by every POST parameter,
 * sorted by key and concatenated as key+value. Two things break this in
 * practice, and both are handled by the caller:
 *
 *   - **The URL must be the public one.** Behind Render's proxy `req.url` is
 *     a path and `req.host` is internal, so lib/baseUrl.js reconstructs the
 *     origin from the forwarded headers — the same function the OpenGraph
 *     tags use.
 *   - **Sorting is over the parsed form**, so the caller parses the raw body
 *     rather than relying on express.
 */
function verifyWebhook(url, params, signature) {
  const crypto = require('crypto');
  const { equal } = require('../../lib/tokens');

  const token = authToken();
  if (!token) return { ok: false, reason: 'TWILIO_AUTH_TOKEN is not set' };
  if (!signature) return { ok: false, reason: 'missing X-Twilio-Signature' };

  const data = Object.keys(params || {})
    .sort()
    .reduce((acc, key) => acc + key + params[key], String(url));

  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  return equal(expected, signature) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** Carrier-mandated keywords. Recognised case-insensitively, whitespace trimmed. */
const KEYWORDS = {
  stop: ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'revoke'],
  help: ['help', 'info'],
  start: ['start', 'yes', 'unstop', 'begin'],
};

/** Classify an inbound message body. Returns 'stop' | 'help' | 'start' | null. */
function classifyInbound(body) {
  const word = String(body || '').trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (!word) return null;
  for (const [kind, words] of Object.entries(KEYWORDS)) {
    if (words.includes(word)) return kind;
  }
  return null;
}

/** Normalize a delivery-status callback. */
function parseStatus(params) {
  const status = String(params?.MessageStatus || '').toLowerCase();
  const map = {
    queued: 'queued', sending: 'queued', sent: 'sent',
    delivered: 'delivered', undelivered: 'undelivered', failed: 'failed',
  };
  if (!map[status]) return null;

  const code = Number(params.ErrorCode) || null;
  return {
    provider: 'twilio',
    providerMessageId: params.MessageSid || null,
    address: params.To || null,
    channel: 'sms',
    status: map[status],
    errorCode: code ? String(code) : null,
    // 21610 means they already replied STOP somewhere we did not see.
    suppress: code === 21610 || (code !== null && PERMANENT_CODES.has(code)),
    reason: code === 21610 ? 'stop_keyword' : 'carrier_block',
  };
}

module.exports = {
  send, configured, verifyWebhook, classifyInbound, parseStatus, isPermanent,
  KEYWORDS, PERMANENT_CODES, API_BASE,
};

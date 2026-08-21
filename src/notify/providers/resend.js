/**
 * Email via Resend.
 *
 * One POST. The official SDK is a couple of megabytes and a dependency for
 * that, and — more to the point — it would bypass lib/http.js and with it the
 * `*_API_BASE` override that every source module in this codebase uses to run
 * its tests against a local stub. Following the established pattern is worth
 * more here than the SDK's convenience.
 */

const API_BASE = process.env.RESEND_API_BASE || 'https://api.resend.com';

const apiKey = () => process.env.RESEND_API_KEY || '';
const configured = () => Boolean(apiKey());

const from = () =>
  process.env.MAIL_FROM || 'Pollbook <alerts@pollbook.example>';

const replyTo = () => process.env.MAIL_REPLY_TO || null;

/**
 * Send one email.
 *
 * @param {object} msg `{ to, subject, body, headers, idempotencyKey }`
 * @returns {{id, provider}}
 */
async function send(msg) {
  const { to, subject, body, headers = {}, idempotencyKey } = msg;

  const res = await fetch(`${API_BASE}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey()}`,
      'content-type': 'application/json',
      // A claimed row whose send timed out gets retried; without this the
      // retry is a second copy in somebody's inbox.
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
    },
    body: JSON.stringify({
      from: from(),
      to: [to],
      subject,
      text: body,
      headers,
      ...(replyTo() ? { reply_to: replyTo() } : {}),
    }),
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
    const err = new Error(payload?.message || `Resend returned HTTP ${res.status}`);
    err.status = res.status;
    // The sender uses this to decide between a retry and a permanent
    // suppression: 4xx other than 429 means this address will never work.
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }

  return { id: payload.id || null, provider: 'resend' };
}

/**
 * Verify a Resend webhook.
 *
 * Resend signs with Svix: `svix-id`, `svix-timestamp`, `svix-signature`, over
 * `id.timestamp.rawBody`. The raw bytes matter — a re-serialized JSON body
 * will not reproduce them, which is why server.js mounts the webhook router
 * with express.raw() before the global express.json().
 */
function verifyWebhook(headers, rawBody) {
  const crypto = require('crypto');
  const { equal } = require('../../lib/tokens');

  const secret = process.env.RESEND_WEBHOOK_SECRET || '';
  if (!secret) return { ok: false, reason: 'RESEND_WEBHOOK_SECRET is not set' };

  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatureHeader = headers['svix-signature'];
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing svix headers' };
  }

  // Reject anything older than five minutes: a captured callback replayed
  // later must not be able to re-suppress an address.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: 'timestamp outside tolerance' };

  // The secret is `whsec_<base64>`; the bytes are what signs.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // The header carries a space-separated list of `v1,<sig>` so a rotation can
  // be signed with both keys at once.
  const provided = String(signatureHeader)
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter(Boolean);

  return provided.some((sig) => equal(sig, expected))
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

/**
 * Normalize a Resend event into what the pipeline acts on.
 *
 * Only two outcomes are permanent: a hard bounce and a complaint. A soft
 * bounce is counted rather than suppressed, because a full mailbox on Tuesday
 * is not a reason to stop sending somebody their election reminders forever.
 */
function parseEvent(body) {
  const type = body?.type || '';
  const data = body?.data || {};
  const to = Array.isArray(data.to) ? data.to[0] : data.to;

  const map = {
    'email.sent': { status: 'sent' },
    'email.delivered': { status: 'delivered' },
    'email.delivery_delayed': { status: 'queued' },
    'email.bounced': {
      status: 'bounced',
      // Resend reports the class; only "hard"/"permanent" suppresses.
      suppress: /hard|permanent/i.test(data.bounce?.type || data.bounce?.subType || ''),
      reason: 'hard_bounce',
    },
    'email.complained': { status: 'complained', suppress: true, reason: 'spam_complaint' },
  };

  const mapped = map[type];
  if (!mapped) return null;

  return {
    provider: 'resend',
    providerMessageId: data.email_id || data.id || null,
    address: to || null,
    channel: 'email',
    eventId: body?.data?.email_id ? `${type}:${body.data.email_id}` : null,
    ...mapped,
  };
}

module.exports = { send, configured, verifyWebhook, parseEvent, from, API_BASE };

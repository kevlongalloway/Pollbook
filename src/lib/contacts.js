/**
 * Normalizing and validating the two things we can reach somebody at.
 *
 * Both of these are the identity key for a person in this system, so getting
 * normalization wrong means either two accounts for one human or one account
 * for two.
 */

const { hash } = require('./tokens');

/* ---------------- email ---------------- */

/*
 * Deliberately permissive. A full RFC 5322 address is a nightmare of nested
 * comments and quoted strings, and every attempt to be strict about email
 * ends up rejecting somebody's real address — apostrophes in Irish surnames,
 * new TLDs, single-character local parts. The only real test of an address is
 * whether mail to it arrives, which is what the double opt-in is for. This
 * catches typos and obvious junk; the confirmation email catches everything
 * else.
 */
const EMAIL_RE = /^[^\s@,;<>"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Lowercase and trim. Nothing else.
 *
 * Notably we do NOT strip dots or `+tags` for Gmail. It is technically true
 * that Gmail ignores them, but the address somebody typed is the address they
 * chose, plenty of other providers treat dots as significant, and silently
 * rewriting it means a person cannot deliberately keep two accounts. Being
 * clever here is a bug that surfaces as "your email is already registered"
 * for an address they have never used.
 */
function normalizeEmail(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw.length > 254) return null;
  if (!EMAIL_RE.test(raw)) return null;
  return raw;
}

/** Apple's private relay. Deliverable, but only from a registered domain. */
const isPrivateRelay = (email) =>
  /@privaterelay\.appleid\.com$/i.test(String(email || ''));

/**
 * Mask an address for display in the portal and in logs.
 *
 * Support needs to confirm they are looking at the right record without the
 * whole address being on screen, and it keeps addresses out of screenshots.
 */
function maskEmail(email) {
  const raw = String(email || '');
  const at = raw.indexOf('@');
  if (at < 1) return '•••';
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  if (local.length <= 2) return `${local[0]}•${domain}`;
  return `${local.slice(0, 2)}${'•'.repeat(Math.min(local.length - 2, 6))}${domain}`;
}

/* ---------------- phone ---------------- */

/**
 * To E.164, or null.
 *
 * North America is handled properly because that is the whole audience: a
 * NANP number has a 10-digit national number whose area code and exchange
 * both start 2–9, which rejects the great majority of typos and every
 * placeholder like 000-000-0000 or 123-456-7890.
 *
 * Numbers outside NANP are accepted in already-E.164 form only. Guessing a
 * country code from a bare local number is how you text a stranger.
 */
function normalizePhone(input, { defaultCountry = 'US' } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('+')) {
    const rest = digits.slice(1);
    if (!/^\d{7,15}$/.test(rest)) return null;
    if (rest.startsWith('1')) return nanp(rest.slice(1));
    return `+${rest}`;
  }

  if (defaultCountry !== 'US') return null;

  if (digits.length === 11 && digits.startsWith('1')) return nanp(digits.slice(1));
  if (digits.length === 10) return nanp(digits);
  return null;
}

function nanp(tenDigits) {
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits)) return null;
  // N11 codes (411, 911, ...) are service codes, never subscriber numbers.
  if (/^\d11/.test(tenDigits)) return null;
  return `+1${tenDigits}`;
}

/** Last four only. What a support agent should ever see by default. */
function maskPhone(phone) {
  const raw = String(phone || '');
  if (raw.length < 4) return '•••';
  return `•••••${raw.slice(-4)}`;
}

/* ---------------- shared ---------------- */

/**
 * The durable identifier for a contact address.
 *
 * Suppression, consent and delivery records all key on this rather than on
 * the address, so they keep working after the plaintext is erased on a
 * deletion request — which is what makes "delete my account" and "never
 * contact me again" compatible instead of contradictory.
 */
const addressHash = (address) => hash(String(address || '').toLowerCase());

module.exports = {
  normalizeEmail, isPrivateRelay, maskEmail,
  normalizePhone, maskPhone,
  addressHash, EMAIL_RE,
};

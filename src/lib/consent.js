/**
 * Recording and checking consent.
 *
 * The shape of this module follows from one decision: consent is an
 * append-only *log*, not a boolean on a row. A flag answers "can we mail
 * them"; a log answers "what exactly did they agree to, when, from what
 * address, having read which words" — which is the question that actually
 * gets asked, and the only one worth being able to answer.
 *
 * So a revocation is a new row, never an update. The `consent_state` view
 * derives the current answer from the log, and every send path joins against
 * it rather than trusting a cached flag.
 */

const db = require('../db');
const { consentText, CURRENT } = require('../data/consentTexts');
const { addressHash } = require('./contacts');
const { hash } = require('./tokens');
const audit = require('./audit');

/**
 * Record a consent event.
 *
 * @param {object}  opts
 * @param {number} [opts.userId]
 * @param {string}  opts.address        the email or phone consented for
 * @param {string}  opts.channel        'email' | 'sms'
 * @param {string}  opts.consentType    'email_updates' | 'sms_alerts' | 'terms' | 'privacy'
 * @param {string}  opts.action         'grant' | 'confirm' | 'revoke'
 * @param {string}  opts.method         how it was captured
 * @param {string} [opts.version]       consent text version; defaults to current
 * @param {object} [opts.req]           request, for IP and user agent
 * @param {string} [opts.pageUrl]
 * @param {object} [opts.evidence]      Twilio SID, form snapshot, webhook id
 */
async function record(opts) {
  const {
    userId = null, address, channel, consentType, action, method,
    version = CURRENT[consentType], req = null, pageUrl = null, evidence = {},
  } = opts;

  // A revocation must always be recordable, even if the text version somebody
  // consented under has since been retired — refusing to record a STOP
  // because of a bookkeeping detail would be the worst possible failure here.
  let text = '';
  let resolvedVersion = version;
  if (action === 'revoke') {
    try {
      text = consentText(version).text;
    } catch {
      text = `Consent revoked via ${method}.`;
      resolvedVersion = version || 'revocation';
    }
  } else {
    text = consentText(version).text;
  }

  const row = await db.one(
    `INSERT INTO consent_records
       (user_id, address_hash, address, channel, consent_type, action, method,
        consent_text, consent_text_version, consent_text_sha256,
        page_url, ip, user_agent, evidence, row_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'\\x00'::bytea)
     RETURNING id, occurred_at`,
    [
      userId, addressHash(address), address, channel, consentType, action, method,
      text, resolvedVersion, hash(text),
      pageUrl, req ? audit.ipOf(req) : null,
      req ? audit.shortUa(req.headers?.['user-agent']) : null,
      JSON.stringify(evidence || {}),
    ]
  );

  await audit.write({
    req,
    actorUserId: userId,
    action: `consent.${action}`,
    objectType: 'consent',
    objectId: String(row.id),
    subjectUserId: userId,
    detail: { channel, consentType, method, version: resolvedVersion },
  });

  return row;
}

/**
 * Is there live consent for this address and type?
 *
 * Reads the derived view rather than a flag, so a revocation recorded a
 * second ago is already in effect.
 */
async function has(address, consentType) {
  const row = await db.one(
    `SELECT action FROM consent_state WHERE address_hash = $1 AND consent_type = $2`,
    [addressHash(address), consentType]
  );
  return Boolean(row) && row.action !== 'revoke';
}

/** The full consent history for an address. What a DSAR export contains. */
async function history(address) {
  return db.rows(
    `SELECT id, channel, consent_type, action, method, consent_text,
            consent_text_version, page_url, occurred_at
       FROM consent_records
      WHERE address_hash = $1
      ORDER BY occurred_at ASC, id ASC`,
    [addressHash(address)]
  );
}

/* ---------------- suppression ---------------- */

/**
 * Add an address to the do-not-contact list.
 *
 * Keyed on the hash, so it survives the account being deleted — which is the
 * point. `ON CONFLICT` keeps the *first* reason rather than the latest: a
 * hard bounce that later gets a manual entry should still read as a bounce.
 */
async function suppress(address, channel, reason, { source = 'user', evidence = {}, expiresAt = null } = {}) {
  await db.query(
    `INSERT INTO suppressions (address_hash, channel, reason, source, evidence, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (address_hash, channel) DO NOTHING`,
    [addressHash(address), channel, reason, source, JSON.stringify(evidence || {}), expiresAt]
  );
}

/** Is this address suppressed for this channel right now? */
async function isSuppressed(address, channel) {
  const row = await db.one(
    `SELECT reason FROM suppressions
      WHERE address_hash = $1 AND channel = $2
        AND (expires_at IS NULL OR expires_at > now())`,
    [addressHash(address), channel]
  );
  return row ? row.reason : null;
}

/**
 * Remove a suppression.
 *
 * Deliberately narrow: only an explicit, human-initiated re-subscribe or a
 * compliance correction should ever call this, and a fresh consent record has
 * to exist first. Quietly un-suppressing somebody because they came back to
 * the site would be the exact behaviour that makes "unsubscribe" meaningless.
 */
async function unsuppress(address, channel, { requireConsent = true } = {}) {
  if (requireConsent) {
    const type = channel === 'sms' ? 'sms_alerts' : 'email_updates';
    if (!(await has(address, type))) {
      throw Object.assign(
        new Error('Cannot lift a suppression without a new consent record for this address.'),
        { status: 409 }
      );
    }
  }
  await db.query('DELETE FROM suppressions WHERE address_hash = $1 AND channel = $2', [
    addressHash(address), channel,
  ]);
}

module.exports = { record, has, history, suppress, isSuppressed, unsuppress, CURRENT };

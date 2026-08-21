/**
 * The audit log.
 *
 * What gets written here is anything a person did that touched somebody
 * else's data or reached somebody's inbox: reading a subscriber record,
 * sending a broadcast, granting a role, erasing an account, changing the
 * taxonomy. Denials are logged as loudly as successes — a support account
 * that tries to export the list and is refused is exactly the event worth
 * having a record of.
 *
 * Two rules the callers have to respect:
 *
 *   - **`detail` never carries raw personal data.** It records *that* an
 *     address was read, not what it was. An audit log full of email addresses
 *     is one more copy of the subscriber list, kept forever, in the table
 *     nobody is allowed to delete from.
 *   - **Writing never fails a request.** The append is best-effort from the
 *     caller's point of view; a logging outage must not stop somebody
 *     unsubscribing. It does get shouted about in the process log.
 *
 * The hash chain and the append-only enforcement live in the database
 * (migrations 007 and 008), not here, precisely so that this module having a
 * bug — or being bypassed — cannot rewrite history.
 */

const db = require('../db');

/** Trim a user-agent to something loggable. */
const shortUa = (ua) => (ua ? String(ua).slice(0, 300) : null);

/**
 * The caller's IP, or null.
 *
 * `req.ip` is only correct because server.js sets `trust proxy`. Postgres
 * `inet` rejects anything that is not an address, so a malformed value is
 * dropped rather than failing the insert.
 */
function ipOf(req) {
  const raw = req?.ip || req?.socket?.remoteAddress;
  if (!raw) return null;
  const value = String(raw).replace(/^::ffff:/, '');
  return /^[0-9a-fA-F.:]+$/.test(value) ? value : null;
}

/**
 * Append one entry.
 *
 * @param {object} entry
 * @param {object} [entry.req]            request, for actor IP and user agent
 * @param {number} [entry.actorUserId]
 * @param {string} [entry.actorRole]
 * @param {string}  entry.action          'pii.read' | 'broadcast.send' | ...
 * @param {string}  entry.objectType
 * @param {string} [entry.objectId]
 * @param {number} [entry.subjectUserId]  whose data was touched
 * @param {string} [entry.outcome]        'ok' | 'denied' | 'error'
 * @param {object} [entry.detail]         never raw PII
 */
async function write(entry) {
  if (!db.enabled()) return null;

  const {
    req, actorUserId = null, actorRole = null, action, objectType,
    objectId = null, subjectUserId = null, outcome = 'ok', detail = {},
  } = entry;

  try {
    const row = await db.one(
      `INSERT INTO audit_log
         (actor_user_id, actor_role, action, object_type, object_id,
          subject_user_id, outcome, ip, user_agent, detail, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'\\x00'::bytea)
       RETURNING id`,
      [
        actorUserId, actorRole, action, objectType, objectId ? String(objectId) : null,
        subjectUserId, outcome, req ? ipOf(req) : null,
        req ? shortUa(req.headers?.['user-agent']) : null,
        JSON.stringify(scrub(detail)),
      ]
    );
    return row?.id ?? null;
  } catch (err) {
    // Deliberately swallowed. A request must not fail because the audit table
    // is unreachable — but this is loud, because a silently missing audit
    // trail is worse than a noisy log.
    console.error(`audit: failed to record "${action}" —`, err.message);
    return null;
  }
}

/**
 * Strip anything that looks like personal data out of a detail object.
 *
 * A backstop rather than the rule — callers are expected not to put it there
 * in the first place — but the cost of one careless `detail: { email }` in a
 * table nobody can delete from is high enough to be worth catching twice.
 */
const PII_KEYS = /^(email|address|phone|ip|user_?agent|token|secret|name|display_?name|zip)/i;

function scrub(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (PII_KEYS.test(key) && typeof value === 'string') {
      out[key] = redacted(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrub(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Enough to correlate two log lines, not enough to be a copy of the value. */
function redacted(value) {
  const { hashHex } = require('./tokens');
  return `redacted:${hashHex(value).slice(0, 12)}`;
}

/**
 * Walk the hash chain and report the first break.
 *
 * Run daily by workers/verifyChain.js.
 *
 * **What this proves, precisely:** each row commits to its predecessor's
 * hash, so removing a row, inserting one into the middle, or reordering them
 * breaks the linkage and is detected here. It does *not* re-derive each
 * row_hash from the row's current bytes, and deliberately so — erasing a
 * subscriber's address on request is a permitted in-place redaction
 * (migration 016), and a content check would report every honoured deletion
 * request as tampering.
 *
 * Field-level immutability is the trigger's job, not this function's. The two
 * together are the guarantee: nothing can be edited, and nothing can be
 * quietly removed.
 */
async function verifyChain(table = 'audit_log', { limit = 5000 } = {}) {
  if (!db.enabled()) return { checked: 0, ok: true };
  if (!['audit_log', 'consent_records'].includes(table)) {
    throw new Error(`verifyChain: refusing to walk an unexpected table "${table}"`);
  }

  const rows = await db.rows(
    `SELECT id, prev_hash, row_hash FROM ${table} ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  rows.reverse();

  for (let i = 1; i < rows.length; i += 1) {
    const expected = rows[i - 1].row_hash;
    const actual = rows[i].prev_hash;
    if (!expected || !actual || !expected.equals(actual)) {
      return { checked: rows.length, ok: false, brokenAt: rows[i].id, table };
    }
  }
  return { checked: rows.length, ok: true, table };
}

module.exports = { write, verifyChain, ipOf, shortUa, scrub };

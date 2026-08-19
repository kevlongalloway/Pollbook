/**
 * Making errors safe to log and safe to return.
 *
 * Two leaks this closes, both of which are easy to introduce and invisible
 * until somebody reads a log:
 *
 * **Postgres puts row contents in the error.** A constraint violation comes
 * back with a `detail` like `Key (email)=(someone@example.com) already
 * exists.` — so `console.error(err)` on a duplicate-signup writes a
 * subscriber's address into the log, forever, on a civic site whose whole
 * posture is that it does not keep more than it needs. `where` and
 * `internalQuery` carry the same risk.
 *
 * **OAuth errors carry credentials.** A failed token exchange can surface a
 * URL containing `code=...` or an assertion, and a fetch failure message can
 * include the query string it was called with.
 *
 * So: nothing goes to a log or to a client without passing through here.
 */

/** Postgres error fields that can contain row values. */
const PG_SENSITIVE = ['detail', 'where', 'internalQuery', 'hint'];

/** Query-string parameters that are credentials. */
const CREDENTIAL_RE = /\b(code|token|secret|assertion|client_secret|id_token|access_token|api[_-]?key|password)=([^&\s"']+)/gi;

/** An email address appearing anywhere in free text. */
const EMAIL_RE = /\b[^\s@,;<>"]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;

/** Strip credentials and addresses out of a message. */
function scrubMessage(message) {
  return String(message || '')
    .replace(CREDENTIAL_RE, '$1=[redacted]')
    .replace(EMAIL_RE, '[email redacted]')
    .slice(0, 1000);
}

/**
 * A version of an error that is safe to write to a log.
 *
 * Keeps what makes an error diagnosable — the constraint name, the SQL state,
 * the routine — and drops the values that triggered it. Knowing that
 * `users_email_norm_uq` was violated is the whole diagnosis; knowing which
 * address did it adds nothing and costs a permanent copy of it.
 */
function forLog(err) {
  if (!err || typeof err !== 'object') return { message: scrubMessage(err) };

  const safe = {
    message: scrubMessage(err.message),
    name: err.name,
  };

  if (err.code) safe.code = err.code;
  if (err.constraint) safe.constraint = err.constraint;
  if (err.table) safe.table = err.table;
  if (err.column) safe.column = err.column;
  if (err.severity) safe.severity = err.severity;
  if (err.routine) safe.routine = err.routine;
  if (err.status) safe.status = err.status;

  const dropped = PG_SENSITIVE.filter((key) => err[key]);
  if (dropped.length) safe.redacted = dropped;

  // The stack is ours, not the user's — but scrub it anyway, since a message
  // is interpolated into the first line.
  if (err.stack) safe.stack = scrubMessage(err.stack).split('\n').slice(0, 6).join('\n');

  return safe;
}

/**
 * What to send a client.
 *
 * A status on the error means somebody wrote the message for a person and it
 * is safe to show — the convention already used in routes/api.js. Anything
 * else is a bug, and gets a generic reply plus a scrubbed log line.
 *
 * Postgres codes are never forwarded: `23503` tells a caller which constraint
 * they tripped, which is a map of the schema.
 */
function forClient(err) {
  const status = Number(err?.status) || 500;
  const isTagged = Boolean(err?.status);

  return {
    status,
    body: {
      error: isTagged ? scrubMessage(err.message) : 'Something went wrong.',
      // Only our own PB_-prefixed codes; a Postgres SQLSTATE is internal.
      code: typeof err?.code === 'string' && err.code.startsWith('PB_') ? err.code : undefined,
      permission: err?.permission || undefined,
      findings: err?.findings || undefined,
    },
  };
}

/**
 * The Express error handler every router mounts.
 *
 * @param {string} label which router, for the log line
 */
function handler(label) {
  return function errorHandler(err, req, res, next) {
    const { status, body } = forClient(err);
    // A tagged 4xx or 503 is an expected outcome, not an incident. Logging
    // every "sign in to do that" buries the ones that matter.
    if (!err?.status || status >= 500) {
      console.error(`${label}:`, forLog(err));
    }
    res.status(status).json(body);
  };
}

module.exports = { forLog, forClient, handler, scrubMessage, PG_SENSITIVE };

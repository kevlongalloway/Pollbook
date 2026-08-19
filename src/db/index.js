/**
 * Postgres connection pool.
 *
 * The whole app was stateless before this file existed, and everything that
 * was free stays free: `enabled()` reports whether a database is configured,
 * and every feature built on top of it degrades to the previous anonymous
 * behaviour when it isn't. That is not politeness — it is what lets `npm test`
 * run offline on a laptop, and what keeps the site serving candidate pages if
 * the database is unreachable while the FEC is fine.
 *
 * Queries made with no DATABASE_URL throw a 503-tagged error rather than
 * crashing, so the existing `err.status` convention in routes/api.js turns
 * them into an honest "accounts are unavailable" instead of a stack trace.
 *
 * Pool size is deliberately small. Render's managed Postgres caps total
 * connections (100 on the paid tiers, far fewer on the smallest), and that
 * ceiling is shared across every instance plus any psql session you open to
 * debug. A pool of 5 per instance leaves room to actually get in and look.
 */

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL || '';

/** Is a database configured at all? Every caller must be able to cope with false. */
const enabled = () => Boolean(CONNECTION_STRING);

function unavailable() {
  const err = new Error('This feature needs a database, and none is configured on this instance.');
  err.status = 503;
  err.code = 'PB_NO_DATABASE';
  return err;
}

/*
 * Managed Postgres (Render, Neon, Supabase, Heroku) terminates TLS with a
 * certificate chain Node doesn't ship a root for, so verification fails
 * against a perfectly real server. Local Postgres usually speaks plaintext.
 * Neither case is served by a global "off" switch, so this branches on the
 * host and lets PGSSLMODE override when the guess is wrong.
 */
function sslConfig() {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable') return false;
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true };
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };

  try {
    const host = new URL(CONNECTION_STRING).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '') return false;
  } catch {
    return false;
  }
  return { rejectUnauthorized: false };
}

let pool = null;

/** The shared pool, created on first use. Null when no database is configured. */
function getPool() {
  if (!enabled()) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: sslConfig(),
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10_000,
    application_name: 'pollbook',
  });

  // An idle client erroring (server restart, network blip) emits on the pool.
  // Without a listener Node treats it as an unhandled 'error' event and exits
  // the process — a database hiccup would take the whole site down, including
  // the anonymous pages that never needed the database.
  pool.on('error', (err) => {
    console.error('pg: idle client error —', err.message);
  });

  return pool;
}

/** One query. Throws a 503-tagged error when no database is configured. */
async function query(text, params) {
  const p = getPool();
  if (!p) throw unavailable();
  return p.query(text, params);
}

/** Convenience: the rows of a query. */
async function rows(text, params) {
  const result = await query(text, params);
  return result.rows;
}

/** Convenience: the first row, or null. */
async function one(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/**
 * Run `fn` inside a transaction, with the client passed in.
 *
 * The client is handed to the callback rather than swapped into the module's
 * `query` export, because an implicit ambient transaction is exactly the kind
 * of state that leaks between requests under concurrency.
 */
async function tx(fn) {
  const p = getPool();
  if (!p) throw unavailable();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Is the database actually reachable right now? For /api/health. */
async function healthy() {
  if (!enabled()) return { enabled: false, reachable: false };
  try {
    await query('SELECT 1');
    return { enabled: true, reachable: true };
  } catch (err) {
    return { enabled: true, reachable: false, error: err.message };
  }
}

/** Close the pool. For tests and graceful shutdown. */
async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => {});
}

module.exports = { enabled, getPool, query, rows, one, tx, healthy, close, unavailable };

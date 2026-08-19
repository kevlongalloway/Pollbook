/**
 * Migrations: numbered .sql files, applied once, in order, inside a lock.
 *
 * Three failure modes this is shaped around, all of which have bitten real
 * deployments of exactly this size:
 *
 *   - **Two instances booting at once.** Render starts the new instance before
 *     retiring the old one, so two processes reach this code simultaneously
 *     and race to apply the same file. A session-level advisory lock makes the
 *     second one wait and then find nothing to do.
 *   - **A migration edited after it was applied.** The file and the database
 *     then disagree silently, and every later assumption is built on sand.
 *     Checksums are recorded on apply and re-verified on every boot, and a
 *     mismatch is a hard stop with an explicit instruction.
 *   - **A migration that fails halfway.** Each file runs in its own
 *     transaction, so a failure leaves the database exactly where it was.
 *     Files that must run outside one (CREATE INDEX CONCURRENTLY, some ALTER
 *     TYPE forms) opt out with a `-- @no-transaction` first line.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./index');

const DIR = path.join(__dirname, 'migrations');

// Arbitrary but constant. Postgres advisory locks are a single 64-bit
// namespace shared with anything else using the same database, so a fixed
// value derived from the project name is less likely to collide than a small
// integer someone else also picked.
const LOCK_ID = 0x504f4c4c; // "POLL"

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** The migration files on disk, in application order. */
function migrationFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** `001_core.sql` → `001`. The number is the identity; the name is a comment. */
function versionOf(file) {
  const idx = file.indexOf('_');
  return idx === -1 ? file.replace(/\.sql$/, '') : file.slice(0, idx);
}

async function migrate({ log = console.log } = {}) {
  if (!db.enabled()) {
    log('migrate: DATABASE_URL is not set — nothing to do.');
    return { applied: [], skipped: true };
  }

  const pool = db.getPool();
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query('SELECT version, name, checksum FROM schema_migrations');
    const seen = new Map(existing.rows.map((r) => [r.version, r]));

    for (const file of migrationFiles()) {
      const version = versionOf(file);
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      const checksum = sha256Hex(sql);
      const prior = seen.get(version);

      if (prior) {
        if (prior.checksum !== checksum) {
          throw new Error(
            `Migration ${file} has changed since it was applied (as ${prior.name}). ` +
            'The database and this checkout now disagree about the schema. ' +
            'Add a new migration rather than editing an applied one.'
          );
        }
        continue;
      }

      const bare = sql.startsWith('-- @no-transaction');
      log(`migrate: applying ${file}${bare ? ' (outside a transaction)' : ''}`);

      if (!bare) await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [version, file, checksum]
        );
        if (!bare) await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        if (!bare) await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    log(
      applied.length
        ? `migrate: applied ${applied.length} migration(s).`
        : 'migrate: database already up to date.'
    );
    return { applied, skipped: false };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(err.message);
      await db.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate, migrationFiles, versionOf, __LOCK_ID: LOCK_ID };

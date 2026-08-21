/**
 * The background scheduler.
 *
 * One `setInterval` per process, and a row per job in Postgres. Cron
 * expressions do not survive horizontal scaling — every instance would run
 * every job, so a deadline reminder would go out once per instance — whereas
 * `FOR UPDATE SKIP LOCKED` means exactly one instance claims a due job and a
 * crashed instance's claim becomes available again when its lock expires.
 *
 * That is the whole coordination story. No Redis, no leader election, no
 * dedicated worker dyno, and the same code path whether you run one instance
 * or six.
 *
 * Off unless `ENABLE_JOBS=1`: setting `DATABASE_URL` should never be what
 * starts sending mail.
 */

const os = require('os');
const db = require('../db');

const TICK_MS = Number(process.env.WORKER_TICK_MS) || 20_000;
const CLAIM_LOCK_MS = Number(process.env.WORKER_LOCK_MS) || 5 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 3;

const instanceId = `${os.hostname()}:${process.pid}`;

/** Job key → the function that runs it. */
const JOBS = {
  'producer.deadlines': () => require('./producers/deadlines').run(),
  'producer.reconcile': () => require('./producers/reconcile').run(),
  'producer.odds': () => require('./producers/odds').run(),
  'producer.news': () => require('./producers/news').run(),
  'worker.fanout': () => require('../notify/outbox').fanoutPending(),
  'worker.sender': () => require('../notify/outbox').drain(),
  'worker.digest': () => require('./digest').run(),
  'worker.retention': () => require('./retention').run(),
  'worker.verify_chain': () => require('./verifyChain').run(),
};

let timer = null;
let running = false;

/**
 * Claim up to `MAX_CONCURRENT_JOBS` due jobs.
 *
 * A job whose row is missing from `JOBS` is claimed and immediately released:
 * that happens when a deploy removes a job the database still knows about,
 * and leaving it claimed would block it forever.
 */
async function claimDue() {
  return db.rows(
    `UPDATE scheduled_jobs
        SET locked_until = now() + ($2::int * interval '1 millisecond'),
            locked_by = $3
      WHERE key IN (
        SELECT key FROM scheduled_jobs
         WHERE enabled
           AND next_run_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY next_run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1)
    RETURNING key, interval_ms, consecutive_failures`,
    [MAX_CONCURRENT_JOBS, CLAIM_LOCK_MS, instanceId]
  );
}

async function release(key, intervalMs, { status, error, durationMs, failures }) {
  // Back off a job that keeps failing rather than hammering a broken upstream
  // every interval — capped so it always recovers on its own once the cause
  // clears.
  const delay = status === 'ok'
    ? intervalMs
    : Math.min(intervalMs * 2 ** Math.min(failures, 5), 6 * 3_600_000);

  await db.query(
    `UPDATE scheduled_jobs
        SET locked_until = NULL,
            locked_by = NULL,
            last_run_at = now(),
            last_status = $2,
            last_error = $3,
            last_duration_ms = $4,
            consecutive_failures = $5,
            next_run_at = now() + ($6::bigint * interval '1 millisecond')
      WHERE key = $1`,
    [key, status, error ? String(error).slice(0, 500) : null, durationMs, failures, delay]
  );
}

async function tick() {
  if (running || !db.enabled()) return;
  running = true;

  try {
    const due = await claimDue();

    for (const job of due) {
      const fn = JOBS[job.key];
      if (!fn) {
        await release(job.key, job.interval_ms, {
          status: 'skipped', error: 'no handler in this build', durationMs: 0, failures: 0,
        });
        continue;
      }

      const started = Date.now();
      try {
        await fn();
        await release(job.key, job.interval_ms, {
          status: 'ok', error: null, durationMs: Date.now() - started, failures: 0,
        });
      } catch (err) {
        console.error(`worker: ${job.key} failed —`, err.message);
        await release(job.key, job.interval_ms, {
          status: 'error',
          error: err.message,
          durationMs: Date.now() - started,
          failures: (job.consecutive_failures || 0) + 1,
        });
      }
    }
  } catch (err) {
    // A tick failing must never stop the loop — a database blip would
    // otherwise silently end all background work until the next deploy.
    console.error('worker: tick failed —', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  console.log(`workers: started (tick ${TICK_MS}ms, instance ${instanceId})`);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // One immediate pass so a restart picks up anything overdue rather than
  // waiting out a full tick.
  setTimeout(() => { void tick(); }, 2000).unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, JOBS, instanceId };

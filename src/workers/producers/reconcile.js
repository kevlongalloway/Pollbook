/**
 * Keeping tracked subjects honest against live data.
 *
 * Races and elections are derived strings with no table (see lib/subjects.js),
 * which means a subscription can outlive the thing it points at in two very
 * different ways, and telling them apart is this job's entire purpose:
 *
 *   - **The FEC is having a bad afternoon.** `buildRaces()` only emits a
 *     Senate race when candidates came back, so a race key vanishes and
 *     reappears. Deleting the subscription would be catastrophic and
 *     irreversible.
 *   - **The election actually happened.** `ga-senate-2026` means nothing in
 *     2027, and somebody following it should be told and offered the next
 *     cycle rather than quietly moved onto a different contest.
 *
 * So: nothing is ever deleted, a key that stops resolving is marked
 * `unresolved` and only after a week of it, and a concluded race is
 * `retired` — with the seat subscription created alongside it (again, see
 * lib/subjects.js) carrying the subscriber into the next cycle on its own.
 */

const db = require('../../db');
const calendar = require('../../lib/calendar');
const subjects = require('../../lib/subjects');
const electionService = require('../../services/electionService');
const { STATES } = require('../../data/usStates');

/** A key must fail to resolve for this long before it is called unresolved. */
const GRACE_DAYS = 7;

async function run({ today = calendar.todayIso() } = {}) {
  const tracked = await db.rows(
    `SELECT DISTINCT sj.key, sj.type, sj.state_code, sj.cycle, sj.status, sj.label
       FROM subjects sj
       JOIN subscriptions s ON s.subject_key = sj.key
      WHERE sj.type IN ('election', 'race')`
  );

  const live = await resolveLiveKeys(tracked, today);
  const stats = { checked: tracked.length, verified: 0, unresolved: 0, retired: 0 };

  for (const subject of tracked) {
    // A cycle whose general election has passed is concluded, not missing.
    // That is a fact about the calendar, not about whether an upstream
    // answered, so it does not wait out the grace period.
    if (subject.cycle && calendar.generalElectionDate(subject.cycle) < today) {
      if (subject.status !== 'retired') {
        await db.query(
          `UPDATE subjects SET status = 'retired', unresolved_since = COALESCE(unresolved_since, now())
            WHERE key = $1`,
          [subject.key]
        );
        stats.retired += 1;
      }
      continue;
    }

    const label = live.get(subject.key);
    if (label) {
      await db.query(
        `UPDATE subjects
            SET status = 'active', last_verified_at = now(), unresolved_since = NULL,
                label = $2, label_updated_at = now()
          WHERE key = $1`,
        [subject.key, label]
      );
      stats.verified += 1;
    } else {
      await db.query(
        `UPDATE subjects
            SET unresolved_since = COALESCE(unresolved_since, now()),
                status = CASE
                  WHEN COALESCE(unresolved_since, now()) < now() - ($2::int * interval '1 day')
                  THEN 'unresolved' ELSE status END
          WHERE key = $1`,
        [subject.key, GRACE_DAYS]
      );
      stats.unresolved += 1;
    }
  }

  return stats;
}

/**
 * Every election and race key the providers currently produce, with labels.
 *
 * Only the states somebody actually follows are queried — walking all 51
 * would be dozens of FEC round trips a day for data nobody is waiting on.
 * An upstream failure for one state leaves its keys unverified rather than
 * marking them missing, which is why the grace period exists.
 */
async function resolveLiveKeys(tracked, today) {
  const live = new Map();
  const states = new Set(
    tracked.map((t) => t.state_code).filter(Boolean)
  );

  for (const election of calendar.allElections({ today, upcoming: true })) {
    const key = subjects.fromLegacyId(election.id, 'election');
    if (key) live.set(key, election.name);
  }

  for (const code of states) {
    if (!STATES.some((s) => s.code === code)) continue;
    const cycle = calendar.currentCycle(today);
    try {
      const election = await electionService.getElectionById(`${code.toLowerCase()}-general-${cycle}`);
      for (const race of election?.races || []) {
        const key = subjects.fromLegacyId(race.id, 'race');
        if (key) live.set(key, race.office);
      }
    } catch (err) {
      // Leave this state's keys unverified. The grace period is precisely
      // for this: an outage must not look like a redistricting.
      console.error(`reconcile: could not resolve races for ${code} —`, err.message);
    }
  }

  return live;
}

/**
 * What to offer somebody whose race has concluded.
 *
 * Returns the next cycle's key for each retired race they follow, so the
 * account page can say "the 2026 Georgia Senate race is over — follow the
 * 2028 one?" rather than either going silent or silently re-pointing them.
 */
async function rolloverSuggestions(userId) {
  const rows = await db.rows(
    `SELECT sj.key, sj.label, sj.cycle, sj.seat_key
       FROM subscriptions s
       JOIN subjects sj ON sj.key = s.subject_key
      WHERE s.user_id = $1 AND sj.status = 'retired' AND sj.seat_key IS NOT NULL`,
    [userId]
  );

  const nextCycle = calendar.currentCycle();
  return rows
    .map((row) => ({
      concluded: row.key,
      label: row.label,
      suggestion: subjects.raceKeyForCycle(row.seat_key, nextCycle),
    }))
    .filter((r) => r.suggestion && r.suggestion !== r.concluded);
}

module.exports = { run, rolloverSuggestions, resolveLiveKeys, GRACE_DAYS };

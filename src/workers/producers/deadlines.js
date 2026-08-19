/**
 * Reminders to check your registration and to go vote.
 *
 * This is the only category that sends without a human approving the words,
 * and the reason it is allowed to is that it makes no claim a person could
 * disagree with: an election date computed from statute, and a link to the
 * official source.
 *
 * **What it deliberately does not say.** Pollbook has no sourced, per-state
 * voter-registration deadline table. `usStates.js` carries primary and
 * general dates derived from 2 U.S.C. §7 and state law, plus a vote.gov link,
 * and nothing more. Asserting "register by October 6" from a constant nobody
 * can cite would be exactly the failure this codebase avoids everywhere else
 * — the watchlist in data/electionBills.js drops a bill rather than render an
 * unverified one, and the money-flow diagram drops a figure rather than force
 * it.
 *
 * So these messages are anchored on the election date, which is defensible,
 * and send the reader to their state for the deadline itself. That is both
 * honest and more useful than a number we would have to hedge. When a sourced
 * deadline table exists — one citation per row, rendered in the message — the
 * templates get a version 2 that names the date.
 */

const db = require('../../db');
const calendar = require('../../lib/calendar');
const subjects = require('../../lib/subjects');
const { getState, registrationUrl } = require('../../data/usStates');

/**
 * How far out to send, and which template each lead time uses.
 *
 * Registration first, because that is the deadline people miss; then the
 * election itself. Nobody gets more than four messages about one election,
 * and the frequency cap in the fanout query trims further.
 */
const SCHEDULE = [
  { days: 30, template: 'deadline.register.t30', sms: 'deadline.register.t30.sms', kind: 'register' },
  { days: 14, template: 'deadline.register.t30', sms: 'deadline.register.t30.sms', kind: 'register' },
  { days: 7, template: 'deadline.election.t7', sms: null, kind: 'election' },
  { days: 1, template: 'deadline.election.t1', sms: 'deadline.election.t1.sms', kind: 'election' },
  { days: 0, template: 'deadline.election.t1', sms: 'deadline.election.day.sms', kind: 'election' },
];

/** Whole days from today to an ISO date, in UTC. */
function daysUntil(isoDate, today = calendar.todayIso()) {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  return Math.round((then - now) / 86_400_000);
}

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

/**
 * Create events for every election that has hit a lead time today.
 *
 * Only elections somebody actually follows produce an event — there is no
 * point fanning out Wyoming's primary to a queue that will match nobody.
 * `dedup_key` carries the lead time, so running hourly creates one event per
 * election per milestone no matter how often this runs.
 */
async function run({ today = calendar.todayIso() } = {}) {
  const followed = await db.rows(
    `SELECT DISTINCT sj.key, sj.state_code, sj.cycle, sj.label
       FROM subscriptions s
       JOIN subjects sj ON sj.key = s.subject_key
      WHERE sj.type IN ('election', 'race', 'seat', 'state')
        AND sj.status <> 'retired'`
  );

  const created = [];
  const seen = new Set();

  for (const subject of followed) {
    if (!subject.state_code) continue;
    const state = getState(subject.state_code);
    if (!state) continue;

    for (const election of calendar.stateElections(state.code, { today, upcoming: true })) {
      const days = daysUntil(election.date, today);
      const milestone = SCHEDULE.find((s) => s.days === days);
      if (!milestone) continue;

      const key = `${election.id}:${milestone.days}:${subject.key}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const subjectKey = subjects.fromLegacyId(election.id, 'election');
      if (!subjectKey) continue;

      // The election has to exist as a subject before an event can reference
      // it, even when nobody follows the election directly — people follow
      // races within it.
      await db.query(
        `INSERT INTO subjects (key, type, state_code, cycle, label, last_verified_at)
         VALUES ($1,'election',$2,$3,$4, now())
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, label_updated_at = now()`,
        [subjectKey, state.code, election.date.slice(0, 4), election.name]
      );

      const payload = {
        stateName: state.name,
        stateCode: state.code,
        electionName: election.name,
        electionDate: election.date,
        electionDateLong: longDate(election.date),
        daysUntil: String(Math.max(days, 0)),
        registrationUrl: election.registrationUrl || registrationUrl(state.code),
        subjectLabel: subject.label || election.name,
        subjectUrl: `${require('../../notify/outbox').siteUrl()}/#/election/${election.id}`,
      };

      for (const [channel, templateKey] of [['email', milestone.template], ['sms', milestone.sms]]) {
        if (!templateKey) continue;

        const row = await db.one(
          `INSERT INTO notification_events
             (dedup_key, category, subject_key, state_code, payload, template_key, sources, auto_send)
           VALUES ($1,'deadlines',$2,$3,$4,$5,$6,true)
           ON CONFLICT (dedup_key) DO NOTHING
           RETURNING id`,
          [
            `deadline:${election.id}:${milestone.kind}:T-${milestone.days}:${channel}`,
            subjectKey,
            state.code,
            JSON.stringify(payload),
            templateKey,
            JSON.stringify([
              { label: `${state.name} voter information (vote.gov)`, url: payload.registrationUrl },
              { label: 'Federal election date (2 U.S.C. §7)', url: 'https://www.congress.gov' },
            ]),
          ]
        );
        if (row) created.push({ id: row.id, election: election.id, days: milestone.days, channel });
      }
    }
  }

  return { created: created.length, events: created };
}

module.exports = { run, daysUntil, longDate, SCHEDULE };

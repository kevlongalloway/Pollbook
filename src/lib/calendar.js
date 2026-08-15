/**
 * Election calendar, computed — not hardcoded per year.
 *
 * Federal general elections fall on "the Tuesday next after the first Monday
 * in November" of even-numbered years (2 U.S.C. §7), so the general-election
 * date for any cycle is derived here rather than stored. Primary dates are
 * set by state law and come from the table in data/usStates.js.
 */

const { STATES, getState, registrationUrl } = require('../data/usStates');

/** ISO date of the federal general election for an even year. */
function generalElectionDate(year) {
  // First Monday in November, then the following Tuesday.
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstMondayOffset = (8 - nov1.getUTCDay()) % 7; // days from Nov 1 to Monday
  const day = 1 + firstMondayOffset + 1;
  return `${year}-11-${String(day).padStart(2, '0')}`;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** The federal election cycle (even year) that today falls in. */
function currentCycle(today = todayIso()) {
  let year = Number(today.slice(0, 4));
  if (year % 2 !== 0) year += 1;
  // If this cycle's general election has passed, roll to the next one.
  if (generalElectionDate(year) < today) year += 2;
  return year;
}

/**
 * The Congress seated on a given date.
 *
 * A new Congress convenes on January 3 of each odd-numbered year (20th
 * Amendment), so the 1st Congress began in 1789 and the number advances every
 * two years. Derived rather than stored, for the same reason election dates
 * are: it stays correct after the current cycle rolls over.
 */
function currentCongress(today = todayIso()) {
  const year = Number(today.slice(0, 4));
  const seatedYear = year % 2 === 1 && today < `${year}-01-03` ? year - 1 : year;
  return Math.floor((seatedYear - 1789) / 2) + 1;
}

function describeGeneral(st, cycle) {
  const parts = ['All of the state’s U.S. House seats'];
  if (st.senate2026 && cycle === 2026) parts.push('a U.S. Senate seat');
  if (st.governor2026 && cycle === 2026) parts.push('the governorship');
  const offices = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    : parts[0];
  return `${offices} are on the ballot, along with state and local offices that vary by county. Check your sample ballot with your local election office for the complete list.`;
}

function stateElections(code, { today = todayIso(), upcoming = true } = {}) {
  const st = getState(code);
  if (!st) return [];
  const cycle = currentCycle(today);
  const out = [];

  // Primary dates are only tabled for the 2026 cycle; later cycles surface
  // once their statutory dates are added to usStates.js.
  if (cycle === 2026 && st.primary2026) {
    out.push({
      id: `${st.code.toLowerCase()}-primary-2026`,
      name: `${st.name} Primary Election`,
      date: st.primary2026,
      scope: 'state',
      state: st.code,
      locality: 'Statewide',
      type: 'Primary',
      registrationUrl: registrationUrl(st.code),
      description: `Party primaries choose the nominees who advance to the November general election. Primary rules (open, closed, or top-two) vary by state.${st.note ? ` ${st.note}` : ''}`,
    });
  }

  out.push({
    id: `${st.code.toLowerCase()}-general-${cycle}`,
    name: `${st.name} General Election`,
    date: generalElectionDate(cycle),
    scope: 'state',
    state: st.code,
    locality: 'Statewide',
    type: 'General',
    registrationUrl: registrationUrl(st.code),
    description: `${describeGeneral(st, cycle)}${st.note ? ` ${st.note}` : ''}`,
  });

  return upcoming ? out.filter((e) => e.date >= today) : out;
}

function nationalElection({ today = todayIso() } = {}) {
  const cycle = currentCycle(today);
  const midterm = cycle % 4 !== 0;
  return {
    id: `us-general-${cycle}`,
    name: midterm ? `U.S. Midterm Elections ${cycle}` : `U.S. General Election ${cycle}`,
    date: generalElectionDate(cycle),
    scope: 'national',
    state: null,
    locality: 'Nationwide',
    type: 'General',
    registrationUrl: 'https://vote.gov',
    description: midterm
      ? `All 435 U.S. House seats and about a third of the U.S. Senate are up for election, along with most governorships. Control of both chambers of Congress is in play. Pick your state above to see exactly what is on your ballot.`
      : `The presidency, all 435 U.S. House seats, and about a third of the U.S. Senate are on the ballot. Pick your state above to see exactly what is on your ballot.`,
  };
}

function allElections(opts = {}) {
  const list = STATES.flatMap((s) => stateElections(s.code, opts));
  list.push(nationalElection(opts));
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

module.exports = {
  generalElectionDate,
  currentCycle,
  currentCongress,
  stateElections,
  nationalElection,
  allElections,
  todayIso,
};

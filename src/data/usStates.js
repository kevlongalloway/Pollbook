/**
 * All 50 states + DC with the facts needed to build an election calendar.
 *
 * governor2026  — state elects its governor in November 2026 (36 states do).
 * senate2026    — a U.S. Senate seat is on the 2026 ballot (Class 2 seats,
 *                 plus the Ohio and Florida special elections). This flag is a
 *                 display hint only — the live candidate list always comes
 *                 from the FEC API, which is the source of truth.
 * primary2026   — statutory/scheduled 2026 primary date. These follow state
 *                 law but legislatures occasionally move them; the UI tells
 *                 users to confirm with their election office.
 *
 * Registration links point at vote.gov, which stays current per state.
 */

const STATES = [
  { code: 'AL', name: 'Alabama',        governor2026: true,  senate2026: true,  primary2026: '2026-05-19' },
  { code: 'AK', name: 'Alaska',         governor2026: true,  senate2026: true,  primary2026: '2026-08-18' },
  { code: 'AZ', name: 'Arizona',        governor2026: true,  senate2026: false, primary2026: '2026-08-04' },
  { code: 'AR', name: 'Arkansas',       governor2026: true,  senate2026: true,  primary2026: '2026-03-03' },
  { code: 'CA', name: 'California',     governor2026: true,  senate2026: false, primary2026: '2026-06-02' },
  { code: 'CO', name: 'Colorado',       governor2026: true,  senate2026: true,  primary2026: '2026-06-30' },
  { code: 'CT', name: 'Connecticut',    governor2026: true,  senate2026: false, primary2026: '2026-08-11' },
  { code: 'DE', name: 'Delaware',       governor2026: false, senate2026: true,  primary2026: '2026-09-08' },
  { code: 'FL', name: 'Florida',        governor2026: true,  senate2026: true,  primary2026: '2026-08-18',
    note: 'The 2026 U.S. Senate race is a special election to fill the remainder of an unexpired term.' },
  { code: 'GA', name: 'Georgia',        governor2026: true,  senate2026: true,  primary2026: '2026-05-19' },
  { code: 'HI', name: 'Hawaii',         governor2026: true,  senate2026: false, primary2026: '2026-08-08' },
  { code: 'ID', name: 'Idaho',          governor2026: true,  senate2026: true,  primary2026: '2026-05-19' },
  { code: 'IL', name: 'Illinois',       governor2026: true,  senate2026: true,  primary2026: '2026-03-17' },
  { code: 'IN', name: 'Indiana',        governor2026: false, senate2026: false, primary2026: '2026-05-05' },
  { code: 'IA', name: 'Iowa',           governor2026: true,  senate2026: true,  primary2026: '2026-06-02' },
  { code: 'KS', name: 'Kansas',         governor2026: true,  senate2026: true,  primary2026: '2026-08-04' },
  { code: 'KY', name: 'Kentucky',       governor2026: false, senate2026: true,  primary2026: '2026-05-19' },
  { code: 'LA', name: 'Louisiana',      governor2026: false, senate2026: true,  primary2026: null,
    note: 'Louisiana is transitioning from its all-party November primary to closed party primaries for federal races — confirm the current schedule with the Louisiana Secretary of State.' },
  { code: 'ME', name: 'Maine',          governor2026: true,  senate2026: true,  primary2026: '2026-06-09' },
  { code: 'MD', name: 'Maryland',       governor2026: true,  senate2026: false, primary2026: '2026-06-30' },
  { code: 'MA', name: 'Massachusetts',  governor2026: true,  senate2026: true,  primary2026: '2026-09-01' },
  { code: 'MI', name: 'Michigan',       governor2026: true,  senate2026: true,  primary2026: '2026-08-04' },
  { code: 'MN', name: 'Minnesota',      governor2026: true,  senate2026: true,  primary2026: '2026-08-11' },
  { code: 'MS', name: 'Mississippi',    governor2026: false, senate2026: true,  primary2026: '2026-06-02' },
  { code: 'MO', name: 'Missouri',       governor2026: false, senate2026: false, primary2026: '2026-08-04' },
  { code: 'MT', name: 'Montana',        governor2026: false, senate2026: true,  primary2026: '2026-06-02' },
  { code: 'NE', name: 'Nebraska',       governor2026: true,  senate2026: true,  primary2026: '2026-05-12' },
  { code: 'NV', name: 'Nevada',         governor2026: true,  senate2026: false, primary2026: '2026-06-09' },
  { code: 'NH', name: 'New Hampshire',  governor2026: true,  senate2026: true,  primary2026: '2026-09-08' },
  { code: 'NJ', name: 'New Jersey',     governor2026: false, senate2026: true,  primary2026: '2026-06-02' },
  { code: 'NM', name: 'New Mexico',     governor2026: true,  senate2026: true,  primary2026: '2026-06-02' },
  { code: 'NY', name: 'New York',       governor2026: true,  senate2026: false, primary2026: '2026-06-23' },
  { code: 'NC', name: 'North Carolina', governor2026: false, senate2026: true,  primary2026: '2026-03-03' },
  { code: 'ND', name: 'North Dakota',   governor2026: false, senate2026: false, primary2026: '2026-06-09' },
  { code: 'OH', name: 'Ohio',           governor2026: true,  senate2026: true,  primary2026: '2026-05-05',
    note: 'The 2026 U.S. Senate race is a special election to fill the remainder of an unexpired term.' },
  { code: 'OK', name: 'Oklahoma',       governor2026: true,  senate2026: true,  primary2026: '2026-06-23' },
  { code: 'OR', name: 'Oregon',         governor2026: true,  senate2026: true,  primary2026: '2026-05-19' },
  { code: 'PA', name: 'Pennsylvania',   governor2026: true,  senate2026: false, primary2026: '2026-05-19' },
  { code: 'RI', name: 'Rhode Island',   governor2026: true,  senate2026: true,  primary2026: '2026-09-08' },
  { code: 'SC', name: 'South Carolina', governor2026: true,  senate2026: true,  primary2026: '2026-06-09' },
  { code: 'SD', name: 'South Dakota',   governor2026: true,  senate2026: true,  primary2026: '2026-06-02' },
  { code: 'TN', name: 'Tennessee',      governor2026: true,  senate2026: true,  primary2026: '2026-08-06' },
  { code: 'TX', name: 'Texas',          governor2026: true,  senate2026: true,  primary2026: '2026-03-03' },
  { code: 'UT', name: 'Utah',           governor2026: false, senate2026: false, primary2026: '2026-06-23' },
  { code: 'VT', name: 'Vermont',        governor2026: true,  senate2026: false, primary2026: '2026-08-11' },
  { code: 'VA', name: 'Virginia',       governor2026: false, senate2026: true,  primary2026: '2026-06-16' },
  { code: 'WA', name: 'Washington',     governor2026: false, senate2026: false, primary2026: '2026-08-04' },
  { code: 'WV', name: 'West Virginia',  governor2026: false, senate2026: true,  primary2026: '2026-05-12' },
  { code: 'WI', name: 'Wisconsin',      governor2026: true,  senate2026: false, primary2026: '2026-08-11' },
  { code: 'WY', name: 'Wyoming',        governor2026: true,  senate2026: true,  primary2026: '2026-08-18' },
  { code: 'DC', name: 'District of Columbia', governor2026: false, senate2026: false, primary2026: '2026-06-02',
    note: 'DC elects a non-voting Delegate to the U.S. House, the mayor, and the DC Council.' },
];

const byCode = new Map(STATES.map((s) => [s.code, s]));

const getState = (code) => byCode.get(String(code || '').toUpperCase()) || null;

const registrationUrl = (code) =>
  `https://vote.gov/register/${String(code || '').toLowerCase()}`;

module.exports = { STATES, getState, registrationUrl };

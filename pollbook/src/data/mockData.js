/**
 * Seed data. All candidates, articles, and outlets are FICTIONAL placeholders —
 * replace with live API data (Google Civic / Vote Smart / Ballotpedia) in production.
 * Dates are set relative to a July 2026 "today" so the skeleton demos well.
 */

const AREAS = [
  {
    code: 'GA', name: 'Georgia',
    localities: ['Atlanta', 'DeKalb County', 'Fulton County', 'Gwinnett County', 'Lithonia', 'Savannah'],
  },
  {
    code: 'TX', name: 'Texas',
    localities: ['Austin', 'Dallas', 'Harris County', 'Houston', 'San Antonio'],
  },
  {
    code: 'CA', name: 'California',
    localities: ['Los Angeles', 'Oakland', 'Sacramento', 'San Diego', 'San Francisco'],
  },
  {
    code: 'OH', name: 'Ohio',
    localities: ['Cincinnati', 'Cleveland', 'Columbus', 'Franklin County'],
  },
];

const ELECTIONS = [
  {
    id: 'ga-general-2026',
    name: 'Georgia General Election',
    date: '2026-11-03',
    scope: 'state',
    state: 'GA',
    locality: 'Statewide',
    type: 'General',
    registrationDeadline: '2026-10-05',
    earlyVotingStart: '2026-10-12',
    description: 'Statewide general election. Governor, all statewide constitutional offices, U.S. House seats, the full General Assembly, and two proposed constitutional amendments are on the ballot.',
    raceIds: ['ga-governor', 'ga-sos', 'ga-house-04'],
  },
  {
    id: 'us-midterm-2026',
    name: 'U.S. Midterm Elections',
    date: '2026-11-03',
    scope: 'national',
    state: null,
    locality: 'Nationwide',
    type: 'General',
    registrationDeadline: 'Varies by state',
    earlyVotingStart: 'Varies by state',
    description: 'All 435 U.S. House seats and 33 U.S. Senate seats are up for election, along with 36 governorships. Control of both chambers of Congress is in play.',
    raceIds: ['us-senate-ga'],
  },
  {
    id: 'dekalb-school-board-2026',
    name: 'DeKalb County School Board Election',
    date: '2026-11-03',
    scope: 'local',
    state: 'GA',
    locality: 'DeKalb County',
    type: 'School Board',
    registrationDeadline: '2026-10-05',
    earlyVotingStart: '2026-10-12',
    description: 'Districts 2, 4, and 6 elect board members who set the budget, hire the superintendent, and shape policy for one of the largest school systems in Georgia.',
    raceIds: ['dekalb-sb-d4'],
  },
  {
    id: 'atl-municipal-runoff-2026',
    name: 'Atlanta Municipal Special Election Runoff',
    date: '2026-08-18',
    scope: 'local',
    state: 'GA',
    locality: 'Atlanta',
    type: 'Runoff',
    registrationDeadline: '2026-07-20',
    earlyVotingStart: '2026-08-03',
    description: 'Runoff for the vacant City Council District 11 seat. Turnout in the special election was under 9% — the runoff will likely be decided by a few thousand voters.',
    raceIds: ['atl-cc-d11'],
  },
  {
    id: 'fulton-judicial-2026',
    name: 'Fulton County Judicial Election',
    date: '2026-11-03',
    scope: 'local',
    state: 'GA',
    locality: 'Fulton County',
    type: 'Judicial',
    registrationDeadline: '2026-10-05',
    earlyVotingStart: '2026-10-12',
    description: 'Nonpartisan election for two Superior Court judgeships and one Probate Court seat. Judicial races are routinely skipped by 30–40% of voters who complete the rest of their ballot.',
    raceIds: ['fulton-superior-3'],
  },
  {
    id: 'gwinnett-transit-2026',
    name: 'Gwinnett County Transit Referendum',
    date: '2026-11-03',
    scope: 'local',
    state: 'GA',
    locality: 'Gwinnett County',
    type: 'Referendum',
    registrationDeadline: '2026-10-05',
    earlyVotingStart: '2026-10-12',
    description: 'A one-percent sales tax referendum to fund a 30-year county transit expansion plan, including bus rapid transit lines and MARTA connectivity.',
    raceIds: [],
  },
  {
    id: 'tx-general-2026',
    name: 'Texas General Election',
    date: '2026-11-03',
    scope: 'state',
    state: 'TX',
    locality: 'Statewide',
    type: 'General',
    registrationDeadline: '2026-10-05',
    earlyVotingStart: '2026-10-19',
    description: 'Governor, lieutenant governor, attorney general, and all statewide executive offices on the ballot, plus U.S. House seats and the Texas Legislature.',
    raceIds: ['tx-governor'],
  },
  {
    id: 'austin-isd-2026',
    name: 'Austin ISD Board of Trustees Election',
    date: '2026-11-03',
    scope: 'local',
    state: 'TX',
    locality: 'Austin',
    type: 'School Board',
    registrationDeadline: '2026-10-05',
    earlyVotingStart: '2026-10-19',
    description: 'Four of nine trustee seats are up. The board oversees an annual budget of roughly $2 billion and district-wide boundary decisions.',
    raceIds: [],
  },
  {
    id: 'ca-general-2026',
    name: 'California General Election',
    date: '2026-11-03',
    scope: 'state',
    state: 'CA',
    locality: 'Statewide',
    type: 'General',
    registrationDeadline: '2026-10-19',
    earlyVotingStart: '2026-10-05',
    description: 'Governor, statewide offices, legislative seats, and a slate of statewide ballot propositions ranging from housing bonds to energy policy.',
    raceIds: [],
  },
  {
    id: 'oh-columbus-levy-2026',
    name: 'Columbus City Schools Levy',
    date: '2026-08-04',
    scope: 'local',
    state: 'OH',
    locality: 'Columbus',
    type: 'Referendum',
    registrationDeadline: '2026-07-06',
    earlyVotingStart: '2026-07-07',
    description: 'A property tax levy funding school building repairs and teacher retention. Special election — historically under 12% turnout.',
    raceIds: [],
  },
];

const RACES = [
  {
    id: 'ga-governor', electionId: 'ga-general-2026',
    office: 'Governor of Georgia', seats: 1,
    candidateIds: ['cand-mwhitfield', 'cand-dokafor', 'cand-rlangley'],
  },
  {
    id: 'ga-sos', electionId: 'ga-general-2026',
    office: 'Georgia Secretary of State', seats: 1,
    candidateIds: ['cand-tbeaumont', 'cand-avaldez'],
  },
  {
    id: 'ga-house-04', electionId: 'ga-general-2026',
    office: 'U.S. House — GA District 4', seats: 1,
    candidateIds: ['cand-jmercer', 'cand-kdrayton'],
  },
  {
    id: 'us-senate-ga', electionId: 'us-midterm-2026',
    office: 'U.S. Senate — Georgia', seats: 1,
    candidateIds: ['cand-mwhitfield', 'cand-pcastellanos'],
  },
  {
    id: 'dekalb-sb-d4', electionId: 'dekalb-school-board-2026',
    office: 'DeKalb School Board — District 4', seats: 1,
    candidateIds: ['cand-lnguyen', 'cand-gharrell'],
  },
  {
    id: 'atl-cc-d11', electionId: 'atl-municipal-runoff-2026',
    office: 'Atlanta City Council — District 11', seats: 1,
    candidateIds: ['cand-sboateng', 'cand-mreyes'],
  },
  {
    id: 'fulton-superior-3', electionId: 'fulton-judicial-2026',
    office: 'Fulton Superior Court — Seat 3', seats: 1,
    candidateIds: ['cand-hpatel'],
  },
  {
    id: 'tx-governor', electionId: 'tx-general-2026',
    office: 'Governor of Texas', seats: 1,
    candidateIds: ['cand-cwalsh', 'cand-idelacruz'],
  },
];

// All fictional. Party field is a code: DEM, REP, IND, LIB, GRN, NP (nonpartisan).
const CANDIDATES = [
  {
    id: 'cand-mwhitfield', name: 'Marcus Whitfield', party: 'DEM',
    office: 'Governor of Georgia', incumbent: false,
    bio: 'Former mayor of Savannah and small-business owner. Ran a port-city administration focused on workforce housing and logistics jobs.',
    coreValues: ['Workforce housing expansion', 'Medicaid expansion', 'Small business tax credits', 'Public transit investment'],
    website: 'https://example.com/whitfield',
    articles: [
      { title: 'Whitfield makes housing the center of his statewide pitch', outlet: 'Placeholder Wire', date: '2026-06-14', url: '#' },
      { title: 'From city hall to the governor\u2019s race: the Savannah record', outlet: 'Placeholder Journal', date: '2026-05-02', url: '#' },
    ],
  },
  {
    id: 'cand-dokafor', name: 'Diane Okafor', party: 'REP',
    office: 'Governor of Georgia', incumbent: false,
    bio: 'State senator from Cherokee County and former prosecutor. Chaired the Senate Appropriations Committee for two terms.',
    coreValues: ['Income tax elimination', 'School choice expansion', 'Public safety funding', 'Regulatory reduction'],
    website: 'https://example.com/okafor',
    articles: [
      { title: 'Okafor pledges to phase out state income tax by 2032', outlet: 'Placeholder Wire', date: '2026-06-20', url: '#' },
      { title: 'Appropriations chair enters the governor\u2019s race', outlet: 'Placeholder Ledger', date: '2026-03-11', url: '#' },
    ],
  },
  {
    id: 'cand-rlangley', name: 'Ruth Langley', party: 'LIB',
    office: 'Governor of Georgia', incumbent: false,
    bio: 'Logistics executive and first-time candidate running on occupational licensing reform.',
    coreValues: ['Occupational licensing reform', 'Criminal justice reform', 'Ballot access reform'],
    website: 'https://example.com/langley',
    articles: [
      { title: 'Third-party bid targets licensing rules', outlet: 'Placeholder Ledger', date: '2026-04-08', url: '#' },
    ],
  },
  {
    id: 'cand-tbeaumont', name: 'Terrence Beaumont', party: 'REP',
    office: 'Georgia Secretary of State', incumbent: true,
    bio: 'Incumbent secretary of state seeking a second term. Oversaw the statewide rollout of updated voter roll auditing.',
    coreValues: ['Election security audits', 'Business registration modernization', 'Voter roll maintenance'],
    website: 'https://example.com/beaumont',
    articles: [
      { title: 'Beaumont defends audit program in re-election launch', outlet: 'Placeholder Journal', date: '2026-02-19', url: '#' },
    ],
  },
  {
    id: 'cand-avaldez', name: 'Alicia Valdez', party: 'DEM',
    office: 'Georgia Secretary of State', incumbent: false,
    bio: 'Voting rights attorney and former county elections director for Athens-Clarke County.',
    coreValues: ['Automatic voter registration', 'Polling place accessibility', 'Election worker protection'],
    website: 'https://example.com/valdez',
    articles: [
      { title: 'Valdez campaign centers poll worker retention crisis', outlet: 'Placeholder Wire', date: '2026-05-27', url: '#' },
    ],
  },
  {
    id: 'cand-jmercer', name: 'Jordan Mercer', party: 'DEM',
    office: 'U.S. House — GA District 4', incumbent: true,
    bio: 'Two-term incumbent. Sits on the House Transportation and Infrastructure Committee.',
    coreValues: ['Infrastructure funding', 'Student debt relief', 'Clean energy manufacturing'],
    website: 'https://example.com/mercer',
    articles: [
      { title: 'Mercer touts transit grants in re-election bid', outlet: 'Placeholder Journal', date: '2026-06-01', url: '#' },
    ],
  },
  {
    id: 'cand-kdrayton', name: 'Kelsey Drayton', party: 'REP',
    office: 'U.S. House — GA District 4', incumbent: false,
    bio: 'Veteran and franchise owner. First run for federal office after serving on a county development authority.',
    coreValues: ['Fiscal restraint', 'Veterans services', 'Border security'],
    website: 'https://example.com/drayton',
    articles: [
      { title: 'Drayton launches challenge in District 4', outlet: 'Placeholder Ledger', date: '2026-04-22', url: '#' },
    ],
  },
  {
    id: 'cand-pcastellanos', name: 'Paula Castellanos', party: 'REP',
    office: 'U.S. Senate — Georgia', incumbent: false,
    bio: 'Former lieutenant governor and agribusiness executive from south Georgia.',
    coreValues: ['Agricultural trade policy', 'Tax cuts', 'Energy independence'],
    website: 'https://example.com/castellanos',
    articles: [
      { title: 'Castellanos enters Senate race with rural-first message', outlet: 'Placeholder Wire', date: '2026-01-30', url: '#' },
    ],
  },
  {
    id: 'cand-lnguyen', name: 'Linh Nguyen', party: 'NP',
    office: 'DeKalb School Board — District 4', incumbent: false,
    bio: 'Public school parent and pediatric nurse. Led a district-wide campaign for expanded school health services.',
    coreValues: ['School health services', 'Teacher pay parity', 'Facility repair transparency'],
    website: 'https://example.com/nguyen',
    articles: [
      { title: 'Parent-led slate reshapes school board race', outlet: 'Placeholder Journal', date: '2026-06-09', url: '#' },
    ],
  },
  {
    id: 'cand-gharrell', name: 'Gerald Harrell', party: 'NP',
    office: 'DeKalb School Board — District 4', incumbent: true,
    bio: 'Retired principal completing his first term on the board. Chaired the facilities committee.',
    coreValues: ['Career and technical education', 'Budget discipline', 'Principal autonomy'],
    website: 'https://example.com/harrell',
    articles: [
      { title: 'Harrell runs on facilities record', outlet: 'Placeholder Ledger', date: '2026-05-15', url: '#' },
    ],
  },
  {
    id: 'cand-sboateng', name: 'Samuel Boateng', party: 'DEM',
    office: 'Atlanta City Council — District 11', incumbent: false,
    bio: 'Neighborhood association president and transit advocate from southwest Atlanta.',
    coreValues: ['Sidewalk and transit investment', 'Anti-displacement policy', 'Neighborhood commercial corridors'],
    website: 'https://example.com/boateng',
    articles: [
      { title: 'Boateng leads special election, heads to runoff', outlet: 'Placeholder Journal', date: '2026-06-17', url: '#' },
    ],
  },
  {
    id: 'cand-mreyes', name: 'Monica Reyes', party: 'DEM',
    office: 'Atlanta City Council — District 11', incumbent: false,
    bio: 'Small business owner and former aide to the district\u2019s previous councilmember.',
    coreValues: ['Public safety staffing', 'Small business permitting reform', 'Park expansion'],
    website: 'https://example.com/reyes',
    articles: [
      { title: 'Reyes forces runoff in District 11', outlet: 'Placeholder Wire', date: '2026-06-17', url: '#' },
    ],
  },
  {
    id: 'cand-hpatel', name: 'Hema Patel', party: 'NP',
    office: 'Fulton Superior Court — Seat 3', incumbent: false,
    bio: 'Sitting magistrate judge running unopposed for an open Superior Court seat. Fifteen years in family and civil court.',
    coreValues: ['Case backlog reduction', 'Court accessibility', 'Alternative dispute resolution'],
    website: 'https://example.com/patel',
    articles: [
      { title: 'Patel unopposed for open Superior Court seat', outlet: 'Placeholder Ledger', date: '2026-05-01', url: '#' },
    ],
  },
  {
    id: 'cand-cwalsh', name: 'Colin Walsh', party: 'REP',
    office: 'Governor of Texas', incumbent: true,
    bio: 'Incumbent governor seeking a second term. Former state attorney general.',
    coreValues: ['Property tax reduction', 'Grid infrastructure', 'Border enforcement'],
    website: 'https://example.com/walsh',
    articles: [
      { title: 'Walsh opens re-election campaign in Fort Worth', outlet: 'Placeholder Wire', date: '2026-03-03', url: '#' },
    ],
  },
  {
    id: 'cand-idelacruz', name: 'Isabel de la Cruz', party: 'DEM',
    office: 'Governor of Texas', incumbent: false,
    bio: 'Former mayor of San Antonio and public health administrator.',
    coreValues: ['Public school funding', 'Rural hospital access', 'Grid reliability oversight'],
    website: 'https://example.com/delacruz',
    articles: [
      { title: 'De la Cruz bets on education funding fight', outlet: 'Placeholder Journal', date: '2026-04-14', url: '#' },
    ],
  },
];

const STATS = {
  GA: {
    state: 'Georgia',
    registeredVoters: 7920000,
    turnoutByType: [
      { type: 'Presidential General', turnout: 68 },
      { type: 'Midterm General', turnout: 52 },
      { type: 'Municipal', turnout: 24 },
      { type: 'School Board', turnout: 18 },
      { type: 'Special / Runoff', turnout: 11 },
    ],
    registrationDeadlineDays: 29,
    note: 'Local elections in Georgia routinely draw less than a third of the turnout of presidential years — a school board seat can be decided by a few hundred votes.',
  },
  TX: {
    state: 'Texas',
    registeredVoters: 18100000,
    turnoutByType: [
      { type: 'Presidential General', turnout: 61 },
      { type: 'Midterm General', turnout: 45 },
      { type: 'Municipal', turnout: 14 },
      { type: 'School Board', turnout: 9 },
      { type: 'Special / Runoff', turnout: 7 },
    ],
    registrationDeadlineDays: 29,
    note: 'Texas school board and municipal elections held in May off-cycles see single-digit turnout in most districts.',
  },
  CA: {
    state: 'California',
    registeredVoters: 22200000,
    turnoutByType: [
      { type: 'Presidential General', turnout: 71 },
      { type: 'Midterm General', turnout: 51 },
      { type: 'Municipal', turnout: 28 },
      { type: 'School Board', turnout: 22 },
      { type: 'Special / Runoff', turnout: 15 },
    ],
    registrationDeadlineDays: 15,
    note: 'California mails every registered voter a ballot, which lifts local turnout relative to most states — but down-ballot drop-off remains high.',
  },
  OH: {
    state: 'Ohio',
    registeredVoters: 8000000,
    turnoutByType: [
      { type: 'Presidential General', turnout: 67 },
      { type: 'Midterm General', turnout: 49 },
      { type: 'Municipal', turnout: 21 },
      { type: 'School Board', turnout: 16 },
      { type: 'Special / Runoff', turnout: 10 },
    ],
    registrationDeadlineDays: 30,
    note: 'August special elections in Ohio, often deciding school levies, historically draw around one in ten registered voters.',
  },
};

module.exports = { AREAS, ELECTIONS, RACES, CANDIDATES, STATS };

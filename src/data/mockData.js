/**
 * Seed data. All candidates, articles, and outlets are FICTIONAL placeholders —
 * replace with live API data (Google Civic / Vote Smart / Ballotpedia) in production.
 * Dates are set relative to a July 2026 "today" so the skeleton demos well.
 *
 * Candidate shape:
 *   { id, name, party, office, incumbent, bio, website,
 *     priorities: [string],                     // short headline tags
 *     policyPositions: [{ issue, stance }],      // concrete positions (may be empty)
 *     articles: [{ title, outlet, date, url }] } // fallback when positions are sparse
 *
 * A candidate with no concrete policyPositions (e.g. a nonpartisan judge) simply
 * leaves that array empty; the UI leans on their bio + articles instead.
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
    measure: {
      question: 'Shall Gwinnett County levy a 1% special-purpose sales tax for 30 years to fund transit expansion?',
      forStatement: 'Funds bus rapid transit, expanded local routes, and a MARTA heavy-rail connection without raising property taxes.',
      againstStatement: 'Adds a permanent penny to every purchase; opponents argue ridership projections are optimistic and the commitment runs three decades.',
    },
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
    raceIds: ['austin-isd-d5'],
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
    raceIds: ['ca-governor'],
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
    measure: {
      question: 'Shall Columbus City Schools levy an additional 5.5-mill property tax for building repairs and staff retention?',
      forStatement: 'Funds overdue roof, HVAC, and safety repairs across aging buildings and a retention bonus to slow teacher turnover.',
      againstStatement: 'Raises the tax on a $200,000 home by roughly $385 a year; opponents want a facilities audit before new money.',
    },
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
    candidateIds: ['cand-hpatel', 'cand-dosei'],
  },
  {
    id: 'tx-governor', electionId: 'tx-general-2026',
    office: 'Governor of Texas', seats: 1,
    candidateIds: ['cand-cwalsh', 'cand-idelacruz', 'cand-tflores'],
  },
  {
    id: 'austin-isd-d5', electionId: 'austin-isd-2026',
    office: 'Austin ISD — Trustee District 5', seats: 1,
    candidateIds: ['cand-bhollis', 'cand-jpark'],
  },
  {
    id: 'ca-governor', electionId: 'ca-general-2026',
    office: 'Governor of California', seats: 1,
    candidateIds: ['cand-arivera', 'cand-dkline', 'cand-sfoster'],
  },
];

// All fictional. Party field is a code: DEM, REP, IND, LIB, GRN, NP (nonpartisan).
const CANDIDATES = [
  {
    id: 'cand-mwhitfield', name: 'Marcus Whitfield', party: 'DEM',
    office: 'Governor of Georgia', incumbent: false,
    bio: 'Former mayor of Savannah and small-business owner. Ran a port-city administration focused on workforce housing and logistics jobs.',
    priorities: ['Workforce housing', 'Medicaid expansion', 'Public transit'],
    website: 'https://example.com/whitfield',
    policyPositions: [
      { issue: 'Housing', stance: 'Wants a $500M state housing trust to build workforce units near job centers and would preempt local rules that block duplexes and townhomes.' },
      { issue: 'Healthcare', stance: 'Supports full Medicaid expansion, which he says would cover roughly 450,000 uninsured Georgians and keep rural hospitals open.' },
      { issue: 'Transportation', stance: 'Backs dedicated state funding for regional transit and a passenger rail study for the Atlanta–Savannah corridor.' },
      { issue: 'Taxes', stance: 'Would keep the current income tax but expand a small-business tax credit for firms under 25 employees.' },
      { issue: 'Education', stance: 'Opposes private-school vouchers; would raise the base teacher salary and fund universal pre-K.' },
    ],
    articles: [
      { title: 'Whitfield makes housing the center of his statewide pitch', outlet: 'Placeholder Wire', date: '2026-06-14', url: '#' },
      { title: 'From city hall to the governor’s race: the Savannah record', outlet: 'Placeholder Journal', date: '2026-05-02', url: '#' },
    ],
  },
  {
    id: 'cand-dokafor', name: 'Diane Okafor', party: 'REP',
    office: 'Governor of Georgia', incumbent: false,
    bio: 'State senator from Cherokee County and former prosecutor. Chaired the Senate Appropriations Committee for two terms.',
    priorities: ['Cut income tax', 'School choice', 'Public safety'],
    website: 'https://example.com/okafor',
    policyPositions: [
      { issue: 'Taxes', stance: 'Would phase out the state personal income tax by 2032, offsetting it with spending caps and sales-tax base broadening.' },
      { issue: 'Education', stance: 'Supports universal education savings accounts letting families spend per-pupil funds at private or home schools.' },
      { issue: 'Public Safety', stance: 'Wants to fund 1,000 additional state and local officers and add mandatory minimums for repeat firearm offenses.' },
      { issue: 'Healthcare', stance: 'Opposes traditional Medicaid expansion; favors a work-requirement waiver program and rural telehealth grants instead.' },
      { issue: 'Regulation', stance: 'Would require every new state regulation to sunset in five years unless re-approved by the legislature.' },
    ],
    articles: [
      { title: 'Okafor pledges to phase out state income tax by 2032', outlet: 'Placeholder Wire', date: '2026-06-20', url: '#' },
      { title: 'Appropriations chair enters the governor’s race', outlet: 'Placeholder Ledger', date: '2026-03-11', url: '#' },
    ],
  },
  {
    id: 'cand-rlangley', name: 'Ruth Langley', party: 'LIB',
    office: 'Governor of Georgia', incumbent: false,
    bio: 'Logistics executive and first-time candidate running on occupational licensing reform.',
    priorities: ['Licensing reform', 'Justice reform', 'Ballot access'],
    website: 'https://example.com/langley',
    policyPositions: [
      { issue: 'Regulation', stance: 'Would abolish state licensing requirements for dozens of lower-risk trades and recognize licenses issued by other states.' },
      { issue: 'Public Safety', stance: 'Supports ending cash bail for nonviolent misdemeanors and legalizing and taxing cannabis.' },
      { issue: 'Elections', stance: 'Wants to lower ballot-access signature thresholds so third-party and independent candidates can qualify more easily.' },
      { issue: 'Taxes', stance: 'Favors a flat 4% income tax and eliminating most targeted corporate incentives.' },
    ],
    articles: [
      { title: 'Third-party bid targets licensing rules', outlet: 'Placeholder Ledger', date: '2026-04-08', url: '#' },
    ],
  },
  {
    id: 'cand-tbeaumont', name: 'Terrence Beaumont', party: 'REP',
    office: 'Georgia Secretary of State', incumbent: true,
    bio: 'Incumbent secretary of state seeking a second term. Oversaw the statewide rollout of updated voter roll auditing.',
    priorities: ['Election audits', 'Business filing modernization', 'Roll maintenance'],
    website: 'https://example.com/beaumont',
    policyPositions: [
      { issue: 'Elections', stance: 'Would keep annual signature-match audits and expand post-election risk-limiting audits to every county.' },
      { issue: 'Elections', stance: 'Supports voter-roll maintenance that removes registrations inactive for two federal cycles after mailed notice.' },
      { issue: 'Economy', stance: 'Would move all business and professional licensing filings to a single online portal with 24-hour turnaround.' },
    ],
    articles: [
      { title: 'Beaumont defends audit program in re-election launch', outlet: 'Placeholder Journal', date: '2026-02-19', url: '#' },
    ],
  },
  {
    id: 'cand-avaldez', name: 'Alicia Valdez', party: 'DEM',
    office: 'Georgia Secretary of State', incumbent: false,
    bio: 'Voting rights attorney and former county elections director for Athens-Clarke County.',
    priorities: ['Automatic registration', 'Poll access', 'Worker protection'],
    website: 'https://example.com/valdez',
    policyPositions: [
      { issue: 'Elections', stance: 'Would implement automatic voter registration through the DMV and same-day registration during early voting.' },
      { issue: 'Elections', stance: 'Wants a statewide standard capping wait times at 30 minutes and adding polling places in high-density precincts.' },
      { issue: 'Elections', stance: 'Supports legal protections and hazard pay for local election workers facing harassment.' },
    ],
    articles: [
      { title: 'Valdez campaign centers poll worker retention crisis', outlet: 'Placeholder Wire', date: '2026-05-27', url: '#' },
    ],
  },
  {
    id: 'cand-jmercer', name: 'Jordan Mercer', party: 'DEM',
    office: 'U.S. House — GA District 4', incumbent: true,
    bio: 'Two-term incumbent. Sits on the House Transportation and Infrastructure Committee.',
    priorities: ['Infrastructure', 'Student debt', 'Clean energy jobs'],
    website: 'https://example.com/mercer',
    policyPositions: [
      { issue: 'Transportation', stance: 'Secured federal transit grants for the district and backs a national infrastructure reauthorization with fixed local set-asides.' },
      { issue: 'Education', stance: 'Supports income-driven student loan forgiveness and doubling the Pell Grant maximum.' },
      { issue: 'Environment', stance: 'Wants manufacturing tax credits tied to domestic clean-energy production and battery plants.' },
      { issue: 'Healthcare', stance: 'Favors letting Medicare negotiate a broader list of drug prices and capping insulin at $35.' },
    ],
    articles: [
      { title: 'Mercer touts transit grants in re-election bid', outlet: 'Placeholder Journal', date: '2026-06-01', url: '#' },
    ],
  },
  {
    id: 'cand-kdrayton', name: 'Kelsey Drayton', party: 'REP',
    office: 'U.S. House — GA District 4', incumbent: false,
    bio: 'Veteran and franchise owner. First run for federal office after serving on a county development authority.',
    priorities: ['Fiscal restraint', 'Veterans', 'Border security'],
    website: 'https://example.com/drayton',
    policyPositions: [
      { issue: 'Economy', stance: 'Would support a balanced-budget amendment and across-the-board discretionary spending caps.' },
      { issue: 'Veterans', stance: 'Wants faster VA claims processing and community-care vouchers when VA wait times exceed 30 days.' },
      { issue: 'Immigration', stance: 'Backs increased border enforcement funding and mandatory E-Verify for employers.' },
      { issue: 'Taxes', stance: 'Would make the current federal individual tax rates permanent.' },
    ],
    articles: [
      { title: 'Drayton launches challenge in District 4', outlet: 'Placeholder Ledger', date: '2026-04-22', url: '#' },
    ],
  },
  {
    id: 'cand-pcastellanos', name: 'Paula Castellanos', party: 'REP',
    office: 'U.S. Senate — Georgia', incumbent: false,
    bio: 'Former lieutenant governor and agribusiness executive from south Georgia.',
    priorities: ['Farm trade', 'Tax cuts', 'Energy'],
    website: 'https://example.com/castellanos',
    policyPositions: [
      { issue: 'Economy', stance: 'Would push farm-export trade deals and expand crop insurance for specialty growers.' },
      { issue: 'Energy', stance: 'Supports expanded domestic drilling, nuclear licensing reform, and opposes new emissions mandates.' },
      { issue: 'Taxes', stance: 'Favors permanent cuts to the corporate and estate tax and a lower capital-gains rate.' },
      { issue: 'Immigration', stance: 'Backs an agricultural guest-worker overhaul paired with stronger border enforcement.' },
    ],
    articles: [
      { title: 'Castellanos enters Senate race with rural-first message', outlet: 'Placeholder Wire', date: '2026-01-30', url: '#' },
    ],
  },
  {
    id: 'cand-lnguyen', name: 'Linh Nguyen', party: 'NP',
    office: 'DeKalb School Board — District 4', incumbent: false,
    bio: 'Public school parent and pediatric nurse. Led a district-wide campaign for expanded school health services.',
    priorities: ['School health', 'Teacher pay', 'Facilities transparency'],
    website: 'https://example.com/nguyen',
    policyPositions: [
      { issue: 'Student Health', stance: 'Wants a nurse in every building and expanded school-based mental health counseling.' },
      { issue: 'Teachers', stance: 'Supports pay parity with neighboring districts to stop losing staff and a mentorship program for new teachers.' },
      { issue: 'Budget', stance: 'Would publish a public, itemized dashboard of every facilities-repair dollar and its timeline.' },
    ],
    articles: [
      { title: 'Parent-led slate reshapes school board race', outlet: 'Placeholder Journal', date: '2026-06-09', url: '#' },
    ],
  },
  {
    id: 'cand-gharrell', name: 'Gerald Harrell', party: 'NP',
    office: 'DeKalb School Board — District 4', incumbent: true,
    bio: 'Retired principal completing his first term on the board. Chaired the facilities committee.',
    priorities: ['Career & technical ed', 'Budget discipline', 'Principal autonomy'],
    website: 'https://example.com/harrell',
    policyPositions: [
      { issue: 'Curriculum', stance: 'Would expand career and technical education pathways and dual-enrollment partnerships with local colleges.' },
      { issue: 'Budget', stance: 'Favors rebuilding the district reserve fund before adding new recurring programs.' },
      { issue: 'Schools', stance: 'Wants to give principals more control over their building budgets and hiring.' },
    ],
    articles: [
      { title: 'Harrell runs on facilities record', outlet: 'Placeholder Ledger', date: '2026-05-15', url: '#' },
    ],
  },
  {
    id: 'cand-sboateng', name: 'Samuel Boateng', party: 'DEM',
    office: 'Atlanta City Council — District 11', incumbent: false,
    bio: 'Neighborhood association president and transit advocate from southwest Atlanta.',
    priorities: ['Sidewalks & transit', 'Anti-displacement', 'Commercial corridors'],
    website: 'https://example.com/boateng',
    policyPositions: [
      { issue: 'Transportation', stance: 'Would fund a sidewalk-gap program and more frequent bus service on the district’s two busiest corridors.' },
      { issue: 'Housing', stance: 'Supports an anti-displacement property-tax freeze for longtime homeowners and inclusionary zoning near transit.' },
      { issue: 'Economy', stance: 'Wants small forgivable grants to fill vacant storefronts along neighborhood commercial streets.' },
    ],
    articles: [
      { title: 'Boateng leads special election, heads to runoff', outlet: 'Placeholder Journal', date: '2026-06-17', url: '#' },
    ],
  },
  {
    id: 'cand-mreyes', name: 'Monica Reyes', party: 'DEM',
    office: 'Atlanta City Council — District 11', incumbent: false,
    bio: 'Small business owner and former aide to the district’s previous councilmember.',
    priorities: ['Public safety staffing', 'Permitting reform', 'Parks'],
    website: 'https://example.com/reyes',
    policyPositions: [
      { issue: 'Public Safety', stance: 'Wants to fully staff the district’s police beat and fund a civilian responder team for mental-health calls.' },
      { issue: 'Economy', stance: 'Would create a one-stop small-business permitting office to cut approval times.' },
      { issue: 'Parks', stance: 'Supports converting two vacant lots into pocket parks and expanding the district tree canopy.' },
    ],
    articles: [
      { title: 'Reyes forces runoff in District 11', outlet: 'Placeholder Wire', date: '2026-06-17', url: '#' },
    ],
  },
  {
    id: 'cand-hpatel', name: 'Hema Patel', party: 'NP',
    office: 'Fulton Superior Court — Seat 3', incumbent: false,
    bio: 'Sitting magistrate judge running for an open Superior Court seat. Fifteen years in family and civil court.',
    priorities: ['Case backlog', 'Court access', 'Dispute resolution'],
    website: 'https://example.com/patel',
    // Judicial candidates don't campaign on policy positions — the UI leans on bio + coverage.
    policyPositions: [],
    articles: [
      { title: 'Patel touts fifteen-year record in Superior Court bid', outlet: 'Placeholder Ledger', date: '2026-05-01', url: '#' },
      { title: 'Bar association rates both judicial candidates “qualified”', outlet: 'Placeholder Journal', date: '2026-06-03', url: '#' },
    ],
  },
  {
    id: 'cand-dosei', name: 'David Osei', party: 'NP',
    office: 'Fulton Superior Court — Seat 3', incumbent: false,
    bio: 'Civil litigator and former public defender. Twenty years of trial experience across criminal and civil dockets.',
    priorities: ['Trial experience', 'Sentencing fairness', 'Court modernization'],
    website: 'https://example.com/osei',
    policyPositions: [],
    articles: [
      { title: 'Osei runs on two decades of courtroom experience', outlet: 'Placeholder Wire', date: '2026-05-20', url: '#' },
    ],
  },
  {
    id: 'cand-cwalsh', name: 'Colin Walsh', party: 'REP',
    office: 'Governor of Texas', incumbent: true,
    bio: 'Incumbent governor seeking a second term. Former state attorney general.',
    priorities: ['Property tax cuts', 'Grid reliability', 'Border enforcement'],
    website: 'https://example.com/walsh',
    policyPositions: [
      { issue: 'Taxes', stance: 'Would use surplus revenue to compress school-district property tax rates toward elimination over a decade.' },
      { issue: 'Energy', stance: 'Backs incentives to build dispatchable gas generation and weatherization mandates after past grid failures.' },
      { issue: 'Immigration', stance: 'Supports continued state border-security spending and hardware along high-traffic crossings.' },
      { issue: 'Education', stance: 'Favors education savings accounts alongside a teacher pay raise funded by the surplus.' },
    ],
    articles: [
      { title: 'Walsh opens re-election campaign in Fort Worth', outlet: 'Placeholder Wire', date: '2026-03-03', url: '#' },
    ],
  },
  {
    id: 'cand-idelacruz', name: 'Isabel de la Cruz', party: 'DEM',
    office: 'Governor of Texas', incumbent: false,
    bio: 'Former mayor of San Antonio and public health administrator.',
    priorities: ['School funding', 'Rural hospitals', 'Grid oversight'],
    website: 'https://example.com/delacruz',
    policyPositions: [
      { issue: 'Education', stance: 'Would raise the per-student funding floor for the first time in years and oppose diverting public funds to vouchers.' },
      { issue: 'Healthcare', stance: 'Supports Medicaid expansion and a rural-hospital stabilization fund to halt closures.' },
      { issue: 'Energy', stance: 'Wants an independent grid oversight board and a faster interconnection queue for solar and storage.' },
      { issue: 'Taxes', stance: 'Favors targeted homestead relief for owner-occupied homes rather than across-the-board rate cuts.' },
    ],
    articles: [
      { title: 'De la Cruz bets on education funding fight', outlet: 'Placeholder Journal', date: '2026-04-14', url: '#' },
    ],
  },
  {
    id: 'cand-tflores', name: 'Tomas Flores', party: 'IND',
    office: 'Governor of Texas', incumbent: false,
    bio: 'Rancher and former county judge running as an independent focused on water and rural infrastructure.',
    priorities: ['Water supply', 'Rural broadband', 'Term limits'],
    website: 'https://example.com/flores',
    policyPositions: [
      { issue: 'Water', stance: 'Would create a statewide water bank and fund aquifer recharge and pipeline repair to cut losses.' },
      { issue: 'Infrastructure', stance: 'Backs a rural broadband build-out mandate tied to existing utility rights-of-way.' },
      { issue: 'Government', stance: 'Supports term limits for statewide offices and a ban on lobbying for two years after leaving office.' },
    ],
    articles: [
      { title: 'Independent Flores puts water at the center of governor’s race', outlet: 'Placeholder Ledger', date: '2026-05-09', url: '#' },
    ],
  },
  {
    id: 'cand-bhollis', name: 'Brenda Hollis', party: 'NP',
    office: 'Austin ISD — Trustee District 5', incumbent: true,
    bio: 'Incumbent trustee and retired classroom teacher. Chaired the district budget committee.',
    priorities: ['Balanced budget', 'Special education', 'Neighborhood schools'],
    website: 'https://example.com/hollis',
    policyPositions: [
      { issue: 'Budget', stance: 'Would close the structural deficit without campus closures by trimming central-office administration.' },
      { issue: 'Special Education', stance: 'Supports hiring more special-education staff to meet caseload ratios and cut evaluation wait times.' },
      { issue: 'Schools', stance: 'Opposes consolidating small neighborhood campuses; favors shared-service partnerships instead.' },
    ],
    articles: [
      { title: 'Hollis defends budget record as deficit looms', outlet: 'Placeholder Wire', date: '2026-06-11', url: '#' },
    ],
  },
  {
    id: 'cand-jpark', name: 'Julian Park', party: 'NP',
    office: 'Austin ISD — Trustee District 5', incumbent: false,
    bio: 'Software engineer and PTA president running on transparency and modernization.',
    priorities: ['Open budgeting', 'Reading outcomes', 'Facilities'],
    website: 'https://example.com/park',
    policyPositions: [
      { issue: 'Budget', stance: 'Wants a public line-item budget portal and zero-based budgeting for non-instructional spending.' },
      { issue: 'Curriculum', stance: 'Supports an evidence-based early-literacy program and expanded tutoring for students below grade level.' },
      { issue: 'Facilities', stance: 'Would prioritize air conditioning and safety upgrades at the district’s oldest campuses.' },
    ],
    articles: [
      { title: 'Newcomer Park pitches “open-book” school budgeting', outlet: 'Placeholder Journal', date: '2026-06-22', url: '#' },
    ],
  },
  {
    id: 'cand-arivera', name: 'Ana Rivera', party: 'DEM',
    office: 'Governor of California', incumbent: false,
    bio: 'State attorney general and former Los Angeles city attorney.',
    priorities: ['Housing production', 'Homelessness', 'Wildfire resilience'],
    website: 'https://example.com/rivera',
    policyPositions: [
      { issue: 'Housing', stance: 'Would set binding regional housing targets with funding tied to permits issued, and streamline approvals near transit.' },
      { issue: 'Homelessness', stance: 'Supports a housing-first expansion paired with funded mental-health and addiction treatment beds.' },
      { issue: 'Environment', stance: 'Backs a wildfire-resilience bond for defensible space, prescribed burns, and grid hardening.' },
      { issue: 'Healthcare', stance: 'Favors a state cap on insulin and out-of-pocket prescription costs.' },
    ],
    articles: [
      { title: 'Rivera makes housing production her signature issue', outlet: 'Placeholder Wire', date: '2026-05-30', url: '#' },
    ],
  },
  {
    id: 'cand-dkline', name: 'Derek Kline', party: 'REP',
    office: 'Governor of California', incumbent: false,
    bio: 'Central Valley farmer and businessman making his first run for statewide office.',
    priorities: ['Affordability', 'Water storage', 'Regulatory rollback'],
    website: 'https://example.com/kline',
    policyPositions: [
      { issue: 'Taxes', stance: 'Would cut the top income tax rate and the state gas tax to lower cost of living.' },
      { issue: 'Water', stance: 'Supports new above-ground reservoirs and expanded storage funded by an existing water bond.' },
      { issue: 'Regulation', stance: 'Wants to roll back CEQA review for housing and infrastructure and cap new business regulations.' },
      { issue: 'Public Safety', stance: 'Favors reversing recent theft-threshold changes and adding funding for local prosecutors.' },
    ],
    articles: [
      { title: 'Kline runs on affordability against Sacramento', outlet: 'Placeholder Ledger', date: '2026-04-27', url: '#' },
    ],
  },
  {
    id: 'cand-sfoster', name: 'Sasha Foster', party: 'GRN',
    office: 'Governor of California', incumbent: false,
    bio: 'Environmental scientist and community organizer from Oakland.',
    priorities: ['100% clean energy', 'Tenant protection', 'Single-payer'],
    website: 'https://example.com/foster',
    policyPositions: [
      { issue: 'Environment', stance: 'Would accelerate the state to 100% clean electricity by 2035 and end new fossil-fuel drilling permits.' },
      { issue: 'Housing', stance: 'Supports statewide rent stabilization and public financing for social housing.' },
      { issue: 'Healthcare', stance: 'Backs a state single-payer health plan funded by a progressive payroll assessment.' },
      { issue: 'Transportation', stance: 'Wants fare-free local transit and a major shift of highway funds to rail and bus.' },
    ],
    articles: [
      { title: 'Green Party’s Foster pushes clean-energy timeline', outlet: 'Placeholder Wire', date: '2026-06-05', url: '#' },
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

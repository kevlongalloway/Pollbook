/**
 * Congress.gov — the official legislative API (https://api.congress.gov/v3).
 *
 * Run by the Library of Congress, hosted on api.data.gov, and the
 * authoritative record of what is actually moving through Congress: bill text,
 * CRS summaries, sponsors, cosponsors, actions and subjects. Like the FEC
 * source it works out of the box on the shared DEMO_KEY and wants a free key
 * (CONGRESS_API_KEY) for real rate limits.
 *
 * **There is no keyword search in this API.** v3 exposes bills by congress,
 * type and number, and lists them by update date — there is no `q`. So the
 * bill feed is assembled two ways, and both are honest about what they are:
 *
 *   1. A window of the most recently-updated bills in the current Congress,
 *      filtered to election-related legislation by matching *titles*. Title
 *      matching is coarse — it will miss an election provision buried inside a
 *      broadly-titled bill — so it is described as a filter, not a census.
 *   2. Direct lookup by bill number ("HR 22", "S. 1"), which resolves any bill
 *      regardless of how recently it moved. This is what makes a specific bill
 *      findable when it has fallen out of the recent-activity window.
 *
 * CONGRESS_API_BASE is overridable so the whole thing can be exercised against
 * a local stub offline, the same way FEC_API_BASE is.
 */

const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');

const BASE = () => process.env.CONGRESS_API_BASE || 'https://api.congress.gov/v3';
const KEY = () => process.env.CONGRESS_API_KEY || 'DEMO_KEY';

const HOUR = 3600 * 1000;
const FEED_TTL = HOUR;
const BILL_TTL = 6 * HOUR;

// Pages of 250 pulled for the feed. Each page is one API call, so this trades
// coverage against the DEMO_KEY budget; a real key makes it free.
const FEED_PAGES = Number(process.env.CONGRESS_FEED_PAGES) || 3;
const PER_PAGE = 250;

/** The bill types Congress.gov recognises, as they appear in URLs. */
const BILL_TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'];

const TYPE_LABELS = {
  hr: 'H.R.', s: 'S.',
  hjres: 'H.J.Res.', sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.', sconres: 'S.Con.Res.',
  hres: 'H.Res.', sres: 'S.Res.',
};

function url(path, params = {}) {
  const q = new URLSearchParams({ api_key: KEY(), format: 'json', ...params });
  return `${BASE()}${path}?${q}`;
}

/**
 * CRS summaries arrive as HTML fragments. Strip to text rather than pulling in
 * a parser — and strip rather than render, because this text is also fed to a
 * language model, where markup is noise at best.
 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse a human bill reference into an API-addressable one.
 *
 * People write bill numbers every possible way — "HR 22", "H.R. 22", "hr22",
 * "H R 22", "S.J.Res. 2". Normalizing here is what lets the search box resolve
 * a bill directly instead of hoping it sits in the recent-activity window.
 */
function parseBillRef(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;

  // Drop the punctuation and spacing people put inside the type ("h.r. 22",
  // "s. j. res. 2") without gluing the type to the number.
  const cleaned = raw.replace(/[.‐-―-]/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = cleaned.replace(/\s+/g, '');

  const m = compact.match(/^(hr|s|hjres|sjres|hconres|sconres|hres|sres)(\d{1,5})$/);
  if (!m) return null;

  const [, type, number] = m;
  return { type, number: String(Number(number)) };
}

/** "hr" + "22" -> "H.R. 22" */
const billLabel = (type, number) =>
  `${TYPE_LABELS[String(type || '').toLowerCase()] || String(type || '').toUpperCase()} ${number}`;

/**
 * Does this title describe election-related legislation?
 *
 * Word-boundary anchored so "selection" doesn't match "election" and
 * "devoting" doesn't match "voting". Deliberately narrow: a false positive
 * puts an unrelated bill in a feed users are told is about elections, which is
 * worse than a miss they can still find by number.
 */
const ELECTION_PATTERNS = [
  /\belection(s|eering)?\b/i,
  /\belector(al|s)?\b/i,
  /\bvoter(s)?\b/i,
  /\bvoting\b/i,
  /\bballot(s|ing)?\b/i,
  /\bredistrict(ing)?\b/i,
  /\bgerrymander(ing)?\b/i,
  /\bpolling place(s)?\b/i,
  /\babsentee\b/i,
  /\bvote[- ]by[- ]mail\b/i,
  /\bmail[- ]in vot/i,
  /\bcampaign finance\b/i,
  /\bpolitical campaign(s)?\b/i,
  /\bsuper pac(s)?\b/i,
  /\bdark money\b/i,
  /\bfederal election commission\b/i,
  /\bpoll worker(s)?\b/i,
  /\bsuffrage\b/i,
  /\bcensus\b/i,
];

const isElectionBill = (title) => ELECTION_PATTERNS.some((re) => re.test(String(title || '')));

/**
 * Coarse progress stage, derived from the latest action.
 *
 * Congress.gov reports actions as free text, not a status enum, so this reads
 * the text. It is a summary for orientation — the full action history is on
 * the bill page and linked out to congress.gov, which is authoritative.
 *
 * `step` counts along the five stages a bill passes through — introduced,
 * out of committee, one chamber, both chambers, enacted — and the UI's
 * progress rail renders exactly those five, so the two must stay in step.
 */
function deriveStage(bill) {
  const text = String(bill?.latestAction?.text || '');
  const hasLaw = Array.isArray(bill?.laws) && bill.laws.length > 0;
  const chamber = String(bill?.originChamber || '').toLowerCase();

  if (hasLaw || /became (public|private) law|signed by president/i.test(text)) {
    return { key: 'law', label: 'Enacted', step: 5 };
  }
  if (/presented to president|sent to president/i.test(text)) {
    return { key: 'president', label: 'On the president’s desk', step: 4 };
  }
  if (/vetoed/i.test(text)) {
    return { key: 'vetoed', label: 'Vetoed', step: 4 };
  }

  const passedHouse = /passed[/ ]?(agreed to in )?house|passed the house/i.test(text);
  const passedSenate = /passed[/ ]?(agreed to in )?senate|passed the senate/i.test(text);
  if ((passedHouse && chamber === 'senate') || (passedSenate && chamber === 'house')) {
    return { key: 'both', label: 'Passed both chambers', step: 4 };
  }
  if (passedHouse || passedSenate) {
    const where = passedHouse ? 'House' : 'Senate';
    return { key: 'one-chamber', label: `Passed the ${where}`, step: 3 };
  }
  if (/reported (by|to)|ordered to be reported|placed on .*calendar/i.test(text)) {
    return { key: 'committee', label: 'Out of committee', step: 2 };
  }
  return { key: 'introduced', label: 'Introduced — in committee', step: 1 };
}

/** A list row (or detail payload) -> the shape Pollbook renders. */
function normalizeBill(row) {
  if (!row || !row.type || row.number == null) return null;
  const type = String(row.type).toLowerCase();
  const number = String(row.number);
  const congress = Number(row.congress) || null;
  if (!congress || !BILL_TYPES.includes(type)) return null;

  return {
    id: `${congress}-${type}-${number}`,
    congress,
    type,
    number,
    label: billLabel(type, number),
    title: row.title || billLabel(type, number),
    originChamber: row.originChamber || null,
    introducedDate: row.introducedDate || null,
    latestAction: row.latestAction
      ? { date: row.latestAction.actionDate || null, text: row.latestAction.text || '' }
      : null,
    policyArea: row.policyArea?.name || null,
    stage: deriveStage(row),
    url: `https://www.congress.gov/bill/${congress}th-congress/${
      type === 's' ? 'senate-bill'
        : type === 'hr' ? 'house-bill'
          : `${type.startsWith('h') ? 'house' : 'senate'}-${type.replace(/^[hs]/, '')}`
    }/${number}`,
  };
}

/**
 * A window of the most recently-updated bills in a Congress.
 *
 * Pages are fetched in sequence and a failure mid-walk keeps what it already
 * has: a partial feed is still a usable feed, and the alternative is an empty
 * page whenever one request flakes.
 */
async function recentBills(congress, { pages = FEED_PAGES } = {}) {
  return cached(`congress:recent:${congress}:${pages}`, FEED_TTL, async () => {
    const rows = [];
    for (let i = 0; i < pages; i++) {
      try {
        const data = await fetchJson(url(`/bill/${congress}`, {
          limit: PER_PAGE,
          offset: i * PER_PAGE,
          sort: 'updateDate+desc',
        }), { timeoutMs: 15000 });
        const batch = data.bills || [];
        rows.push(...batch);
        if (batch.length < PER_PAGE) break;
      } catch (err) {
        if (i === 0) throw err;
        break;
      }
    }
    return rows.map(normalizeBill).filter(Boolean);
  });
}

/** Bill detail, with the CRS summary and subjects folded in. */
async function billById(congress, type, number) {
  const t = String(type).toLowerCase();
  if (!BILL_TYPES.includes(t)) return null;
  const n = String(Number(number));
  if (!/^\d+$/.test(n)) return null;

  return cached(`congress:bill:${congress}:${t}:${n}`, BILL_TTL, async () => {
    const path = `/bill/${congress}/${t}/${n}`;
    const data = await fetchJson(url(path), { timeoutMs: 15000 });
    const bill = data && data.bill;
    if (!bill) return null;

    const base = normalizeBill({ ...bill, congress: bill.congress || congress, type: bill.type || t, number: bill.number || n });
    if (!base) return null;

    // Each enrichment is optional — a bill page that loses its subject list
    // is still a bill page.
    const soft = (p) => p.catch(() => null);
    const [summaries, subjects, actions, cosponsors] = await Promise.all([
      soft(fetchJson(url(`${path}/summaries`), { timeoutMs: 12000 })),
      soft(fetchJson(url(`${path}/subjects`), { timeoutMs: 12000 })),
      soft(fetchJson(url(`${path}/actions`, { limit: 10 }), { timeoutMs: 12000 })),
      soft(fetchJson(url(`${path}/cosponsors`, { limit: 250 }), { timeoutMs: 12000 })),
    ]);

    // CRS writes a fresh summary at each major stage; the last one is current.
    const summaryRows = (summaries?.summaries || []).slice().sort((a, b) =>
      String(a.actionDate || '').localeCompare(String(b.actionDate || '')));
    const latestSummary = summaryRows.at(-1);

    const sponsor = (bill.sponsors || [])[0] || null;
    const cosponsorRows = cosponsors?.cosponsors || [];
    const partySplit = cosponsorRows.reduce((acc, c) => {
      const p = String(c.party || '').toUpperCase();
      if (p === 'D') acc.D += 1;
      else if (p === 'R') acc.R += 1;
      else acc.other += 1;
      return acc;
    }, { D: 0, R: 0, other: 0 });

    return {
      ...base,
      summary: latestSummary
        ? {
          text: stripHtml(latestSummary.text),
          asOf: latestSummary.actionDate || null,
          stageDesc: latestSummary.actionDesc || null,
        }
        : null,
      sponsor: sponsor
        ? {
          name: sponsor.fullName || [sponsor.firstName, sponsor.lastName].filter(Boolean).join(' '),
          party: sponsor.party || null,
          state: sponsor.state || null,
          bioguideId: sponsor.bioguideId || null,
        }
        : null,
      cosponsors: {
        count: bill.cosponsors?.count ?? cosponsorRows.length,
        partySplit: cosponsorRows.length ? partySplit : null,
      },
      subjects: (subjects?.subjects?.legislativeSubjects || [])
        .map((s) => s.name).filter(Boolean).slice(0, 12),
      actions: (actions?.actions || []).slice(0, 8).map((a) => ({
        date: a.actionDate || null,
        text: a.text || '',
        chamber: a.chamber || null,
      })),
      committees: bill.committees?.count ?? null,
      laws: (bill.laws || []).map((l) => `${l.type} ${l.number}`),
    };
  });
}

module.exports = {
  recentBills,
  billById,
  parseBillRef,
  isElectionBill,
  normalizeBill,
  deriveStage,
  stripHtml,
  billLabel,
  BILL_TYPES,
};

/**
 * Watchlist — landmark election bills that should stay on the Bills page even
 * when they go quiet.
 *
 * The bills feed is built dynamically from Congress.gov's recent-activity
 * window (see sources/congress.js), which is the right default: it surfaces
 * whatever is actually moving. But a bill that passed one chamber and then sat
 * for a year drops out of that window while remaining the most consequential
 * election legislation in front of Congress. This table pins a few by number
 * so they survive the drop.
 *
 * Only the *identifier* is stored. Every fact shown about these bills —
 * title, sponsor, status, summary — is fetched live like any other bill, so
 * this table cannot go stale in a way that misinforms; it can only go stale by
 * pointing at the wrong bill.
 *
 * `expect` guards against exactly that. Bill numbers are reused every
 * Congress, so an entry carried forward to a new Congress would otherwise
 * silently resolve to an unrelated bill. The live title must match `expect` or
 * the entry is dropped — a missing bill is a much better failure than a wrong
 * one presented as authoritative.
 */

const WATCHLIST = [
  {
    congress: 119,
    type: 'hr',
    number: '22',
    expect: /save act|voter eligibility/i,
    why: 'Would require documentary proof of citizenship to register to vote in federal elections.',
  },
];

/** Watchlist entries for a given Congress. */
const watchlistFor = (congress) => WATCHLIST.filter((b) => b.congress === Number(congress));

/**
 * Does a live-fetched bill match the entry that asked for it? Guards against a
 * recycled bill number resolving to unrelated legislation.
 */
const matchesExpectation = (entry, bill) =>
  Boolean(bill && entry && entry.expect.test(String(bill.title || '')));

module.exports = { WATCHLIST, watchlistFor, matchesExpectation };

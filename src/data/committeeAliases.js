/**
 * Committee search aliases.
 *
 * Some organizations' campaign committees file with the FEC under names
 * that don't contain the brand people search for — e.g. AIPAC's super PAC
 * files as "United Democracy Project". This table expands a search term to
 * also check publicly reported, widely documented affiliated committee
 * names, so a search for the organization surfaces its whole footprint.
 *
 * Rules for adding entries: the affiliation must be publicly acknowledged
 * or extensively reported (not speculation), and entries are added for
 * organizations across the political spectrum. The UI discloses when an
 * alias expanded a search.
 */

const ALIASES = [
  { match: /\baipac\b|american israel public affairs/i,
    add: ['United Democracy Project', 'AIPAC'],
    why: 'United Democracy Project is AIPAC’s super PAC (publicly reported).' },
  { match: /united democracy project/i,
    add: ['AIPAC'],
    why: 'United Democracy Project is AIPAC’s super PAC (publicly reported).' },
  { match: /\bnra\b/i,
    add: ['National Rifle Association'],
    why: 'The NRA’s committees file under the full organization name.' },
  { match: /\bkoch\b/i,
    add: ['Americans for Prosperity'],
    why: 'Americans for Prosperity Action is the Koch-network super PAC (publicly reported).' },
  { match: /\bsoros\b/i,
    add: ['Democracy PAC'],
    why: 'Democracy PAC is George Soros’s super PAC (publicly reported).' },
  { match: /\bcrypto\b|coinbase|ripple/i,
    add: ['Fairshake'],
    why: 'Fairshake is the crypto industry’s super PAC (publicly reported).' },
];

/** Expand a user query into the list of FEC name searches to run. */
function expandQuery(q) {
  const query = String(q || '').trim();
  if (!query) return { terms: [], expansions: [] };
  const terms = [query];
  const expansions = [];
  for (const alias of ALIASES) {
    if (alias.match.test(query)) {
      for (const name of alias.add) {
        if (!terms.some((t) => t.toLowerCase() === name.toLowerCase())) {
          terms.push(name);
          expansions.push({ term: name, why: alias.why });
        }
      }
    }
  }
  return { terms: terms.slice(0, 4), expansions };
}

module.exports = { expandQuery };

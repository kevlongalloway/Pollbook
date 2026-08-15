/**
 * Win probabilities from prediction markets (PredictIt public API).
 *
 * PredictIt publishes every market's live prices in one unauthenticated
 * feed; a contract's last-trade price (0–1) is the market's implied
 * probability. These are trading prices, not forecasts — the UI labels
 * them as such. If the feed is unreachable the app simply omits odds.
 */

const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');
const { getState } = require('../data/usStates');

const FEED = 'https://www.predictit.org/api/marketdata/all/';
const TTL = 5 * 60 * 1000;

async function allMarkets() {
  return cached('markets:all', TTL, async () => {
    const data = await fetchJson(FEED, { timeoutMs: 12000 });
    return (data.markets || []).map((m) => ({
      id: m.id,
      name: m.name || m.shortName || '',
      shortName: m.shortName || '',
      url: m.url || null,
      contracts: (m.contracts || []).map((c) => ({
        name: c.name || c.shortName || '',
        shortName: c.shortName || '',
        price: typeof c.lastTradePrice === 'number' ? c.lastTradePrice : null,
      })).filter((c) => c.price != null)
        .sort((a, b) => b.price - a.price),
    }));
  });
}

const OFFICE_PATTERNS = {
  S: /\bsenate\b|\bsenator\b/i,
  H: /\bhouse\b|\bdistrict\b|\bcongressional\b/i,
  G: /\bgovernor\b|\bgubernatorial\b/i,
};

/**
 * Markets about a given state's race. officeKind: 'S' | 'H' | 'G'.
 * Matches on state name + office keyword; markets naming the cycle year
 * rank first. Primary markets are kept but sorted after general ones.
 */
async function marketsForRace(stateCode, officeKind, year) {
  const st = getState(stateCode);
  const pattern = OFFICE_PATTERNS[officeKind];
  if (!st || !pattern) return [];
  let markets;
  try {
    markets = await allMarkets();
  } catch {
    return [];
  }
  const stateRe = new RegExp(`\\b${st.name}\\b`, 'i');
  return markets
    .filter((m) => stateRe.test(m.name) && pattern.test(m.name))
    .sort((a, b) => {
      const score = (m) =>
        (m.name.includes(String(year)) ? 2 : 0) + (/primary|nominee/i.test(m.name) ? -1 : 0);
      return score(b) - score(a);
    })
    .slice(0, 3);
}

/** National balance-of-power markets for the home page. */
async function nationalMarkets() {
  let markets;
  try {
    markets = await allMarkets();
  } catch {
    return [];
  }
  return markets
    .filter((m) => /control (of )?the (house|senate)|balance of power|party will (control|win the (house|senate))/i.test(m.name))
    .slice(0, 4);
}

const lastName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : '';
};

/**
 * Attach implied win probabilities to candidate summaries by matching
 * contract names against candidate surnames in the race's best market.
 * Mutates and returns the list. Only general-election (non-primary)
 * markets are used for candidate-level odds.
 */
function attachProbabilities(candidates, markets) {
  const general = markets.find((m) => !/primary|nominee/i.test(m.name));
  if (!general) return candidates;
  for (const cand of candidates) {
    const ln = lastName(cand.name);
    if (ln.length < 3) continue;
    const re = new RegExp(`\\b${ln.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const hit = general.contracts.find((c) => re.test(c.name) || re.test(c.shortName));
    if (hit) {
      cand.probability = Math.round(hit.price * 100);
      cand.probabilitySource = 'PredictIt';
    }
  }
  return candidates;
}

module.exports = { marketsForRace, nationalMarkets, attachProbabilities };

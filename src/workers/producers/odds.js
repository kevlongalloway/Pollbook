/**
 * Prediction-market snapshots, and the alerts that come from them.
 *
 * Two jobs in one, and the first is worth having even if nobody ever
 * subscribes: PredictIt is currently polled live and thrown away, so storing
 * snapshots is what makes odds-over-time possible at all — the sparkline in
 * ROADMAP item 4 falls out of this table for free.
 *
 * The second is where the care goes. An odds alert is the easiest message on
 * this site to write badly: "Smith surges to 68%" is a sentence that reads as
 * a forecast, favours whoever moved, and is wrong about what a market price
 * even is. So three rules, all enforced rather than remembered:
 *
 *   1. **A suggestion, never a send.** This writes to `broadcast_suggestions`,
 *      which is inert: it has no audience, nothing fans it out, and it cannot
 *      be approved. An editor adopts it under their own name and it becomes an
 *      ordinary broadcast, subject to the whole workflow. The CHECK on
 *      `notification_events.auto_send` refuses to let an editorial category
 *      reach the queue any other way.
 *   2. **The whole market, alphabetically.** Every contract is reported, in
 *      alphabetical order by name — never sorted by price, never mentioning
 *      only the one that moved. The balance rule checks this at approval.
 *   3. **Prices, not predictions.** The generated summary says what traders
 *      are paying. `checkOddsFraming` blocks "forecast", "likely to win" and
 *      "surges" outright.
 */

const db = require('../../db');
const markets = require('../../sources/markets');

/** How far a price must move, over how long, before it is worth a message. */
const MOVE_THRESHOLD = Number(process.env.ODDS_MOVE_THRESHOLD) || 0.10;
const LOOKBACK_HOURS = Number(process.env.ODDS_LOOKBACK_HOURS) || 24;

/**
 * Ignore movement in the tails.
 *
 * A contract trading at two cents can double to four and mean nothing except
 * that somebody bought fifty dollars of it. Requiring the market to have a
 * contract above 15% keeps the alerts about races that are actually
 * contested.
 */
const RELEVANCE_FLOOR = 0.15;

/** One alert per race per this window, however much it moves. */
const COOLDOWN_HOURS = 72;

async function run() {
  const snapshotCount = await snapshot();
  const drafts = await detectMoves();
  return { snapshots: snapshotCount, suggestions: drafts.length, moves: drafts };
}

/** Record where every tracked market is right now. */
async function snapshot() {
  let all;
  try {
    all = await markets.allMarkets();
  } catch (err) {
    console.error('odds: could not reach the market source —', err.message);
    return 0;
  }

  let written = 0;
  for (const market of all || []) {
    for (const contract of market.contracts || []) {
      if (typeof contract.price !== 'number') continue;
      await db.query(
        `INSERT INTO market_snapshots (market_id, subject_key, contract_name, price)
         VALUES ($1,$2,$3,$4)`,
        [market.id, null, contract.shortName || contract.name, contract.price]
      );
      written += 1;
    }
  }
  return written;
}

/**
 * Find markets that moved, and draft a message about each.
 *
 * The comparison is against the oldest snapshot inside the lookback window
 * rather than the immediately preceding one, so a slow steady drift registers
 * the same as a sudden jump — which is the movement most worth telling
 * somebody about, and the kind a naive tick-to-tick comparison misses
 * entirely.
 */
async function detectMoves() {
  const rows = await db.rows(
    `WITH latest AS (
       SELECT DISTINCT ON (market_id, contract_name)
              market_id, contract_name, price, captured_at
         FROM market_snapshots
        ORDER BY market_id, contract_name, captured_at DESC
     ), earlier AS (
       SELECT DISTINCT ON (market_id, contract_name)
              market_id, contract_name, price
         FROM market_snapshots
        WHERE captured_at < now() - ($1::int * interval '1 hour')
        ORDER BY market_id, contract_name, captured_at DESC
     )
     SELECT l.market_id, l.contract_name, l.price AS now_price, e.price AS then_price
       FROM latest l JOIN earlier e
         ON e.market_id = l.market_id AND e.contract_name = l.contract_name
      WHERE abs(l.price - e.price) >= $2`,
    [LOOKBACK_HOURS, MOVE_THRESHOLD]
  );

  const byMarket = new Map();
  for (const row of rows) {
    if (!byMarket.has(row.market_id)) byMarket.set(row.market_id, []);
    byMarket.get(row.market_id).push(row);
  }

  const drafted = [];

  for (const [marketId, moves] of byMarket) {
    // Every contract in the market, not just the movers.
    const contracts = await db.rows(
      `SELECT DISTINCT ON (contract_name) contract_name, price
         FROM market_snapshots
        WHERE market_id = $1
        ORDER BY contract_name, captured_at DESC`,
      [marketId]
    );

    if (!contracts.some((c) => Number(c.price) >= RELEVANCE_FLOOR)) continue;

    const recent = await db.one(
      `SELECT id FROM broadcast_suggestions
        WHERE producer = 'odds' AND dedup_key LIKE $1
          AND created_at > now() - ($2::int * interval '1 hour')
        LIMIT 1`,
      [`odds:${marketId}:%`, COOLDOWN_HOURS]
    );
    if (recent) continue;

    drafted.push(await draftBroadcast(marketId, contracts, moves));
  }

  return drafted;
}

/**
 * Compose the draft.
 *
 * The summary is generated, not written, and it is the only path by which an
 * odds number reaches a subscriber. Contracts are listed alphabetically and
 * described as prices.
 */
async function draftBroadcast(marketId, contracts, moves) {
  const ordered = [...contracts].sort((a, b) =>
    String(a.contract_name).localeCompare(String(b.contract_name)));

  const lines = ordered.map((c) => `- ${c.contract_name}: ${Math.round(Number(c.price) * 100)}¢`);

  const movement = moves
    .sort((a, b) => String(a.contract_name).localeCompare(String(b.contract_name)))
    .map((m) => {
      const delta = Math.round((Number(m.now_price) - Number(m.then_price)) * 100);
      return `- ${m.contract_name}: ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} cents in the last ${LOOKBACK_HOURS} hours`;
    });

  const body = [
    `Prices in a prediction market you follow have moved by more than ${Math.round(MOVE_THRESHOLD * 100)} cents.`,
    '',
    'Where the market stands now:',
    ...lines,
    '',
    'What changed:',
    ...movement,
    '',
    'These are the prices traders are paying for a contract that pays out if an outcome happens. ' +
    'They are not a forecast, and they are not a poll. They tell you what a small number of people ' +
    'are willing to bet, which is worth knowing and is not the same as what will happen.',
  ].join('\n');

  // A suggestion, not a broadcast. `broadcasts.created_by` is NOT NULL
  // deliberately — a machine does not get to author a message to forty
  // thousand people — so this lands somewhere inert until an editor adopts it
  // under their own name and runs it through the full workflow.
  const row = await db.one(
    `INSERT INTO broadcast_suggestions
       (public_id, producer, dedup_key, category, subject_line, body, sources, evidence)
     VALUES (gen_random_uuid(), 'odds', $1, 'odds', $2, $3, $4, $5)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING public_id`,
    [
      `odds:${marketId}:${new Date().toISOString().slice(0, 10)}`,
      'Prediction-market prices moved in a race you follow',
      body,
      JSON.stringify([{ label: 'PredictIt market prices', url: 'https://www.predictit.org' }]),
      JSON.stringify({ marketId, contracts: ordered, moves }),
    ]
  );

  // The dedup key is also the cooldown: one suggestion per market per day,
  // whatever the market does in between.
  return { marketId, suggested: Boolean(row), contracts: ordered.length, moves: moves.length };
}

module.exports = {
  run, snapshot, detectMoves,
  MOVE_THRESHOLD, LOOKBACK_HOURS, RELEVANCE_FLOOR, COOLDOWN_HOURS,
};

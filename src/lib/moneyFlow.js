/**
 * Money-flow model — turns a candidate's finance + funding panels into a
 * normalized graph the UI can draw as a flow diagram.
 *
 * This is a pure function so the arithmetic is testable offline; the SVG that
 * renders it lives in public/js/app.js.
 *
 * Two things make this diagram honest, and both are easy to get wrong:
 *
 * 1. **Conduit money is not a separate inflow.** Bundled/earmarked donations
 *    arrive at the campaign *as individual contributions* — that is the whole
 *    point of a conduit. Drawing them as their own ribbon into the campaign
 *    would double-count them against `fromIndividuals` and inflate the total.
 *    They ride as an annotation on the individual band instead.
 *
 * 2. **Outside spending never reaches the campaign.** Independent
 *    expenditures are spent *about* a candidate without touching (or being
 *    coordinated with) their books. It gets its own track with no ribbon to
 *    the campaign node — the visual break is the point, because this is
 *    usually the largest number on the page.
 *
 * Everything is derived from what the FEC actually reports. Where a figure
 * can't be derived it is omitted rather than estimated, and `caveats` carries
 * the reason so the UI can say it out loud.
 */

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

/** Non-negative number or null — negative aggregates (refund-heavy periods) aren't drawable. */
const positive = (n) => {
  const v = round(n);
  return v != null && v > 0 ? v : null;
};

const sum = (rows) => rows.reduce((t, r) => t + (positive(r.total) || 0), 0);

/**
 * Split individual money into small-dollar and large-dollar bands.
 *
 * `donorSizes` is a separate FEC aggregate from `fromIndividuals`, computed
 * over itemized receipts with its own coverage window, so the two do not
 * always reconcile. When the small-donor bucket doesn't fit inside the
 * individual total, the split is dropped rather than forced — a band wider
 * than its parent would be a lie about where the money came from.
 */
function splitIndividuals(individuals, donorSizes) {
  if (!individuals) return { bands: [], split: false };

  const small = positive((donorSizes || []).find((s) => s.size === 0)?.total);
  if (!small || small > individuals) {
    return {
      bands: [{ key: 'individuals', label: 'Individual donors', amount: individuals }],
      split: false,
    };
  }

  const large = individuals - small;
  return {
    split: true,
    bands: [
      { key: 'small', label: 'Small donors', amount: small, note: 'Gave under $200 each' },
      ...(large > 0
        ? [{ key: 'large', label: 'Larger individual donors', amount: large, note: 'Itemized — $200 and up' }]
        : []),
    ],
  };
}

/**
 * Build the flow model. Returns null when there is nothing truthful to draw —
 * no reported receipts and no outside spending.
 */
function buildMoneyFlow(candidate) {
  const fin = candidate?.finance || {};
  const funding = candidate?.funding || {};

  const raised = positive(fin.receipts);
  const support = (funding.independent?.support || []).filter((r) => positive(r.total));
  const oppose = (funding.independent?.oppose || []).filter((r) => positive(r.total));
  const outsideTotal = sum(support) + sum(oppose);

  if (!raised && !outsideTotal) return null;

  const caveats = [];

  /* ---------- money into the campaign ---------- */

  const individuals = positive(fin.fromIndividuals);
  const { bands, split } = splitIndividuals(individuals, funding.donorSizes);
  if (individuals && !split && (funding.donorSizes || []).length) {
    caveats.push("The FEC's small-donor aggregate doesn't reconcile with this campaign's individual total for the reported period, so individual money is shown undivided.");
  }

  const inflows = [...bands];

  const pacs = positive(fin.fromPacs);
  if (pacs) {
    inflows.push({
      key: 'pacs',
      label: 'PACs & committees',
      amount: pacs,
      note: 'Capped at $5,000 per election',
    });
  }

  const party = positive(fin.fromParty);
  if (party) inflows.push({ key: 'party', label: 'Party committees', amount: party });

  // Transfers from other committees, candidate loans, refunds and offsets all
  // land in receipts without appearing in any of the named buckets. Showing
  // the remainder keeps the ribbons summing to the reported total instead of
  // quietly disagreeing with the "Raised" figure printed above them.
  if (raised) {
    const named = inflows.reduce((t, f) => t + f.amount, 0);
    const other = raised - named;
    // Below 1% it's rounding noise in the FEC aggregates, not a real channel.
    if (other > 0 && other / raised >= 0.01) {
      inflows.push({
        key: 'other',
        label: 'Other receipts',
        amount: other,
        note: 'Transfers, loans, offsets',
      });
    } else if (other < 0) {
      // The named buckets exceeding receipts means the aggregates cover
      // different periods. Report it rather than drawing an impossible chart.
      caveats.push('The FEC source aggregates add up to more than the reported receipts total — they cover slightly different filing periods, so the bands below are approximate.');
    }
  }

  const inflowTotal = inflows.reduce((t, f) => t + f.amount, 0);
  for (const f of inflows) f.share = inflowTotal ? f.amount / inflowTotal : 0;

  /* ---------- conduits: an annotation, never a ribbon ---------- */

  const earmarked = (funding.earmarked || []).filter((e) => positive(e.total));
  const conduitTotal = sum(earmarked);
  // Only meaningful as a proportion of individual money, since that's the
  // channel it actually arrives through.
  const conduits = conduitTotal && individuals
    ? {
      total: conduitTotal,
      shareOfIndividuals: Math.min(1, conduitTotal / individuals),
      top: earmarked.slice(0, 4).map((e) => ({ name: e.name, total: round(e.total), count: e.count || null })),
    }
    : null;

  /* ---------- outside spending: a separate track ---------- */

  const outside = outsideTotal
    ? {
      total: outsideTotal,
      support: {
        total: sum(support),
        committees: support.slice(0, 5).map((r) => ({
          name: r.committee, committeeId: r.committeeId || null, total: round(r.total),
        })),
      },
      oppose: {
        total: sum(oppose),
        committees: oppose.slice(0, 5).map((r) => ({
          name: r.committee, committeeId: r.committeeId || null, total: round(r.total),
        })),
      },
    }
    : null;

  return {
    cycle: fin.cycle || null,
    coverageEnd: fin.coverageEnd || null,
    campaign: {
      raised: raised || inflowTotal || 0,
      spent: positive(fin.disbursements),
      cashOnHand: positive(fin.cashOnHand),
      inflows,
      inflowTotal,
      conduits,
    },
    outside,
    // Both tracks are drawn against one scale so their widths are comparable —
    // an outside-spending bar dwarfing the campaign's own money is the single
    // most informative thing this diagram can show, and it only reads that way
    // if the two are measured with the same ruler.
    scale: Math.max(inflowTotal, outsideTotal, 1),
    caveats,
  };
}

module.exports = { buildMoneyFlow, __splitIndividuals: splitIndividuals };

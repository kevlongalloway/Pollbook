/* Pollbook frontend — vanilla JS, hash routing, talks to /api.
   Covers all 50 states + DC; data arrives live from the backend providers. */

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const areaSelect = document.getElementById('area-select');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');

const state = {
  area: localStorage.getItem('pb-area') || 'GA',
  areas: [],
  tracked: new Set(JSON.parse(localStorage.getItem('pb-tracked') || '[]')),
  meta: { provider: 'live', live: true },
};

/* ---------------- api client ---------------- */

const api = {
  async get(path) {
    const res = await fetch(`/api${path}`);
    if (!res.ok) {
      let msg = `API ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `API ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },
  areas: () => api.get('/areas'),
  elections: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    return api.get(`/elections?${q}`);
  },
  election: (id) => api.get(`/elections/${id}`),
  candidate: (id) => api.get(`/candidates/${id}`),
  stats: (st) => api.get(`/stats${st ? `?state=${st}` : ''}`),
  search: (q) => api.get(`/search?q=${encodeURIComponent(q)}`),
  nationalMarkets: () => api.get('/markets/national'),
  committees: (q) => api.get(`/committees?q=${encodeURIComponent(q)}`),
  committee: (id) => api.get(`/committees/${id}`),
  meta: () => api.get('/meta'),
  askCandidate: (id, question, history) => api.post(`/candidates/${id}/ask`, { question, history }),
  bills: (q) => api.get(`/bills${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  bill: (congress, type, number) => api.get(`/bills/${congress}/${type}/${number}`),
  askBill: (congress, type, number, question, history) =>
    api.post(`/bills/${congress}/${type}/${number}/ask`, { question, history }),
};

/* ---------------- helpers ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtDate = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '—';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const daysUntil = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const diff = Math.ceil((new Date(`${iso}T12:00:00`) - new Date()) / 86400000);
  return diff >= 0 ? diff : null;
};

const fmtMoney = (n) => {
  if (n == null) return '';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
};

const PARTY_NAMES = {
  DEM: 'Democratic', REP: 'Republican', IND: 'Independent',
  LIB: 'Libertarian', GRN: 'Green', NP: 'Nonpartisan', OTH: 'Other',
};

const OFFICE_NAMES = { S: 'U.S. Senate', H: 'U.S. House', P: 'President' };

const areaInfo = (code) => state.areas.find((a) => a.code === code);
const areaName = (code) => areaInfo(code)?.name || code;

const saveTracked = () =>
  localStorage.setItem('pb-tracked', JSON.stringify([...state.tracked]));

const setArea = (code) => {
  state.area = code;
  localStorage.setItem('pb-area', code);
  areaSelect.value = code;
};

/* ---------------- shared renderers ---------------- */

const scopeTag = (scope) =>
  `<span class="tag tag--${esc(scope)}">${esc(scope)}</span>`;

const probChip = (c) => (c.probability != null
  ? `<span class="prob" title="Implied win probability — ${esc(c.probabilitySource || 'prediction-market')} price, not a forecast">${c.probability}%</span>`
  : '');

const ballotLine = (e) => {
  const days = daysUntil(e.date);
  return `
    <a class="ballot-line" href="#/election/${esc(e.id)}">
      <span class="line-oval ${state.tracked.has(e.id) ? 'oval--filled' : ''}" aria-hidden="true"></span>
      <span class="line-main">
        <span class="line-name">${esc(e.name)}</span>
        <span class="line-place">${esc(e.locality)}${e.state ? `, ${esc(e.state)}` : ''} · ${esc(e.type)}</span>
      </span>
      ${scopeTag(e.scope)}
      <span class="line-date">${fmtDate(e.date)}${days != null ? `<small>${days} days out</small>` : ''}</span>
    </a>`;
};

const ballotList = (elections, emptyMsg) =>
  elections.length
    ? `<div class="ballot-list">${elections.map(ballotLine).join('')}</div>`
    : `<div class="empty">${esc(emptyMsg)}</div>`;

const backLink = (href, label) =>
  `<a class="back-link" href="${href}"><span class="oval"></span>${esc(label)}</a>`;

const noteBox = (text) => `<div class="notice">${esc(text)}</div>`;

/** One prediction market as a block of contract bars. */
const marketPanel = (m) => `
  <div class="market">
    <div class="market-name">${esc(m.name)}${m.url ? ` <a href="${esc(m.url)}" target="_blank" rel="noopener">↗</a>` : ''}</div>
    ${(m.contracts || []).slice(0, 5).map((c) => {
      const pct = Math.round((c.price || 0) * 100);
      return `
        <div class="market-row">
          <span class="market-label">${esc(c.name || c.shortName)}</span>
          <span class="market-track"><span class="market-fill" style="width:${pct}%"></span></span>
          <span class="market-pct">${pct}%</span>
        </div>`;
    }).join('')}
    <p class="market-caption">Prediction-market prices — what traders will pay, not forecasts or endorsements.</p>
  </div>`;

const candLine = (c) => `
  <a class="cand-line" href="#/candidate/${esc(c.id)}">
    <span class="line-oval" aria-hidden="true"></span>
    <span class="cand-name">${esc(c.name)}
      <small>${c.incumbent ? 'Incumbent' : ''}${c.incumbent && c.receipts ? ' · ' : ''}${c.receipts ? `${fmtMoney(c.receipts)} raised` : ''}</small>
    </span>
    ${probChip(c)}
    <span class="party party--${esc(c.party)}">${esc(PARTY_NAMES[c.party] || c.party)}</span>
  </a>`;

/** A committee/PAC as a clickable money line: name, meta, amount. */
const moneyLine = ({ href, name, meta, amount, tag }) => `
  <a class="money-line" ${href ? `href="${esc(href)}"` : ''}>
    <span class="money-name">${esc(name)}${meta ? `<small>${esc(meta)}</small>` : ''}</span>
    ${tag ? `<span class="so-chip so-chip--${tag.toLowerCase()}">${esc(tag)}</span>` : ''}
    <span class="money-amount">${fmtMoney(amount)}</span>
  </a>`;

const committeeHref = (id) => (id ? `#/committee/${id}` : null);

/** Candidate-page block: who funds this candidate. */
const fundingSection = (c) => {
  const f = c.funding || {};
  const fin = c.finance || {};
  const mix = [
    ['Individuals', fin.fromIndividuals],
    ['PACs & committees', fin.fromPacs],
    ['Party committees', fin.fromParty],
  ].filter(([, v]) => v != null && fin.receipts > 0);
  const support = f.independent?.support || [];
  const oppose = f.independent?.oppose || [];
  const employers = f.employers || [];
  const earmarked = f.earmarked || [];
  const sizes = f.donorSizes || [];
  const hasAnything = mix.length || (f.topPacs || []).length || support.length
    || oppose.length || employers.length || earmarked.length;
  if (!hasAnything && !c.sources?.funding) return '';

  const smallDollar = sizes.find((s) => s.size === 0);
  const sizeTotal = sizes.reduce((sum, s) => sum + s.total, 0);

  return `
    <section class="section">
      <div class="section-head"><h2>Who funds them</h2><span class="count">${c.sources?.mock ? '' : 'FEC filings, fetched live'}</span></div>
      ${c.sources?.funding === 'partial' ? noteBox('Some funding data could not be loaded from the FEC just now — panels below may be incomplete.') : ''}

      ${mix.length ? `
        <div class="finance-grid">
          ${mix.map(([label, v]) => `
            <div class="finance-card"><dt>${esc(label)}</dt><dd>${fmtMoney(v)}</dd>
              <small>${Math.round((v / fin.receipts) * 100)}% of money raised</small></div>`).join('')}
          ${smallDollar && sizeTotal ? `
            <div class="finance-card"><dt>Small donors</dt><dd>${Math.round((smallDollar.total / sizeTotal) * 100)}%</dd>
              <small>Gave under $200 each</small></div>` : ''}
        </div>` : ''}

      ${support.length || oppose.length ? `
        <div class="section-sub"><h3>Outside spending about this candidate</h3></div>
        <div class="money-list">
          ${support.map((r) => moneyLine({
            href: committeeHref(r.committeeId), name: r.committee, amount: r.total, tag: 'For',
          })).join('')}
          ${oppose.map((r) => moneyLine({
            href: committeeHref(r.committeeId), name: r.committee, amount: r.total, tag: 'Against',
          })).join('')}
        </div>
        <p class="attribution" style="padding:0.5rem 0 0">Independent expenditures by super PACs and outside groups — unlimited, and spent for or against the candidate without going to (or being coordinated with) the campaign. This is where the largest outside money shows up.</p>` : ''}

      ${earmarked.length ? `
        <div class="section-sub"><h3>Bundled through a conduit</h3></div>
        <div class="money-list">
          ${earmarked.map((e) => moneyLine({
            href: null, name: e.name, meta: `${e.count} earmarked donation${e.count === 1 ? '' : 's'}`, amount: e.total,
          })).join('')}
        </div>
        <p class="attribution" style="padding:0.5rem 0 0">Individual donations earmarked through an organization acting as a conduit. This is how groups such as AIPAC move most of their money — it never appears as a PAC check, so a PAC-only view misses it.</p>` : ''}

      ${employers.length ? `
        <div class="section-sub"><h3>Top donor employers &amp; affiliations</h3></div>
        <div class="money-list">
          ${employers.map((e) => moneyLine({
            href: null, name: e.employer, meta: e.count ? `${e.count} donations` : '', amount: e.total,
          })).join('')}
        </div>
        <p class="attribution" style="padding:0.5rem 0 0">Individual contributions grouped by the donor's reported employer. The organization itself isn't giving — its employees and members are — but this is the clearest signal of which industries and institutions are behind a campaign.</p>` : ''}

      ${(f.topPacs || []).length ? `
        <div class="section-sub"><h3>PAC &amp; committee contributions</h3></div>
        <div class="money-list">
          ${f.topPacs.map((p) => moneyLine({
            href: committeeHref(p.committeeId),
            name: p.name,
            meta: p.count > 1 ? `${p.count} contributions` : '',
            amount: p.total,
          })).join('')}
        </div>
        <p class="attribution" style="padding:0.5rem 0 0">Direct contributions from PACs and party committees, totalled across the cycle. Federal law caps these at $5,000 per election, so the amounts are small and similar across candidates by design — the panels above carry far more signal.</p>` : ''}
    </section>`;
};

/* ---------------- money flow diagram ---------------- */

/**
 * Where a campaign's money comes from, drawn as a flow.
 *
 * Two rules make this honest, and the layout exists to enforce them:
 *
 *  - **Outside spending gets its own track, with no ribbon to the campaign.**
 *    Independent expenditures never touch a campaign's books. Drawing them
 *    flowing in would be the single most misleading thing this chart could do,
 *    and it is exactly what a naive "total money" chart implies.
 *  - **Both tracks share one ruler.** Pixels-per-dollar is constant across the
 *    whole diagram, so when outside groups outspend the campaign the outside
 *    stack is visibly taller. That comparison is the reason to draw this at
 *    all, and it only holds if nothing is independently normalized.
 *
 * Conduit money is drawn as hatching *inside* the individual-donor bands
 * rather than as its own inflow, because that is what it is: individual
 * donations routed through an organization. A separate ribbon would
 * double-count it against the individual total.
 */
const FLOW_COLORS = {
  small: '#F2B807',
  large: '#2038C8',
  individuals: '#2038C8',
  pacs: '#7A8290',
  party: '#17289B',
  other: '#C7CBC1',
};

const flowPct = (share) => `${share < 0.01 ? '<1' : Math.round(share * 100)}%`;

/** Sankey ribbon: source band edge to campaign node edge, as one closed path. */
function ribbonPath(x0, y0, x1, y1, h0, h1) {
  const mid = (x0 + x1) / 2;
  return [
    `M${x0},${y0}`,
    `C${mid},${y0} ${mid},${y1} ${x1},${y1}`,
    `L${x1},${y1 + h1}`,
    `C${mid},${y1 + h1} ${mid},${y0 + h0} ${x0},${y0 + h0}`,
    'Z',
  ].join(' ');
}

function moneyFlowSvg(mf) {
  const W = 680;
  const LBL_R = 176;        // right edge of the label column
  const SRC_X = 184;
  const SRC_W = 11;
  const CAMP_X = 452;
  const CAMP_W = 15;
  const BAND_GAP = 4;
  const TRACK_H = 210;      // pixels representing `mf.scale` dollars
  const TOP = 30;

  const pxPer = TRACK_H / mf.scale;
  // A band below a pixel or two vanishes; the label still carries the exact
  // figure, so a hairline reads as "negligible" rather than as zero.
  const bandH = (amount) => Math.max(2, amount * pxPer);

  const inflows = mf.campaign.inflows || [];
  const parts = [];

  /* ---- campaign track ---- */

  const campH = inflows.reduce((t, f) => t + bandH(f.amount), 0);
  let srcY = TOP;
  let campY = TOP;

  // Geometry first, labels second. A band only a few pixels tall can't hold a
  // two-line label at its own centre, and small bands cluster — so labels are
  // laid out in a separate pass that pushes each one clear of the last and
  // draws a leader back to the band it belongs to.
  const bands = inflows.map((f) => {
    const h = bandH(f.amount);
    const geom = { f, h, srcY, campY, color: FLOW_COLORS[f.key] || FLOW_COLORS.other };
    srcY += h + BAND_GAP;
    campY += h;
    return geom;
  });

  const LABEL_H = 27;
  let labelFloor = -Infinity;
  for (const g of bands) {
    const wanted = g.srcY + g.h / 2;
    g.labelY = Math.max(wanted, labelFloor + LABEL_H / 2);
    g.displaced = Math.abs(g.labelY - wanted) > 3;
    labelFloor = g.labelY + LABEL_H / 2;
  }

  for (const g of bands) {
    const { f, h, color } = g;
    parts.push(`<path d="${ribbonPath(SRC_X + SRC_W, g.srcY, CAMP_X, g.campY, h, h)}" fill="${color}" fill-opacity="0.42" />`);
    parts.push(`<rect x="${SRC_X}" y="${g.srcY}" width="${SRC_W}" height="${h}" fill="${color}" />`);

    // Conduit hatching sits inside the individual bands only — that is the
    // channel bundled money actually arrives through.
    const conduits = mf.campaign.conduits;
    if (conduits && (f.key === 'small' || f.key === 'large' || f.key === 'individuals')) {
      // Runs past the source bar into the head of the ribbon purely so the
      // hatching is legible — the *height* is the only thing carrying data.
      const ch = h * conduits.shareOfIndividuals;
      parts.push(`<rect x="${SRC_X}" y="${g.srcY + h - ch}" width="${SRC_W + 32}" height="${ch}" fill="url(#pb-hatch)" />`);
    }

    if (g.displaced) {
      parts.push(`<path d="M${LBL_R + 5},${g.labelY + 3} L${SRC_X - 5},${g.srcY + h / 2}" stroke="${color}" stroke-width="1" fill="none" />`);
    }

    parts.push(`
      <text x="${LBL_R}" y="${g.labelY - 1}" text-anchor="end" class="mf-label">${esc(f.label)}</text>
      <text x="${LBL_R}" y="${g.labelY + 12}" text-anchor="end" class="mf-amt">${fmtMoney(f.amount)} · ${flowPct(f.share)}</text>`);
  }

  // Labels can run past the last band when several thin ones stack up.
  const labelsBottom = bands.length ? bands.at(-1).labelY + LABEL_H / 2 : TOP;

  parts.push(`<rect x="${CAMP_X}" y="${TOP}" width="${CAMP_W}" height="${campH}" fill="#15181B" />`);
  parts.push(`
    <text x="${CAMP_X + CAMP_W + 10}" y="${TOP + campH / 2 - 1}" class="mf-node">The campaign</text>
    <text x="${CAMP_X + CAMP_W + 10}" y="${TOP + campH / 2 + 13}" class="mf-amt">${fmtMoney(mf.campaign.raised)} raised</text>`);

  parts.push(`<text x="0" y="16" class="mf-track-label">MONEY INTO THE CAMPAIGN</text>`);

  /* ---- outside track ---- */

  const bottomOfCampaign = Math.max(srcY, TOP + campH, labelsBottom);
  let height = bottomOfCampaign + 20;

  if (mf.outside) {
    const dividerY = height + 14;
    parts.push(`<line x1="0" y1="${dividerY}" x2="${W}" y2="${dividerY}" stroke="#15181B" stroke-width="1.5" stroke-dasharray="5 5" />`);
    parts.push(`<text x="0" y="${dividerY + 20}" class="mf-track-label">SPENT ABOUT THIS CANDIDATE — NEVER TOUCHES THE CAMPAIGN</text>`);

    let y = dividerY + 34;
    const rows = [
      ['Supporting them', mf.outside.support, '#2038C8'],
      ['Opposing them', mf.outside.oppose, '#B3231F'],
    ].filter(([, group]) => group && group.total > 0);

    for (const [label, group, color] of rows) {
      const h = bandH(group.total);
      // Deliberately starts at SRC_X and stops short of the campaign node: the
      // gap between this bar and the black bar above is the whole point.
      parts.push(`<rect x="${SRC_X}" y="${y}" width="${SRC_W}" height="${h}" fill="${color}" />`);
      parts.push(`<path d="${ribbonPath(SRC_X + SRC_W, y, CAMP_X - 42, y, h, h)}" fill="${color}" fill-opacity="0.30" />`);
      parts.push(`
        <text x="${LBL_R}" y="${y + h / 2 - 1}" text-anchor="end" class="mf-label">${esc(label)}</text>
        <text x="${LBL_R}" y="${y + h / 2 + 12}" text-anchor="end" class="mf-amt">${fmtMoney(group.total)}</text>`);
      y += h + 14;
    }

    parts.push(`
      <text x="${CAMP_X - 30}" y="${dividerY + 46}" class="mf-node">The race</text>
      <text x="${CAMP_X - 30}" y="${dividerY + 60}" class="mf-amt">ads, mail, canvassing</text>`);

    height = y + 10;
  }

  const alt = [
    `Money flow for this campaign.`,
    `Into the campaign: ${inflows.map((f) => `${f.label} ${fmtMoney(f.amount)}`).join(', ')}.`,
    mf.campaign.conduits ? `Of the individual money, ${fmtMoney(mf.campaign.conduits.total)} was bundled through conduits.` : '',
    mf.outside ? `Spent separately about this candidate, never touching the campaign: ${fmtMoney(mf.outside.support.total)} supporting, ${fmtMoney(mf.outside.oppose.total)} opposing.` : '',
  ].filter(Boolean).join(' ');

  return `
    <svg class="mf-svg" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(alt)}" preserveAspectRatio="xMidYMin meet">
      <defs>
        <pattern id="pb-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#FDFDFB" fill-opacity="0.25" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#15181B" stroke-width="2.5" />
        </pattern>
      </defs>
      ${parts.join('')}
    </svg>`;
}

const moneyFlowSection = (c) => {
  const mf = c.moneyFlow;
  if (!mf) return '';
  const conduits = mf.campaign.conduits;

  return `
    <section class="section">
      <div class="section-head">
        <h2>Where the money comes from</h2>
        <span class="count">${mf.coverageEnd ? `FEC filings through ${fmtDate(mf.coverageEnd)}` : 'FEC filings, fetched live'}</span>
      </div>
      <div class="mf-wrap">${moneyFlowSvg(mf)}</div>
      <div class="mf-legend">
        ${conduits ? `
          <span class="mf-key"><span class="mf-swatch mf-swatch--hatch"></span>${fmtMoney(conduits.total)} of the individual money was bundled through a conduit${conduits.top.length ? ` — largest: ${esc(conduits.top[0].name)}` : ''}. It arrives as individual donations, so it is drawn inside those bands, not as money of its own.</span>` : ''}
        ${mf.outside ? `
          <span class="mf-key"><span class="mf-swatch mf-swatch--rule"></span>Everything below the dashed line is independent expenditure — unlimited outside spending for or against this candidate that never enters the campaign's accounts. Both halves of the diagram are drawn to the same scale, so the heights are directly comparable.</span>` : ''}
        ${mf.campaign.spent ? `
          <span class="mf-key"><span class="mf-swatch mf-swatch--ink"></span>The campaign has spent ${fmtMoney(mf.campaign.spent)}${mf.campaign.cashOnHand ? `, with ${fmtMoney(mf.campaign.cashOnHand)} still on hand` : ''}.</span>` : ''}
        ${(mf.caveats || []).map((c2) => `<span class="mf-key mf-key--caveat">${esc(c2)}</span>`).join('')}
      </div>
    </section>`;
};

const raceBlock = (r) => `
  <div class="race-block">
    <div class="race-office">${esc(r.office)}</div>
    ${r.candidates.length
      ? r.candidates.map(candLine).join('')
      : `<div class="race-empty">${esc(r.note || 'No candidate filings loaded for this race yet.')}</div>`}
    ${(r.markets || []).length ? marketPanel(r.markets[0]) : ''}
  </div>`;

/* ---------------- Q&A panel (AI, Groq) ---------------- */

/* Shared by the candidate and bill panels. History lives only in the browser —
   one localStorage entry per subject, and the key is passed in so a bill
   conversation and a candidate conversation never collide. */

const loadQaHistory = (key) => {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch { return []; }
};

const saveQaHistory = (key, history) =>
  localStorage.setItem(key, JSON.stringify(history.slice(-40)));

/**
 * esc() escapes quotes but would happily pass through `javascript:` — and
 * these URLs come from web search results, i.e. from strangers. Only http(s)
 * reaches an href.
 */
const safeHref = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? esc(u) : '#');

const qaSourcesHtml = (sources) => {
  const list = (sources || []).filter((s) => s && s.url).slice(0, 6);
  if (!list.length) return '';
  return `
    <div class="qa-sources">
      <span class="qa-sources-label">Sources</span>
      <ol>
        ${list.map((s) => `
          <li><a href="${safeHref(s.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(s.title || s.url)}">${esc(s.outlet || s.title || s.url)}</a>${s.date ? ` <span class="qa-source-date">${esc(s.date)}</span>` : ''}</li>`).join('')}
      </ol>
    </div>`;
};

const qaMsgHtml = (m) => `
  <div class="qa-msg qa-msg--${m.role === 'user' ? 'user' : 'ai'}${m.pending ? ' qa-msg--pending' : ''}">
    <span class="qa-msg-role">${m.role === 'user' ? 'You' : 'Pollbook AI'}</span>
    <p>${esc(m.content)}</p>
    ${m.role === 'user' ? '' : qaSourcesHtml(m.sources)}
  </div>`;

function renderQaLog(key, emptyMsg) {
  const log = document.getElementById('qa-log');
  if (!log) return;
  const history = loadQaHistory(key);
  log.innerHTML = history.length
    ? history.map(qaMsgHtml).join('')
    : `<div class="empty qa-empty">${esc(emptyMsg)}</div>`;
  log.scrollTop = log.scrollHeight;
}

/**
 * Wire up the panel. `ask` is the only thing that differs between subjects —
 * it takes (question, history) and resolves to { answer, sources }.
 */
function setupQa({ storeKey, ask, emptyMsg }) {
  renderQaLog(storeKey, emptyMsg);

  const form = document.getElementById('qa-form');
  const input = document.getElementById('qa-input');
  const clearBtn = document.getElementById('qa-clear');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    const historyForRequest = loadQaHistory(storeKey);
    const history = [...historyForRequest, { role: 'user', content: question }];
    saveQaHistory(storeKey, history);
    input.value = '';
    input.disabled = true;
    renderQaLog(storeKey, emptyMsg);
    document.getElementById('qa-log').insertAdjacentHTML('beforeend',
      qaMsgHtml({ role: 'assistant', content: 'Thinking… this may take a few seconds if it needs to search.', pending: true }));

    try {
      const { answer, sources } = await ask(question, historyForRequest);
      // Sources are persisted alongside the answer so citations survive a
      // reload — the server re-maps history to {role, content}, so this extra
      // key is never echoed back into the prompt.
      saveQaHistory(storeKey, [...history, { role: 'assistant', content: answer, sources: (sources || []).slice(0, 6) }]);
    } catch (err) {
      saveQaHistory(storeKey, [...history, { role: 'assistant', content: `Couldn't get an answer — ${err.message}` }]);
    } finally {
      input.disabled = false;
      renderQaLog(storeKey, emptyMsg);
      input.focus();
    }
  });

  clearBtn.addEventListener('click', () => {
    localStorage.removeItem(storeKey);
    renderQaLog(storeKey, emptyMsg);
  });
}

const qaSection = ({ heading, tag, note, placeholder, ariaLabel }) => `
  <section class="qa-callout">
    <div class="qa-callout-head">
      <span class="qa-badge">AI</span>
      <h2>${esc(heading)}</h2>
      <span class="qa-callout-tag">${esc(tag)}</span>
    </div>
    <div class="qa-callout-body">
      <p class="qa-note">${esc(note)}</p>
      <div class="qa-log" id="qa-log"></div>
      <form id="qa-form" class="qa-form">
        <input id="qa-input" type="text" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="${esc(ariaLabel)}" />
        <button type="submit" class="filter-btn qa-send">Ask</button>
      </form>
      <div class="qa-actions"><button type="button" id="qa-clear" class="deep-link">Clear conversation</button></div>
    </div>
  </section>`;

const candidateQaSection = (c) => qaSection({
  heading: `Ask about ${c.name}`,
  tag: 'U.S. elections only',
  note: "Grounded in this candidate's Pollbook profile — FEC filings, Wikipedia, news — and it searches the web when the profile doesn't cover your question, listing the sources it used. It only discusses United States elections and candidates, and refuses anything else. It can get things wrong; verify anything that matters. Your conversation stays in this browser, never on our server.",
  placeholder: 'e.g. What are their views on healthcare?',
  ariaLabel: 'Ask a question about this candidate',
});

const billQaSection = (b) => qaSection({
  heading: `Ask about ${b.label}`,
  tag: 'U.S. legislation only',
  note: "Grounded in this bill's official record — the Congressional Research Service summary, sponsor, cosponsors and action history from Congress.gov — and it searches the web for current status and reaction, listing the sources it used. It explains what the bill does and who is for and against it; it will not argue either side. It can get things wrong; verify anything that matters against congress.gov. Your conversation stays in this browser, never on our server.",
  placeholder: 'e.g. What would this actually change for voters?',
  ariaLabel: 'Ask a question about this bill',
});

/* ---------------- views ---------------- */

async function viewHome() {
  const [elections, natMarkets] = await Promise.all([
    api.elections({ state: state.area }),
    api.nationalMarkets().catch(() => []),
  ]);

  const info = areaInfo(state.area) || {};
  const name = areaName(state.area);
  const localOnly = elections.filter((e) => e.scope !== 'national');
  const national = elections.filter((e) => e.scope === 'national');
  const next = elections[0];
  const nextDays = next ? daysUntil(next.date) : null;
  const primaryDays = daysUntil(info.primaryDate);

  app.innerHTML = `
    <section class="hero">
      <div class="hero-strip">
        <span>Official sample — Pollbook</span>
        <span>State: ${esc(name)}</span>
      </div>
      <div class="hero-body">
        <h1>Every election.<br>Not just the <span class="accent">big one.</span></h1>
        <p class="lede">Senate, House, governor, primaries — here is everything on the calendar for ${esc(name)}, with who's running, where their money comes from, and where they stand.</p>
        ${next ? `<span class="hero-count"><span class="oval oval--filled"></span>Next: ${esc(next.name)} — ${fmtDate(next.date)}${nextDays != null ? ` · ${nextDays} days` : ''}</span>` : ''}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Key dates for ${esc(name)}</h2></div>
      <div class="keydates">
        <div class="keydate">
          <dt>Primary</dt>
          <dd>${info.primaryDate ? fmtDate(info.primaryDate) : 'See note'}</dd>
          <small>${info.primaryDate ? (primaryDays != null ? `${primaryDays} days out` : 'Held') : 'Schedule varies'}</small>
        </div>
        <div class="keydate">
          <dt>General election</dt>
          <dd>${fmtDate(info.generalDate)}</dd>
          <small>${daysUntil(info.generalDate) != null ? `${daysUntil(info.generalDate)} days out` : 'Held'}</small>
        </div>
        <div class="keydate">
          <dt>On the ${new Date().getFullYear()} ballot</dt>
          <dd class="keydate-chips">
            ${info.senate2026 ? '<span class="chip">U.S. Senate</span>' : ''}
            ${info.governor2026 ? '<span class="chip">Governor</span>' : ''}
            <span class="chip">U.S. House</span>
          </dd>
          <small>Plus state &amp; local races</small>
        </div>
        <div class="keydate keydate--action">
          <dt>Not registered?</dt>
          <dd><a href="${esc(info.registrationUrl || 'https://vote.gov')}" target="_blank" rel="noopener">Register at vote.gov ↗</a></dd>
          <small>Official state instructions</small>
        </div>
      </div>
      ${info.note ? noteBox(info.note) : ''}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Upcoming in ${esc(name)}</h2>
        <span class="count">${localOnly.length} election${localOnly.length === 1 ? '' : 's'} scheduled</span>
      </div>
      ${ballotList(localOnly, 'No upcoming elections found for this state.')}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>National</h2>
        <span class="count">${national.length} scheduled</span>
      </div>
      ${ballotList(national, 'No upcoming national elections found.')}
      ${natMarkets.length ? `
        <div class="section-sub"><h3>Control of Congress — market odds</h3></div>
        <div class="market-grid">${natMarkets.slice(0, 2).map(marketPanel).join('')}</div>` : ''}
    </section>
  `;
}

async function viewBrowse(params) {
  const selectedState = params.get('state') || '';
  const selectedScope = params.get('scope') || '';

  const elections = await api.elections({
    state: selectedState || undefined,
    scope: selectedScope || undefined,
  });

  const stateOptions = state.areas
    .map((a) => `<option value="${esc(a.code)}" ${a.code === selectedState ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  const scopes = ['', 'state', 'national'];

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Jump to a state</h2>
        <span class="count">50 states + DC</span>
      </div>
      <div class="state-grid">
        ${state.areas.map((a) => `
          <button class="state-tile ${a.code === state.area ? 'active' : ''}" data-code="${esc(a.code)}" title="${esc(a.name)}">
            <span class="state-code">${esc(a.code)}</span>
            <span class="state-name">${esc(a.name)}</span>
            <span class="state-marks">${a.senate2026 ? '<i title="U.S. Senate race in 2026">S</i>' : ''}${a.governor2026 ? '<i title="Governor race in 2026">G</i>' : ''}</span>
          </button>`).join('')}
      </div>
      <p class="legend"><i>S</i> Senate seat on the 2026 ballot &nbsp; <i>G</i> Governor on the 2026 ballot — tap a state to open its ballot.</p>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>All upcoming elections</h2>
        <span class="count">${elections.length} result${elections.length === 1 ? '' : 's'}</span>
      </div>

      <div class="browse-controls">
        <select id="browse-state" aria-label="Filter by state">
          <option value="">All states</option>
          ${stateOptions}
        </select>
        ${scopes.map((s) => `
          <button class="filter-btn ${s === selectedScope ? 'active' : ''}" data-scope="${s}">
            ${s === '' ? 'All scopes' : s[0].toUpperCase() + s.slice(1)}
          </button>`).join('')}
        <input id="browse-filter" type="search" placeholder="Filter by name…" aria-label="Filter elections by name" />
      </div>

      <div id="browse-list">${ballotList(elections, 'Nothing matches these filters. Try widening the search.')}</div>
    </section>
  `;

  app.querySelectorAll('.state-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      setArea(tile.dataset.code);
      location.hash = '#/home';
    });
  });

  document.getElementById('browse-state').addEventListener('change', (e) => {
    const q = new URLSearchParams(params);
    e.target.value ? q.set('state', e.target.value) : q.delete('state');
    location.hash = `#/browse?${q}`;
  });

  app.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = new URLSearchParams(params);
      btn.dataset.scope ? q.set('scope', btn.dataset.scope) : q.delete('scope');
      location.hash = `#/browse?${q}`;
    });
  });

  document.getElementById('browse-filter').addEventListener('input', (e) => {
    const needle = e.target.value.trim().toLowerCase();
    const filtered = needle
      ? elections.filter((el) => el.name.toLowerCase().includes(needle))
      : elections;
    document.getElementById('browse-list').innerHTML =
      ballotList(filtered, 'Nothing matches these filters. Try widening the search.');
  });
}

async function viewElection(id) {
  const e = await api.election(id);
  const days = daysUntil(e.date);
  const tracked = state.tracked.has(e.id);
  const fecDown = e.sources && e.sources.fec === 'error';
  const raceCount = (e.races || []).length;

  app.innerHTML = `
    ${backLink('#/home', 'Back to your ballot')}

    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">${esc(e.type)} · ${esc(e.locality)}${e.state ? `, ${esc(areaName(e.state))}` : ''}</p>
        <h1>${esc(e.name)}</h1>
      </div>
      <dl class="detail-meta">
        <div><dt>Election day</dt><dd>${fmtDate(e.date)}</dd></div>
        <div><dt>Days remaining</dt><dd>${days != null ? days : 'Held'}</dd></div>
        ${e.registrationDeadline ? `<div><dt>Register by</dt><dd>${fmtDate(e.registrationDeadline)}</dd></div>` : ''}
        ${e.registrationUrl ? `<div><dt>Registration</dt><dd><a href="${esc(e.registrationUrl)}" target="_blank" rel="noopener">vote.gov ↗</a></dd></div>` : ''}
      </dl>
      <p class="detail-desc">${esc(e.description)}</p>
    </article>

    <button class="track-btn" id="track-btn" data-tracked="${tracked}">
      <span class="track-oval"></span>
      ${tracked ? 'Tracking this election' : 'Track this election'}
    </button>

    <section class="section" style="margin-top:2rem">
      <div class="section-head">
        <h2>On the ballot</h2>
        <span class="count">${raceCount} race${raceCount === 1 ? '' : 's'} loaded</span>
      </div>
      ${fecDown ? noteBox('Live candidate data (FEC) is unreachable right now, so candidate lists may be missing or incomplete. They will fill in automatically once the connection recovers.') : ''}
      ${raceCount
        ? e.races.map(raceBlock).join('')
        : (e.scope === 'national'
            ? '<div class="empty">Pick your state (top right, or via Browse) to see the exact races on your ballot.</div>'
            : '<div class="empty">No federal races found for this election yet.</div>')}
      ${e.scope === 'national' && (e.markets || []).length ? `
        <div class="section-sub"><h3>Control of Congress — market odds</h3></div>
        <div class="market-grid">${e.markets.slice(0, 2).map(marketPanel).join('')}</div>` : ''}
      ${e.provenance ? `<p class="provenance">${esc(e.provenance)}</p>` : ''}
    </section>
  `;

  document.getElementById('track-btn').addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    if (state.tracked.has(e.id)) {
      state.tracked.delete(e.id);
      btn.dataset.tracked = 'false';
      btn.innerHTML = '<span class="track-oval"></span>Track this election';
    } else {
      state.tracked.add(e.id);
      btn.dataset.tracked = 'true';
      btn.innerHTML = '<span class="track-oval"></span>Tracking this election';
    }
    saveTracked();
  });
}

async function viewCandidate(id) {
  const c = await api.candidate(id);
  const appearance = (c.appearances || [])[0];
  const bio = c.wiki?.extract || c.bio || '';
  const hasPositionTexts = (c.positions || []).some((p) => p.text);

  app.innerHTML = `
    ${backLink(appearance ? `#/election/${esc(appearance.electionId)}` : '#/home', appearance ? `Back to ${appearance.electionName}` : 'Back')}

    <article class="detail-card">
      <div class="detail-band detail-band--person">
        ${c.wiki?.thumbnail ? `<img class="portrait" src="${esc(c.wiki.thumbnail)}" alt="Portrait of ${esc(c.name)}" />` : ''}
        <div>
          <p class="eyebrow">${esc(PARTY_NAMES[c.party] || c.partyFull || c.party)}${c.incumbent ? ' · Incumbent' : ''}${c.probability != null ? ` · ${c.probability}% market odds` : ''}</p>
          <h1>${esc(c.name)}</h1>
        </div>
      </div>
      <dl class="detail-meta">
        <div><dt>Running for</dt><dd>${esc(c.officeLabel || c.office)}</dd></div>
        ${c.stateName ? `<div><dt>State</dt><dd>${esc(c.stateName)}</dd></div>` : ''}
        <div><dt>Election day</dt><dd>${appearance ? fmtDate(appearance.date) : '—'}</dd></div>
        ${c.probability != null ? `<div><dt>Win odds<sup>*</sup></dt><dd>${c.probability}%</dd></div>` : ''}
      </dl>
      ${bio ? `<p class="detail-desc">${esc(bio)}</p>` : ''}
      ${c.wiki ? `<p class="attribution">Background from <a href="${esc(c.wiki.url)}" target="_blank" rel="noopener">Wikipedia: ${esc(c.wiki.title)}</a> — community-edited; verify anything that matters.</p>` : ''}
      ${c.probability != null ? `<p class="attribution"><sup>*</sup>${esc(c.probabilitySource || 'Prediction-market')} price — what traders will pay, not a forecast.</p>` : ''}
    </article>

    ${candidateQaSection(c)}

    ${c.finance ? `
    <section class="section">
      <div class="section-head"><h2>Campaign money</h2><span class="count">FEC totals · ${c.finance.coverageEnd ? `through ${fmtDate(c.finance.coverageEnd)}` : `${c.finance.cycle} cycle`}</span></div>
      <div class="finance-grid">
        <div class="finance-card"><dt>Raised</dt><dd>${fmtMoney(c.finance.receipts)}</dd></div>
        <div class="finance-card"><dt>Spent</dt><dd>${fmtMoney(c.finance.disbursements)}</dd></div>
        <div class="finance-card"><dt>Cash on hand</dt><dd>${fmtMoney(c.finance.cashOnHand)}</dd></div>
      </div>
    </section>` : ''}

    ${moneyFlowSection(c)}

    ${fundingSection(c)}

    <section class="section">
      <div class="section-head"><h2>Where they stand</h2>${hasPositionTexts ? '<span class="count">From Wikipedia’s political-positions coverage</span>' : ''}</div>
      ${(c.positions || []).length
        ? (hasPositionTexts
          ? c.positions.map((p) => `
              <details class="position">
                <summary>${esc(p.topic)}</summary>
                <p>${esc(p.text)}</p>
              </details>`).join('')
          : `<div class="values-grid">${c.positions.map((p) => `
              <div class="value-item"><span class="oval"></span>${esc(p.topic)}</div>`).join('')}</div>`)
        : '<div class="empty">No published policy-position summary found for this candidate yet. Try the links below — Ballotpedia and campaign sites usually have platform details first.</div>'}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>In the news</h2>
        <span class="count">${(c.articles || []).length && !c.sources?.mock ? 'Live from Google News' : ''}</span>
      </div>
      ${(c.articles || []).length ? c.articles.map((a) => `
        <a class="article-line" href="${esc(a.url)}" ${a.url && a.url !== '#' ? 'target="_blank" rel="noopener"' : ''}>
          <span class="article-title">${esc(a.title)}</span>
          <span class="article-src">${esc(a.outlet)}${a.date ? ` · ${fmtDate(a.date)}` : ''}</span>
        </a>`).join('')
      : '<div class="empty">No recent coverage indexed for this candidate.</div>'}
    </section>

    ${(c.links || []).length ? `
    <section class="section">
      <div class="section-head"><h2>Go deeper</h2></div>
      <div class="links-row">
        ${c.links.map((l) => `<a class="deep-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}
      </div>
    </section>` : ''}
  `;

  setupQa({
    // Unchanged key shape — existing candidate conversations survive this
    // panel becoming shared with bills.
    storeKey: `pb-ai-${c.id}`,
    ask: (question, history) => api.askCandidate(c.id, question, history),
    emptyMsg: 'No questions yet — ask anything about this candidate, or about U.S. elections generally.',
  });
}

async function viewData() {
  const [stats, national] = await Promise.all([
    api.stats(state.area),
    api.stats().catch(() => null),
  ]);

  const bars = (payload) => {
    if (!payload) return '';
    if (payload.error) return noteBox(payload.error);
    const top = payload.topFundraisers || [];
    if (!top.length) return '<div class="empty">No candidate filings found.</div>';
    const max = Math.max(...top.map((c) => c.receipts || 0), 1);
    return `
      <div class="stat-card">
        <h3>${esc(payload.stateName)} <small>${payload.totalCandidates != null ? `${payload.totalCandidates} filed candidates` : ''}</small></h3>
        <div class="bar-rows">
          ${top.map((c) => `
            <a class="bar-row bar-row--link" href="#/candidate/${esc(c.id)}">
              <div class="bar-label">
                <span>${esc(c.name)} <em>${esc(c.party)}${c.office ? ` · ${esc(OFFICE_NAMES[c.office] || c.office)}` : ''}${c.district && Number(c.district) ? `-${Number(c.district)}` : ''}</em></span>
                <span>${fmtMoney(c.receipts)}</span>
              </div>
              <div class="bar-track"><div class="bar-fill" data-w="${Math.round(((c.receipts || 0) / max) * 100)}"></div></div>
            </a>`).join('')}
        </div>
        <p class="stat-note">${esc(payload.note || '')}</p>
      </div>`;
  };

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Money in the ${esc(String(stats.cycle || ''))} races</h2>
        <span class="count">${esc(stats.source || '')}</span>
      </div>
      <p style="max-width:64ch;margin-bottom:1.5rem">Follow the money: every federal candidate reports what they raise and spend to the FEC. Fundraising isn't destiny, but it is the clearest early signal of which races are seriously contested.</p>
      <div class="stats-grid stats-grid--wide">
        ${bars(stats)}
        ${national && national.state !== stats.state ? bars(national) : ''}
      </div>
    </section>
  `;

  requestAnimationFrame(() => {
    app.querySelectorAll('.bar-fill').forEach((el) => {
      el.style.width = `${el.dataset.w}%`;
    });
  });
}

async function viewSearch(params) {
  const q = (params.get('q') || '').trim();
  searchInput.value = q;

  let results = [];
  let error = null;
  if (q) {
    try {
      results = await api.search(q);
    } catch (err) {
      error = err.message;
    }
  }

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Candidate search</h2>
        <span class="count">${q ? `${results.length} match${results.length === 1 ? '' : 'es'} for “${esc(q)}”` : ''}</span>
      </div>
      ${error ? noteBox(error) : ''}
      ${!q ? '<div class="empty">Type a candidate name in the search box above — the search covers every filed federal candidate in all 50 states.</div>' : ''}
      ${q && !error ? (results.length ? results.map((r) => `
        <a class="cand-line" href="#/candidate/${esc(r.id)}">
          <span class="line-oval" aria-hidden="true"></span>
          <span class="cand-name">${esc(r.name)}
            <small>${esc(OFFICE_NAMES[r.office] || r.officeFull || '')}${r.state ? ` · ${esc(areaName(r.state))}` : ''}${r.district && Number(r.district) ? ` District ${Number(r.district)}` : ''}${(r.electionYears || []).length ? ` · ${r.electionYears.slice(-1)[0]}` : ''}</small>
          </span>
          <span class="party party--${esc(r.party)}">${esc(PARTY_NAMES[r.party] || r.party)}</span>
        </a>`).join('')
      : '<div class="empty">No filed candidates match that name. Check the spelling — the index covers candidates who have filed with the FEC.</div>') : ''}
    </section>
  `;
}

async function viewPacs(params) {
  const q = (params.get('q') || '').trim();

  let data = { results: [], expansions: [] };
  let error = null;
  if (q) {
    try {
      data = await api.committees(q);
    } catch (err) {
      error = err.message;
    }
  }

  const QUICK = ['AIPAC', 'Club for Growth', 'EMILY’s List', 'NRA', 'League of Conservation Voters', 'Fairshake', 'Senate Leadership Fund', 'Senate Majority PAC'];

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>PAC &amp; outside-money tracker</h2>
        <span class="count">${q ? `${data.results.length} committee${data.results.length === 1 ? '' : 's'} for “${esc(q)}”` : (state.meta.live ? 'FEC filings, fetched live' : 'Sample data')}</span>
      </div>
      <p style="max-width:70ch;margin-bottom:1rem">Search any PAC, super PAC, or party committee to see who they fund — and who they spend against. Organizational money reaches a candidate three ways: <strong>direct contributions</strong> (capped at $5,000 per election, so they're small); <strong>independent expenditures</strong> (unlimited super-PAC spending for or against a candidate, never touching the campaign's books); and <strong>bundled donations</strong> earmarked through the organization as a conduit — which is how groups like AIPAC move most of their money. All three come straight from FEC filings.</p>

      <form id="pac-form" class="browse-controls" role="search">
        <input id="pac-input" type="search" value="${esc(q)}" placeholder="Search committees — try AIPAC…" aria-label="Search PACs and committees" style="flex:2;min-width:220px" />
        <button type="submit" class="filter-btn">Search</button>
      </form>

      <div class="links-row" style="margin-bottom:1.5rem">
        ${QUICK.map((name) => `<button class="deep-link quick-pac" data-q="${esc(name)}">${esc(name)}</button>`).join('')}
      </div>

      ${(data.expansions || []).length ? noteBox(`Also searching affiliated committees: ${data.expansions.map((e) => `${e.term} — ${e.why}`).join(' ')}`) : ''}
      ${error ? noteBox(error) : ''}

      ${q && !error ? (data.results.length ? `<div class="money-list">${data.results.map((c) => `
        <a class="money-line" href="#/committee/${esc(c.id)}">
          <span class="money-name">${esc(c.name)}<small>${esc(c.typeLabel)}${c.party ? ` · ${esc(c.party)}` : ''}${c.state ? ` · ${esc(c.state)}` : ''}</small></span>
          <span class="tag">${esc(c.typeLabel)}</span>
        </a>`).join('')}</div>`
      : '<div class="empty">No committees match that name in FEC records. Try a shorter fragment of the name.</div>') : ''}

      ${!q ? '<div class="empty">Search a committee above, or tap a quick pick. Every result links to who they fund and who they oppose.</div>' : ''}

      <p class="attribution" style="padding-top:1rem">Looking for registered lobbying — who lobbies Congress on which bills? That's disclosed separately under the Lobbying Disclosure Act: see <a href="https://lda.senate.gov/system/public/" target="_blank" rel="noopener">lda.senate.gov</a> and <a href="https://www.opensecrets.org/federal-lobbying" target="_blank" rel="noopener">OpenSecrets lobbying</a>. This tracker covers campaign money: PACs, super PACs, and party committees.</p>
    </section>
  `;

  document.getElementById('pac-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('pac-input').value.trim();
    location.hash = val ? `#/pacs?q=${encodeURIComponent(val)}` : '#/pacs';
  });

  app.querySelectorAll('.quick-pac').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = `#/pacs?q=${encodeURIComponent(btn.dataset.q)}`;
    });
  });
}

/* ---------------- bills ---------------- */

const STAGE_STEPS = ['Introduced', 'Committee', 'One chamber', 'Both chambers', 'Law'];

/** Progress rail — where a bill has actually got to. */
const stageRail = (stage) => {
  const step = stage?.step ?? 1;
  return `
    <div class="stage-rail" role="img" aria-label="Status: ${esc(stage?.label || 'Introduced')}">
      ${STAGE_STEPS.map((label, i) => `
        <span class="stage-step ${i < step ? 'stage-step--done' : ''} ${i === step - 1 ? 'stage-step--now' : ''}">
          <span class="stage-dot"></span><small>${esc(label)}</small>
        </span>`).join('')}
    </div>`;
};

const billHref = (b) => `#/bill/${b.congress}/${b.type}/${b.number}`;

const billLine = (b) => `
  <a class="bill-line" href="${esc(billHref(b))}">
    <span class="bill-num">${esc(b.label)}</span>
    <span class="bill-main">
      <span class="bill-title">${esc(b.title)}</span>
      <span class="bill-meta">${esc(b.stage?.label || '')}${b.latestAction?.date ? ` · last action ${fmtDate(b.latestAction.date)}` : ''}${b.watchlisted ? ' · tracked' : ''}</span>
    </span>
    <span class="tag tag--stage-${esc(b.stage?.key || 'introduced')}">${esc(b.stage?.label || '')}</span>
  </a>`;

async function viewBills(params) {
  const q = (params.get('q') || '').trim();

  let data = { bills: [], sources: {} };
  let error = null;
  try {
    data = await api.bills(q);
  } catch (err) {
    error = err.message;
  }

  const down = data.sources && data.sources.congress === 'error';
  // Only worth saying on a live instance: in mock mode nothing is fetched, and
  // the red sample-data banner is already the louder warning.
  const demoKey = state.meta.live && state.meta.congressKey === 'DEMO_KEY';
  const QUICK = ['SAVE Act', 'HR 22', 'voting rights', 'redistricting', 'campaign finance'];

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Bills before Congress</h2>
        <span class="count">${q ? `${data.bills.length} match${data.bills.length === 1 ? '' : 'es'}` : (state.meta.live ? 'Congress.gov, fetched live' : 'Sample data')}</span>
      </div>
      <p style="max-width:70ch;margin-bottom:1rem">Elections aren't only decided at the ballot box — Congress writes the rules for how you register, how you vote, and how campaigns are funded. These are the election-related bills currently moving, straight from the official Congress.gov record, with the nonpartisan Congressional Research Service summary of what each one actually does. Search any bill by name, or by number: <strong>HR 22</strong>, <strong>S. 1</strong>.</p>

      <form id="bill-form" class="browse-controls" role="search">
        <input id="bill-input" type="search" value="${esc(q)}" placeholder="Search bills — try SAVE Act, or HR 22…" aria-label="Search bills" style="flex:2;min-width:220px" />
        <button type="submit" class="filter-btn">Search</button>
      </form>

      <div class="links-row" style="margin-bottom:1.5rem">
        ${QUICK.map((name) => `<button class="deep-link quick-bill" data-q="${esc(name)}">${esc(name)}</button>`).join('')}
      </div>

      ${error ? noteBox(error) : ''}
      ${down ? noteBox('Live legislative data (Congress.gov) is unreachable right now. This list will fill in automatically once the connection recovers.') : ''}
      ${demoKey ? noteBox('This instance is running on the shared Congress.gov demo key, which allows only 30 requests an hour across everyone using it — so the bill list and individual bill pages will intermittently come up short or empty. Setting CONGRESS_API_KEY (free, instant, from api.congress.gov/sign-up) fixes it.') : ''}

      ${data.bills.length ? `<div class="bill-list">${data.bills.map(billLine).join('')}</div>` : ''}

      ${!data.bills.length && !error && !down ? `<div class="empty">${q
        ? 'No bill matches that in the recent-activity window. If you know the bill number, search that instead — it resolves any bill directly.'
        : 'No election-related bills found in the current window of congressional activity.'}</div>` : ''}

      <p class="attribution" style="padding-top:1rem">${q
        ? `Searched the titles of the ${data.coverage != null ? `${data.coverage} ` : ''}most recently-updated bills of the ${data.congress}th Congress. Congress.gov has no keyword search, so a name search covers recent activity only — <strong>searching by bill number resolves any bill</strong>, however long it has been sitting.`
        : `Assembled from the most recently-updated bills of the ${data.congress}th Congress${data.coverage != null ? ` (${data.coverage} scanned)` : ''}, filtered to election-related legislation by title. Title matching is coarse: it catches bills that announce themselves as election bills, and misses election provisions tucked inside broadly-titled ones. It is a starting point, not a complete census.`}</p>
    </section>
  `;

  document.getElementById('bill-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('bill-input').value.trim();
    location.hash = val ? `#/bills?q=${encodeURIComponent(val)}` : '#/bills';
  });

  app.querySelectorAll('.quick-bill').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = `#/bills?q=${encodeURIComponent(btn.dataset.q)}`;
    });
  });
}

async function viewBill(congress, type, number) {
  const b = await api.bill(congress, type, number);
  const split = b.cosponsors?.partySplit;

  app.innerHTML = `
    ${backLink('#/bills', 'Back to bills')}

    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">${esc(b.label)} · ${esc(String(b.congress))}th Congress${b.policyArea ? ` · ${esc(b.policyArea)}` : ''}</p>
        <h1>${esc(b.title)}</h1>
      </div>
      <dl class="detail-meta">
        <div><dt>Status</dt><dd>${esc(b.stage?.label || '—')}</dd></div>
        ${b.introducedDate ? `<div><dt>Introduced</dt><dd>${fmtDate(b.introducedDate)}</dd></div>` : ''}
        ${b.sponsor ? `<div><dt>Sponsor</dt><dd>${esc(b.sponsor.name)}</dd></div>` : ''}
        <div><dt>Cosponsors</dt><dd>${b.cosponsors?.count ?? 0}${split ? ` <small>(${split.D}D · ${split.R}R${split.other ? ` · ${split.other} other` : ''})</small>` : ''}</dd></div>
      </dl>
      ${stageRail(b.stage)}
      ${b.laws?.length ? noteBox(`Enacted as ${b.laws.join(', ')}.`) : ''}
      ${b.latestAction ? `<p class="detail-desc"><strong>Latest action${b.latestAction.date ? ` (${fmtDate(b.latestAction.date)})` : ''}:</strong> ${esc(b.latestAction.text)}</p>` : ''}
    </article>

    ${billQaSection(b)}

    ${b.summary ? `
    <section class="section">
      <div class="section-head">
        <h2>What it does</h2>
        <span class="count">Congressional Research Service${b.summary.asOf ? ` · as of ${fmtDate(b.summary.asOf)}` : ''}</span>
      </div>
      <div class="bill-summary">${b.summary.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      <p class="attribution" style="padding-top:0.5rem">Summaries are written by the Congressional Research Service — nonpartisan staff at the Library of Congress — and describe the bill as introduced or as amended at the stage noted, which may not be its current text.</p>
    </section>` : `
    <section class="section">
      <div class="section-head"><h2>What it does</h2></div>
      <div class="empty">No Congressional Research Service summary has been published for this bill yet — that usually means it was introduced recently. The full text and action history are on congress.gov, linked below.</div>
    </section>`}

    ${(b.actions || []).length ? `
    <section class="section">
      <div class="section-head"><h2>What's happened so far</h2><span class="count">Most recent first</span></div>
      <div class="action-list">
        ${b.actions.map((a) => `
          <div class="action-line">
            <span class="action-date">${a.date ? fmtDate(a.date) : '—'}</span>
            <span class="action-text">${esc(a.text)}${a.chamber ? ` <small>${esc(a.chamber)}</small>` : ''}</span>
          </div>`).join('')}
      </div>
    </section>` : ''}

    ${(b.subjects || []).length ? `
    <section class="section">
      <div class="section-head"><h2>Subjects</h2></div>
      <div class="values-grid">
        ${b.subjects.map((s) => `<div class="value-item"><span class="oval"></span>${esc(s)}</div>`).join('')}
      </div>
    </section>` : ''}

    <section class="section">
      <div class="section-head"><h2>Go deeper</h2></div>
      <div class="links-row">
        <a class="deep-link" href="${safeHref(b.url)}" target="_blank" rel="noopener">Full record on Congress.gov ↗</a>
      </div>
    </section>

    <p class="provenance">Bill status, sponsor, actions and summary from Congress.gov (Library of Congress), fetched live. Status labels are derived from the latest action text — congress.gov is authoritative.</p>
  `;

  setupQa({
    storeKey: `pb-ai-bill-${b.congress}-${b.type}-${b.number}`,
    ask: (question, history) => api.askBill(b.congress, b.type, b.number, question, history),
    emptyMsg: 'No questions yet — ask what this bill would change, who supports it, or where it stands.',
  });
}

async function viewCommittee(id) {
  const c = await api.committee(id);
  const support = c.independent?.support || [];
  const oppose = c.independent?.oppose || [];
  const isSuper = c.type === 'O' || c.type === 'U';

  const candMoneyLine = (r) => moneyLine({
    href: r.candidateId ? `#/candidate/${r.candidateId}` : null,
    name: r.candidate || r.committee,
    amount: r.total,
    tag: r.support ? 'For' : 'Against',
  });

  app.innerHTML = `
    ${backLink('#/pacs', 'Back to PAC tracker')}

    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">${esc(c.typeLabel)}${c.party ? ` · ${esc(c.party)}` : ''}${c.state ? ` · ${esc(c.state)}` : ''}</p>
        <h1>${esc(c.name)}</h1>
      </div>
      ${c.totals ? `
      <dl class="detail-meta">
        <div><dt>Raised (${c.totals.cycle})</dt><dd>${fmtMoney(c.totals.receipts)}</dd></div>
        <div><dt>Spent</dt><dd>${fmtMoney(c.totals.disbursements)}</dd></div>
        ${c.totals.independentExpenditures ? `<div><dt>Independent expenditures</dt><dd>${fmtMoney(c.totals.independentExpenditures)}</dd></div>` : ''}
        ${c.totals.contributionsToCandidates ? `<div><dt>Given to candidates</dt><dd>${fmtMoney(c.totals.contributionsToCandidates)}</dd></div>` : ''}
      </dl>` : ''}
      ${isSuper ? '<p class="detail-desc">Super PACs may raise unlimited sums but cannot give to campaigns — they spend independently for or against candidates.</p>' : ''}
    </article>

    ${support.length || oppose.length ? `
    <section class="section">
      <div class="section-head">
        <h2>Spending for &amp; against candidates</h2>
        <span class="count">${support.length + oppose.length} candidate${support.length + oppose.length === 1 ? '' : 's'} · ${c.cycle} cycle</span>
      </div>
      <div class="money-list">
        ${support.map(candMoneyLine).join('')}
        ${oppose.map(candMoneyLine).join('')}
      </div>
    </section>` : ''}

    ${(c.topRecipients || []).length ? `
    <section class="section">
      <div class="section-head"><h2>Top recipients of direct contributions</h2><span class="count">${c.cycle} cycle</span></div>
      <div class="money-list">
        ${c.topRecipients.map((r) => moneyLine({
          href: null,
          name: r.name,
          meta: r.count > 1 ? `${r.count} contributions` : '',
          amount: r.total,
        })).join('')}
      </div>
    </section>` : ''}

    ${!(support.length || oppose.length || (c.topRecipients || []).length)
      ? '<div class="empty">No candidate spending found for this committee in the current cycle — it may be inactive, or its money may move through other committees. Check the full FEC profile below.</div>' : ''}

    ${(c.links || []).length ? `
    <section class="section">
      <div class="section-head"><h2>Go deeper</h2></div>
      <div class="links-row">
        ${c.links.map((l) => `<a class="deep-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}
      </div>
    </section>` : ''}

    ${c.provenance ? `<p class="provenance">${esc(c.provenance)}</p>` : ''}
  `;
}

/* ---------------- router ---------------- */

const routes = [
  { match: /^#\/home/, view: () => viewHome(), route: 'home' },
  { match: /^#\/browse/, view: (h) => viewBrowse(new URLSearchParams(h.split('?')[1] || '')), route: 'browse' },
  { match: /^#\/election\/([\w-]+)/, view: (h, m) => viewElection(m[1]), route: 'home' },
  { match: /^#\/candidate\/([\w-]+)/, view: (h, m) => viewCandidate(m[1]), route: 'home' },
  { match: /^#\/data/, view: () => viewData(), route: 'data' },
  { match: /^#\/search/, view: (h) => viewSearch(new URLSearchParams(h.split('?')[1] || '')), route: 'search' },
  { match: /^#\/pacs/, view: (h) => viewPacs(new URLSearchParams(h.split('?')[1] || '')), route: 'pacs' },
  { match: /^#\/committee\/([\w-]+)/, view: (h, m) => viewCommittee(m[1]), route: 'pacs' },
  { match: /^#\/bill\/(\d+)\/([a-z]+)\/(\d+)/, view: (h, m) => viewBill(m[1], m[2], m[3]), route: 'bills' },
  { match: /^#\/bills/, view: (h) => viewBills(new URLSearchParams(h.split('?')[1] || '')), route: 'bills' },
];

/** Loud, permanent warning whenever the server isn't serving real data. */
function renderModeBanner() {
  const existing = document.getElementById('mode-banner');
  if (state.meta.live) return existing?.remove();
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'mode-banner';
  el.className = 'mode-banner';
  el.innerHTML = `<strong>Sample data — not real filings.</strong> This server is running with
    <code>DATA_PROVIDER=${esc(state.meta.provider)}</code>, so every candidate, dollar figure, and PAC on
    this page is fictional. Set <code>DATA_PROVIDER=live</code> (or remove the variable) to pull live FEC data.`;
  document.querySelector('.rulebar').insertAdjacentElement('afterend', el);
}

async function render() {
  const hash = location.hash || '#/home';
  const found = routes.find((r) => r.match.test(hash)) || routes[0];
  const m = hash.match(found.match);

  nav.querySelectorAll('a').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === found.route));

  app.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await found.view(hash, m);
    window.scrollTo({ top: 0 });
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="empty">Couldn’t load this page${err.message ? ` — ${esc(err.message)}` : ''}. Check that the server is running, then reload.</div>`;
  }
}

/* ---------------- boot ---------------- */

async function init() {
  const [areas, meta] = await Promise.all([
    api.areas().catch(() => []),
    api.meta().catch(() => ({ provider: 'live', live: true })),
  ]);
  state.areas = areas;
  state.meta = meta;
  renderModeBanner();

  if (!state.areas.some((a) => a.code === state.area) && state.areas.length) {
    state.area = state.areas[0].code;
  }

  areaSelect.innerHTML = state.areas
    .map((a) => `<option value="${esc(a.code)}" ${a.code === state.area ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  areaSelect.addEventListener('change', () => {
    setArea(areaSelect.value);
    if ((location.hash || '#/home').startsWith('#/home')) render();
    else location.hash = '#/home';
  });

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
  });

  window.addEventListener('hashchange', render);
  render();
}

init();

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
  // Signed out, this stays exactly what it has always been: a localStorage
  // Set. Signed in, it mirrors the server and every change is written
  // through. Nothing about anonymous browsing changes.
  tracked: new Set(JSON.parse(localStorage.getItem('pb-tracked') || '[]')),
  meta: { provider: 'live', live: true },
  // null until /api/me answers. `false` means signed out; an object means
  // signed in. Three states, because "not asked yet" and "asked, nobody
  // there" must not render the same.
  account: null,
  providers: { accountsEnabled: false, email: false, google: false, apple: false },
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
    return api.send('POST', path, body);
  },

  /**
   * Any state-changing call.
   *
   * Carries the CSRF token the server set as a readable cookie. That is the
   * double-submit half of the protection: an attacker on another origin can
   * neither read our cookies nor set our headers, so matching the two proves
   * the request came from our own page.
   */
  async send(method, path, body) {
    const csrf = document.cookie.match(/(?:^|;\s*)pb_csrf=([^;]*)/);
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrf ? { 'x-pollbook-csrf': decodeURIComponent(csrf[1]) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `API ${res.status}`;
      let payload = null;
      try { payload = await res.json(); msg = payload.error || msg; } catch { /* keep default */ }
      const err = new Error(msg);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return res.status === 204 ? null : res.json();
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

  /* ---- accounts ---- */

  authProviders: () => api.get('/auth/providers'),
  // Answers 200 with `signedIn: false` when nobody is signed in — the
  // ordinary case on this site — so a 401 does not appear in the console on
  // every anonymous page load.
  me: () => fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.signedIn ? d : null))
    .catch(() => null),
  requestSignIn: (email, redirectTo) => api.post('/auth/email', { email, redirectTo }),
  signOut: () => api.post('/auth/logout'),
  signOutEverywhere: () => api.post('/auth/logout-all'),

  updateProfile: (patch) => api.send('PATCH', '/me/profile', patch),
  updatePreferences: (patch) => api.send('PUT', '/me/preferences', patch),
  subscriptions: () => api.get('/me/subscriptions'),
  subscribe: (key, label) => api.post('/me/subscriptions', { key, label }),
  unsubscribe: (key) => api.send('DELETE', `/me/subscriptions/${encodeURIComponent(key)}`),
  importSubscriptions: (items) => api.post('/me/subscriptions/import', { items }),
  issues: () => api.get('/me/issues'),
  setIssues: (issues) => api.send('PUT', '/me/issues', { issues }),
  smsConsentText: () => api.get('/me/sms/consent-text'),
  addPhone: (phone, consent) => api.post('/me/phone', { phone, consent }),
  confirmPhone: (phone, code) => api.post('/me/phone/confirm', { phone, code }),
  deleteAccount: () => api.post('/me/delete', { confirm: 'delete' }),

  transparency: () => api.get('/transparency'),
  sentMessages: () => api.get('/transparency/broadcasts'),
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

  return `
    <svg class="mf-svg" viewBox="0 0 ${W} ${height}" role="img" aria-label="Diagram of this campaign's funding. The same figures are in the table that follows." preserveAspectRatio="xMidYMin meet">
      <defs>
        <pattern id="pb-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#FDFDFB" fill-opacity="0.25" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#15181B" stroke-width="2.5" />
        </pattern>
      </defs>
      ${parts.join('')}
    </svg>`;
}

/**
 * The same numbers as a table, visually hidden.
 *
 * A long aria-label is a poor substitute for a chart: it's read as one
 * unstoppable sentence with no way to navigate between figures or re-hear a
 * single one. A table gives real structure — and the distinction the diagram
 * is built to make, money *into* the campaign versus money spent *about* the
 * candidate, survives as two labelled sections rather than a clause a listener
 * has to hold in their head.
 */
function moneyFlowTable(mf) {
  const row = (label, amount, note) =>
    `<tr><th scope="row">${esc(label)}</th><td>${fmtMoney(amount)}</td><td>${esc(note || '')}</td></tr>`;

  const conduits = mf.campaign.conduits;

  return `
    <table class="visually-hidden mf-table">
      <caption>Campaign funding${mf.coverageEnd ? `, from FEC filings through ${fmtDate(mf.coverageEnd)}` : ''}</caption>
      <thead><tr><th scope="col">Source</th><th scope="col">Amount</th><th scope="col">Notes</th></tr></thead>
      <tbody>
        <tr><th scope="row" colspan="3">Money into the campaign — total ${fmtMoney(mf.campaign.raised)}</th></tr>
        ${mf.campaign.inflows.map((f) =>
    row(f.label, f.amount, `${flowPct(f.share)} of money raised${f.note ? `. ${f.note}` : ''}`)).join('')}
        ${conduits ? row(
    'Bundled through a conduit', conduits.total,
    'Included in the individual-donor figures above, not additional to them'
  ) : ''}
        ${mf.outside ? `
          <tr><th scope="row" colspan="3">Spent about this candidate, never touching the campaign — total ${fmtMoney(mf.outside.total)}</th></tr>
          ${mf.outside.support.total ? row('Outside spending supporting them', mf.outside.support.total, 'Independent expenditure') : ''}
          ${mf.outside.oppose.total ? row('Outside spending opposing them', mf.outside.oppose.total, 'Independent expenditure') : ''}` : ''}
        ${mf.campaign.spent ? row('Spent by the campaign', mf.campaign.spent, '') : ''}
        ${mf.campaign.cashOnHand ? row('Cash on hand', mf.campaign.cashOnHand, '') : ''}
      </tbody>
    </table>`;
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
      ${moneyFlowTable(mf)}
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

/* ---------------- race money comparison ---------------- */

/**
 * The money in a race, candidate by candidate, on one shared scale.
 *
 * A single candidate's diagram answers "where does their money come from".
 * This answers the question people actually arrive with — "who is being
 * carried by outside money, and is anyone being buried by it" — which is
 * only visible side by side. Everything is measured against the largest
 * single figure in the race, so the bars are comparable across candidates
 * rather than each being normalized to itself.
 *
 * Loaded on demand: a full profile per candidate is several FEC calls, and
 * most visitors to a race page never ask this.
 */
const CMP_KINDS = [
  ['raised', 'Raised by the campaign', 'cmp-bar--raised'],
  ['support', 'Outside spending for them', 'cmp-bar--for'],
  ['oppose', 'Outside spending against them', 'cmp-bar--against'],
];

function raceCompareHtml(rows) {
  const usable = rows.filter((r) => r.flow);
  if (usable.length < 2) {
    return `<div class="empty">Not enough of this race's candidates have filed financial reports yet to compare them.</div>`;
  }

  const valueOf = (flow, kind) => (kind === 'raised'
    ? flow.campaign.raised
    : (flow.outside ? flow.outside[kind].total : 0)) || 0;

  const scale = Math.max(1, ...usable.flatMap((r) => CMP_KINDS.map(([k]) => valueOf(r.flow, k))));

  return `
    <div class="cmp-grid">
      ${usable.map((r) => `
        <div class="cmp-cand">
          <div class="cmp-head">
            <a href="#/candidate/${esc(r.id)}">${esc(r.name)}</a>
            <span class="party party--${esc(r.party)}">${esc(PARTY_NAMES[r.party] || r.party)}</span>
          </div>
          ${CMP_KINDS.map(([kind, label, cls]) => {
    const v = valueOf(r.flow, kind);
    return `
              <div class="cmp-row">
                <span class="cmp-label">${esc(label)}</span>
                <span class="cmp-track"><span class="cmp-bar ${cls}" style="width:${(v / scale) * 100}%"></span></span>
                <span class="cmp-amt">${v ? fmtMoney(v) : '—'}</span>
              </div>`;
  }).join('')}
        </div>`).join('')}
    </div>
    <p class="attribution" style="padding-top:0.75rem">All bars share one scale, so lengths are comparable between candidates. Outside spending never passes through a campaign's accounts — a candidate can be the target of the largest number here without controlling any of it. FEC filings, fetched live; candidates who have not filed are omitted.</p>`;
}

/** Load full profiles for a race's candidates and render the comparison. */
async function loadRaceCompare(race, host) {
  host.innerHTML = '<div class="empty">Loading the money in this race…</div>';
  // Capped: each profile is several upstream calls, and beyond a handful the
  // comparison stops being readable anyway.
  const subjects = race.candidates.slice(0, 4);

  const rows = await Promise.all(subjects.map(async (c) => {
    try {
      const full = await api.candidate(c.id);
      return { id: c.id, name: c.name, party: c.party, flow: full.moneyFlow };
    } catch {
      // One unreachable profile shouldn't collapse the whole comparison.
      return { id: c.id, name: c.name, party: c.party, flow: null };
    }
  }));

  host.innerHTML = raceCompareHtml(rows);
}

const raceBlock = (r) => `
  <div class="race-block">
    <div class="race-office">${esc(r.office)}</div>
    ${r.candidates.length
      ? r.candidates.map(candLine).join('')
      : `<div class="race-empty">${esc(r.note || 'No candidate filings loaded for this race yet.')}</div>`}
    ${r.candidates.length >= 2 ? `
      <div class="race-compare">
        <button type="button" class="deep-link race-compare-btn" data-race="${esc(r.id)}">Compare the money in this race</button>
        <div class="race-compare-out" data-race-out="${esc(r.id)}"></div>
      </div>` : ''}
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
    <div id="track-prompt"></div>

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

  app.querySelectorAll('.race-compare-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const race = (e.races || []).find((r) => r.id === btn.dataset.race);
      const host = app.querySelector(`[data-race-out="${CSS.escape(btn.dataset.race)}"]`);
      if (!race || !host) return;
      btn.disabled = true;
      btn.remove();
      loadRaceCompare(race, host);
    });
  });

  /*
   * Tracking, signed out and signed in.
   *
   * Signed out this is exactly what it always was — a note to yourself in
   * localStorage — and the invitation to sign in appears only after you use
   * it, because that is the moment it means something. Signed in, the same
   * button writes through to the server and becomes an actual reminder.
   *
   * The optimistic update stays: a toggle that waits on a round trip feels
   * broken, and the worst case is a button that flips back.
   */
  document.getElementById('track-btn').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const wasTracked = state.tracked.has(e.id);
    const key = `election:${e.id}`;

    if (wasTracked) state.tracked.delete(e.id);
    else state.tracked.add(e.id);
    btn.dataset.tracked = String(!wasTracked);
    btn.innerHTML = `<span class="track-oval"></span>${
      wasTracked ? 'Track this election' : 'Tracking this election'}`;
    saveTracked();

    if (signedIn()) {
      try {
        if (wasTracked) await api.unsubscribe(key);
        else await api.subscribe(key, e.name);
      } catch (err) {
        // Put it back rather than leaving the button lying about the server.
        if (wasTracked) state.tracked.add(e.id);
        else state.tracked.delete(e.id);
        saveTracked();
        btn.dataset.tracked = String(wasTracked);
        btn.innerHTML = `<span class="track-oval"></span>${
          wasTracked ? 'Tracking this election' : 'Track this election'}`;
        document.getElementById('track-prompt').innerHTML = noteBox(err.message);
        return;
      }
    }
    renderTrackPrompt(e, !wasTracked);
  });

  renderTrackPrompt(e, tracked);
}

/**
 * What to say under the track button.
 *
 * Signed out and tracking something, this is the one place an account is
 * worth mentioning — the toggle currently does nothing, and saying so plainly
 * is more honest than a banner nobody asked for.
 */
function renderTrackPrompt(election, isTracked) {
  const host = document.getElementById('track-prompt');
  if (!host) return;

  if (!isTracked || !state.providers.accountsEnabled) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = signedIn()
    ? `<p class="attribution">We will remind you to check your registration and to vote for this
       election. <a href="#/account">Change what you get</a>.</p>`
    : `<p class="attribution">Saved in this browser only — this does not remind you of anything
       yet. <a href="#/signin?redirect_to=${encodeURIComponent(`#/election/${election.id}`)}">Sign in
       and we will</a>, with a link to your email. No password.</p>`;
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
      <span class="bill-meta">${esc(b.stage?.label || '')}${b.latestAction?.date ? ` · last action ${fmtDate(b.latestAction.date)}` : ''}${b.watchlisted ? ' · tracked' : ''}${b.matchedOn === 'summary' ? ' · matched on its summary, not its title' : ''}</span>
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
        ? `Searched the titles and published summaries of the ${data.coverage != null ? `${data.coverage} ` : ''}most recently-active bills of the ${data.congress}th Congress. Congress.gov has no keyword search, so a name search covers recent activity only — <strong>searching by bill number resolves any bill</strong>, however long it has been sitting.`
        : `Assembled from the ${data.congress}th Congress's recent activity${data.coverage != null ? ` (${data.coverage} bills scanned)` : ''} two ways: bills whose <em>title</em> names an election subject, and bills whose Congressional Research Service <em>summary</em> does — which is how a provision buried in a broadly-titled bill shows up at all. Summary matches are labelled, because the phrase can be incidental to a bill that is mostly about something else. A bill has no summary until CRS writes one, so this is still a starting point rather than a complete census.`}</p>
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

/* ---------------- accounts ----------------

   Everything below is additive. Signed out, every page on this site behaves
   exactly as it did before any of it existed — an account turns "track this
   election" from a note to yourself into an actual reminder, and nothing
   more.                                                                     */

const signedIn = () => Boolean(state.account && state.account.user);

/** Refresh the cached session. Safe to call any time; never throws. */
async function loadAccount() {
  const me = await api.me();
  state.account = me || false;
  return me;
}

/**
 * Move anonymous tracking into the account, once.
 *
 * Somebody who has been following six races in this browser should not have
 * to add them again because they signed up for the alerts. Runs on the first
 * sign-in only; the flag is per-browser because that is where the old data
 * lives.
 */
async function migrateLocalTracking() {
  const local = JSON.parse(localStorage.getItem('pb-tracked') || '[]');
  if (!local.length || localStorage.getItem('pb-tracked-migrated')) return;
  try {
    await api.importSubscriptions(local.map((id) => ({ key: id })));
    localStorage.setItem('pb-tracked-migrated', '1');
  } catch { /* it will be offered again next time; not worth interrupting a sign-in */ }
}

/** Pull the server's list into `state.tracked` so every page renders from one source. */
async function syncTracked() {
  if (!signedIn()) return;
  try {
    const { subscriptions } = await api.subscriptions();
    state.tracked = new Set(subscriptions.map((s) => s.key.slice(s.key.indexOf(':') + 1)));
  } catch { /* keep whatever we had */ }
}

/* ---------------- sign in ---------------- */

async function viewSignIn(params) {
  const redirectTo = params.get('redirect_to') || '#/account';
  const error = params.get('error');
  const { providers } = state;

  if (!providers.accountsEnabled) {
    app.innerHTML = `
      ${backLink('#/home', 'Back to your ballot')}
      <div class="empty">Accounts are not switched on for this server. Everything else on
      Pollbook works without one.</div>`;
    return;
  }

  if (signedIn()) {
    location.hash = '#/account';
    return;
  }

  app.innerHTML = `
    ${backLink('#/home', 'Back to your ballot')}
    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">Pollbook account</p>
        <h1>Get reminded about the elections you follow</h1>
      </div>
      <p class="detail-desc">Track a race and we will remind you to check your registration and
      to vote, for that election, in your state. Nothing else.</p>
    </article>

    ${error ? noteBox(`That sign-in did not complete (${esc(error)}). Try again.`) : ''}

    <section class="section" style="margin-top:2rem">
      <div class="section-head"><h2>Sign in</h2></div>

      <form id="signin-form" class="account-form">
        <label for="signin-email">Email address</label>
        <input id="signin-email" type="email" name="email" autocomplete="email" required
               placeholder="you@example.com" />
        <button type="submit" class="track-btn" style="margin-top:0.75rem">
          <span class="track-oval"></span>Email me a sign-in link
        </button>
        <p class="attribution">No password. We send a link that works once and expires in
        fifteen minutes.</p>
      </form>

      <div id="signin-result"></div>

      ${providers.google || providers.apple ? `
        <div class="section-sub"><h3>Or continue with</h3></div>
        <div class="account-oauth">
          ${providers.google ? `<a class="track-btn" href="/api/auth/google/start?redirect_to=${encodeURIComponent(redirectTo)}"><span class="track-oval"></span>Google</a>` : ''}
          ${providers.apple ? `<a class="track-btn" href="/api/auth/apple/start?redirect_to=${encodeURIComponent(redirectTo)}"><span class="track-oval"></span>Apple</a>` : ''}
        </div>` : ''}

      <p class="attribution" style="padding-top:1.25rem">
        Pollbook is nonpartisan. We do not ask your party, we have nowhere to store it, and we
        will never tell you how to vote. <a href="#/privacy">What we collect, and what we refuse to.</a>
      </p>
    </section>`;

  document.getElementById('signin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = document.getElementById('signin-result');
    const email = document.getElementById('signin-email').value.trim();
    out.innerHTML = '<div class="empty">Sending…</div>';
    try {
      const result = await api.requestSignIn(email, redirectTo.replace(/^#/, '/#'));
      // Deliberately the same message whether or not the address has an
      // account — the server answers identically, and so should we.
      out.innerHTML = noteBox(result.message);
    } catch (err) {
      out.innerHTML = noteBox(err.message);
    }
  });
}

/* ---------------- account ---------------- */

async function viewAccount() {
  if (!state.providers.accountsEnabled) {
    app.innerHTML = `${backLink('#/home', 'Back')}
      <div class="empty">Accounts are not switched on for this server.</div>`;
    return;
  }

  await loadAccount();
  if (!signedIn()) {
    location.hash = '#/signin';
    return;
  }

  const { user, preferences: prefs, subscriptions, issues, messaging } = state.account;

  app.innerHTML = `
    ${backLink('#/home', 'Back to your ballot')}

    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">Signed in as ${esc(user.email)}</p>
        <h1>Your alerts</h1>
      </div>
      <dl class="detail-meta">
        <div><dt>State</dt><dd>${esc(areaName(user.state) || 'Not set')}</dd></div>
        <div><dt>Following</dt><dd>${subscriptions.length} election${subscriptions.length === 1 ? '' : 's'}</dd></div>
        <div><dt>Issues</dt><dd>${issues.length}</dd></div>
      </dl>
    </article>

    <section class="section" style="margin-top:2rem">
      <div class="section-head"><h2>Elections you follow</h2></div>
      <div id="account-subs">${subscriptionList(subscriptions)}</div>
      <p class="attribution">Track an election from its page. We will remind you about
      registration and about election day — in your time zone, never at night.</p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Issues you want to hear about</h2></div>
      <p style="max-width:70ch;margin-bottom:1rem">These are subject areas, not positions. We
      use them to decide which bills and races to tell you about — never to guess what you think
      about them.</p>
      <div id="account-issues"><div class="empty">Loading…</div></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>What we send, and when</h2></div>
      <form id="prefs-form" class="account-form">
        ${checkbox('deadlines', 'Registration and voting deadlines', prefs.cat_deadlines,
    'The reason to have an account. Sent for every election you follow.')}
        ${checkbox('odds', 'Prediction-market movement', prefs.cat_odds,
      'Market prices for races you follow. These are what traders pay, not forecasts.')}
        ${checkbox('news', 'News coverage', prefs.cat_news, 'Coverage of candidates in races you follow.')}
        ${checkbox('filings', 'New candidates and filings', prefs.cat_filings, 'When someone new files in a race you follow.')}
        <label for="digest-mode" style="margin-top:1rem">How often</label>
        <select id="digest-mode" name="digestMode">
          ${['immediate', 'daily', 'weekly'].map((m) =>
    `<option value="${m}" ${prefs.digest_mode === m ? 'selected' : ''}>${
      { immediate: 'As things happen', daily: 'A daily summary', weekly: 'A weekly summary' }[m]}</option>`).join('')}
        </select>
        <p class="attribution">Deadline reminders always arrive on time regardless of this setting —
        holding "the election is tomorrow" for a weekly digest would defeat the point.</p>
        <button type="submit" class="track-btn" style="margin-top:0.75rem">
          <span class="track-oval"></span>Save
        </button>
        <span id="prefs-saved" class="account-saved"></span>
      </form>
    </section>

    <section class="section">
      <div class="section-head"><h2>Where you vote</h2></div>
      <form id="profile-form" class="account-form">
        <label for="profile-state">State</label>
        <select id="profile-state" name="state">
          <option value="">Not set</option>
          ${state.areas.map((a) =>
    `<option value="${esc(a.code)}" ${a.code === user.state ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
        <label for="profile-zip" style="margin-top:0.75rem">ZIP code <span class="account-optional">optional</span></label>
        <input id="profile-zip" name="zip5" inputmode="numeric" maxlength="5" pattern="[0-9]{5}"
               value="${esc(user.zip5 || '')}" placeholder="30303" />
        <p class="attribution">Five digits only. We do not take ZIP+4, which identifies a
        household, and we never ask for a street address.</p>
        <button type="submit" class="track-btn" style="margin-top:0.75rem">
          <span class="track-oval"></span>Save
        </button>
        <span id="profile-saved" class="account-saved"></span>
      </form>
    </section>

    ${messaging && messaging.smsAvailable ? `
    <section class="section">
      <div class="section-head"><h2>Text alerts</h2></div>
      <div id="sms-panel"><div class="empty">Loading…</div></div>
    </section>` : ''}

    <section class="section">
      <div class="section-head"><h2>Your data</h2></div>
      <p style="max-width:70ch;margin-bottom:1rem">You can take everything we hold, or remove
      it. <a href="#/privacy">Here is the full list of what that is</a>, including what we
      deliberately never collect.</p>
      <div class="account-actions">
        <a class="track-btn" href="/api/me/export"><span class="track-oval"></span>Download my data</a>
        <button class="track-btn" id="signout-btn"><span class="track-oval"></span>Sign out</button>
        <button class="track-btn" id="signout-all-btn"><span class="track-oval"></span>Sign out everywhere</button>
      </div>
      <div id="delete-panel" style="margin-top:1.5rem">
        <button class="account-danger" id="delete-btn">Delete my account</button>
      </div>
    </section>`;

  wireAccount();
  void loadIssuesPanel();
  if (messaging && messaging.smsAvailable) void loadSmsPanel();
}

const checkbox = (name, label, checked, note) => `
  <label class="account-check">
    <input type="checkbox" name="${name}" ${checked ? 'checked' : ''} />
    <span><strong>${esc(label)}</strong>${note ? `<br /><span class="account-note">${esc(note)}</span>` : ''}</span>
  </label>`;

function subscriptionList(subscriptions) {
  if (!subscriptions.length) {
    return '<div class="empty">You are not following anything yet. Open an election and choose “Track this election”.</div>';
  }
  // Matches ballotLine's structure so the list reads identically to every
  // other list on the site, with the "stop" control as a fourth column in
  // place of the date.
  return `<div class="ballot-list">${subscriptions.map((s) => {
    const id = s.key.slice(s.key.indexOf(':') + 1);
    const concluded = s.status === 'retired';
    return `<div class="ballot-line">
      <a class="sub-link" href="#/election/${esc(id)}">
        <span class="line-oval oval--filled" aria-hidden="true"></span>
        <span class="line-main">
          <span class="line-name">${esc(s.label)}</span>
          <span class="line-place">${concluded
    ? 'Held — no more reminders for this one'
    : `Following since ${fmtDate(String(s.created_at).slice(0, 10))}`}</span>
        </span>
      </a>
      <button class="account-remove" data-unsub="${esc(s.key)}"
              aria-label="Stop following ${esc(s.label)}">Stop</button>
    </div>`;
  }).join('')}</div>`;
}

async function loadIssuesPanel() {
  const host = document.getElementById('account-issues');
  if (!host) return;
  try {
    const { available, selected } = await api.issues();
    const chosen = new Set(selected);
    host.innerHTML = `
      <div class="issue-grid">
        ${available.map((i) => `
          <label class="account-check">
            <input type="checkbox" data-issue="${esc(i.slug)}" ${chosen.has(i.slug) ? 'checked' : ''} />
            <span><strong>${esc(i.name)}</strong><br />
            <span class="account-note">${esc(i.description)}</span></span>
          </label>`).join('')}
      </div>
      <button class="track-btn" id="issues-save" style="margin-top:1rem">
        <span class="track-oval"></span>Save issues
      </button>
      <span id="issues-saved" class="account-saved"></span>`;

    document.getElementById('issues-save').addEventListener('click', async () => {
      const picked = [...host.querySelectorAll('[data-issue]')]
        .filter((el) => el.checked).map((el) => el.dataset.issue);
      const note = document.getElementById('issues-saved');
      try {
        await api.setIssues(picked);
        note.textContent = 'Saved';
      } catch (err) {
        note.textContent = err.message;
      }
      setTimeout(() => { note.textContent = ''; }, 3000);
    });
  } catch (err) {
    host.innerHTML = `<div class="empty">Could not load the issue list — ${esc(err.message)}</div>`;
  }
}

/**
 * The SMS panel.
 *
 * The consent wording comes from the server rather than being written here,
 * so the words on the screen are provably the words stored in the consent
 * record. A checkbox that says something slightly different from the evidence
 * is worse than no checkbox.
 */
async function loadSmsPanel() {
  const host = document.getElementById('sms-panel');
  if (!host) return;
  try {
    const consent = await api.smsConsentText();
    host.innerHTML = `
      <form id="sms-form" class="account-form">
        <label for="sms-phone">Mobile number</label>
        <input id="sms-phone" name="phone" type="tel" autocomplete="tel" placeholder="(404) 555-0142" />
        <label class="account-check" style="margin-top:1rem">
          <input type="checkbox" id="sms-consent" />
          <span>${esc(consent.text)}</span>
        </label>
        ${consent.supporting ? `<p class="account-note">${esc(consent.supporting)}</p>` : ''}
        <p class="attribution">
          <a href="#/privacy">Privacy notice</a> · This box is separate from your email
          preferences on purpose, and starts unticked. Agreeing is never a condition of using
          Pollbook.
        </p>
        <button type="submit" class="track-btn" style="margin-top:0.75rem">
          <span class="track-oval"></span>Send me a confirmation text
        </button>
      </form>
      <div id="sms-result"></div>`;

    document.getElementById('sms-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = document.getElementById('sms-result');
      try {
        await api.addPhone(
          document.getElementById('sms-phone').value,
          document.getElementById('sms-consent').checked
        );
        out.innerHTML = `
          ${noteBox('Check your phone and enter the six-digit code to finish.')}
          <form id="sms-confirm" class="account-form">
            <label for="sms-code">Confirmation code</label>
            <input id="sms-code" inputmode="numeric" maxlength="6" />
            <button type="submit" class="track-btn" style="margin-top:0.75rem">
              <span class="track-oval"></span>Confirm
            </button>
          </form>`;
        document.getElementById('sms-confirm').addEventListener('submit', async (e2) => {
          e2.preventDefault();
          try {
            await api.confirmPhone(
              document.getElementById('sms-phone').value,
              document.getElementById('sms-code').value
            );
            out.innerHTML = noteBox('Text alerts are on. Reply STOP to any message to turn them off.');
          } catch (err) {
            out.innerHTML = noteBox(err.message);
          }
        });
      } catch (err) {
        out.innerHTML = noteBox(err.message);
      }
    });
  } catch (err) {
    host.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function wireAccount() {
  app.querySelectorAll('[data-unsub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.unsubscribe(btn.dataset.unsub);
        await loadAccount();
        await syncTracked();
        document.getElementById('account-subs').innerHTML =
          subscriptionList(state.account.subscriptions);
        wireAccount();
      } catch {
        btn.disabled = false;
      }
    });
  });

  const prefsForm = document.getElementById('prefs-form');
  if (prefsForm) {
    prefsForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const note = document.getElementById('prefs-saved');
      const data = new FormData(prefsForm);
      try {
        await api.updatePreferences({
          deadlines: data.has('deadlines'),
          odds: data.has('odds'),
          news: data.has('news'),
          filings: data.has('filings'),
          digestMode: data.get('digestMode'),
        });
        note.textContent = 'Saved';
      } catch (err) {
        note.textContent = err.message;
      }
      setTimeout(() => { note.textContent = ''; }, 3000);
    });
  }

  const profileForm = document.getElementById('profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const note = document.getElementById('profile-saved');
      const data = new FormData(profileForm);
      try {
        await api.updateProfile({
          state: data.get('state') || null,
          zip5: data.get('zip5') || null,
          // Captured from the browser rather than guessed from an IP or a
          // state — a state can span two zones and quiet hours has to be
          // right for the person, not the average.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        note.textContent = 'Saved';
      } catch (err) {
        note.textContent = err.message;
      }
      setTimeout(() => { note.textContent = ''; }, 3000);
    });
  }

  document.getElementById('signout-btn')?.addEventListener('click', async () => {
    await api.signOut().catch(() => {});
    state.account = false;
    location.hash = '#/home';
    renderAccountNav();
  });

  document.getElementById('signout-all-btn')?.addEventListener('click', async () => {
    await api.signOutEverywhere().catch(() => {});
    state.account = false;
    location.hash = '#/home';
    renderAccountNav();
  });

  document.getElementById('delete-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('delete-panel');
    panel.innerHTML = `
      ${noteBox('This removes your account, your subscriptions and your preferences. Your address stays on our do-not-contact list so we can never mail you again — that part is deliberate, and it is not reversible by signing up again.')}
      <button class="account-danger" id="delete-confirm">Yes, delete my account</button>
      <button class="track-btn" id="delete-cancel"><span class="track-oval"></span>Keep it</button>`;

    document.getElementById('delete-cancel').addEventListener('click', () => viewAccount());
    document.getElementById('delete-confirm').addEventListener('click', async () => {
      try {
        await api.deleteAccount();
        state.account = false;
        localStorage.removeItem('pb-tracked-migrated');
        app.innerHTML = `<div class="empty">Your account has been deleted. Everything on
          Pollbook still works without one.</div>`;
        renderAccountNav();
      } catch (err) {
        panel.innerHTML = noteBox(err.message);
      }
    });
  });
}

/* ---------------- policy pages ---------------- */

async function viewAbout() {
  const t = await api.transparency();
  app.innerHTML = `
    ${backLink('#/home', 'Back to your ballot')}
    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">How this works</p>
        <h1>How Pollbook stays nonpartisan</h1>
      </div>
      <p class="detail-desc">Not a promise — a set of rules enforced in code, and a public
      record you can check them against.</p>
    </article>

    <section class="section" style="margin-top:2rem">
      <div class="section-head"><h2>The rules</h2></div>
      <ul class="policy-list">${t.principles.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    </section>

    <section class="section">
      <div class="section-head"><h2>How a message can be targeted</h2></div>
      <p style="max-width:70ch">A message can only be aimed at people by what they chose to
      follow, which issues they asked about, what state they are in, and which channel they
      use:</p>
      <ul class="policy-list">${t.audienceDimensions.map((d) => `<li><code>${esc(d)}</code></li>`).join('')}</ul>
      <p class="attribution">${esc(t.audienceNote)}</p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Naming issues</h2></div>
      <p style="max-width:70ch">${esc(t.topicNamingRule)}</p>
      <p class="attribution">“Voting access” and “election integrity” describe the same bills.
      Choosing between them announces a side before a word of the message is written, so the
      taxonomy is named the way a librarian would name it.</p>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Everything we have sent</h2>
        <span class="count">${t.broadcastsSent} message${t.broadcastsSent === 1 ? '' : 's'}</span>
      </div>
      <p style="max-width:70ch"><a href="#/transparency">Read every message Pollbook has ever
      sent</a>, with its sources and who it went to. Publishing our own send log is the only one
      of these safeguards that still works if the people running Pollbook stop wanting it to.</p>
    </section>

    <p class="attribution" style="padding-top:1rem">${esc(t.funder)}</p>`;
}

async function viewPrivacy() {
  const t = await api.transparency();
  app.innerHTML = `
    ${backLink('#/home', 'Back to your ballot')}
    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">Privacy</p>
        <h1>What we collect, and what we refuse to</h1>
      </div>
      <p class="detail-desc">You can browse all of Pollbook without an account, and we do not
      ask for anything until you want to be reminded of something.</p>
    </article>

    <section class="section" style="margin-top:2rem">
      <div class="section-head"><h2>What we collect</h2></div>
      <ul class="policy-list">${t.collect.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    </section>

    <section class="section">
      <div class="section-head"><h2>What we deliberately do not collect</h2></div>
      <ul class="policy-list policy-list--refuse">${t.doNotCollect.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <p class="attribution">These are not oversights. There is no database column for party
      affiliation, so there is nothing to target with and nothing to leak — which is what makes
      the nonpartisan claim structural rather than something you have to take on trust.</p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Your rights</h2></div>
      <ul class="policy-list">
        <li>Take everything we hold, as a file, from your account page.</li>
        <li>Delete your account. Your address stays on our do-not-contact list afterwards so we
        can never mail you again.</li>
        <li>Unsubscribe from any message, in one click, with no sign-in.</li>
        <li>We do not sell, rent, or share your details, and we never accept political
        advertising in what we send you.</li>
      </ul>
    </section>

    <p class="attribution" style="padding-top:1rem">${esc(t.funder)}</p>`;
}

async function viewTransparency() {
  const data = await api.sentMessages();
  const messages = data.broadcasts || [];

  app.innerHTML = `
    ${backLink('#/about', 'Back to how this works')}
    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">Public record</p>
        <h1>Every message we have sent</h1>
      </div>
      <p class="detail-desc">${esc(data.note || 'Nothing has been sent yet.')}</p>
    </article>

    <section class="section" style="margin-top:2rem">
      <div class="section-head">
        <h2>Sent messages</h2>
        <span class="count">${messages.length}</span>
      </div>
      ${messages.length ? messages.map((m) => `
        <article class="sent-message">
          <p class="eyebrow">${esc(m.category)} · ${esc(m.channel)} · ${m.sentAt ? fmtDate(String(m.sentAt).slice(0, 10)) : ''}${m.aiAssisted ? ' · AI-assisted draft' : ''}</p>
          <h3>${esc(m.subject || m.title)}</h3>
          <pre class="sent-body">${esc(m.body)}</pre>
          <dl class="detail-meta">
            <div><dt>Recipients</dt><dd>${m.recipients ?? '—'}</dd></div>
            <div><dt>Sent to people following</dt><dd>${
  [...(m.audience.subjects || []), ...(m.audience.issues || []), ...(m.audience.states || [])]
    .map(esc).join(', ') || '—'}</dd></div>
          </dl>
          ${(m.sources || []).length ? `<p class="attribution">Sources: ${
    m.sources.map((s) => `<a href="${esc(safeHref(s.url))}" target="_blank" rel="noopener">${esc(s.label || s.url)}</a>`).join(' · ')}</p>` : ''}
          ${m.candidateBalance && m.candidateBalance.applies ? `<p class="attribution">Candidates named: ${
    (m.candidateBalance.named || []).map((c) => esc(c.name)).join(', ')} — all qualifying candidates in the race, alphabetically by surname.</p>` : ''}
        </article>`).join('')
    : '<div class="empty">Nothing has been sent yet. When it is, it will appear here in full.</div>'}
    </section>`;
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
  { match: /^#\/account/, view: () => viewAccount(), route: 'account' },
  { match: /^#\/signin/, view: (h) => viewSignIn(new URLSearchParams(h.split('?')[1] || '')), route: 'account' },
  { match: /^#\/about/, view: () => viewAbout(), route: '' },
  { match: /^#\/transparency/, view: () => viewTransparency(), route: '' },
  { match: /^#\/privacy/, view: () => viewPrivacy(), route: '' },
];

/**
 * The account link in the masthead.
 *
 * Added by script rather than sitting in index.html, so an instance with no
 * database shows no sign-in affordance at all — offering an account that
 * cannot exist is worse than not mentioning it.
 */
function renderAccountNav() {
  const existing = nav.querySelector('[data-route="account"]');
  if (!state.providers.accountsEnabled) return existing?.remove();

  const label = signedIn() ? 'Your alerts' : 'Sign in';
  const href = signedIn() ? '#/account' : '#/signin';

  if (existing) {
    existing.setAttribute('href', href);
    existing.innerHTML = `<span class="nav-oval"></span>${label}`;
    return;
  }

  const link = document.createElement('a');
  link.href = href;
  link.dataset.route = 'account';
  link.innerHTML = `<span class="nav-oval"></span>${label}`;
  nav.appendChild(link);
}

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
  const [areas, meta, providers] = await Promise.all([
    api.areas().catch(() => []),
    api.meta().catch(() => ({ provider: 'live', live: true })),
    api.authProviders().catch(() => ({ accountsEnabled: false })),
  ]);
  state.areas = areas;
  state.meta = meta;
  state.providers = providers;
  renderModeBanner();

  // Accounts are entirely optional, so this must never block the first
  // render: an instance with no database, or a database that is briefly
  // unreachable, still serves every page it always did.
  if (providers.accountsEnabled) {
    await loadAccount().catch(() => {});
    if (signedIn()) {
      await migrateLocalTracking();
      await syncTracked();
    }
  }
  renderAccountNav();

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

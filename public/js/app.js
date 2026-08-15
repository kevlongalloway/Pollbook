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

const raceBlock = (r) => `
  <div class="race-block">
    <div class="race-office">${esc(r.office)}</div>
    ${r.candidates.length
      ? r.candidates.map(candLine).join('')
      : `<div class="race-empty">${esc(r.note || 'No candidate filings loaded for this race yet.')}</div>`}
    ${(r.markets || []).length ? marketPanel(r.markets[0]) : ''}
  </div>`;

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

    ${c.finance ? `
    <section class="section">
      <div class="section-head"><h2>Campaign money</h2><span class="count">FEC totals · ${c.finance.coverageEnd ? `through ${fmtDate(c.finance.coverageEnd)}` : `${c.finance.cycle} cycle`}</span></div>
      <div class="finance-grid">
        <div class="finance-card"><dt>Raised</dt><dd>${fmtMoney(c.finance.receipts)}</dd></div>
        <div class="finance-card"><dt>Spent</dt><dd>${fmtMoney(c.finance.disbursements)}</dd></div>
        <div class="finance-card"><dt>Cash on hand</dt><dd>${fmtMoney(c.finance.cashOnHand)}</dd></div>
      </div>
    </section>` : ''}

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

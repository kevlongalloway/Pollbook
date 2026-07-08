/* Pollbook frontend — vanilla JS, hash routing, talks to /api. */

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const areaSelect = document.getElementById('area-select');

const state = {
  area: localStorage.getItem('pb-area') || 'GA',
  areas: [],
  tracked: new Set(JSON.parse(localStorage.getItem('pb-tracked') || '[]')),
};

/* ---------------- api client ---------------- */

const api = {
  async get(path) {
    const res = await fetch(`/api${path}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
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

const PARTY_NAMES = {
  DEM: 'Democratic', REP: 'Republican', IND: 'Independent',
  LIB: 'Libertarian', GRN: 'Green', NP: 'Nonpartisan',
};

const saveTracked = () =>
  localStorage.setItem('pb-tracked', JSON.stringify([...state.tracked]));

/* ---------------- shared renderers ---------------- */

const scopeTag = (scope) =>
  `<span class="tag tag--${esc(scope)}">${esc(scope)}</span>`;

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

/* ---------------- views ---------------- */

async function viewHome() {
  const [local, national] = await Promise.all([
    api.elections({ state: state.area }),
    api.elections({ scope: 'national' }),
  ]);

  const localOnly = local.filter((e) => e.scope !== 'national');
  const next = local[0];
  const areaName = state.areas.find((a) => a.code === state.area)?.name || state.area;

  app.innerHTML = `
    <section class="hero">
      <div class="hero-strip">
        <span>Official sample — Pollbook</span>
        <span>Area: ${esc(areaName)}</span>
      </div>
      <div class="hero-body">
        <h1>Every election.<br>Not just the <span class="accent">big one.</span></h1>
        <p class="lede">School board, judges, city council, referendums — the races that shape your daily life are the ones most people never hear about. Here's everything on the calendar for ${esc(areaName)}.</p>
        ${next ? `<span class="hero-count"><span class="oval oval--filled"></span>Next: ${esc(next.name)} — ${fmtDate(next.date)}</span>` : ''}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Upcoming in ${esc(areaName)}</h2>
        <span class="count">${localOnly.length} election${localOnly.length === 1 ? '' : 's'} scheduled</span>
      </div>
      ${ballotList(localOnly, 'No upcoming elections found for this area.')}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>National</h2>
        <span class="count">${national.length} scheduled</span>
      </div>
      ${ballotList(national, 'No upcoming national elections found.')}
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

  const scopes = ['', 'local', 'state', 'national'];

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Browse elections</h2>
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
      </div>

      ${ballotList(elections, 'Nothing matches these filters. Try widening the search.')}
    </section>
  `;

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
}

async function viewElection(id) {
  const e = await api.election(id);
  const days = daysUntil(e.date);
  const regDays = daysUntil(e.registrationDeadline);
  const tracked = state.tracked.has(e.id);

  app.innerHTML = `
    ${backLink('#/home', 'Back to your ballot')}

    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">${esc(e.type)} · ${esc(e.locality)}${e.state ? `, ${esc(e.state)}` : ''}</p>
        <h1>${esc(e.name)}</h1>
      </div>
      <dl class="detail-meta">
        <div><dt>Election day</dt><dd>${fmtDate(e.date)}</dd></div>
        <div><dt>Days remaining</dt><dd>${days != null ? days : '—'}</dd></div>
        <div><dt>Register by</dt><dd>${fmtDate(e.registrationDeadline)}${regDays != null ? ` (${regDays}d)` : ''}</dd></div>
        <div><dt>Early voting</dt><dd>${fmtDate(e.earlyVotingStart)}</dd></div>
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
        <span class="count">${e.races.length} race${e.races.length === 1 ? '' : 's'} loaded</span>
      </div>
      ${e.races.length ? e.races.map((r) => `
        <div class="race-block">
          <div class="race-office">${esc(r.office)}</div>
          ${r.candidates.map((c) => `
            <a class="cand-line" href="#/candidate/${esc(c.id)}">
              <span class="line-oval" aria-hidden="true"></span>
              <span class="cand-name">${esc(c.name)}${c.incumbent ? '<small>Incumbent</small>' : ''}</span>
              <span class="party">${esc(PARTY_NAMES[c.party] || c.party)}</span>
            </a>`).join('')}
        </div>`).join('')
      : '<div class="empty">Race data not yet loaded for this election. Connect a ballot data provider to populate contests.</div>'}
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
  const appearance = c.appearances[0];

  app.innerHTML = `
    ${backLink(appearance ? `#/election/${esc(appearance.electionId)}` : '#/home', appearance ? `Back to ${appearance.electionName}` : 'Back')}

    <article class="detail-card">
      <div class="detail-band">
        <p class="eyebrow">${esc(PARTY_NAMES[c.party] || c.party)}${c.incumbent ? ' · Incumbent' : ''}</p>
        <h1>${esc(c.name)}</h1>
      </div>
      <dl class="detail-meta">
        <div><dt>Running for</dt><dd>${esc(c.office)}</dd></div>
        <div><dt>Election day</dt><dd>${appearance ? fmtDate(appearance.date) : '—'}</dd></div>
        <div><dt>Campaign site</dt><dd><a href="${esc(c.website)}" target="_blank" rel="noopener">Visit ↗</a></dd></div>
      </dl>
      <p class="detail-desc">${esc(c.bio)}</p>
    </article>

    <section class="section">
      <div class="section-head"><h2>Core values</h2></div>
      <div class="values-grid">
        ${c.coreValues.map((v) => `
          <div class="value-item"><span class="oval"></span>${esc(v)}</div>`).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>In the news</h2>
        <span class="count">${c.articles.length} article${c.articles.length === 1 ? '' : 's'}</span>
      </div>
      ${c.articles.length ? c.articles.map((a) => `
        <a class="article-line" href="${esc(a.url)}" ${a.url !== '#' ? 'target="_blank" rel="noopener"' : ''}>
          <span class="article-title">${esc(a.title)}</span>
          <span class="article-src">${esc(a.outlet)} · ${fmtDate(a.date)}</span>
        </a>`).join('')
      : '<div class="empty">No coverage indexed yet for this candidate.</div>'}
    </section>
  `;
}

async function viewData() {
  const stats = await api.stats();
  const entries = Object.entries(stats);

  app.innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Turnout by election type</h2>
        <span class="count">${entries.length} states</span>
      </div>
      <p style="max-width:64ch;margin-bottom:1.5rem">The pattern holds everywhere: the closer an election is to your front door, the fewer people vote in it. Turnout figures below are share of registered voters, recent cycle averages.</p>
      <div class="stats-grid">
        ${entries.map(([code, s]) => `
          <div class="stat-card">
            <h3>${esc(s.state)} <small>${(s.registeredVoters / 1e6).toFixed(1)}M registered</small></h3>
            <div class="bar-rows">
              ${s.turnoutByType.map((t) => `
                <div class="bar-row">
                  <div class="bar-label"><span>${esc(t.type)}</span><span>${t.turnout}%</span></div>
                  <div class="bar-track"><div class="bar-fill" data-w="${t.turnout}"></div></div>
                </div>`).join('')}
            </div>
            <p class="stat-note">${esc(s.note)}</p>
          </div>`).join('')}
      </div>
    </section>
  `;

  // Animate bars after paint.
  requestAnimationFrame(() => {
    app.querySelectorAll('.bar-fill').forEach((el) => {
      el.style.width = `${el.dataset.w}%`;
    });
  });
}

/* ---------------- router ---------------- */

const routes = [
  { match: /^#\/home/, view: () => viewHome(), route: 'home' },
  { match: /^#\/browse/, view: (h) => viewBrowse(new URLSearchParams(h.split('?')[1] || '')), route: 'browse' },
  { match: /^#\/election\/([\w-]+)/, view: (h, m) => viewElection(m[1]), route: 'home' },
  { match: /^#\/candidate\/([\w-]+)/, view: (h, m) => viewCandidate(m[1]), route: 'home' },
  { match: /^#\/data/, view: () => viewData(), route: 'data' },
];

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
    app.innerHTML = '<div class="empty">Couldn\u2019t load this page. Check that the server is running, then reload.</div>';
  }
}

/* ---------------- boot ---------------- */

async function init() {
  try {
    state.areas = await api.areas();
  } catch {
    state.areas = [];
  }

  areaSelect.innerHTML = state.areas
    .map((a) => `<option value="${esc(a.code)}" ${a.code === state.area ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  areaSelect.addEventListener('change', () => {
    state.area = areaSelect.value;
    localStorage.setItem('pb-area', state.area);
    if ((location.hash || '#/home').startsWith('#/home')) render();
    else location.hash = '#/home';
  });

  window.addEventListener('hashchange', render);
  render();
}

init();

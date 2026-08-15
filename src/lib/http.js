/**
 * Fetch helpers for external data sources (Node 18+ global fetch).
 * Every call has a timeout; callers are expected to catch failures and
 * degrade gracefully — a dead upstream should never take a page down.
 */

const USER_AGENT = 'Pollbook/0.2 (nonpartisan election awareness app)';

async function fetchRaw(url, { timeoutMs = 10000, headers = {}, method, body } = {}) {
  const res = await fetch(url, {
    method: method || 'GET',
    body,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, ...headers },
    redirect: 'follow',
  });
  if (!res.ok) {
    // Callers occasionally need to branch on the code (e.g. falling back to a
    // keyless provider when a metered one returns 429), so carry it along.
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function fetchJson(url, opts = {}) {
  const res = await fetchRaw(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  return res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetchRaw(url, opts);
  return res.text();
}

module.exports = { fetchJson, fetchText };

/**
 * Fetch helpers for external data sources (Node 18+ global fetch).
 * Every call has a timeout; callers are expected to catch failures and
 * degrade gracefully — a dead upstream should never take a page down.
 */

const USER_AGENT = 'Pollbook/0.2 (nonpartisan election awareness app)';

async function fetchRaw(url, { timeoutMs = 10000, headers = {} } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, ...headers },
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    // Callers need the status to tell an invalid API key (403) from a rate
    // limit (429) from an outage. The body often names the exact cause, but
    // it can contain the request URL — and therefore the API key — so it is
    // only ever read by callers that scrub it, never logged raw.
    err.status = res.status;
    err.body = await res.text().catch(() => '');
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

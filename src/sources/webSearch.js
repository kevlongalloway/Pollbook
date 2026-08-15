/**
 * Web search for the candidate Q&A assistant.
 *
 * Two providers, one shape. Tavily (TAVILY_API_KEY) is the real search — it
 * returns extracted page text, which is what an LLM actually needs to ground
 * an answer. Without a key, or when Tavily is out of quota, this degrades to
 * the same keyless Google News RSS feed `news.js` already reads: headlines
 * only, no page text, but better than nothing.
 *
 * Results are untrusted third-party text. Nothing here decides what to do
 * with them — see `formatResults` in lib/candidateQa.js for the fencing that
 * keeps a search result from talking to the model as if it were an
 * instruction.
 */

const { fetchJson, fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');
const { parseItems } = require('./news');

const TTL = 15 * 60 * 1000;
const TAVILY_API_BASE = process.env.TAVILY_API_BASE || 'https://api.tavily.com';
const RSS_BASE = process.env.WEB_SEARCH_RSS_BASE || 'https://news.google.com';

/** Hostname makes a serviceable outlet label: "www.reuters.com" -> "reuters.com". */
function outletFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Control characters, soft hyphen, zero-width spaces, bidi overrides, BOM.
// All invisible in a rendered prompt but not to the tokenizer — the usual way
// text is smuggled past a human reviewing what a page "says".
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// Chat-template and role markers. A page that contains "<|im_start|>system"
// is trying to end the tool result and start a new turn; flatten it to text.
const TEMPLATE_TOKENS = /<\|[^|>]*\|>|<\/?s>|\[\/?INST\]|^\s*###\s*(system|assistant|user)\b/gim;

const clean = (s, max) =>
  String(s || '')
    .replace(INVISIBLE, ' ')
    .replace(TEMPLATE_TOKENS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Only http(s) survives — a `javascript:` URL must never reach an href. */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);

/** Tavily payload -> normalized rows. Pure; exported for tests. */
function normalizeTavily(data, limit = 5) {
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows
    .map((r) => (r && r.title && safeUrl(r.url) ? { r, url: safeUrl(r.url) } : null))
    .filter(Boolean)
    .slice(0, limit)
    .map(({ r, url }) => ({
      title: clean(r.title, 200),
      url,
      snippet: clean(r.content, 500),
      outlet: outletFor(url),
      date: r.published_date ? String(r.published_date).slice(0, 10) : null,
    }));
}

async function searchTavily(query, limit, timeoutMs) {
  const data = await fetchJson(`${TAVILY_API_BASE}/search`, {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: limit,
      search_depth: 'basic',
    }),
  });
  return normalizeTavily(data, limit);
}

/** Keyless fallback — headlines from Google News RSS, in the same shape. */
async function searchNews(query, limit, timeoutMs) {
  const xml = await fetchText(
    `${RSS_BASE}/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    { timeoutMs }
  );
  return parseItems(xml, limit)
    .filter((a) => safeUrl(a.url))
    .map((a) => ({
      title: clean(a.title, 200),
      url: a.url,
      snippet: '',
      outlet: a.outlet || outletFor(a.url),
      date: a.date,
    }));
}

/** True when a real web-search provider is configured (vs. the news fallback). */
const configured = () => Boolean(process.env.TAVILY_API_KEY);

/** Which provider is actually serving searches — reported by GET /api/meta. */
const provider = () => (configured() ? 'tavily' : 'news-rss');

/**
 * Search the web. Never throws — an empty array means "found nothing", which
 * the assistant reports honestly rather than filling in from memory.
 */
async function search(query, { limit = 5, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];

  return cached(`websearch:${provider()}:${limit}:${q.toLowerCase()}`, TTL, async () => {
    if (!configured()) return searchNews(q, limit, timeoutMs);
    try {
      return await searchTavily(q, limit, timeoutMs);
    } catch (err) {
      // Out of quota or key rejected: the keyless feed still has headlines.
      if (err.status === 429 || err.status === 401 || err.status === 403) {
        return searchNews(q, limit, timeoutMs);
      }
      throw err;
    }
  }).catch(() => []);
}

module.exports = { search, provider, configured, __normalizeTavily: normalizeTavily, __clean: clean };

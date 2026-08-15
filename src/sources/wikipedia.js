/**
 * Candidate background from Wikipedia (live, no key).
 *
 * 1. Search for the candidate's article.
 * 2. Pull the lead summary + photo from the REST summary endpoint.
 * 3. Pull the full plaintext extract and slice out the "Political positions"
 *    section (when the article has one) for the policy-positions panel.
 *
 * Matches are best-effort: the result carries the article title + URL so the
 * UI can attribute it and users can judge the match themselves. Articles
 * whose description clearly isn't a political figure are discarded.
 */

const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');

const API = 'https://en.wikipedia.org/w/api.php';
const REST = 'https://en.wikipedia.org/api/rest_v1';
const DAY = 24 * 3600 * 1000;

const POLITICAL_HINT = /politic|senat|congress|represent|govern|legislat|attorney|mayor|judge|official|candidate|activist|executive|secretary|council/i;

async function searchTitle(query) {
  const q = new URLSearchParams({
    action: 'query', list: 'search', srsearch: query,
    srlimit: 1, format: 'json', origin: '*',
  });
  const data = await fetchJson(`${API}?${q}`);
  return data?.query?.search?.[0]?.title || null;
}

async function summaryFor(title) {
  return fetchJson(`${REST}/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
}

async function plainExtract(title) {
  const q = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1', redirects: '1',
    titles: title, format: 'json', origin: '*',
  });
  const data = await fetchJson(`${API}?${q}`, { timeoutMs: 15000 });
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  return page?.extract || '';
}

/**
 * Slice "== Political positions ==" (or similar) out of a plaintext article
 * and split its "=== Sub-topic ===" headings into topic blocks.
 */
function extractPositions(fullText) {
  const sectionRe = /^==\s*(Political positions|Policy positions|Political views|Positions|Platform)\s*==\s*$/im;
  const start = fullText.search(sectionRe);
  if (start === -1) return [];
  const afterHeading = fullText.slice(start).replace(sectionRe, '').trimStart();
  const nextSection = afterHeading.search(/^==[^=].*==\s*$/m);
  const body = (nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection)).trim();
  if (!body) return [];

  const chunks = body.split(/^===\s*(.+?)\s*===\s*$/m);
  const positions = [];
  // chunks: [preamble, topic1, text1, topic2, text2, ...]
  const preamble = chunks[0].trim();
  if (preamble) positions.push({ topic: 'Overview', text: clip(preamble) });
  for (let i = 1; i < chunks.length - 1; i += 2) {
    const topic = chunks[i].trim();
    const text = chunks[i + 1].replace(/^====.*$/gm, '').trim();
    if (topic && text) positions.push({ topic, text: clip(text) });
  }
  return positions.slice(0, 12);
}

const clip = (text, max = 900) => {
  const t = text.replace(/\s+\n/g, '\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, max - 200))}…`;
};

/**
 * Full best-effort profile: { title, url, extract, description, thumbnail,
 * positions[] } or null when no plausible article exists.
 */
async function profileFor(name, { state, officeFull } = {}) {
  const key = `wiki:${name}:${state || ''}`.toLowerCase();
  return cached(key, DAY, async () => {
    const query = [name, officeFull || 'politician', state].filter(Boolean).join(' ');
    const title = await searchTitle(query);
    if (!title) return null;

    const summary = await summaryFor(title);
    if (!summary || summary.type === 'disambiguation') return null;
    const description = summary.description || '';
    // Reject obvious mismatches (an athlete/musician sharing the name).
    if (description && !POLITICAL_HINT.test(description)) return null;

    let positions = [];
    try {
      positions = extractPositions(await plainExtract(title));
    } catch { /* positions are a bonus — keep the summary */ }

    return {
      title: summary.title || title,
      url: summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      extract: summary.extract || '',
      description,
      thumbnail: summary.thumbnail?.source || null,
      positions,
    };
  });
}

module.exports = { profileFor, extractPositions };

/**
 * Recent coverage from the Google News RSS feed (live, no key).
 * The feed is a small, stable XML document — parsed here with a few
 * regexes to avoid pulling in an XML dependency.
 */

const { fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');

const TTL = 30 * 60 * 1000;

const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .trim();

function parseItems(xml, limit) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const block = m[1];
    const pick = (tag) => {
      const hit = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return hit ? decode(hit[1]) : '';
    };
    const title = pick('title');
    const link = pick('link');
    if (!title || !link) continue;
    const source = pick('source');
    const pubDate = pick('pubDate');
    items.push({
      // Google appends " - Outlet" to titles; the <source> tag is cleaner.
      title: source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title,
      outlet: source || 'Google News',
      date: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : null,
      url: link,
    });
  }
  return items;
}

/** Recent articles mentioning the candidate. Empty array on any failure. */
async function articlesFor(name, context = '', { limit = 6 } = {}) {
  const key = `news:${name}:${context}`.toLowerCase();
  return cached(key, TTL, async () => {
    const q = encodeURIComponent(`"${name}" ${context}`.trim());
    const xml = await fetchText(
      `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
      { timeoutMs: 12000 }
    );
    return parseItems(xml, limit);
  }).catch(() => []);
}

module.exports = { articlesFor, parseItems };

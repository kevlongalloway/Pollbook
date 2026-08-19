/**
 * News about candidates people follow.
 *
 * Off by default (`scheduled_jobs.enabled = false` for this one), and it
 * produces suggestions rather than messages, for a reason worth stating: news
 * selection *is* editorial. Deciding which three headlines about a race are
 * worth an alert is exactly the decision a partisan operation would make
 * differently, and no amount of neutral wording around a one-sided selection
 * fixes it.
 *
 * So the machine's job here is narrow and mechanical — find coverage, dedupe
 * it, present it in a fixed order — and the judgement stays with a person who
 * has to put their name on it and get a second person to agree.
 */

const db = require('../../db');
const news = require('../../sources/news');
const subjects = require('../../lib/subjects');
const electionService = require('../../services/electionService');

/** How many followers a race needs before its coverage is worth a suggestion. */
const MIN_FOLLOWERS = Number(process.env.NEWS_MIN_FOLLOWERS) || 5;

/** One suggestion per race per this many hours. */
const COOLDOWN_HOURS = 24;

async function run() {
  const races = await db.rows(
    `SELECT sj.key, sj.label, sj.state_code, count(*)::int AS followers
       FROM subscriptions s
       JOIN subjects sj ON sj.key = s.subject_key
      WHERE sj.type = 'race' AND sj.status = 'active'
      GROUP BY sj.key, sj.label, sj.state_code
     HAVING count(*) >= $1
      ORDER BY count(*) DESC
      LIMIT 20`,
    [MIN_FOLLOWERS]
  );

  const suggestions = [];

  for (const race of races) {
    const recent = await db.one(
      `SELECT id FROM broadcast_suggestions
        WHERE producer = 'news' AND subject_key = $1
          AND created_at > now() - ($2::int * interval '1 hour')`,
      [race.key, COOLDOWN_HOURS]
    );
    if (recent) continue;

    const articles = await coverageFor(race.key);
    if (articles.length < 2) continue;

    suggestions.push(await suggest(race, articles));
  }

  return { races: races.length, suggestions: suggestions.filter(Boolean).length };
}

/**
 * Coverage for every candidate in a race, deduplicated by URL.
 *
 * Every candidate, not just the ones with the most coverage — the balance
 * rule will require them all to be named anyway, and gathering only the
 * newsworthy ones would bake the imbalance in before an editor ever sees it.
 */
async function coverageFor(subjectKey) {
  const parsed = subjects.parseSubjectKey(subjectKey);
  if (!parsed || parsed.type !== 'race') return [];

  let candidates = [];
  try {
    const election = await electionService.getElectionById(
      `${parsed.stateCode.toLowerCase()}-general-${parsed.cycle}`
    );
    const race = (election?.races || []).find((r) => r.id === subjects.toLegacyId(subjectKey));
    candidates = race?.candidates || [];
  } catch {
    return [];
  }

  const seen = new Set();
  const out = [];

  for (const candidate of candidates) {
    let articles = [];
    try {
      articles = await news.articlesFor(`${candidate.name} ${parsed.stateCode}`);
    } catch {
      continue; // one candidate's feed failing must not skew the set
    }
    for (const article of (articles || []).slice(0, 3)) {
      if (!article.url || seen.has(article.url)) continue;
      seen.add(article.url);
      out.push({ ...article, candidate: candidate.name });
    }
  }

  return out;
}

async function suggest(race, articles) {
  // Grouped by candidate, candidates alphabetical by surname. The order is
  // not cosmetic: whoever appears first in a list is read as the subject of
  // the story, and sorting by volume of coverage would hand that position to
  // whoever had the busiest week.
  const { surnameOf } = require('../../lib/nonpartisan');
  const byCandidate = new Map();
  for (const article of articles) {
    if (!byCandidate.has(article.candidate)) byCandidate.set(article.candidate, []);
    byCandidate.get(article.candidate).push(article);
  }

  const ordered = [...byCandidate.entries()].sort((a, b) =>
    surnameOf(a[0]).localeCompare(surnameOf(b[0])));

  const body = [
    `Recent coverage of ${race.label}.`,
    '',
    ...ordered.flatMap(([name, items]) => [
      `${name}:`,
      ...items.map((a) => `- ${a.title} (${a.outlet})`),
      '',
    ]),
    'Pollbook does not choose these stories to make a point, and linking to one is not an ' +
    'endorsement of it. Coverage is gathered per candidate and listed alphabetically.',
  ].join('\n');

  const row = await db.one(
    `INSERT INTO broadcast_suggestions
       (public_id, producer, dedup_key, category, subject_key, subject_line, body, sources, evidence)
     VALUES (gen_random_uuid(), 'news', $1, 'news', $2, $3, $4, $5, $6)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING public_id`,
    [
      `news:${race.key}:${new Date().toISOString().slice(0, 10)}`,
      race.key,
      `Coverage this week — ${race.label}`,
      body,
      JSON.stringify(articles.slice(0, 12).map((a) => ({ label: a.outlet || a.title, url: a.url }))),
      JSON.stringify({ candidates: ordered.map(([name]) => name), articles: articles.length }),
    ]
  );

  return row?.public_id || null;
}

module.exports = { run, coverageFor, MIN_FOLLOWERS, COOLDOWN_HOURS };

/**
 * The public record of everything Pollbook has sent.
 *
 * This is the safeguard I would fight hardest to keep, because it is the only
 * one that works when the people running the product want to cheat. Every
 * other mechanism — the linter, the balance rule, the two-person approval —
 * is enforced by code that the people running the product control. This one
 * is enforced by the fact that anybody can read it.
 *
 * So: every broadcast that went out, in full, with its sources, its audience
 * criteria and its recipient count. Plus a monthly tally of how often each
 * party and each candidate was mentioned, which is the number that would
 * expose a slow drift no individual message would.
 *
 * No authentication, and no personal data — audience criteria are the
 * *rules*, never the people they matched.
 */

const express = require('express');
const errors = require('../lib/errors');
const db = require('../db');
const { FUNDING_LINE } = require('../notify/render');

const router = express.Router();

/** Cheap, public, and cached at the edge if anything ever sits in front. */
router.use((req, res, next) => {
  res.set('cache-control', 'public, max-age=300');
  next();
});

function requireDatabase(req, res, next) {
  if (db.enabled()) {
    return next();
  }
  // Honest rather than empty: "we have sent nothing" and "this instance has
  // no database" are very different claims and should not look the same.
  res.json({
    accountsEnabled: false,
    note: 'This instance has no subscriber database, so it has never sent a message.',
    broadcasts: [],
  });
}

/**
 * What we collect, what we refuse to collect, and the rules we hold ourselves
 * to — served from the same constants the code enforces, so this page cannot
 * drift from the behaviour it describes.
 */
router.get('/', async (req, res, next) => {
  try {
    const { POSITION_CODED, AUDIENCE_KEYS } = require('../lib/nonpartisan');

    const stats = db.enabled()
      ? await db.one(
        `SELECT count(*) FILTER (WHERE status = 'sent') AS sent,
                min(sent_at) AS first_sent,
                max(sent_at) AS last_sent
           FROM broadcasts`
      ).catch(() => null)
      : null;

    res.json({
      funder: FUNDING_LINE,
      principles: [
        'Pollbook never tells anyone how to vote, and never asks how they voted.',
        'We do not collect, infer, buy, or store party affiliation, political views, or voting history. There is no column for any of them.',
        'A message that names one candidate in a race must name every qualifying candidate, in alphabetical order by surname.',
        'Express advocacy — "vote for", "defeat", "elect" — is blocked before a message can be approved.',
        'We never link to a donation page, and never accept political advertising in email or SMS.',
        'A human other than the author must approve every message that is not a pure logistics reminder.',
        'Prediction-market prices are reported as prices, never as forecasts.',
        'Every message we send is published here.',
      ],
      collect: [
        'Your email address, and your phone number only if you asked for text alerts.',
        'Your state, and optionally your five-digit ZIP, so we can tell you about the right ballot.',
        'Your time zone, so we never text you in the middle of the night.',
        'Which races and issues you chose to follow, and how often you want to hear from us.',
        'A record of what you agreed to, when, and the exact words you were shown.',
      ],
      doNotCollect: [
        'Party affiliation or registration — the single most important thing we refuse.',
        'Political views, or which way you intend to vote.',
        'Voting history, turnout scores, or any match against a public voter file.',
        'Your home address, date of birth, or precise location.',
        'Race, ethnicity, religion, health, or any other sensitive category.',
        'Your questions to the AI panels — those are never stored on our servers.',
      ],
      audienceDimensions: AUDIENCE_KEYS,
      audienceNote:
        'These are the only ways a message can be targeted. There is no field for party or ideology, ' +
        'because there is no such data to target with.',
      topicNamingRule:
        'Issues are named as subject areas, never as positions. Names matching any of ' +
        `${POSITION_CODED.length} position-coded phrases are rejected automatically.`,
      broadcastsSent: stats ? Number(stats.sent) : 0,
      firstSent: stats?.first_sent || null,
      lastSent: stats?.last_sent || null,
    });
  } catch (err) {
    next(err);
  }
});

/** Every broadcast we have sent, most recent first. */
router.get('/broadcasts', requireDatabase, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const rows = await db.rows(
      `SELECT b.public_id, b.title, b.category, b.channel, b.subject_line, b.body,
              b.sources, b.ai_assisted, b.sent_at, b.recipient_count,
              b.balance_report, b.lint_report,
              a.subject_keys, a.issue_slugs, a.state_codes, a.channels, a.active_since_days
         FROM broadcasts b
         LEFT JOIN broadcast_audience a ON a.broadcast_id = b.id
        WHERE b.status = 'sent'
        ORDER BY b.sent_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      accountsEnabled: true,
      note:
        'Every message Pollbook has sent, in full. Audience criteria are the rules a message ' +
        'was targeted by — never the people it reached.',
      broadcasts: rows.map((b) => ({
        id: b.public_id,
        title: b.title,
        category: b.category,
        channel: b.channel,
        subject: b.subject_line,
        body: b.body,
        sources: b.sources,
        aiAssisted: b.ai_assisted,
        sentAt: b.sent_at,
        recipients: b.recipient_count,
        audience: {
          subjects: b.subject_keys || [],
          issues: b.issue_slugs || [],
          states: b.state_codes || [],
          channels: b.channels || [],
          activeSinceDays: b.active_since_days,
        },
        // Published deliberately: the warnings an approver accepted, and the
        // reason they gave, are exactly what an outside reader should be able
        // to weigh for themselves.
        neutralityFindings: (b.lint_report?.findings || []).map((f) => ({
          rule: f.rule, severity: f.severity, text: f.text,
        })),
        candidateBalance: b.balance_report || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The balance report: how often each party and candidate was named.
 *
 * Individually neutral messages can still add up to a pattern, and this is
 * the number that shows it. Computed from what was actually sent rather than
 * from what was intended.
 */
router.get('/balance', requireDatabase, async (req, res, next) => {
  try {
    const months = Math.min(Number(req.query.months) || 12, 36);
    const { partyMentions } = require('../lib/nonpartisan');

    const rows = await db.rows(
      `SELECT date_trunc('month', sent_at) AS month, body, subject_line, recipient_count
         FROM broadcasts
        WHERE status = 'sent' AND sent_at > now() - ($1::int * interval '1 month')
        ORDER BY sent_at DESC`,
      [months]
    );

    const byMonth = new Map();
    for (const row of rows) {
      const key = new Date(row.month).toISOString().slice(0, 7);
      const entry = byMonth.get(key) || {
        month: key, broadcasts: 0, recipients: 0,
        mentions: { democratic: 0, republican: 0, other: 0 },
      };
      const counts = partyMentions(`${row.subject_line || ''}\n${row.body}`);
      entry.broadcasts += 1;
      entry.recipients += Number(row.recipient_count) || 0;
      entry.mentions.democratic += counts.democratic;
      entry.mentions.republican += counts.republican;
      entry.mentions.other += counts.other;
      byMonth.set(key, entry);
    }

    const totals = [...byMonth.values()].reduce(
      (acc, m) => ({
        democratic: acc.democratic + m.mentions.democratic,
        republican: acc.republican + m.mentions.republican,
        other: acc.other + m.mentions.other,
      }),
      { democratic: 0, republican: 0, other: 0 }
    );

    res.json({
      note:
        'How often each party was named across everything we sent. A ratio far from 1:1 is not ' +
        'automatically wrong — one party holding a primary is a real reason — but it is the number ' +
        'worth watching, and it is published so you can watch it too.',
      months: [...byMonth.values()],
      totals,
      ratio: totals.republican > 0
        ? Number((totals.democratic / totals.republican).toFixed(2))
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.use(errors.handler('transparency'));

module.exports = router;

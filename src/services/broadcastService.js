/**
 * Human-authored messages, and the workflow between writing one and sending it.
 *
 * Draft → lint → submit → approve (by somebody else) → send. Each transition
 * checks something the previous one could not, and the order matters:
 *
 *   - **Lint at draft** so an author finds out immediately, not after review.
 *   - **Lint again at approve**, because the body can change in between.
 *   - **Hash at approve**, and compare at send, so what was approved is
 *     provably what goes out. Without this the two-person rule is theatre:
 *     get an innocuous draft approved, edit it, send.
 *   - **Lint a third time at render**, per message, in notify/render.js —
 *     because a template or a variable can carry text nobody reviewed.
 *
 * The two-person rule itself is a CHECK constraint on the table, not a check
 * here. Application logic is one `if` away from being removed by somebody in
 * a hurry; a constraint costs a migration and a code review.
 */

const crypto = require('crypto');
const db = require('../db');
const audit = require('../lib/audit');
const nonpartisan = require('../lib/nonpartisan');
const subjects = require('../lib/subjects');
const electionService = require('./electionService');

const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest();

/**
 * The candidates in a race, for the balance rule.
 *
 * Fails **open on data, closed on balance**: if the provider is unreachable
 * we cannot know who is in the race, so a message naming anybody cannot be
 * checked — and an unchecked balance claim is worse than a delayed message.
 * The caller turns a null here into a block.
 */
async function raceCandidates(subjectKey) {
  const parsed = subjects.parseSubjectKey(subjectKey);
  if (!parsed || (parsed.type !== 'race' && parsed.type !== 'election')) return [];

  try {
    const electionId = parsed.type === 'election'
      ? subjects.toLegacyId(parsed.canonical)
      : `${parsed.stateCode.toLowerCase()}-general-${parsed.cycle}`;

    const election = await electionService.getElectionById(electionId);
    if (!election) return null;

    const races = election.races || [];
    const race = parsed.type === 'race'
      ? races.find((r) => r.id === subjects.toLegacyId(parsed.canonical))
      : null;

    const list = race ? race.candidates : races.flatMap((r) => r.candidates || []);
    return (list || []).map((c) => ({
      name: c.name,
      party: c.party,
      incumbent: c.incumbent,
      receipts: c.receipts,
      probability: c.probability,
    }));
  } catch {
    return null; // unknown, not empty — the caller must not read this as "no candidates"
  }
}

/**
 * Run every neutrality check over a draft.
 *
 * Returns the findings rather than throwing, because the portal has to be
 * able to show an author what is wrong while they are still writing.
 */
async function review({ subjectLine, body, sources, subjectKey, category }) {
  const candidates = subjectKey ? await raceCandidates(subjectKey) : [];

  const findings = [];
  let balance = null;

  if (candidates === null) {
    findings.push({
      rule: 'balance-unverifiable',
      severity: 'block',
      span: 0,
      text: subjectKey,
      context: '',
      note:
        'The candidate list for this race is unavailable right now, so the balance rule cannot be ' +
        'checked. Nothing naming a candidate goes out unchecked — try again once the FEC connection ' +
        'recovers.',
    });
  } else if (candidates.length) {
    balance = nonpartisan.assertBalanced(`${subjectLine || ''}\n${body}`, candidates);
    findings.push(...balance.findings);
  }

  const report = nonpartisan.lint(body, {
    subject: subjectLine,
    sources,
    candidates: candidates || [],
  });
  findings.push(...report.findings);

  // Odds copy gets the extra framing check. The templated path cannot produce
  // a forecast, but a human writing about a market can.
  if (category === 'odds') {
    findings.push(...nonpartisan.checkOddsFraming(`${subjectLine || ''}\n${body}`).findings);
  }

  const blocked = findings.some((f) => f.severity === 'block');
  return {
    ok: !blocked,
    blocked,
    findings,
    warnings: findings.filter((f) => f.severity === 'warn'),
    counts: report.counts,
    balance,
    candidatesChecked: (candidates || []).length,
  };
}

/* ---------------- lifecycle ---------------- */

async function create(actorId, draft, { req } = {}) {
  const { title, category, channel, subjectKey, subjectLine, body, sources, audience, aiAssisted } = draft;

  const audienceCheck = nonpartisan.checkAudience(audience || {});
  if (!audienceCheck.ok) {
    throw Object.assign(new Error(audienceCheck.errors.join(' ')), { status: 400, code: 'PB_AUDIENCE' });
  }

  const key = subjectKey ? subjects.parseSubjectKey(subjectKey)?.canonical : null;
  if (subjectKey && !key) {
    throw Object.assign(new Error(`"${subjectKey}" is not a race Pollbook knows.`), { status: 400 });
  }

  const report = await review({ subjectLine, body, sources, subjectKey: key, category });

  const row = await db.tx(async (client) => {
    const inserted = await client.query(
      `INSERT INTO broadcasts
         (public_id, title, category, channel, subject_key, subject_line, body, body_sha256,
          sources, ai_assisted, status, lint_report, lint_passed_at, balance_report, created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, public_id, status`,
      [
        title, category, channel, key, subjectLine || null, body, sha256(body),
        JSON.stringify(sources || []), Boolean(aiAssisted),
        report.blocked ? 'lint_failed' : 'draft',
        JSON.stringify({ findings: report.findings, counts: report.counts }),
        report.blocked ? null : new Date(),
        report.balance ? JSON.stringify(report.balance) : null,
        actorId,
      ]
    );

    const broadcast = inserted.rows[0];
    await client.query(
      `INSERT INTO broadcast_audience
         (broadcast_id, subject_keys, include_seat_rollup, issue_slugs, state_codes, channels, active_since_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        broadcast.id,
        audience.subjectKeys || [],
        audience.includeSeatRollup !== false,
        audience.issueSlugs || [],
        (audience.stateCodes || []).map((s) => String(s).toUpperCase()),
        audience.channels || ['email'],
        audience.activeSinceDays || null,
      ]
    );
    return broadcast;
  });

  await audit.write({
    req, actorUserId: actorId, action: 'broadcast.created', objectType: 'broadcast',
    objectId: row.public_id, detail: { category, blocked: report.blocked },
  });

  return { id: row.public_id, status: row.status, review: report };
}

/** Move a clean draft into the approval queue. */
async function submit(actorId, publicId, { req } = {}) {
  const bc = await byPublicId(publicId);
  if (!['draft', 'lint_failed'].includes(bc.status)) {
    throw Object.assign(new Error(`This broadcast is ${bc.status} and cannot be resubmitted.`), { status: 409 });
  }

  const report = await review({
    subjectLine: bc.subject_line, body: bc.body, sources: bc.sources,
    subjectKey: bc.subject_key, category: bc.category,
  });

  if (report.blocked) {
    await db.query(
      `UPDATE broadcasts SET status = 'lint_failed', lint_report = $2, lint_passed_at = NULL WHERE id = $1`,
      [bc.id, JSON.stringify({ findings: report.findings, counts: report.counts })]
    );
    throw Object.assign(
      new Error('This message cannot be sent as written. See the findings.'),
      { status: 422, code: 'PB_NEUTRALITY_BLOCK', findings: report.findings }
    );
  }

  await db.query(
    `UPDATE broadcasts
        SET status = 'pending_approval', lint_report = $2, lint_passed_at = now(),
            balance_report = $3, body_sha256 = $4
      WHERE id = $1`,
    [
      bc.id,
      JSON.stringify({ findings: report.findings, counts: report.counts }),
      report.balance ? JSON.stringify(report.balance) : null,
      sha256(bc.body),
    ]
  );

  await audit.write({
    req, actorUserId: actorId, action: 'broadcast.submitted', objectType: 'broadcast',
    objectId: publicId, detail: { warnings: report.warnings.length },
  });

  return { status: 'pending_approval', review: report };
}

/**
 * Approve.
 *
 * Three things have to be true, and the first is enforced by the database:
 * the approver is not the author; the copy still passes; and every warning
 * has been explicitly acknowledged with a reason.
 *
 * That last one is why warnings are useful at all. A warning nobody has to
 * answer is a warning everybody scrolls past.
 */
async function approve(actorId, publicId, { acknowledgements = [], note, req } = {}) {
  const bc = await byPublicId(publicId);

  if (bc.status !== 'pending_approval') {
    throw Object.assign(new Error(`This broadcast is ${bc.status}, not awaiting approval.`), { status: 409 });
  }
  if (Number(bc.created_by) === Number(actorId)) {
    throw Object.assign(
      new Error('You wrote this one. Somebody else has to approve it — that is the point.'),
      { status: 403, code: 'PB_TWO_PERSON' }
    );
  }

  const report = await review({
    subjectLine: bc.subject_line, body: bc.body, sources: bc.sources,
    subjectKey: bc.subject_key, category: bc.category,
  });

  if (report.blocked) {
    throw Object.assign(
      new Error('This message no longer passes the neutrality checks. It cannot be approved.'),
      { status: 422, code: 'PB_NEUTRALITY_BLOCK', findings: report.findings }
    );
  }

  const acknowledged = new Set(acknowledgements.map((a) => a.rule));
  const unacknowledged = report.warnings.filter((w) => !acknowledged.has(w.rule));
  if (unacknowledged.length) {
    throw Object.assign(
      new Error(
        `Acknowledge every warning before approving, with a reason. Outstanding: ${
          [...new Set(unacknowledged.map((w) => w.rule))].join(', ')}`
      ),
      { status: 422, code: 'PB_UNACKNOWLEDGED', findings: unacknowledged }
    );
  }

  const hash = sha256(bc.body);

  await db.tx(async (client) => {
    await client.query(
      `UPDATE broadcasts
          SET status = 'approved', approved_by = $2, approved_at = now(), body_sha256 = $3
        WHERE id = $1`,
      [bc.id, actorId, hash]
    );
    await client.query(
      `INSERT INTO broadcast_approvals (broadcast_id, actor_id, decision, note, body_sha256, acknowledged)
       VALUES ($1,$2,'approve',$3,$4,$5)`,
      [bc.id, actorId, note || null, hash, JSON.stringify(acknowledgements)]
    );
  });

  await audit.write({
    req, actorUserId: actorId, action: 'broadcast.approved', objectType: 'broadcast',
    objectId: publicId, detail: { acknowledgements: acknowledgements.length },
  });

  return { status: 'approved' };
}

async function reject(actorId, publicId, { note, req } = {}) {
  const bc = await byPublicId(publicId);
  await db.tx(async (client) => {
    await client.query(`UPDATE broadcasts SET status = 'rejected' WHERE id = $1`, [bc.id]);
    await client.query(
      `INSERT INTO broadcast_approvals (broadcast_id, actor_id, decision, note, body_sha256)
       VALUES ($1,$2,'reject',$3,$4)`,
      [bc.id, actorId, note || null, sha256(bc.body)]
    );
  });
  await audit.write({
    req, actorUserId: actorId, action: 'broadcast.rejected', objectType: 'broadcast', objectId: publicId,
  });
  return { status: 'rejected' };
}

/**
 * Send.
 *
 * The hash comparison is the load-bearing line. Everything else in the
 * workflow is defeated by editing the body after approval, and this is what
 * closes it.
 */
async function send(actorId, publicId, { req } = {}) {
  const bc = await byPublicId(publicId);

  if (bc.status !== 'approved') {
    throw Object.assign(new Error(`This broadcast is ${bc.status}, not approved.`), { status: 409 });
  }
  if (!sha256(bc.body).equals(bc.body_sha256)) {
    throw Object.assign(
      new Error('The message has changed since it was approved. It has to be approved again.'),
      { status: 409, code: 'PB_HASH_MISMATCH' }
    );
  }

  const notify = require('../notify');
  if (!notify.sendingEnabled()) {
    throw Object.assign(new Error('Sending is switched off on this instance (SEND_ENABLED=0).'), { status: 503 });
  }

  // The event is the thing that fans out. Note `auto_send` stays false: a
  // broadcast reaches the queue because a human approved and sent it, and the
  // database constraint would refuse `auto_send` for an editorial category
  // anyway.
  const templateKey = await templateFor(bc.channel, bc.category);

  const event = await db.one(
    `INSERT INTO notification_events
       (dedup_key, category, subject_key, state_code, payload, template_key, sources, broadcast_id, auto_send)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [
      `broadcast:${bc.public_id}`, bc.category, bc.subject_key, null,
      JSON.stringify({
        headline: bc.subject_line || bc.title,
        messageBody: bc.body,
        // Rendered into the body rather than left as metadata: a citation
        // the reader cannot see is not a citation.
        sourceList: (bc.sources || [])
          .map((s) => `- ${s.label ? `${s.label}: ` : ''}${s.url}`)
          .join('\n'),
        candidates: await raceCandidates(bc.subject_key) || [],
      }),
      templateKey, JSON.stringify(bc.sources || []), bc.id,
    ]
  );

  if (!event) {
    throw Object.assign(new Error('This broadcast has already been queued.'), { status: 409 });
  }

  const outbox = require('../notify/outbox');
  const result = await outbox.fanout(event.id);

  await db.query(
    `UPDATE broadcasts
        SET status = 'sent', sent_by = $2, sent_at = now(),
            recipient_count = $3, published_at = now()
      WHERE id = $1`,
    [bc.id, actorId, result.inserted]
  );

  await audit.write({
    req, actorUserId: actorId, action: 'broadcast.send', objectType: 'broadcast',
    objectId: publicId, detail: { recipients: result.inserted, category: bc.category },
  });

  return { status: 'sent', recipients: result.inserted };
}

/**
 * How many people an audience would reach.
 *
 * Runs the same predicate as fanout without inserting anything, so an
 * approver sees the real number rather than an estimate.
 */
async function previewAudience(publicId) {
  const bc = await byPublicId(publicId);
  const row = await db.one(
    `SELECT count(DISTINCT u.id)::int AS reach
       FROM users u
       JOIN notification_preferences np ON np.user_id = u.id
       JOIN contact_channels cc ON cc.user_id = u.id AND cc.status = 'verified'
       JOIN broadcast_audience a ON a.broadcast_id = $1
      WHERE u.status = 'active'
        AND cc.channel = ANY(a.channels)
        AND ( EXISTS (SELECT 1 FROM subscriptions s
                       WHERE s.user_id = u.id AND s.subject_key = ANY(a.subject_keys))
           OR EXISTS (SELECT 1 FROM user_issues ui
                       WHERE ui.user_id = u.id AND ui.issue_slug = ANY(a.issue_slugs))
           OR (cardinality(a.state_codes) > 0 AND u.state_code = ANY(a.state_codes)))
        AND NOT EXISTS (SELECT 1 FROM suppressions sup
                         WHERE sup.address_hash = cc.address_hash AND sup.channel = cc.channel
                           AND (sup.expires_at IS NULL OR sup.expires_at > now()))`,
    [bc.id]
  );
  return { reach: row?.reach || 0 };
}

/* ---------------- helpers ---------------- */

async function byPublicId(publicId) {
  const bc = await db.one(
    `SELECT b.*, a.subject_keys, a.issue_slugs, a.state_codes, a.channels
       FROM broadcasts b LEFT JOIN broadcast_audience a ON a.broadcast_id = b.id
      WHERE b.public_id = $1`,
    [publicId]
  );
  if (!bc) throw Object.assign(new Error('No such broadcast.'), { status: 404 });
  return bc;
}

/** The generic wrapper template a broadcast body renders inside. */
async function templateFor(channel, category) {
  const key = `broadcast.${channel === 'sms' ? 'sms' : 'email'}`;
  const row = await db.one('SELECT key FROM message_templates WHERE key = $1 AND active', [key]);
  if (row) return row.key;
  void category;
  throw Object.assign(
    new Error(`The ${key} template is missing or inactive.`),
    { status: 500 }
  );
}

const list = (status, limit = 50) =>
  db.rows(
    `SELECT public_id, title, category, channel, status, created_at, sent_at, recipient_count,
            created_by, approved_by
       FROM broadcasts
      ${status ? 'WHERE status = $2' : ''}
      ORDER BY created_at DESC LIMIT $1`,
    status ? [limit, status] : [limit]
  );

module.exports = {
  create, submit, approve, reject, send, review, previewAudience, list,
  byPublicId, raceCandidates,
};

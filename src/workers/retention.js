/**
 * Deleting what we no longer need.
 *
 * Data minimization is not only about what you collect. Every row here has a
 * reason to exist and a point at which that reason stops applying, and the
 * default outcome of not writing this job is that a system quietly keeps
 * everything forever — which is both a compliance problem and, in a breach, a
 * much bigger one.
 *
 * Two retentions are deliberately long, and both for the same reason: they
 * are the evidence that we had permission. The TCPA's limitation period is
 * four years, so consent records and the audit log are kept for seven and are
 * never deleted by this job at all.
 */

const db = require('../db');

/**
 * The policy, as data.
 *
 * test/nonpartisan.js asserts that every table holding personal data appears
 * here, so adding a table with PII and forgetting to age it out fails the
 * build rather than becoming a slow accumulation nobody notices.
 */
const POLICY = [
  {
    table: 'sessions',
    why: 'A dead session is a row tying an IP and a user agent to a person.',
    sql: `DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`,
  },
  {
    table: 'login_tokens',
    why: 'Consumed or expired sign-in tokens are spent credentials plus an email address.',
    sql: `DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'`,
  },
  {
    table: 'auth_transactions',
    why: 'In-flight OAuth state is worthless ten minutes after the fact.',
    sql: `DELETE FROM auth_transactions WHERE expires_at < now() - interval '1 day'`,
  },
  {
    table: 'auth_attempts',
    why: 'Rate-limit counters outside their window are noise.',
    sql: `DELETE FROM auth_attempts WHERE window_start < now() - interval '7 days'`,
  },
  {
    table: 'webhook_events',
    why: 'Raw provider callbacks are for replay and forensics, not for keeping.',
    sql: `DELETE FROM webhook_events WHERE received_at < now() - interval '90 days'`,
  },
  {
    table: 'outbox',
    why:
      'The rendered body names somebody\'s state and the races they follow. The row itself stays ' +
      'so the dedup constraint keeps working; only the message text goes.',
    sql: `UPDATE outbox SET rendered_body = NULL, rendered_subject = NULL
           WHERE sent_at < now() - interval '30 days' AND rendered_body IS NOT NULL`,
  },
  {
    table: 'outbox',
    why: 'Cancelled and failed rows past any useful retry window.',
    sql: `DELETE FROM outbox
           WHERE status IN ('cancelled', 'failed') AND created_at < now() - interval '90 days'`,
  },
  {
    table: 'deliveries',
    why:
      'Kept 25 months so year-over-year deliverability is analysable; it holds an address hash, ' +
      'not an address.',
    sql: `DELETE FROM deliveries WHERE status_at < now() - interval '25 months'`,
  },
  {
    table: 'market_snapshots',
    why: 'Public market prices, no personal data. Thinned to hourly beyond 90 days.',
    sql: `DELETE FROM market_snapshots ms
           WHERE ms.captured_at < now() - interval '90 days'
             AND EXISTS (
               SELECT 1 FROM market_snapshots keep
                WHERE keep.market_id = ms.market_id
                  AND keep.contract_name = ms.contract_name
                  AND date_trunc('hour', keep.captured_at) = date_trunc('hour', ms.captured_at)
                  AND keep.id > ms.id)`,
  },
  {
    table: 'notification_events',
    why: 'Fanned-out events are only needed while their outbox rows exist.',
    sql: `DELETE FROM notification_events e
           WHERE e.fanned_out_at < now() - interval '180 days'
             AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = e.id)`,
  },
  {
    table: 'broadcast_suggestions',
    why: 'Machine suggestions nobody adopted go stale quickly.',
    sql: `UPDATE broadcast_suggestions SET status = 'expired', resolved_at = now()
           WHERE status = 'open' AND created_at < now() - interval '14 days'`,
  },
];

/**
 * Tables holding personal data that this job deliberately does NOT touch, and
 * why. Named explicitly so the coverage test can tell "kept on purpose" from
 * "forgotten".
 */
const RETAINED = {
  consent_records:
    'Seven years. This is the evidence that somebody agreed to be contacted, and the TCPA ' +
    'limitation period is four. Erasure redacts the address in place; the row and its hash chain stay.',
  audit_log:
    'Seven years, append-only. An audit log with a delete job is not an audit log.',
  users:
    'Until the account is deleted, which is the person\'s decision rather than a timer.',
  contact_channels:
    'Same lifetime as the account.',
  suppressions:
    'Forever, deliberately. This is how a deleted address stays un-mailable — the one record that ' +
    'must outlive everything else about a person.',
};

async function run() {
  const results = [];
  for (const rule of POLICY) {
    try {
      const res = await db.query(rule.sql);
      if (res.rowCount) results.push({ table: rule.table, rows: res.rowCount });
    } catch (err) {
      console.error(`retention: ${rule.table} —`, err.message);
      results.push({ table: rule.table, error: err.message });
    }
  }
  return { applied: results };
}

module.exports = { run, POLICY, RETAINED };

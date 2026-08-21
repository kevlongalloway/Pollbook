/**
 * Daily integrity check on the append-only logs.
 *
 * The audit log and the consent log are hash-chained (migration 008), which
 * makes tampering *detectable* — but only if somebody looks. This is the
 * looking. Without it the chain is a property nobody ever evaluates, which is
 * the same as not having one.
 *
 * A break means a row was edited or removed by a path that bypassed the
 * triggers: a migration that dropped one, a superuser session, or a restore
 * from a doctored dump. None of those are ordinary, and all of them are worth
 * waking somebody up for — so this logs loudly and records the failure on the
 * job row, where the portal's health view surfaces it.
 */

const audit = require('../lib/audit');

async function run() {
  const results = [];

  for (const table of ['audit_log', 'consent_records']) {
    const result = await audit.verifyChain(table, { limit: 20_000 });
    results.push(result);

    if (!result.ok) {
      // Deliberately thrown, so the scheduler records it as a failure and it
      // shows up as a red job rather than a line in a log nobody reads.
      const message =
        `INTEGRITY: the ${table} hash chain is broken at row ${result.brokenAt}. ` +
        'A row has been altered or removed outside the append-only path. ' +
        'Nothing after that point can be trusted as an unedited record.';
      console.error(message);
      throw new Error(message);
    }
  }

  return { chains: results };
}

module.exports = { run };

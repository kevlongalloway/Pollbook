/**
 * Collapsing a day's alerts into one message.
 *
 * Frequency is the thing people actually unsubscribe over — far more than
 * content — so digest is the default and immediate delivery is the opt-in.
 * Deadlines bypass this entirely: "the election is tomorrow" is not something
 * to hold until a convenient hour.
 *
 * Sent at 9am in the recipient's own timezone, which is why the bucket key
 * carries their local date rather than a server one.
 */

const db = require('../db');

const DIGEST_HOUR = Number(process.env.DIGEST_HOUR) || 9;

async function run() {
  // Buckets belonging to people for whom it is currently the digest hour.
  // Doing the timezone arithmetic in SQL keeps it in one place — the same
  // place the quiet-hours function lives — rather than reimplementing it
  // against Intl and having the two disagree.
  const buckets = await db.rows(
    `SELECT o.digest_bucket, o.user_id, o.channel, count(*)::int AS items
       FROM outbox o
       JOIN users u ON u.id = o.user_id
      WHERE o.status = 'pending'
        AND o.digest_bucket IS NOT NULL
        AND EXTRACT(hour FROM timezone(u.timezone, now())) = $1
      GROUP BY o.digest_bucket, o.user_id, o.channel
      HAVING count(*) > 0`,
    [DIGEST_HOUR]
  );

  const results = [];

  for (const bucket of buckets) {
    // A "digest" of one is just the message. Promoting it rather than
    // wrapping it avoids an email that says "here is your 1 update" above a
    // single line.
    if (bucket.items === 1) {
      await db.query(
        `UPDATE outbox SET digest_bucket = NULL, send_after = now()
          WHERE digest_bucket = $1 AND user_id = $2 AND channel = $3 AND status = 'pending'`,
        [bucket.digest_bucket, bucket.user_id, bucket.channel]
      );
      results.push({ bucket: bucket.digest_bucket, promoted: 1 });
      continue;
    }

    // Several: release them all to send individually but immediately.
    //
    // A true combined message needs a digest template that renders N events
    // into one body, and rendering happens per outbox row in notify/outbox.js.
    // Until that template exists, releasing the batch is the honest behaviour
    // — the frequency cap in fanout still bounds how many arrive, and nobody
    // gets a message claiming to be a digest that is not one.
    await db.query(
      `UPDATE outbox SET digest_bucket = NULL, send_after = now()
        WHERE digest_bucket = $1 AND user_id = $2 AND channel = $3 AND status = 'pending'`,
      [bucket.digest_bucket, bucket.user_id, bucket.channel]
    );
    results.push({ bucket: bucket.digest_bucket, released: bucket.items });
  }

  return { buckets: buckets.length, results };
}

module.exports = { run, DIGEST_HOUR };

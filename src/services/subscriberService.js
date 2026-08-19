/**
 * Accounts, what people follow, and their rights over their own data.
 *
 * The rule this module exists to hold: **an account adds capability and never
 * gates anything.** Everything Pollbook shows today stays visible to somebody
 * who never signs up, and every function here is reachable only from a route
 * that already required a session.
 */

const db = require('../db');
const audit = require('../lib/audit');
const consent = require('../lib/consent');
const subjects = require('../lib/subjects');
const { normalizeEmail, normalizePhone, addressHash, isPrivateRelay } = require('../lib/contacts');
const { getState } = require('../data/usStates');

/* ---------------- accounts ---------------- */

/**
 * Find or create the account behind a verified identity.
 *
 * The linking rule is the security-relevant part. `(provider, subject)` is
 * the identity key — never the email, which Apple may rotate behind a relay.
 * An email match links two providers to one account **only when both sides
 * are verified**: linking on an unverified address is the classic
 * pre-verified-email takeover, where somebody signs up with your address at a
 * provider that does not check, then signs in as you.
 */
async function findOrCreateFromIdentity(identity, { req, signupSource = {} } = {}) {
  const { provider, subject, email, emailVerified, displayName } = identity;
  const normalized = email ? normalizeEmail(email) : null;

  return db.tx(async (client) => {
    const existing = await client.query(
      `SELECT ui.user_id, u.status
         FROM user_identities ui
         JOIN users u ON u.id = ui.user_id
        WHERE ui.provider = $1 AND ui.provider_subject = $2`,
      [provider, subject]
    );

    if (existing.rows[0]) {
      const userId = existing.rows[0].user_id;
      await client.query(
        'UPDATE user_identities SET last_login_at = now() WHERE provider = $1 AND provider_subject = $2',
        [provider, subject]
      );
      return { userId, created: false };
    }

    // Link to an existing account only when both sides are proven.
    let userId = null;
    if (normalized && emailVerified) {
      const match = await client.query(
        `SELECT id FROM users
          WHERE email_normalized = $1 AND deleted_at IS NULL AND email_verified_at IS NOT NULL`,
        [normalized]
      );
      if (match.rows[0]) userId = match.rows[0].id;
    }

    let created = false;
    if (!userId) {
      if (!normalized) {
        throw Object.assign(
          new Error('That sign-in did not include an email address, so there is nothing to send alerts to.'),
          { status: 400 }
        );
      }
      const inserted = await client.query(
        `INSERT INTO users (public_id, email, email_normalized, email_verified_at, display_name, signup_source)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
         RETURNING id`,
        [email, normalized, emailVerified ? new Date() : null, displayName || null, JSON.stringify(signupSource)]
      );
      userId = inserted.rows[0].id;
      created = true;

      await client.query(
        `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId]
      );
      await client.query(
        `INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'subscriber') ON CONFLICT DO NOTHING`,
        [userId]
      );
    } else if (displayName) {
      // Apple hands the name over exactly once, on first authorization. If
      // this is that moment and we do not have one yet, take it.
      await client.query(
        'UPDATE users SET display_name = COALESCE(display_name, $2) WHERE id = $1',
        [userId, displayName]
      );
    }

    await client.query(
      `INSERT INTO user_identities
         (user_id, provider, provider_subject, email_at_provider, is_private_relay, last_login_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (provider, provider_subject) DO UPDATE SET last_login_at = now()`,
      [userId, provider, subject, email || null, Boolean(identity.isPrivateRelay || isPrivateRelay(email))]
    );

    return { userId, created };
  }).then(async (result) => {
    // Audited after the transaction commits, not inside it. audit.write() uses
    // the pool rather than the transaction's client, so a row written mid-
    // transaction cannot see the user it references and fails the foreign key.
    if (result.created) {
      await audit.write({
        req, actorUserId: result.userId, action: 'account.created', objectType: 'user',
        objectId: String(result.userId), subjectUserId: result.userId, detail: { provider },
      });
    }
    return result;
  });
}

/** The account behind a verified email, creating one if there is none. */
async function findOrCreateFromEmail(emailNormalized, { req, signupSource = {} } = {}) {
  return findOrCreateFromIdentity(
    {
      provider: 'email',
      subject: emailNormalized,
      email: emailNormalized,
      emailVerified: true,
      displayName: null,
    },
    { req, signupSource }
  );
}

/** Mark the account's email verified, and record the contact channel. */
async function confirmEmail(userId, email, { req, method = 'double_optin_click' } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw Object.assign(new Error('Not a usable email address.'), { status: 400 });

  await db.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
    [userId]
  );

  await db.query(
    `INSERT INTO contact_channels
       (user_id, channel, address, address_hash, is_primary, verified_at, status)
     VALUES ($1,'email',$2,$3,true, now(),'verified')
     ON CONFLICT (user_id, channel, address)
     DO UPDATE SET verified_at = COALESCE(contact_channels.verified_at, now()), status = 'verified'`,
    [userId, normalized, addressHash(normalized)]
  );

  await consent.record({
    userId, address: normalized, channel: 'email',
    consentType: 'email_updates', action: 'confirm', method, req,
  });
}

/* ---------------- profile ---------------- */

const DIGEST_MODES = ['immediate', 'daily', 'weekly'];

/**
 * Update the profile.
 *
 * The allowlist here is the data-minimization policy made executable: these
 * are the only fields an account has, so a future endpoint cannot quietly
 * start collecting more. There is no party field, no address field, no date
 * of birth, and adding one would take a migration and a code review rather
 * than a request body with an extra key.
 */
async function updateProfile(userId, patch, { req } = {}) {
  const updates = [];
  const values = [userId];
  const changed = [];

  const push = (column, value) => {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
    changed.push(column);
  };

  if (patch.displayName !== undefined) {
    const name = patch.displayName === null ? null : String(patch.displayName).trim().slice(0, 80);
    push('display_name', name || null);
  }

  if (patch.state !== undefined) {
    const code = patch.state === null ? null : String(patch.state).toUpperCase();
    if (code && !getState(code)) {
      throw Object.assign(new Error(`"${patch.state}" is not a state or DC.`), { status: 400 });
    }
    push('state_code', code);
  }

  if (patch.zip5 !== undefined) {
    const zip = patch.zip5 === null ? null : String(patch.zip5).trim();
    if (zip && !/^\d{5}$/.test(zip)) {
      throw Object.assign(
        new Error('ZIP must be five digits. Pollbook deliberately does not take ZIP+4, which identifies a household.'),
        { status: 400 }
      );
    }
    push('zip5', zip || null);
  }

  if (patch.timezone !== undefined) {
    const tz = String(patch.timezone || '');
    if (!isValidTimezone(tz)) {
      throw Object.assign(new Error(`"${tz}" is not a recognised time zone.`), { status: 400 });
    }
    push('timezone', tz);
  }

  if (patch.ageAttested === true) push('age_attested_at', new Date());

  if (updates.length === 0) return { changed: [] };

  await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $1`, values);
  await audit.write({
    req, actorUserId: userId, action: 'account.updated', objectType: 'user',
    objectId: String(userId), subjectUserId: userId, detail: { fields: changed },
  });

  return { changed };
}

/** Does Intl recognise this zone? Cheaper and more current than a table. */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Notification preferences. Quiet hours are clamped to the TCPA window. */
async function updatePreferences(userId, patch, { req } = {}) {
  const columns = {
    emailEnabled: 'email_enabled', smsEnabled: 'sms_enabled',
    deadlines: 'cat_deadlines', odds: 'cat_odds', news: 'cat_news',
    filings: 'cat_filings', product: 'cat_product',
  };

  const updates = [];
  const values = [userId];
  const push = (column, value) => {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  };

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] !== undefined) push(column, Boolean(patch[key]));
  }

  if (patch.digestMode !== undefined) {
    if (!DIGEST_MODES.includes(patch.digestMode)) {
      throw Object.assign(new Error(`Digest mode must be one of: ${DIGEST_MODES.join(', ')}.`), { status: 400 });
    }
    push('digest_mode', patch.digestMode);
  }

  // A user may narrow their quiet hours but never widen them past the legal
  // window — 8am to 9pm recipient-local is a floor, not a default.
  if (patch.quietStartHour !== undefined) {
    push('quiet_start_hour', Math.max(8, Math.min(22, Number(patch.quietStartHour) || 8)));
  }
  if (patch.quietEndHour !== undefined) {
    push('quiet_end_hour', Math.min(21, Math.max(9, Number(patch.quietEndHour) || 21)));
  }
  if (patch.maxPerWeek !== undefined) {
    push('max_per_week', Math.max(0, Math.min(20, Number(patch.maxPerWeek) || 5)));
  }

  if (updates.length === 0) return { changed: false };

  values.push(new Date());
  updates.push(`updated_at = $${values.length}`);

  await db.query(`UPDATE notification_preferences SET ${updates.join(', ')} WHERE user_id = $1`, values);
  await audit.write({
    req, actorUserId: userId, action: 'preferences.updated', objectType: 'user',
    objectId: String(userId), subjectUserId: userId,
  });
  return { changed: true };
}

/* ---------------- subscriptions ---------------- */

/**
 * Follow something.
 *
 * Two rows go in for a race: the race itself, and — as `source='derived'` —
 * the cycle-free seat behind it. The seat is what still means something in
 * 2028. Following the race alone would leave somebody silently unsubscribed
 * the day after an election, which is exactly when they are most likely to
 * care about the next one.
 */
async function subscribe(userId, key, { label, req } = {}) {
  const parsed = subjects.parseSubjectKey(key);
  if (!parsed) {
    throw Object.assign(new Error(`"${key}" is not something Pollbook can follow.`), { status: 400 });
  }

  await ensureSubject(parsed, label);

  await db.query(
    `INSERT INTO subscriptions (user_id, subject_key, source)
     VALUES ($1, $2, 'explicit')
     ON CONFLICT (user_id, subject_key) DO NOTHING`,
    [userId, parsed.canonical]
  );

  if (parsed.seatKey) {
    const seat = subjects.parseSubjectKey(parsed.seatKey);
    await ensureSubject(seat, seatLabel(parsed, label));
    await db.query(
      `INSERT INTO subscriptions (user_id, subject_key, source)
       VALUES ($1, $2, 'derived')
       ON CONFLICT (user_id, subject_key) DO NOTHING`,
      [userId, parsed.seatKey]
    );
  }

  await audit.write({
    req, actorUserId: userId, action: 'subscription.added', objectType: 'subject',
    objectId: parsed.canonical, subjectUserId: userId,
  });

  return { key: parsed.canonical, seatKey: parsed.seatKey || null };
}

/**
 * Stop following something.
 *
 * The derived seat goes too, but only when no other race on that seat is
 * still followed — otherwise unfollowing the 2026 race would silently cancel
 * a subscription the user made through the 2028 one.
 */
async function unsubscribeFrom(userId, key, { req } = {}) {
  const parsed = subjects.parseSubjectKey(key);
  if (!parsed) throw Object.assign(new Error('Unknown subscription.'), { status: 400 });

  await db.query('DELETE FROM subscriptions WHERE user_id = $1 AND subject_key = $2', [
    userId, parsed.canonical,
  ]);

  if (parsed.seatKey) {
    await db.query(
      `DELETE FROM subscriptions
        WHERE user_id = $1 AND subject_key = $2 AND source = 'derived'
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s2
             JOIN subjects sj ON sj.key = s2.subject_key
            WHERE s2.user_id = $1 AND sj.seat_key = $2)`,
      [userId, parsed.seatKey]
    );
  }

  await audit.write({
    req, actorUserId: userId, action: 'subscription.removed', objectType: 'subject',
    objectId: parsed.canonical, subjectUserId: userId,
  });
  return { key: parsed.canonical };
}

/** Register a subject, or refresh its label snapshot. Never deletes. */
async function ensureSubject(parsed, label) {
  // The seat row has to exist first: `subjects.seat_key` is a self-referencing
  // foreign key, so inserting the race before its seat fails.
  if (parsed.seatKey) {
    const seat = subjects.parseSubjectKey(parsed.seatKey);
    await db.query(
      `INSERT INTO subjects (key, type, state_code, label, last_verified_at)
       VALUES ($1,'seat',$2,$3, now())
       ON CONFLICT (key) DO NOTHING`,
      [seat.canonical, seat.stateCode, seatLabel(parsed, label)]
    );
  }

  await db.query(
    `INSERT INTO subjects (key, type, seat_key, state_code, cycle, label, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (key) DO UPDATE
       SET label = COALESCE(NULLIF(EXCLUDED.label, ''), subjects.label),
           label_updated_at = now()`,
    [
      parsed.canonical, parsed.type,
      parsed.type === 'race' ? parsed.seatKey : null,
      parsed.stateCode || null, parsed.cycle || null,
      label || defaultLabel(parsed),
    ]
  );
}

/** A readable fallback when the caller had no label to hand. */
function defaultLabel(parsed) {
  const state = parsed.stateCode ? getState(parsed.stateCode)?.name || parsed.stateCode : null;
  if (parsed.type === 'race' || parsed.type === 'seat') {
    const office = parsed.office === 'house'
      ? `U.S. House ${parsed.district === '00' ? 'At-Large' : `District ${Number(parsed.district)}`}`
      : parsed.office === 'senate' ? 'U.S. Senate' : 'Governor';
    return `${office} — ${state}${parsed.cycle ? ` (${parsed.cycle})` : ''}`;
  }
  if (parsed.type === 'election') return `${state || 'U.S.'} ${parsed.kind} election ${parsed.cycle}`;
  if (parsed.type === 'state') return state || parsed.stateCode;
  return subjects.toLegacyId(parsed.canonical);
}

/** The seat's label is the race's without the cycle. */
const seatLabel = (parsed, label) =>
  (label ? String(label).replace(/\s*\(?\b(19|20)\d{2}\)?\s*$/, '').trim() : '') ||
  defaultLabel({ ...parsed, cycle: null, type: 'seat' });

/** Everything a user follows, with the seat rows folded away. */
async function listSubscriptions(userId) {
  return db.rows(
    `SELECT s.subject_key AS key, s.source, s.created_at, s.muted_until,
            sj.type, sj.label, sj.state_code, sj.cycle, sj.status
       FROM subscriptions s
       JOIN subjects sj ON sj.key = s.subject_key
      WHERE s.user_id = $1 AND s.source = 'explicit'
      ORDER BY sj.cycle DESC NULLS LAST, sj.label ASC`,
    [userId]
  );
}

/* ---------------- issues ---------------- */

async function listIssues() {
  return db.rows(
    'SELECT slug, name, description FROM issues WHERE active ORDER BY sort_order ASC, name ASC'
  );
}

/** Replace the user's issue selections wholesale. */
async function setIssues(userId, slugs, { req } = {}) {
  const wanted = [...new Set((Array.isArray(slugs) ? slugs : []).map(String))];

  const valid = await db.rows(
    'SELECT slug FROM issues WHERE active AND slug = ANY($1::text[])',
    [wanted]
  );
  const validSlugs = valid.map((r) => r.slug);

  await db.tx(async (client) => {
    await client.query('DELETE FROM user_issues WHERE user_id = $1', [userId]);
    if (validSlugs.length) {
      await client.query(
        `INSERT INTO user_issues (user_id, issue_slug)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [userId, validSlugs]
      );
    }
  });

  await audit.write({
    req, actorUserId: userId, action: 'issues.updated', objectType: 'user',
    objectId: String(userId), subjectUserId: userId, detail: { count: validSlugs.length },
  });

  return { issues: validSlugs, rejected: wanted.filter((s) => !validSlugs.includes(s)) };
}

const userIssues = (userId) =>
  db.rows(
    `SELECT i.slug, i.name FROM user_issues ui
       JOIN issues i ON i.slug = ui.issue_slug
      WHERE ui.user_id = $1 ORDER BY i.sort_order`,
    [userId]
  );

/* ---------------- phone ---------------- */

/**
 * Start SMS enrolment.
 *
 * Deliberately two steps. Storing the number is not consent; the confirming
 * reply is. So this records the number as pending and the express-consent
 * grant, then sends a confirmation the user has to answer — and nothing is
 * sent to that number until they do.
 */
async function startPhoneVerification(userId, phone, { req, consentVersion } = {}) {
  const e164 = normalizePhone(phone);
  if (!e164) {
    throw Object.assign(
      new Error('That does not look like a mobile number. Use a 10-digit US number, or +country format.'),
      { status: 400 }
    );
  }

  const suppressed = await consent.isSuppressed(e164, 'sms');
  if (suppressed === 'stop_keyword') {
    throw Object.assign(
      new Error('That number replied STOP to us before. Text START to our number to restart, and we will confirm.'),
      { status: 409 }
    );
  }

  const { secret, hash } = require('../lib/tokens');
  const code = String(Math.floor(100000 + Math.random() * 900000)); // six digits, human-typeable

  await db.query(
    `INSERT INTO contact_channels
       (user_id, channel, address, address_hash, verify_token_hash, verify_sent_at, status)
     VALUES ($1,'sms',$2,$3,$4, now(),'pending')
     ON CONFLICT (user_id, channel, address)
     DO UPDATE SET verify_token_hash = $4, verify_sent_at = now(),
                   verify_attempts = 0,
                   status = CASE WHEN contact_channels.status = 'verified'
                                 THEN 'verified' ELSE 'pending' END`,
    [userId, e164, addressHash(e164), hash(code)]
  );

  await consent.record({
    userId, address: e164, channel: 'sms', consentType: 'sms_alerts',
    action: 'grant', method: 'web_form', version: consentVersion, req,
    evidence: { stage: 'pending_double_optin' },
  });

  void secret; // the six-digit code is the credential here, not a long token
  return { phone: e164, code };
}

/** Complete SMS enrolment. Only now is the number sendable. */
async function confirmPhone(userId, phone, code, { req } = {}) {
  const { hash } = require('../lib/tokens');
  const e164 = normalizePhone(phone);
  if (!e164) throw Object.assign(new Error('Unknown number.'), { status: 400 });

  const row = await db.one(
    `UPDATE contact_channels
        SET status = 'verified', verified_at = now(), verify_token_hash = NULL
      WHERE user_id = $1 AND channel = 'sms' AND address = $2
        AND verify_token_hash = $3
        AND verify_sent_at > now() - interval '30 minutes'
      RETURNING id`,
    [userId, e164, hash(String(code))]
  );

  if (!row) {
    await db.query(
      `UPDATE contact_channels SET verify_attempts = verify_attempts + 1
        WHERE user_id = $1 AND channel = 'sms' AND address = $2`,
      [userId, e164]
    );
    throw Object.assign(new Error('That code did not match, or it has expired.'), { status: 400 });
  }

  await db.query('UPDATE notification_preferences SET sms_enabled = true WHERE user_id = $1', [userId]);

  await consent.record({
    userId, address: e164, channel: 'sms', consentType: 'sms_alerts',
    action: 'confirm', method: 'double_optin_sms', req,
  });

  return { phone: e164, verified: true };
}

/* ---------------- data rights ---------------- */

/**
 * Everything held about one person, in one object.
 *
 * Includes the consent history verbatim, because "what did I agree to" is the
 * question people actually have and the log is the only honest answer.
 */
async function exportData(userId, { req } = {}) {
  const [user, prefs, subs, issues, contacts, deliveries] = await Promise.all([
    db.one(
      `SELECT public_id, email, display_name, state_code, zip5, timezone, locale,
              age_attested_at, status, signup_source, created_at, last_login_at
         FROM users WHERE id = $1`,
      [userId]
    ),
    db.one('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]),
    listSubscriptions(userId),
    userIssues(userId),
    db.rows(
      `SELECT channel, address, status, verified_at, created_at
         FROM contact_channels WHERE user_id = $1`,
      [userId]
    ),
    db.rows(
      `SELECT channel, provider, status, status_at
         FROM deliveries WHERE user_id = $1 ORDER BY status_at DESC LIMIT 500`,
      [userId]
    ),
  ]);

  const consents = [];
  for (const contact of contacts) {
    consents.push(...(await consent.history(contact.address)));
  }

  await audit.write({
    req, actorUserId: userId, action: 'dsar.export', objectType: 'user',
    objectId: String(userId), subjectUserId: userId,
  });

  return {
    exportedAt: new Date().toISOString(),
    note:
      'This is everything Pollbook holds about you. Note what is not here: we do not store your ' +
      'party affiliation, political views, voting history, home address, or date of birth, and we ' +
      'do not buy or match against voter files.',
    account: user,
    preferences: prefs,
    subscriptions: subs,
    issues,
    contactChannels: contacts,
    consentHistory: consents,
    recentDeliveries: deliveries,
  };
}

/**
 * Delete an account.
 *
 * Personal data goes; the suppression entry and the redacted consent history
 * stay. That combination is what makes "delete me" and "never contact me
 * again" compatible instead of contradictory — without the tombstone, a
 * deleted address could be re-added by an import and mailed again, which is
 * the outcome the person was trying to prevent.
 *
 * The consent rows are redacted in place rather than removed: the append-only
 * trigger permits exactly this one mutation, so the hash chain stays intact
 * and the record that a consent existed survives without the address.
 */
async function deleteAccount(userId, { req, reason = 'user_request' } = {}) {
  const contacts = await db.rows(
    'SELECT channel, address FROM contact_channels WHERE user_id = $1',
    [userId]
  );

  for (const contact of contacts) {
    await consent.suppress(contact.address, contact.channel, 'erasure', {
      source: 'account_deletion',
    });
    await consent.record({
      userId, address: contact.address, channel: contact.channel,
      consentType: contact.channel === 'sms' ? 'sms_alerts' : 'email_updates',
      action: 'revoke', method: 'account_deletion', req,
    });
  }

  await db.tx(async (client) => {
    await client.query(
      `UPDATE consent_records SET address = NULL
        WHERE user_id = $1 AND address IS NOT NULL`,
      [userId]
    );
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_identities WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM contact_channels WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_issues WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM outbox WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE users
          SET status = 'deleted', deleted_at = now(),
              email = 'deleted+' || public_id || '@invalid',
              email_normalized = 'deleted+' || public_id || '@invalid',
              display_name = NULL, zip5 = NULL, state_code = NULL, signup_source = '{}'::jsonb
        WHERE id = $1`,
      [userId]
    );
  });

  await audit.write({
    req, actorUserId: userId, action: 'dsar.erase', objectType: 'user',
    objectId: String(userId), subjectUserId: userId, detail: { reason },
  });

  return { deleted: true };
}

module.exports = {
  findOrCreateFromIdentity, findOrCreateFromEmail, confirmEmail,
  updateProfile, updatePreferences,
  subscribe, unsubscribeFrom, listSubscriptions, ensureSubject, defaultLabel,
  listIssues, setIssues, userIssues,
  startPhoneVerification, confirmPhone,
  exportData, deleteAccount,
  isValidTimezone, DIGEST_MODES,
};

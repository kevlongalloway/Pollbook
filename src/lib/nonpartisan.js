/**
 * Neutrality enforcement for anything Pollbook sends.
 *
 * A nonpartisan claim that rests on good intentions is worth nothing. Once
 * this product can put words in forty thousand inboxes, the honest question is
 * not "do we mean well" but "what stops a partisan message going out on a
 * Tuesday when everyone is tired". This module is most of the answer, and it
 * runs at four points: template save, broadcast save, broadcast approval, and
 * again inside the sender — because copy that changed after approval is
 * exactly the case a single check at approval time would miss.
 *
 * Five mechanisms, roughly in order of how much they would matter in a bad
 * week:
 *
 *  1. **The balance rule.** If a message names any candidate in a race, it
 *     must name all of them, in alphabetical order by surname. Ordering by
 *     odds or by incumbency is a thumb on the scale that nobody notices, so
 *     the order is checked too.
 *  2. **Express advocacy is blocked**, using the *Buckley v. Valeo* magic
 *     words as a mechanical test — "vote for", "defeat", "elect" — near a
 *     name.
 *  3. **Fundraising links are blocked outright.** A civic reminder that links
 *     to a donation page has stopped being a civic reminder.
 *  4. **Loaded language is flagged** and cannot be ignored silently: an
 *     approver has to acknowledge each warning with a reason, and the
 *     acknowledgement is stored.
 *  5. **Party asymmetry is measured**, because copy can be scrupulously
 *     neutral sentence by sentence and still only ever be about one side.
 *
 * What this module deliberately does *not* try to be is a general-purpose
 * bias detector. It is a set of narrow, mechanical, testable rules with a
 * corpus behind them in test/nonpartisan.js. A rule that cannot be tested is
 * not in here.
 *
 * Severity contract:
 *   'block' — the send cannot proceed. No override exists in the UI or the API.
 *   'warn'  — an approver must acknowledge it with a recorded reason.
 */

/* ---------------- vocabularies ----------------

   All word-boundary anchored, following the ELECTION_PATTERNS convention in
   sources/congress.js: "selection" must not match "election", and
   "devoting" must not match "voting".                                       */

// Buckley's magic words, plus the constructions that mean the same thing.
const ADVOCACY = [
  { re: /\bvote\s+for\b/i, label: 'vote for' },
  { re: /\bvote\s+against\b/i, label: 'vote against' },
  { re: /\bcast\s+(?:your|a)\s+ballot\s+for\b/i, label: 'cast your ballot for' },
  { re: /\bre-?elect\b/i, label: 're-elect' },
  { re: /\belect\s+(?![a-z])/i, label: 'elect' },
  { re: /\bdefeat\b/i, label: 'defeat' },
  { re: /\bthrow\s+(?:him|her|them|\w+)\s+out\b/i, label: 'throw out' },
  { re: /\bsend\s+(?:him|her|them|\w+)\s+(?:home|packing)\b/i, label: 'send home' },
  { re: /\bflip\s+(?:this|the|that)\s+(?:seat|district|state|chamber)\b/i, label: 'flip the seat' },
  { re: /\bhold\s+the\s+line\b/i, label: 'hold the line' },
  { re: /\bendorse[sd]?\b/i, label: 'endorse' },
  { re: /\bstand\s+with\b/i, label: 'stand with' },
  { re: /\bstop\s+(?=[A-Z])/, label: 'stop <name>' },
];

/*
 * Disclaiming advocacy is not advocacy.
 *
 * "We will never tell you who to vote for" is one of the most useful
 * sentences this product can say, and a naive rule blocks it. So a negation
 * within a short window before the phrase exempts it — narrow enough that
 * "don't vote for Smith" is not exempted, because that has a name after it and
 * the name check below fires anyway.
 */
const NEGATED_ADVOCACY =
  /\b(?:never|not|no|don'?t|do\s+not|won'?t|will\s+not|cannot|can'?t|refuse\s+to|without)\b[^.!?]{0,60}$/i;

// Applied to a party or a candidate, each of these announces a side.
const PEJORATIVES = [
  { re: /\bdemonrats?\b/i, label: 'party slur' },
  { re: /\blibtards?\b/i, label: 'party slur' },
  { re: /\brepublicans?\s+party\b/i, label: 'party name distortion' },
  { re: /\bdemocrat\s+party\b/i, label: 'party name distortion (the party is the Democratic Party)' },
  { re: /\bRINOs?\b/, label: 'factional slur' },
  { re: /\bDINOs?\b/, label: 'factional slur' },
  { re: /\bradical\s+(?:left|right)\b/i, label: 'partisan framing' },
  { re: /\bfar-?(?:left|right)\s+(?:mob|extremis|agenda|radical)/i, label: 'partisan framing' },
  { re: /\b(?:leftist|right-?wing)\s+(?:agenda|mob|extremis)/i, label: 'partisan framing' },
  { re: /\bwoke\s+(?:agenda|mob|left)\b/i, label: 'partisan framing' },
  { re: /\bdeep\s+state\b/i, label: 'partisan framing' },
  { re: /\bmaga\s+(?:extremis|republican)/i, label: 'partisan framing' },
];

// Loaded adjectives and nouns. Legitimate in a quotation, which is why these
// warn rather than block — but they have to be acknowledged.
const VALENCE = [
  /\bextremists?\b/i, /\bextreme\b/i, /\bdangerous\b/i, /\bcorrupt(?:ion)?\b/i,
  /\bdisgraced\b/i, /\bfailed\b/i, /\bdisastrous\b/i, /\breckless\b/i,
  /\bcommon-?sense\b/i, /\bcourageous\b/i, /\bprincipled\b/i, /\bbrave\b/i,
  /\bpatriots?\b/i, /\bdefender\s+of\b/i, /\bchampion\s+of\b/i, /\bfighting\s+for\b/i,
  /\bsensible\b/i, /\bunhinged\b/i, /\bcatastroph/i,
];

const FRAMING_NOUNS = [
  /\bagenda\b/i, /\bregime\b/i, /\bcabal\b/i, /\bthe\s+establishment\b/i,
  /\bthe\s+elites?\b/i, /\bthe\s+mob\b/i, /\bpower\s+grab\b/i, /\bwar\s+on\s+\w+/i,
];

// Unsourced attribution — the construction that smuggles a claim in without
// owning it.
const WEASEL = [
  /\bcritics\s+say\b/i, /\bmany\s+believe\b/i, /\bsome\s+say\b/i,
  /\bit\s+is\s+said\b/i, /\breportedly\b/i, /\bsources\s+say\b/i,
  /\bwidely\s+(?:seen|viewed|regarded)\b/i, /\beveryone\s+knows\b/i,
];

/*
 * Fundraising. Blocked in the body and in the sources list.
 *
 * This is the brightest line in the file. Everything else here is about tone;
 * this is about what the message is *for*. A get-out-the-vote reminder that
 * links to a donation page is a fundraising email wearing a civic costume,
 * and no amount of balanced language fixes that.
 */
const FUNDRAISING = [
  /\bactblue\.com\b/i,
  /\bwinred\.com\b/i,
  /\bsecure\.anedot\.com\b/i,
  /\bdonorbox\.org\b/i,
  /\bfundrais(?:e|ing)\b/i,
  /\bchip\s+in\b/i,
  /\bdonate\b/i,
  /\bcontribute\s+\$/i,
  /\/donate\b/i,
  /\bmatch(?:ed|ing)?\s+(?:your\s+)?(?:gift|donation)\b/i,
];

/**
 * Domains a source citation may point at.
 *
 * Official records first, then the neutral aggregators this site already
 * relies on. Anything else is a warning rather than a block — a legitimate
 * local newspaper will not be on any list somebody maintains by hand, and
 * refusing it would push editors toward the handful of national outlets that
 * are, which is its own kind of bias.
 */
const SOURCE_ALLOW = [
  /(^|\.)fec\.gov$/i, /(^|\.)congress\.gov$/i, /(^|\.)senate\.gov$/i, /(^|\.)house\.gov$/i,
  /(^|\.)vote\.gov$/i, /(^|\.)usa\.gov$/i, /(^|\.)census\.gov$/i, /(^|\.)gao\.gov$/i,
  /(^|\.)supremecourt\.gov$/i, /(^|\.)uscourts\.gov$/i, /(^|\.)eac\.gov$/i,
  /\.gov$/i, /\.us$/i,
  /(^|\.)predictit\.org$/i, /(^|\.)wikipedia\.org$/i, /(^|\.)opensecrets\.org$/i,
  /(^|\.)ballotpedia\.org$/i, /(^|\.)ncsl\.org$/i, /(^|\.)crsreports\.congress\.gov$/i,
];

/**
 * Issue names that are positions wearing a subject's clothes.
 *
 * "Voting access" and "election integrity" describe the same bills; picking
 * between them announces a side before a word of copy is written. Same for
 * "reproductive health policy" vs "the right to life", "firearms policy" vs
 * "gun rights". The taxonomy gets named the way a librarian would name it.
 */
const POSITION_CODED = [
  /\bpro-?life\b/i, /\bpro-?choice\b/i, /\bright\s+to\s+life\b/i,
  /\bgun\s+(?:rights|control|safety|grab)\b/i, /\bsecond\s+amendment\b/i,
  /\belection\s+integrity\b/i, /\bballot\s+security\b/i, /\bvoter\s+fraud\b/i,
  /\bamnesty\b/i, /\billegal\s+aliens?\b/i, /\bopen\s+borders\b/i, /\bborder\s+crisis\b/i,
  /\bfamily\s+values\b/i, /\breligious\s+liberty\b/i, /\bwar\s+on\b/i,
  /\bcommon-?sense\b/i, /\bwoke\b/i, /\bcancel\s+culture\b/i,
  /\bjob-?killing\b/i, /\bhandouts?\b/i, /\bentitlement\s+reform\b/i,
  /\btax\s+relief\b/i, /\bdeath\s+tax\b/i, /\bgovernment\s+overreach\b/i,
];

/** Every key the audience selector is permitted to carry. */
const AUDIENCE_KEYS = [
  'subjectKeys', 'includeSeatRollup', 'issueSlugs', 'stateCodes', 'channels', 'activeSinceDays',
];

/* ---------------- helpers ---------------- */

const WINDOW = 60;

function finding(rule, severity, match, text, note) {
  return {
    rule,
    severity,
    span: match.index,
    text: String(match[0]).slice(0, 80),
    context: text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30).trim(),
    note,
  };
}

/** All matches of a global-ised pattern, with indices. */
function scan(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  let m;
  while ((m = g.exec(text)) !== null) {
    out.push(m);
    if (m.index === g.lastIndex) g.lastIndex += 1; // zero-width guard
  }
  return out;
}

/**
 * The surname of a candidate, for balance checks.
 *
 * FEC names arrive as "LAST, FIRST MIDDLE" and the normalizer in sources/fec.js
 * turns most of them into "First Last", so both shapes turn up. Suffixes are
 * dropped because "Smith Jr." and "Smith" have to sort and match as the same
 * person.
 */
function surnameOf(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const base = raw.includes(',') ? raw.slice(0, raw.indexOf(',')) : raw;
  const parts = base
    .replace(/\b(?:jr|sr|ii|iii|iv|md|phd|esq)\.?\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (parts.at(-1) || '').toLowerCase();
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------------- the linter ---------------- */

/**
 * Lint outbound copy.
 *
 * @param {string} body            the rendered message
 * @param {object} [opts]
 * @param {Array}  [opts.candidates] `[{ name, party }]` for the race in scope
 * @param {Array}  [opts.sources]    `[{ label, url }]`
 * @param {string} [opts.subject]    the subject line, linted alongside the body
 * @returns {{ok: boolean, blocked: boolean, findings: Array, counts: object}}
 */
function lint(body, opts = {}) {
  const subject = String(opts.subject || '');
  const text = subject ? `${subject}\n\n${String(body || '')}` : String(body || '');
  const findings = [];
  const names = (opts.candidates || []).map((c) => surnameOf(c.name)).filter(Boolean);

  /* --- fundraising: the brightest line --- */
  for (const re of FUNDRAISING) {
    for (const m of scan(text, re)) {
      findings.push(finding('fundraising', 'block', m, text,
        'Pollbook does not solicit or link to political money. A reminder that links to a donation page is a fundraising message.'));
    }
  }

  /* --- express advocacy --- */
  for (const { re, label } of ADVOCACY) {
    for (const m of scan(text, re)) {
      const before = text.slice(Math.max(0, m.index - 70), m.index);
      if (NEGATED_ADVOCACY.test(before)) continue; // "we will never tell you who to vote for"

      const after = text.slice(m.index, m.index + m[0].length + WINDOW);
      const namesNearby = names.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(after));
      const properNoun = /\s[A-Z][a-z]{2,}/.test(after.slice(m[0].length));
      const partyNearby = /\b(?:democrat|republican|libertarian|green|GOP)/i.test(after);

      const severity = namesNearby || partyNearby || properNoun ? 'block' : 'warn';
      findings.push(finding('express-advocacy', severity, m, text,
        `"${label}" is express advocacy under the Buckley magic-words test. Pollbook reports what candidates say and where money comes from; it never asks anyone to vote a particular way.`));
    }
  }

  /* --- pejoratives and partisan framing --- */
  for (const { re, label } of PEJORATIVES) {
    for (const m of scan(text, re)) {
      findings.push(finding('partisan-framing', 'block', m, text, label));
    }
  }

  /* --- loaded language, near a name --- */
  for (const re of [...VALENCE, ...FRAMING_NOUNS]) {
    for (const m of scan(text, re)) {
      const around = text.slice(Math.max(0, m.index - WINDOW), m.index + m[0].length + WINDOW);
      const nearName = names.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(around));
      findings.push(finding('loaded-language', nearName ? 'block' : 'warn', m, text,
        nearName
          ? 'A valence-loaded word within a sentence of a candidate name is a characterization, not a report.'
          : 'Loaded wording. Acceptable inside a direct quotation, attributed — otherwise rephrase.'));
    }
  }

  /* --- unsourced attribution --- */
  for (const re of WEASEL) {
    for (const m of scan(text, re)) {
      findings.push(finding('unsourced-claim', 'warn', m, text,
        'Attribute this to a named source, or drop it. "Critics say" is an assertion with the author\'s name filed off.'));
    }
  }

  /* --- citations --- */
  const sources = Array.isArray(opts.sources) ? opts.sources : [];
  if (sources.length === 0) {
    findings.push({
      rule: 'no-sources', severity: 'block', span: 0, text: '', context: '',
      note: 'Every message carries at least one source. If a claim cannot be sourced it does not go out.',
    });
  }
  findings.push(...checkSourceUrls(sources));

  /* --- party asymmetry --- */
  const counts = partyMentions(text);
  const asymmetry = asymmetryFinding(counts);
  if (asymmetry) findings.push(asymmetry);

  const blocked = findings.some((f) => f.severity === 'block');
  return { ok: !blocked && findings.length === 0, blocked, findings, counts };
}

/**
 * Source URLs: https only, no fundraising, and a note when a domain is
 * outside the list of official and neutral sources.
 */
function checkSourceUrls(sources) {
  const findings = [];
  for (const src of sources || []) {
    const raw = typeof src === 'string' ? src : src?.url;
    let url;
    try {
      url = new URL(String(raw));
    } catch {
      findings.push({
        rule: 'source-invalid', severity: 'block', span: 0, text: String(raw).slice(0, 80),
        context: '', note: 'Not a URL.',
      });
      continue;
    }

    if (url.protocol !== 'https:') {
      findings.push({
        rule: 'source-insecure', severity: 'block', span: 0, text: url.href.slice(0, 80),
        context: '', note: 'Sources must be https. A cited page a reader cannot verify safely is not a citation.',
      });
      continue;
    }

    if (FUNDRAISING.some((re) => re.test(url.href))) {
      findings.push({
        rule: 'fundraising', severity: 'block', span: 0, text: url.href.slice(0, 80),
        context: '', note: 'Fundraising domain.',
      });
      continue;
    }

    if (!SOURCE_ALLOW.some((re) => re.test(url.hostname))) {
      findings.push({
        rule: 'source-unrecognized', severity: 'warn', span: 0, text: url.hostname,
        context: '',
        note: 'Not an official record or a source Pollbook already relies on. Legitimate for local reporting — confirm the outlet and acknowledge.',
      });
    }
  }
  return findings;
}

/** Mentions of each party, by name and by common abbreviation. */
function partyMentions(text) {
  const count = (re) => scan(text, re).length;
  return {
    democratic: count(/\b(?:democrat(?:ic|s)?|DEM|\(D[-)])/gi),
    republican: count(/\b(?:republicans?|GOP|\(R[-)])/gi),
    other: count(/\b(?:libertarians?|green\s+party|independents?)\b/gi),
  };
}

/**
 * Flag copy that is scrupulously neutral sentence by sentence and still only
 * ever about one side.
 *
 * A warning rather than a block, because plenty of one-sided copy is simply
 * true: "the Republican primary is on Tuesday" mentions one party for the
 * good reason that only one party is holding a primary. The threshold is
 * deliberately loose so it fires on pattern, not on a single sentence.
 */
function asymmetryFinding(counts) {
  const { democratic: d, republican: r } = counts;
  const total = d + r;
  if (total < 4) return null;
  const [hi, lo] = d >= r ? [d, r] : [r, d];
  if (hi < lo * 3) return null;
  return {
    rule: 'party-asymmetry', severity: 'warn', span: 0, text: `${d} vs ${r}`, context: '',
    note: `One party is mentioned ${hi} times and the other ${lo}. Sometimes that is just the story; confirm it is, and say why in the acknowledgement.`,
  };
}

/* ---------------- the balance rule ---------------- */

/**
 * Which candidates a message must name if it names any.
 *
 * Objective and published, so it is the same rule for everyone and no
 * editorial judgment enters: an incumbent, or a candidate with a prediction
 * market, or one who has raised at least 1% of everything raised in the race.
 * The 1% floor exists because a House race can carry a dozen filers who have
 * raised nothing, and requiring all of them would make the rule unusable and
 * therefore ignored.
 */
function qualifyingCandidates(candidates, { floor = 0.01 } = {}) {
  const list = (candidates || []).filter((c) => c && c.name);
  const total = list.reduce((sum, c) => sum + (Number(c.receipts) || 0), 0);
  return list.filter((c) =>
    c.incumbent === true ||
    Number(c.probability) > 0 ||
    (total > 0 && (Number(c.receipts) || 0) >= total * floor));
}

/**
 * The balance rule: name all of them, or none, in alphabetical order.
 *
 * The order check is the part people are surprised by, and it is the part
 * that matters most. Listing the front-runner first is a completely natural
 * editorial instinct and it is a thumb on the scale in every message, so the
 * order is fixed by surname and checked mechanically.
 */
function assertBalanced(body, candidates, opts = {}) {
  const text = String(body || '');
  const qualifying = qualifyingCandidates(candidates, opts);

  const appearances = qualifying
    .map((c) => {
      const surname = surnameOf(c.name);
      if (!surname) return null;
      const m = new RegExp(`\\b${escapeRe(surname)}\\b`, 'i').exec(text);
      return { name: c.name, surname, index: m ? m.index : -1, party: c.party || null };
    })
    .filter(Boolean);

  const named = appearances.filter((a) => a.index >= 0);
  const missing = appearances.filter((a) => a.index < 0);

  // Names none of them: nothing to balance.
  if (named.length === 0) {
    return { ok: true, applies: false, required: appearances, named: [], missing: [], findings: [] };
  }

  const findings = [];

  if (missing.length > 0) {
    findings.push({
      rule: 'balance-incomplete',
      severity: 'block',
      span: 0,
      text: missing.map((m) => m.name).join(', '),
      context: '',
      note:
        `This message names ${named.length} of ${appearances.length} qualifying candidates in the race. ` +
        'Name all of them or none. Missing: ' + missing.map((m) => m.name).join(', '),
    });
  }

  const alphabetical = [...named].sort((a, b) => a.surname.localeCompare(b.surname));
  const asWritten = [...named].sort((a, b) => a.index - b.index);
  const orderOk = alphabetical.every((c, i) => c.surname === asWritten[i].surname);

  if (!orderOk) {
    findings.push({
      rule: 'balance-order',
      severity: 'block',
      span: asWritten[0].index,
      text: asWritten.map((c) => c.name).join(' → '),
      context: '',
      note:
        'Candidates must appear in alphabetical order by surname. Ordering by odds, incumbency or ' +
        'fundraising puts a thumb on the scale in a way readers do not consciously notice. Expected: ' +
        alphabetical.map((c) => c.name).join(' → '),
    });
  }

  return {
    ok: findings.length === 0,
    applies: true,
    required: appearances,
    named: asWritten,
    missing,
    expectedOrder: alphabetical.map((c) => c.name),
    findings,
  };
}

/* ---------------- taxonomy and audience ---------------- */

/** Is this issue name a subject area, or a position wearing one's clothes? */
function checkIssueLabel(name, description = '') {
  const text = `${name} ${description}`;
  const findings = [];
  for (const re of POSITION_CODED) {
    for (const m of scan(text, re)) {
      findings.push(finding('position-coded-topic', 'block', m, text,
        'An issue is a subject area, not a position. Name it the way a librarian would: the neutral name covers the same bills without announcing a side.'));
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Validate an audience selector against the closed schema.
 *
 * This is the structural safeguard rather than a linguistic one, and it is the
 * one that holds when everything else fails. The audience can only be
 * expressed as what somebody follows, which issues they asked about, where
 * they are, and which channel — because those are the only columns
 * broadcast_audience has. There is no free-form filter, no saved segment, no
 * raw SQL. An unknown key is rejected rather than ignored, so a request to
 * target by party fails loudly instead of silently doing nothing.
 */
function checkAudience(audience) {
  const errors = [];
  if (!audience || typeof audience !== 'object' || Array.isArray(audience)) {
    return { ok: false, errors: ['Audience must be an object.'] };
  }

  for (const key of Object.keys(audience)) {
    if (!AUDIENCE_KEYS.includes(key)) {
      errors.push(
        `Unknown audience field "${key}". The audience can only be expressed as ` +
        `${AUDIENCE_KEYS.join(', ')}. Pollbook does not record party, ideology or vote history, ` +
        'so there is nothing to target on and deliberately no place to say it.'
      );
    }
  }

  const arrays = ['subjectKeys', 'issueSlugs', 'stateCodes', 'channels'];
  for (const key of arrays) {
    if (audience[key] !== undefined && !Array.isArray(audience[key])) {
      errors.push(`${key} must be an array.`);
    }
  }

  for (const channel of audience.channels || []) {
    if (!['email', 'sms'].includes(channel)) errors.push(`Unknown channel "${channel}".`);
  }

  const size =
    (audience.subjectKeys || []).length +
    (audience.issueSlugs || []).length +
    (audience.stateCodes || []).length;
  if (size === 0) {
    errors.push('An audience needs at least one race, issue or state. There is no "everyone" selector.');
  }

  return { ok: errors.length === 0, errors };
}

/* ---------------- odds copy ----------------

   Prediction-market alerts have no free-text path at all. The README's
   honesty convention — these are prices traders pay, not forecasts — survives
   only if the sentence is generated rather than written, so this is the only
   way an odds number reaches a subscriber.                                   */

const ODDS_FORBIDDEN = [
  /\bforecast\b/i, /\bpredicts?\b/i, /\blikely\s+to\s+win\b/i, /\bwill\s+win\b/i,
  /\bexpected\s+to\s+win\b/i, /\bchance\s+of\s+winning\b/i, /\bodds\s+of\s+victory\b/i,
  /\bsurges?\b/i, /\bcollapses?\b/i, /\bcrushing\b/i, /\bdominat/i,
];

/** Reject odds copy that describes a market price as a prediction. */
function checkOddsFraming(text) {
  const findings = [];
  for (const re of ODDS_FORBIDDEN) {
    for (const m of scan(String(text || ''), re)) {
      findings.push(finding('odds-framing', 'block', m, String(text),
        'Prediction-market prices are what traders are paying, not a forecast. Say "the market price moved", never "likely to win".'));
    }
  }
  return { ok: findings.length === 0, findings };
}

module.exports = {
  lint,
  assertBalanced,
  qualifyingCandidates,
  checkSourceUrls,
  checkIssueLabel,
  checkAudience,
  checkOddsFraming,
  partyMentions,
  surnameOf,
  AUDIENCE_KEYS,
  POSITION_CODED,
  SOURCE_ALLOW,
};

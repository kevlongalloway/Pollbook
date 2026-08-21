/**
 * Turning a template plus some variables into an actual message.
 *
 * Everything that must appear on every outbound message is added here rather
 * than written into each template, because a requirement that depends on an
 * author remembering it is a requirement that will eventually be missing from
 * one message — and the one it is missing from will be the one that matters.
 *
 * So this module, and nothing else, is allowed to produce a sendable body.
 * It guarantees:
 *
 *   - an unsubscribe link, and for email the RFC 8058 one-click headers that
 *     Gmail and Yahoo now require of bulk senders;
 *   - a physical postal address, which CAN-SPAM requires and which is the
 *     single most common omission in a first mailing;
 *   - the Nolvek Technologies funding line, plus a plain statement that
 *     nothing here is authorized by a campaign;
 *   - for SMS, the opt-out instruction carriers require;
 *   - and a final pass of the neutrality linter, because copy can change
 *     between approval and send.
 *
 * The substitution language is deliberately not a template engine. It is
 * `{{name}}` against an allowlisted set of variables, with no expressions, no
 * conditionals, and no property access. A message body is untrusted-adjacent
 * input assembled by humans under time pressure; giving it an evaluator would
 * be handing it a foot-gun for no benefit.
 */

const { lint } = require('../lib/nonpartisan');

/** Every variable a template may reference. Anything else is an error. */
const ALLOWED_VARS = [
  'displayName', 'stateName', 'stateCode',
  'electionName', 'electionDate', 'electionDateLong', 'daysUntil',
  'registrationUrl', 'subjectLabel', 'subjectUrl', 'subjectSummary',
  'siteUrl', 'preferencesUrl', 'unsubscribeUrl', 'actionUrl',
  'marketSummary', 'headline', 'messageBody', 'sourceList',
];

const VAR_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitute `{{vars}}`.
 *
 * An unknown variable throws rather than rendering empty. A message that
 * silently says "The  is on " because somebody typo'd a name is worse than
 * one that fails loudly in the portal before anybody sees it.
 */
function substitute(template, vars) {
  const missing = [];
  const out = String(template || '').replace(VAR_RE, (match, name) => {
    if (!ALLOWED_VARS.includes(name)) {
      missing.push(`${name} (not an allowed variable)`);
      return match;
    }
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return match;
    }
    return String(value);
  });

  if (missing.length) {
    const err = new Error(`Template is missing values for: ${missing.join(', ')}`);
    err.status = 422;
    err.code = 'PB_TEMPLATE_VARS';
    throw err;
  }
  return out;
}

/* ---------------- required trailers ---------------- */

const FUNDING_LINE =
  'Powered by and paid for by Nolvek Technologies. Pollbook is nonpartisan and is not ' +
  'authorized by any candidate or candidate’s committee.';

/**
 * The postal address CAN-SPAM requires in every commercial message.
 *
 * Missing in production is fatal at render time rather than at send time, so
 * it surfaces the first time anybody previews a message instead of after a
 * mailing has gone out without it. In development it degrades to a visible
 * placeholder, because failing local development over an address nobody has
 * yet just teaches people to hardcode one.
 */
function postalAddress() {
  const configured = process.env.MAILING_ADDRESS;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    const err = new Error(
      'MAILING_ADDRESS is not set. CAN-SPAM requires a valid physical postal address in ' +
      'every message, so nothing can be rendered without one.'
    );
    err.status = 500;
    err.code = 'PB_NO_MAILING_ADDRESS';
    throw err;
  }
  return '[MAILING_ADDRESS not set — required before sending in production]';
}

/** The email trailer. Never optional, never a template's responsibility. */
function emailFooter({ unsubscribeUrl, preferencesUrl }) {
  return [
    '',
    '—',
    `Change what you receive: ${preferencesUrl}`,
    `Unsubscribe from everything: ${unsubscribeUrl}`,
    '',
    postalAddress(),
    '',
    FUNDING_LINE,
  ].join('\n');
}

/**
 * SMS opt-out.
 *
 * Appended only when the template does not already carry it — the seeded
 * templates do, because for SMS the wording is part of the consent language
 * and belongs where an author can see it. Doubling it up wastes a segment,
 * and segments are what SMS costs.
 */
function ensureSmsOptOut(body) {
  return /\breply\s+stop\b/i.test(body) ? body : `${body.trimEnd()} Reply STOP to opt out.`;
}

/* ---------------- the entry point ---------------- */

/**
 * Render one message.
 *
 * @param {object} template `{ key, channel, subject_tpl, body_tpl }`
 * @param {object} vars
 * @param {object} opts     `{ unsubscribeUrl, preferencesUrl, candidates, sources }`
 * @returns {{subject, body, headers, lint}}
 */
function render(template, vars, opts = {}) {
  const { unsubscribeUrl, preferencesUrl, candidates = [], sources = [] } = opts;

  if (!unsubscribeUrl || !preferencesUrl) {
    const err = new Error('Cannot render a message without an unsubscribe and a preferences link.');
    err.status = 500;
    throw err;
  }

  const channel = template.channel === 'both' ? opts.channel || 'email' : template.channel;
  const merged = { ...vars, unsubscribeUrl, preferencesUrl };

  const subject = template.subject_tpl ? substitute(template.subject_tpl, merged) : null;
  let body = substitute(template.body_tpl, merged);

  if (channel === 'sms') {
    body = ensureSmsOptOut(body);
  } else {
    body += emailFooter({ unsubscribeUrl, preferencesUrl });
  }

  // The last gate. Copy can be edited after approval, a variable can carry
  // text nobody linted, and a template can be changed by a migration — so the
  // check runs here, on the finished bytes, every time.
  const report = lint(body, { subject, candidates, sources });
  if (report.blocked) {
    const err = new Error(
      `Refusing to send: ${report.findings.filter((f) => f.severity === 'block').map((f) => f.note).join(' ')}`
    );
    err.status = 422;
    err.code = 'PB_NEUTRALITY_BLOCK';
    err.findings = report.findings;
    throw err;
  }

  const headers = channel === 'email'
    ? {
      // RFC 8058. Gmail and Yahoo require both of these from bulk senders,
      // and the pair is what makes the mail client's own "unsubscribe"
      // button work without the reader having to find the link.
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    }
    : {};

  return { channel, subject, body, headers, lint: report };
}

/**
 * SMS segment count, for cost and for the 10DLC throughput budget.
 *
 * A message containing any character outside GSM-03.38 is encoded UCS-2,
 * which cuts a segment from 160 characters to 70 — so one curly apostrophe
 * more than doubles the cost of a message. Worth knowing before a send, not
 * after the bill.
 */
function smsSegments(body) {
  const text = String(body || '');
  // eslint-disable-next-line no-control-regex
  const gsm = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€\r\n]*$/;
  const unicode = !gsm.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  if (text.length <= single) return { segments: 1, encoding: unicode ? 'UCS-2' : 'GSM-7', length: text.length };
  return {
    segments: Math.ceil(text.length / multi),
    encoding: unicode ? 'UCS-2' : 'GSM-7',
    length: text.length,
  };
}

module.exports = {
  render, substitute, smsSegments, emailFooter, ensureSmsOptOut, postalAddress,
  ALLOWED_VARS, FUNDING_LINE,
};

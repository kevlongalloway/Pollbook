/**
 * Provider selection.
 *
 * Mirrors services/electionService.js: one module that picks an
 * implementation from the environment and re-exports a fixed interface, so
 * nothing upstream knows which provider is in play.
 *
 * The selection is by configuration rather than by a name, deliberately. The
 * question a deploy actually asks is "did the keys arrive", and answering it
 * by checking for the keys means adding `RESEND_API_KEY` is the whole
 * integration — there is no second switch to remember to flip. With nothing
 * configured, messages print to stdout and the app is fully usable locally.
 *
 * `describe()` follows the `fecKey`/`congressKey` reporting already in
 * /api/meta, for the same reason it exists there: a missing key shows up as
 * mail that quietly is not sent, and that has to be visible from outside.
 */

const resend = require('./providers/resend');
const twilio = require('./providers/twilio');
const local = require('./providers/local');

/** Explicit override, mostly for tests. `memory` | `console` | `live`. */
const mode = () => process.env.MESSAGING_PROVIDER || 'auto';

function emailProvider() {
  const m = mode();
  if (m === 'memory') return local.memory;
  if (m === 'console') return local.console;
  if (m === 'live') return resend;
  return resend.configured() ? resend : local.console;
}

function smsProvider() {
  const m = mode();
  if (m === 'memory') return local.memory;
  if (m === 'console') return local.console;
  if (m === 'live') return twilio;
  return twilio.configured() ? twilio : local.console;
}

/**
 * Send a rendered message.
 *
 * Takes what render() produced rather than a template plus variables, so
 * there is no path from a raw string to a provider that skips the neutrality
 * check and the required footers.
 */
async function send({ channel, to, subject, body, headers, idempotencyKey, statusCallback }) {
  if (channel === 'sms') {
    return smsProvider().send({ channel, to, body, idempotencyKey, statusCallback });
  }
  return emailProvider().send({ channel, to, subject, body, headers, idempotencyKey });
}

/**
 * Is SMS allowed to send at all?
 *
 * Separate from "is Twilio configured", because 10DLC registration takes
 * weeks and the code will be ready first. `SMS_ENABLED=1` is the deliberate
 * flip once the campaign is approved — so a deploy that happens to carry
 * Twilio credentials does not start texting people before the registration
 * that legally permits it is finished.
 */
const smsEnabled = () => process.env.SMS_ENABLED === '1';

/** Is anything at all able to leave this instance? The kill switch. */
const sendingEnabled = () => process.env.SEND_ENABLED !== '0';

/** One line for the boot log and for /api/health. */
function describe() {
  const email = mode() === 'auto'
    ? (resend.configured() ? 'resend' : 'console (no RESEND_API_KEY)')
    : mode();
  const sms = !smsEnabled()
    ? 'off (set SMS_ENABLED=1 after 10DLC approval)'
    : mode() === 'auto'
      ? (twilio.configured() ? 'twilio' : 'console (no Twilio credentials)')
      : mode();
  return `email=${email}, sms=${sms}${sendingEnabled() ? '' : ', SENDING DISABLED (SEND_ENABLED=0)'}`;
}

/** Structured version of the above, for /api/health and the portal. */
const status = () => ({
  email: mode() === 'auto' ? (resend.configured() ? 'resend' : 'console') : mode(),
  sms: mode() === 'auto' ? (twilio.configured() ? 'twilio' : 'console') : mode(),
  smsEnabled: smsEnabled(),
  sendingEnabled: sendingEnabled(),
  mailingAddressConfigured: Boolean(process.env.MAILING_ADDRESS),
});

module.exports = {
  send, describe, status, smsEnabled, sendingEnabled,
  emailProvider, smsProvider, resend, twilio, local,
};

/**
 * The exact words shown when somebody agrees to be contacted.
 *
 * These are stored verbatim in `consent_records` alongside their version and
 * a hash, because the question a regulator or a plaintiff actually asks is
 * not "did you have a checkbox" but "what did it say, on the day this person
 * ticked it". A version string pointing at a file that has since been edited
 * answers nothing.
 *
 * So: **never edit a string in this file.** Add a new version and leave the
 * old one in place. Anything already recorded points at the text it pointed
 * at, forever.
 *
 * The SMS text is the one with legal shape requirements. Express written
 * consent under the TCPA, and the carrier requirements that come with A2P
 * 10DLC registration, mean the disclosure has to name the sender, say the
 * messages are recurring, describe the message frequency, carry "Msg & data
 * rates may apply", give the STOP and HELP keywords, and link terms and
 * privacy on the same page as the checkbox. It also has to be its own
 * checkbox, unticked, never bundled with the email opt-in or the terms.
 */

const CONSENT_TEXTS = {
  'email-updates-v1': {
    channel: 'email',
    consentType: 'email_updates',
    text:
      'Email me election reminders from Pollbook for the races and issues I follow — ' +
      'registration and voting deadlines, and the alerts I turn on. ' +
      'I can change what I get or unsubscribe at any time, from a link in every message. ' +
      'Pollbook is nonpartisan and does not ask for or store my party affiliation.',
  },

  'sms-alerts-v1': {
    channel: 'sms',
    consentType: 'sms_alerts',
    text:
      'I agree to receive recurring automated text messages from Pollbook at the mobile number ' +
      'I provided, about the elections and issues I follow — including reminders to check my ' +
      'registration and to vote. Message frequency varies. Msg & data rates may apply. ' +
      'Consent is not a condition of using Pollbook or of any purchase. ' +
      'Reply STOP to cancel, HELP for help.',
    // Rendered next to the checkbox, not part of the consent sentence itself.
    supporting:
      'Links to our Terms and Privacy Notice appear beside this checkbox. ' +
      'We will never use your number for anything other than the alerts you chose, ' +
      'we do not sell or rent it, and we do not ask your party affiliation.',
  },

  'terms-v1': {
    channel: 'email',
    consentType: 'terms',
    text: 'I have read and agree to the Pollbook Terms of Use and Privacy Notice, and I am at least 16 years old.',
  },
};

/** Look up a consent text by version. Unknown versions throw — never guess. */
function consentText(version) {
  const entry = CONSENT_TEXTS[version];
  if (!entry) {
    throw new Error(
      `Unknown consent version "${version}". Consent text is never inferred — ` +
      'add the version to data/consentTexts.js rather than recording a guess.'
    );
  }
  return entry;
}

/** The version currently shown for a channel. New signups get this one. */
const CURRENT = {
  email_updates: 'email-updates-v1',
  sms_alerts: 'sms-alerts-v1',
  terms: 'terms-v1',
};

module.exports = { CONSENT_TEXTS, consentText, CURRENT };

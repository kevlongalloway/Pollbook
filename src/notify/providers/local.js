/**
 * The two providers that never touch the network.
 *
 * `console` is what runs when no API key is configured, and it is genuinely
 * useful rather than a stub: the sign-in link is printed to stdout, so the
 * whole account flow — magic link, verification, preferences, unsubscribe —
 * can be exercised end to end on a laptop with nothing configured but a
 * database. That property is why magic-link sign-in is the first auth method
 * built rather than the last.
 *
 * `memory` is the same thing for tests: it keeps what it was given so a test
 * can assert on the footer, the headers and the segment count without a stub
 * HTTP server.
 */

const sent = [];

/** Everything the memory provider has been handed. */
const outbox = () => sent.slice();
const reset = () => { sent.length = 0; };

const memory = {
  configured: () => true,
  async send(msg) {
    const id = `mem_${sent.length + 1}`;
    sent.push({ ...msg, id, at: new Date().toISOString() });
    return { id, provider: 'memory', segments: 1 };
  },
};

const consoleProvider = {
  configured: () => true,
  async send(msg) {
    const id = `console_${Date.now()}`;
    const rule = '─'.repeat(64);
    console.log(
      `\n${rule}\n` +
      `  ${msg.channel === 'sms' ? 'SMS' : 'EMAIL'} → ${msg.to}\n` +
      (msg.subject ? `  Subject: ${msg.subject}\n` : '') +
      `${rule}\n${msg.body}\n${rule}\n` +
      '  (no provider key configured — printed instead of sent)\n'
    );
    sent.push({ ...msg, id, at: new Date().toISOString() });
    return { id, provider: 'console', segments: 1 };
  },
};

module.exports = { memory, console: consoleProvider, outbox, reset };

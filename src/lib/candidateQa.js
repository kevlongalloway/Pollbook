/**
 * Candidate Q&A — grounds a Groq chat completion in one candidate's Pollbook
 * profile (FEC filings, Wikipedia, news) and refuses anything outside U.S.
 * elections/candidates. Conversation history is client-supplied and never
 * persisted server-side — the browser is the only place it's stored.
 */

const groq = require('./groq');

const REFUSAL = 'I only give information on United States elections and their candidates.';

const money = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);

function summarizeFinance(c) {
  const f = c.finance;
  if (!f) return null;
  const parts = [
    f.receipts != null && `raised ${money(f.receipts)}`,
    f.disbursements != null && `spent ${money(f.disbursements)}`,
    f.cashOnHand != null && `${money(f.cashOnHand)} cash on hand`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function buildContext(c) {
  const lines = [
    `Name: ${c.name}`,
    `Party: ${c.partyFull || c.party || 'Unknown'}`,
    `Running for: ${c.officeLabel || c.office || 'Unknown office'}`,
  ];
  if (c.stateName) lines.push(`State: ${c.stateName}`);
  if (c.incumbent) lines.push('Incumbent: yes');
  if (c.probability != null) lines.push(`Market-implied win odds: ${c.probability}% (${c.probabilitySource || 'prediction market'} price, not a forecast)`);

  const bio = c.wiki?.extract || c.bio;
  if (bio) lines.push(`Biography: ${bio}`);

  const positions = (c.positions || []).map((p) => (p.text ? `- ${p.topic}: ${p.text}` : `- ${p.topic}`));
  if (positions.length) lines.push(`Policy positions:\n${positions.join('\n')}`);

  const finance = summarizeFinance(c);
  if (finance) lines.push(`Campaign finance (FEC): ${finance}`);

  const headlines = (c.articles || []).slice(0, 5).map((a) => `- ${a.title} (${a.outlet})`);
  if (headlines.length) lines.push(`Recent news headlines:\n${headlines.join('\n')}`);

  return lines.join('\n');
}

const systemPrompt = (context) => `You are the Pollbook Candidate Q&A assistant, embedded on a nonpartisan U.S. election-awareness website. You answer questions about the candidate profiled below, and about United States elections and politics more broadly (how elections work, other candidates or races, campaign finance, voting logistics, etc).

Candidate profile (from Pollbook — FEC filings, Wikipedia, news):
${context}

Rules:
- Stay strictly nonpartisan: present facts, never endorse, campaign for, or attack any candidate or party.
- Only use the profile above for facts about this candidate. If it doesn't cover something, say you don't have that information — never invent details about the candidate.
- If the question is not about United States elections or candidates, refuse it. Reply with exactly this sentence and nothing else: "${REFUSAL}"
- Keep answers concise — a few sentences, unless the user asks for more detail.`;

async function askAboutCandidate(candidate, question, history = []) {
  const cleanHistory = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  const messages = [
    { role: 'system', content: systemPrompt(buildContext(candidate)) },
    ...cleanHistory,
    { role: 'user', content: question.slice(0, 1000) },
  ];

  return groq.chat(messages);
}

module.exports = { askAboutCandidate, REFUSAL };

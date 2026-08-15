/**
 * Groq chat-completions client (OpenAI-compatible endpoint, Node 18+ fetch).
 * Free tier — get a key at https://console.groq.com/keys and set GROQ_API_KEY.
 */

const GROQ_API_BASE = process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

async function chat(messages, { temperature = 0.3, maxTokens = 600 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('AI answers are unavailable — GROQ_API_KEY is not configured on this server.');
    err.status = 503;
    throw err;
  }

  let res;
  try {
    res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (err) {
    const e = new Error(`Groq API is unreachable (${err.message}).`);
    e.status = 503;
    throw e;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`Groq API error ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    e.status = res.status === 429 ? 429 : 502;
    throw e;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = { chat };

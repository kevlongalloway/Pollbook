/**
 * Groq chat-completions client (OpenAI-compatible endpoint, Node 18+ fetch).
 * Free tier — get a key at https://console.groq.com/keys and set GROQ_API_KEY.
 */

const GROQ_API_BASE = process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * One completion. Returns the whole assistant message, so callers that pass
 * `tools` can see `tool_calls` — `chat()` below keeps the plain-string
 * contract for everyone who doesn't care.
 */
async function request(messages, { temperature = 0.3, maxTokens = 600, tools, toolChoice, timeoutMs = 20000 } = {}) {
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
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        // Omitted entirely when unused — some OpenAI-compatible backends
        // reject an empty `tools` array.
        ...(tools && tools.length ? { tools, tool_choice: toolChoice || 'auto' } : {}),
      }),
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
  return data.choices?.[0]?.message || {};
}

/** Full assistant message, with `tool_calls` always an array. */
async function chatRaw(messages, opts = {}) {
  const msg = await request(messages, opts);
  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : '',
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
  };
}

/** Just the text. */
async function chat(messages, opts = {}) {
  return (await request(messages, opts)).content?.trim() || '';
}

module.exports = { chat, chatRaw };

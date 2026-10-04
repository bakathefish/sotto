'use strict';

const { createSSEParser, readAnthropicEvent, readOpenAIEvent } = require('../core/sse');

// messages: [{ role: 'user' | 'assistant', text, imageBase64? }]

function anthropicRequest({ settings, apiKey, system, messages, fast }) {
  const cfg = settings.anthropic;
  const body = {
    model: fast ? cfg.fastModel : cfg.model,
    max_tokens: settings.maxTokens,
    stream: true,
    // The system prompt holds the profile and the knowledge files, which
    // repeat on every request, so mark it cacheable.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: messages.map((m) => ({
      role: m.role,
      content: m.imageBase64
        ? [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.imageBase64 } },
            { type: 'text', text: m.text },
          ]
        : m.text,
    })),
  };
  if (cfg.webSearch && !fast) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body,
    read: readAnthropicEvent,
  };
}

function openaiRequest({ settings, apiKey, system, messages, fast }) {
  const cfg = settings.openai;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    url: cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions',
    headers,
    body: {
      model: fast ? cfg.fastModel : cfg.model,
      max_tokens: settings.maxTokens,
      stream: true,
      messages: [{ role: 'system', content: system }].concat(
        messages.map((m) => ({
          role: m.role,
          content: m.imageBase64
            ? [
                { type: 'text', text: m.text },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.imageBase64}` } },
              ]
            : m.text,
        }))
      ),
    },
    read: readOpenAIEvent,
  };
}

function buildRequest(args) {
  return args.settings.provider === 'openai' ? openaiRequest(args) : anthropicRequest(args);
}

async function errorMessage(response) {
  const raw = await response.text().catch(() => '');
  try {
    const json = JSON.parse(raw);
    const msg = (json.error && (json.error.message || json.error)) || json.message;
    if (msg) return `${response.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  } catch {
    // not JSON
  }
  return `${response.status}: ${raw.slice(0, 300) || response.statusText}`;
}

// Streams a reply. Calls onText for each piece and resolves with the full text.
async function streamChat({ settings, apiKey, system, messages, fast = false, signal, onText }) {
  if (settings.provider === 'anthropic' && !apiKey) throw new Error('No Anthropic API key. Add one in the dashboard.');
  const req = buildRequest({ settings, apiKey, system, messages, fast });
  const response = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
  if (!response.ok) throw new Error(await errorMessage(response));

  let full = '';
  let failure = null;
  const parser = createSSEParser((evt) => {
    const out = req.read(evt);
    if (out.error) failure = out.error;
    if (out.text) {
      full += out.text;
      if (onText) onText(out.text);
    }
  });
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    parser.feed(decoder.decode(chunk, { stream: true }));
    if (failure) break;
  }
  parser.end();
  if (failure) throw new Error(failure);
  return full;
}

module.exports = { streamChat, buildRequest };

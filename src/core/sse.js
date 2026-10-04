'use strict';

// Incremental parser for server-sent events. Feed it decoded text chunks in
// any split; it calls onEvent({ event, data }) once per complete event.
function createSSEParser(onEvent) {
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  function dispatch() {
    if (dataLines.length > 0) onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
  }

  function handleLine(line) {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  return {
    feed(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.search(/\r\n|\n|\r/)) !== -1) {
        // A lone \r at the very end may be the first half of \r\n.
        if (buffer[idx] === '\r' && idx === buffer.length - 1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer.startsWith('\r\n', idx) ? 2 : 1));
        handleLine(line);
      }
    },
    end() {
      if (buffer.length > 0) handleLine(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    },
  };
}

function safeParse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Each reader maps one SSE event to { text?, done?, error? }.
function readAnthropicEvent(evt) {
  const json = safeParse(evt.data);
  if (!json) return {};
  if (json.type === 'content_block_delta' && json.delta && json.delta.type === 'text_delta') {
    return { text: json.delta.text };
  }
  if (json.type === 'message_stop') return { done: true };
  if (json.type === 'error') return { error: (json.error && json.error.message) || 'Unknown API error' };
  return {};
}

function readOpenAIEvent(evt) {
  if (evt.data === '[DONE]') return { done: true };
  const json = safeParse(evt.data);
  if (!json) return {};
  if (json.error) return { error: json.error.message || String(json.error) };
  const choice = json.choices && json.choices[0];
  if (!choice) return {};
  const out = {};
  if (choice.delta && typeof choice.delta.content === 'string' && choice.delta.content) out.text = choice.delta.content;
  return out;
}

module.exports = { createSSEParser, readAnthropicEvent, readOpenAIEvent };

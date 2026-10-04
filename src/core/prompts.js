'use strict';

const { SHARED_RULES, ACTIONS } = require('./profiles');

// The system prompt is ordered stable-first so that provider prompt caching
// can reuse the profile and knowledge across turns.
function buildSystemPrompt({ profile, customInstructions, knowledge }) {
  const parts = [profile.prompt, 'Rules:\n' + SHARED_RULES];
  if (customInstructions && customInstructions.trim()) {
    parts.push('My standing instructions:\n' + customInstructions.trim());
  }
  if (knowledge && knowledge.text) {
    const note =
      knowledge.mode === 'full'
        ? 'These are my files, complete.'
        : 'These are the excerpts of my files most relevant to the question. Other parts exist that you cannot see.';
    parts.push(`${note}\n\n<my_files>\n${knowledge.text}\n</my_files>`);
  }
  return parts.join('\n\n');
}

// The text that goes with one request: what was said recently, then the ask.
function buildUserText({ question, actionId, transcriptText, hasScreenshot }) {
  const parts = [];
  if (transcriptText) parts.push(`<recent_conversation>\n${transcriptText}\n</recent_conversation>`);
  if (hasScreenshot) parts.push('A screenshot of my screen right now is attached.');
  const action = actionId && ACTIONS[actionId];
  const ask = (question && question.trim()) || (action && action.prompt) || ACTIONS.assist.prompt;
  parts.push(ask);
  return parts.join('\n\n');
}

function buildSuggestionText({ utterance, transcriptText }) {
  return (
    `<recent_conversation>\n${transcriptText}\n</recent_conversation>\n\n` +
    `They just asked: "${utterance}"\n\n` +
    'Give me the answer to say out loud, in my voice, under 60 words. No preamble.'
  );
}

function buildNotesPrompt({ transcriptText, chatText }) {
  return (
    'Write notes for the session below. Use exactly these sections, in this order, as markdown headings:\n' +
    '## Title\nOne line, six words or fewer.\n' +
    '## Summary\nThree to six bullets.\n' +
    '## Decisions\nBullets. Write "None recorded" if there are none.\n' +
    '## Action items\nBullets in the form "Owner: task (due date if one was said)". Write "None recorded" if there are none.\n' +
    '## Open questions\nBullets. Write "None recorded" if there are none.\n' +
    '## Follow-up email\nA short email I could send: thanks, what was agreed, next steps.\n\n' +
    'Use only what the session contains. Do not invent names, dates or commitments.\n\n' +
    (transcriptText ? `<transcript>\n${transcriptText}\n</transcript>\n\n` : '') +
    (chatText ? `<assistant_chat>\n${chatText}\n</assistant_chat>` : '')
  );
}

// Pull the "## Title" line out of generated notes for the session list.
function titleFromNotes(notes, fallback) {
  const match = /^##\s*Title\s*\n+([^\n]+)/m.exec(notes || '');
  const title = match ? match[1].replace(/^[-*\s]+/, '').trim() : '';
  return title || fallback;
}

module.exports = { buildSystemPrompt, buildUserText, buildSuggestionText, buildNotesPrompt, titleFromNotes };

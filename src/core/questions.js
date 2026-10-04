'use strict';

const STARTERS = [
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose',
  'can you', 'could you', 'would you', 'will you', 'do you', 'did you', 'does', 'have you', 'has',
  'is it', 'is there', 'is that', 'is this', 'are you', 'are there', 'was', 'were',
  'tell me', 'walk me through', 'talk me through', 'explain', 'describe', 'give me', 'show me',
  'any thoughts', 'thoughts on', 'what about', 'how about',
];

// Heuristic: does this utterance ask the listener for something? Speech-to-text
// often drops the question mark, so the opening words count too.
function isQuestion(text) {
  const clean = (text || '').trim().toLowerCase();
  if (clean.split(/\s+/).length < 3) return false;
  if (clean.endsWith('?')) return true;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1].replace(/^(so|and|but|okay|ok|well|right|now|um|uh)[, ]+/, '');
  return STARTERS.some((s) => last.startsWith(s + ' '));
}

module.exports = { isQuestion };

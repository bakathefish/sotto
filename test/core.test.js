'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSSEParser, readAnthropicEvent, readOpenAIEvent } = require('../src/core/sse');
const { chunkText, tokenize, buildIndex, search, buildContext, estimateTokens } = require('../src/core/retrieval');
const { Transcript } = require('../src/core/transcript');
const { isQuestion } = require('../src/core/questions');
const { pcm16ToWav, rms } = require('../src/core/wav');
const { render } = require('../src/core/markdown');
const { BUILTIN_PROFILES, ACTIONS, MODES, parsePack, profileFromPack, listProfiles, slugify } = require('../src/core/profiles');
const { buildSystemPrompt, buildUserText, buildNotesPrompt, titleFromNotes } = require('../src/core/prompts');

function collect(chunks) {
  const events = [];
  const parser = createSSEParser((e) => events.push(e));
  for (const c of chunks) parser.feed(c);
  parser.end();
  return events;
}

test('sse: parses events split at arbitrary byte positions', () => {
  const raw = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: line1\ndata: line2\n\n';
  for (let cut = 1; cut < raw.length; cut++) {
    const events = collect([raw.slice(0, cut), raw.slice(cut)]);
    assert.deepEqual(events, [
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: 'line1\nline2' },
    ]);
  }
});

test('sse: handles CRLF, comments and a missing trailing blank line', () => {
  const events = collect([': ping\r\ndata: one\r\n\r\ndata: two']);
  assert.deepEqual(events, [
    { event: 'message', data: 'one' },
    { event: 'message', data: 'two' },
  ]);
});

test('sse: anthropic reader extracts text, stop and errors', () => {
  assert.deepEqual(
    readAnthropicEvent({ data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}' }),
    { text: 'hi' }
  );
  assert.deepEqual(readAnthropicEvent({ data: '{"type":"message_stop"}' }), { done: true });
  assert.deepEqual(readAnthropicEvent({ data: '{"type":"error","error":{"message":"overloaded"}}' }), { error: 'overloaded' });
  assert.deepEqual(readAnthropicEvent({ data: '{"type":"ping"}' }), {});
  assert.deepEqual(readAnthropicEvent({ data: 'not json' }), {});
});

test('sse: openai reader extracts text, done and errors', () => {
  assert.deepEqual(readOpenAIEvent({ data: '{"choices":[{"delta":{"content":"yo"}}]}' }), { text: 'yo' });
  assert.deepEqual(readOpenAIEvent({ data: '{"choices":[{"delta":{"role":"assistant"}}]}' }), {});
  assert.deepEqual(readOpenAIEvent({ data: '[DONE]' }), { done: true });
  assert.deepEqual(readOpenAIEvent({ data: '{"error":{"message":"bad key"}}' }), { error: 'bad key' });
});

test('retrieval: chunks stay under size and carry their heading', () => {
  const text = '# Title\n\nintro\n\n## Numbers\n\n' + 'alpha beta. '.repeat(300) + '\n\n## End\n\nlast';
  const chunks = chunkText(text, { size: 500 });
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.length <= 500 + '## Numbers\n'.length);
  assert.ok(chunks.some((c) => c.startsWith('## Numbers') && c.includes('alpha')));
  assert.ok(chunks[chunks.length - 1].includes('last'));
});

test('retrieval: tokenizer drops stopwords and keeps numbers and identifiers', () => {
  assert.deepEqual(tokenize('What is the F277W colour of 1,133 sources?'), ['f277w', 'colour', '1', '133', 'sources']);
  assert.deepEqual(tokenize('reg_alpha=0.25'), ['reg_alpha', '0.25']);
});

test('retrieval: bm25 ranks the matching chunk first', () => {
  const index = buildIndex([
    { name: 'a.md', text: 'The classifier recovers 124 of 147 confirmed sources.' },
    { name: 'b.md', text: 'The telescope has a 6.5 metre mirror.\n\nIt launched in December.' },
  ]);
  const hits = search(index, 'how big is the telescope mirror');
  assert.equal(hits[0].doc.file, 'b.md');
  assert.equal(search(index, 'zebra').length, 0);
});

test('retrieval: small knowledge goes in whole, large knowledge is retrieved within budget', () => {
  const small = buildContext([{ name: 'a.md', text: 'short fact' }], 'anything', 1000);
  assert.equal(small.mode, 'full');
  assert.ok(small.text.includes('<file name="a.md">'));

  const filler = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} about weather and oceans and tides.`).join('\n\n');
  const big = buildContext(
    [{ name: 'big.md', text: filler + '\n\nThe kiln fires at cone six overnight.' }],
    'when does the kiln fire',
    300
  );
  assert.equal(big.mode, 'retrieved');
  assert.ok(big.text.includes('kiln fires'));
  assert.ok(estimateTokens(big.text) <= 400);

  assert.equal(buildContext([], 'q').mode, 'none');
});

test('transcript: interim text is replaced, finals merge by speaker and time', () => {
  const t = new Transcript();
  t.add({ speaker: 'them', text: 'so what', final: false, ts: 0 });
  assert.equal(t.interim.them, 'so what');
  t.add({ speaker: 'them', text: 'So what is your result?', ts: 1000 });
  assert.equal(t.interim.them, '');
  t.add({ speaker: 'them', text: 'In one line.', ts: 2000 });
  t.add({ speaker: 'me', text: 'The rules miss 44.', ts: 3000 });
  t.add({ speaker: 'them', text: 'Okay.', ts: 20000 });
  assert.equal(t.lines.length, 3);
  assert.equal(t.fullText(), 'Them: So what is your result? In one line.\nMe: The rules miss 44.\nThem: Okay.');
});

test('transcript: recentText keeps the newest lines within the limit', () => {
  const t = new Transcript();
  for (let i = 0; i < 50; i++) t.add({ speaker: i % 2 ? 'me' : 'them', text: `line number ${i}`, ts: i * 10000 });
  const recent = t.recentText(100);
  assert.ok(recent.length <= 100);
  assert.ok(recent.endsWith('line number 49'));
  assert.ok(!recent.includes('line number 0\n'));
});

test('questions: detects questions with and without a question mark', () => {
  assert.equal(isQuestion('What is your biggest weakness?'), true);
  assert.equal(isQuestion('so how do you know it is not memorising'), true);
  assert.equal(isQuestion('Okay. Can you walk me through the method'), true);
  assert.equal(isQuestion('Tell me about the data'), true);
  assert.equal(isQuestion('That makes sense, thank you.'), false);
  assert.equal(isQuestion('Why?'), false);
  assert.equal(isQuestion(''), false);
});

test('wav: header describes mono 16-bit pcm of the right length', () => {
  const pcm = new Int16Array(16000);
  const wav = pcm16ToWav(pcm, 16000);
  assert.equal(wav.length, 44 + 32000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + 32000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 32000);
});

test('wav: rms is 0 for silence and near 1 for full scale', () => {
  assert.equal(rms(new Int16Array(100)), 0);
  assert.ok(rms(new Int16Array(100).fill(32767)) > 0.99);
});

test('markdown: escapes html so model output cannot inject markup', () => {
  const html = render('<img src=x onerror=alert(1)> and `<b>` and **bold**');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('<code>&lt;b&gt;</code>'));
  assert.ok(html.includes('<strong>bold</strong>'));
});

test('markdown: renders lists, code blocks, tables and safe links only', () => {
  const html = render('## Head\n\n- one\n- two\n\n1. a\n2. b\n\n```js\nconst x = "<y>";\n```\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n[ok](https://example.com) [bad](javascript:alert(1))');
  assert.ok(html.includes('<h4>Head</h4>'));
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
  assert.ok(html.includes('<ol><li>a</li><li>b</li></ol>'));
  assert.ok(html.includes('<pre><code>const x = &quot;&lt;y&gt;&quot;;</code></pre>'));
  assert.ok(html.includes('<th>A</th>') && html.includes('<td>2</td>'));
  assert.ok(html.includes('<a href="https://example.com"'));
  assert.ok(!html.includes('href="javascript'));
});

test('profiles: every built-in profile is well formed and covers every mode', () => {
  const modes = new Set();
  for (const p of BUILTIN_PROFILES) {
    assert.ok(p.id && p.name && p.prompt.length > 100, p.id);
    assert.ok(MODES.includes(p.mode));
    modes.add(p.mode);
    assert.ok(p.actions.length >= 3);
    for (const a of p.actions) assert.ok(ACTIONS[a], `${p.id} uses unknown action ${a}`);
  }
  assert.deepEqual([...modes].sort(), [...MODES].sort());
});

test('profiles: a pack inherits its mode and adds its own prompt', () => {
  const pack = parsePack(
    { name: 'Star Map', mode: 'research', description: 'd', prompt: 'File 02 wins.', files: ['01.md', '02.md'] },
    'C:/packs/star-map'
  );
  assert.equal(pack.id, 'pack-star-map');
  const profile = profileFromPack(pack);
  assert.equal(profile.mode, 'research');
  assert.ok(profile.prompt.includes('denominator'));
  assert.ok(profile.prompt.endsWith('File 02 wins.'));
  assert.deepEqual(profile.packFiles, ['01.md', '02.md']);
  assert.equal(listProfiles([profile]).length, BUILTIN_PROFILES.length + 1);
});

test('profiles: rejects bad packs and paths that escape the folder', () => {
  assert.throws(() => parsePack(null, 'x'), /not an object/);
  assert.throws(() => parsePack({ mode: 'research' }, 'x'), /name/);
  assert.throws(() => parsePack({ name: 'A', files: ['../secret.md'] }, 'x'), /relative/);
  assert.throws(() => parsePack({ name: 'A', files: ['C:\\secret.md'] }, 'x'), /relative/);
  assert.equal(parsePack({ name: 'A', mode: 'nonsense' }, 'x').mode, 'general');
  assert.equal(slugify('  My Project! '), 'my-project');
  assert.equal(slugify('Физика 2'), 'физика-2');
  assert.equal(slugify('!!!'), 'profile');
  assert.deepEqual(parsePack({ name: 'A', files: ['notes..final.md'] }, 'x').packFiles, ['notes..final.md']);
});

test('markdown: odd line breaks inside a heading do not hang the renderer', () => {
  assert.match(render('# a\u2028b'), /<h3>a<\/h3>/);
  assert.match(render('# a\rb'), /<p>b<\/p>/);
  assert.match(render('#\u2028'), /<p>#<\/p>/);
});

test('retrieval: a question that matches nothing still sends the top of the files', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about soil and watering.`).join('\n\n');
  const context = buildContext([{ name: 'garden.md', text: filler }], 'zzz', 1500);
  assert.equal(context.mode, 'retrieved');
  assert.ok(context.text.includes('Paragraph 0 about soil'));
  const cyrillic = buildContext([{ name: 'a.md', text: `${filler}\n\nПредел батареи 4.2 В.` }], 'предел батареи', 1500);
  assert.ok(cyrillic.text.includes('Предел батареи'));
});

test('llm: newer OpenAI models get max_completion_tokens, others max_tokens', () => {
  const { buildRequest } = require('../src/main/llm');
  const settings = (model) => ({ provider: 'openai', maxTokens: 500, openai: { baseUrl: 'http://x/v1', model, fastModel: model } });
  const args = { apiKey: '', system: 's', messages: [{ role: 'user', text: 'hi' }] };
  assert.equal(buildRequest({ ...args, settings: settings('gpt-4o') }).body.max_tokens, 500);
  const newer = buildRequest({ ...args, settings: settings('gpt-5-mini') }).body;
  assert.equal(newer.max_completion_tokens, 500);
  assert.equal(newer.max_tokens, undefined);
});

test('prompts: system prompt is ordered stable-first and labels partial knowledge', () => {
  const profile = BUILTIN_PROFILES[0];
  const full = buildSystemPrompt({ profile, customInstructions: 'Be brief.', knowledge: { mode: 'full', text: 'FACT' } });
  assert.ok(full.indexOf(profile.prompt) < full.indexOf('Be brief.'));
  assert.ok(full.indexOf('Be brief.') < full.indexOf('FACT'));
  assert.ok(full.includes('complete'));
  const partial = buildSystemPrompt({ profile, knowledge: { mode: 'retrieved', text: 'FACT' } });
  assert.ok(partial.includes('cannot see'));
  assert.ok(!buildSystemPrompt({ profile, knowledge: { mode: 'none', text: '' } }).includes('<my_files>'));
});

test('prompts: user text prefers the typed question, then the action, then assist', () => {
  assert.ok(buildUserText({ question: 'Why 147?', actionId: 'recap' }).endsWith('Why 147?'));
  assert.ok(buildUserText({ actionId: 'recap' }).endsWith(ACTIONS.recap.prompt));
  assert.ok(buildUserText({}).endsWith(ACTIONS.assist.prompt));
  const withContext = buildUserText({ question: 'q', transcriptText: 'Them: hi', hasScreenshot: true });
  assert.ok(withContext.includes('<recent_conversation>\nThem: hi'));
  assert.ok(withContext.includes('screenshot'));
});

test('prompts: notes prompt carries the transcript and the title is recovered', () => {
  const prompt = buildNotesPrompt({ transcriptText: 'Me: hello', chatText: '' });
  assert.ok(prompt.includes('<transcript>\nMe: hello'));
  assert.ok(!prompt.includes('<assistant_chat>'));
  assert.equal(titleFromNotes('## Title\nBudget review call\n\n## Summary\n- x', 'fallback'), 'Budget review call');
  assert.equal(titleFromNotes('no headings here', 'fallback'), 'fallback');
});

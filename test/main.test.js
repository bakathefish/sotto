'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, DEFAULTS } = require('../src/main/store');
const { Sessions, toMarkdown, newSessionId } = require('../src/main/sessions');
const { ChunkedStream, createStream } = require('../src/main/stt');
const { buildRequest } = require('../src/main/llm');
const { readKnowledgeFile, profileFilePaths, isSupported } = require('../src/main/knowledge');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sotto-test-'));

// Stands in for Electron's safeStorage.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
  decryptString: (b) => b.toString().split('').reverse().join(''),
};

test('store: defaults, nested updates and persistence', () => {
  const dir = tmpDir();
  const store = new Store(dir, fakeSafeStorage);
  assert.equal(store.get().provider, 'anthropic');
  store.update({ overlay: { opacity: 0.5 }, shortcuts: { toggle: 'F9' } });
  assert.equal(store.get().overlay.opacity, 0.5);
  assert.equal(store.get().overlay.width, DEFAULTS.overlay.width, 'sibling keys survive a nested update');
  assert.equal(store.get().shortcuts.assist, DEFAULTS.shortcuts.assist);

  const reopened = new Store(dir, fakeSafeStorage);
  assert.equal(reopened.get().shortcuts.toggle, 'F9');
});

test('store: knowledge lists are replaced, not merged', () => {
  const store = new Store(tmpDir(), fakeSafeStorage);
  store.update({ knowledge: { general: ['a.md', 'b.md'] } });
  store.update({ knowledge: { general: ['a.md'] } });
  assert.deepEqual(store.get().knowledge, { general: ['a.md'] });
});

test('store: secrets are encrypted on disk and never listed by value', () => {
  const dir = tmpDir();
  const store = new Store(dir, fakeSafeStorage);
  store.setSecret('anthropic', 'key-12345');
  assert.equal(store.getSecret('anthropic'), 'key-12345');
  assert.deepEqual(store.secretStatus(), { anthropic: true, openai: false, deepgram: false, sttOpenai: false });
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('key-12345'), false);
  store.update({ maxTokens: 1024 });
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('key-12345'), false);

  store.setSecret('anthropic', '');
  assert.equal(store.getSecret('anthropic'), '');
  assert.throws(() => store.setSecret('other', 'x'), /Unknown secret/);
});

test('sessions: save, list newest first, export, remove', () => {
  const sessions = new Sessions(tmpDir());
  const base = { profile: 'Research', transcript: [{ speaker: 'them', text: 'Why 16 kHz?' }], chat: [], notes: '' };
  sessions.save({ ...base, id: 'a', title: 'Older', started: 1000, ended: 2000 });
  sessions.save({
    ...base,
    id: 'b',
    title: 'Newer',
    started: 5000,
    ended: 6000,
    chat: [{ role: 'user', text: 'Assist' }, { role: 'assistant', text: 'Speech needs 8 kHz of bandwidth.' }],
    notes: '## Title\nNewer\n\n## Summary\n- Sample rate.',
  });
  assert.deepEqual(sessions.list().map((s) => s.id), ['b', 'a']);
  assert.equal(sessions.list()[0].turns, 2);

  const markdown = toMarkdown(sessions.get('b'));
  assert.match(markdown, /^# Newer\n/);
  assert.match(markdown, /## Summary\n- Sample rate\./);
  assert.equal(markdown.includes('## Title'), false, 'the title section is not repeated');
  assert.match(markdown, /\*\*Them:\*\* Why 16 kHz\?/);
  assert.match(markdown, /\*\*Sotto:\*\* Speech needs/);

  sessions.remove('a');
  assert.deepEqual(sessions.list().map((s) => s.id), ['b']);
  assert.throws(() => sessions.get('../settings'), /Bad session id/);
  assert.match(newSessionId(new Date('2026-01-02T03:04:05Z')), /^20260102030405-[a-z0-9]+$/);
});

// 16 kHz mono PCM16: a 440 Hz tone or silence.
function pcm(seconds, amplitude) {
  const samples = Math.round(seconds * 16000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  return buf;
}

function chunkedStream(replies) {
  const calls = [];
  const results = [];
  const errors = [];
  const stream = new ChunkedStream({
    apiKey: 'k',
    baseUrl: 'http://stt.test/v1/',
    model: 'whisper-1',
    language: 'en',
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return replies.shift();
    },
  });
  return { stream, calls, results, errors };
}

const okReply = (text) => ({ ok: true, json: async () => ({ text }) });

test('chunked transcription: sends speech after a pause as a WAV upload', async () => {
  const { stream, calls, results } = chunkedStream([okReply(' Hello there. ')]);
  stream.write(pcm(1.5, 0.3));
  assert.equal(calls.length, 0, 'waits while the speaker is still talking');
  stream.write(pcm(0.6, 0.3));
  stream.write(pcm(0.8, 0));
  await stream.pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://stt.test/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const file = calls[0].init.body.get('file');
  assert.equal(file.size, 44 + Math.round(2.9 * 16000) * 2, 'WAV header plus every sample');
  assert.equal(calls[0].init.body.get('model'), 'whisper-1');
  assert.deepEqual(results, [{ text: 'Hello there.', final: true }]);
});

test('chunked transcription: silence is never uploaded, long speech is cut at 12 s', async () => {
  const quiet = chunkedStream([]);
  quiet.stream.write(pcm(3, 0));
  quiet.stream.close();
  await quiet.stream.pending;
  assert.equal(quiet.calls.length, 0);

  const long = chunkedStream([okReply('part one')]);
  for (let i = 0; i < 12; i++) long.stream.write(pcm(1, 0.3));
  await long.stream.pending;
  assert.equal(long.calls.length, 1);
});

test('chunked transcription: a failed request reaches onError and later chunks still run', async () => {
  const { stream, results, errors } = chunkedStream([{ ok: false, status: 401, text: async () => 'bad key' }, okReply('second')]);
  stream.write(pcm(2, 0.3));
  stream.close();
  stream.write(pcm(2, 0.3));
  stream.close();
  await stream.pending;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /401.*bad key/);
  assert.deepEqual(results, [{ text: 'second', final: true }]);
});

test('createStream: clear errors when transcription is off or the key is missing', () => {
  const args = { secrets: {}, onResult() {}, onError() {} };
  assert.throws(() => createStream({ ...args, settings: { stt: { provider: 'off' } } }), /Transcription is off/);
  assert.throws(() => createStream({ ...args, settings: { stt: { provider: 'deepgram' } } }), /No Deepgram API key/);
});

const messages = [
  { role: 'user', text: 'Earlier question' },
  { role: 'assistant', text: 'Earlier answer' },
  { role: 'user', text: 'What is on screen?', imageBase64: 'QUJD' },
];

test('llm: Anthropic request shape', () => {
  const settings = structuredClone(DEFAULTS);
  const req = buildRequest({ settings, apiKey: 'key', system: 'SYSTEM', messages, fast: false });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'key');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.model, settings.anthropic.model);
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
  assert.equal(req.body.messages[0].content, 'Earlier question');
  assert.deepEqual(req.body.messages[2].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(req.body.tools, undefined);

  settings.anthropic.webSearch = true;
  assert.equal(buildRequest({ settings, apiKey: 'key', system: 'S', messages, fast: false }).body.tools[0].name, 'web_search');
  const fast = buildRequest({ settings, apiKey: 'key', system: 'S', messages, fast: true });
  assert.equal(fast.body.model, settings.anthropic.fastModel);
  assert.equal(fast.body.tools, undefined, 'live suggestions skip web search');
});

test('llm: OpenAI-compatible request shape, with and without a key', () => {
  const settings = { ...structuredClone(DEFAULTS), provider: 'openai' };
  settings.openai.baseUrl = 'http://localhost:11434/v1/';
  const req = buildRequest({ settings, apiKey: '', system: 'SYSTEM', messages, fast: true });
  assert.equal(req.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(req.headers.authorization, undefined, 'local servers need no key');
  assert.equal(req.body.model, settings.openai.fastModel);
  assert.deepEqual(req.body.messages[0], { role: 'system', content: 'SYSTEM' });
  assert.equal(req.body.messages[3].content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.equal(buildRequest({ settings, apiKey: 'k', system: 'S', messages }).headers.authorization, 'Bearer k');
});

test('knowledge: reads text, reports problems, lists pack then profile then shared files', async () => {
  const dir = tmpDir();
  const note = path.join(dir, 'note.md');
  fs.writeFileSync(note, '# Note\nBody');
  assert.deepEqual(await readKnowledgeFile(note), { name: 'note.md', path: note, text: '# Note\nBody' });
  assert.match((await readKnowledgeFile(path.join(dir, 'missing.md'))).error, /ENOENT/);
  const binary = path.join(dir, 'photo.png');
  fs.writeFileSync(binary, 'x');
  assert.match((await readKnowledgeFile(binary)).error, /Unsupported file type/);
  assert.equal(isSupported('paper.PDF'), true);
  assert.equal(isSupported('photo.png'), false);

  const profile = { id: 'pack-x', packFolder: dir, packFiles: ['note.md'] };
  const settings = { knowledge: { 'pack-x': ['/own.md'], '*': ['/shared.md', '/own.md'] } };
  assert.deepEqual(profileFilePaths(profile, settings), [note, '/own.md', '/shared.md']);
});

test('the example pack in the repo is valid and its files exist', () => {
  const { parsePack, profileFromPack } = require('../src/core/profiles');
  const dir = path.join(__dirname, '..', 'examples', 'example-pack');
  const pack = parsePack(JSON.parse(fs.readFileSync(path.join(dir, 'sotto-pack.json'), 'utf8')), dir);
  assert.equal(pack.mode, 'hardware');
  for (const file of pack.packFiles) assert.ok(fs.existsSync(path.join(dir, file)), file);
  assert.match(profileFromPack(pack).prompt, /This project:\nThis is a solar weather station/);
});

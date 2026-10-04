'use strict';

// End-to-end smoke test. Starts a local mock of an OpenAI-compatible server,
// launches the real app against it with a throwaway settings folder, and
// checks that a question travels screen -> knowledge -> model -> overlay, and
// that ending the session writes notes. No API key or network needed.
//
// Run: npm run smoke

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const ANSWER = 'The magic number is **4417**.';
const NOTES = '## Title\nSmoke session\n\n## Summary\n- The mock streamed a fixed reply.\n\n## Action items\n- None';

const requests = [];

function startMock() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"text":""}');
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const isNotes = body.messages[0].content.includes('compact notes');
      const reply = isNotes ? NOTES : ANSWER;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Split mid-word so the client has to reassemble the stream.
      for (let i = 0; i < reply.length; i += 7) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + 7) } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runApp(env) {
  return new Promise((resolve, reject) => {
    // SOTTO_SMOKE_EXE runs a packaged build instead of the source tree.
    const exe = process.env.SOTTO_SMOKE_EXE;
    const child = spawn(exe || require('electron'), exe ? [] : ['.'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The app did not finish within 90 seconds'));
    }, 90000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', reject);
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sotto-smoke-'));
  const userData = path.join(tmp, 'userData');
  const packs = path.join(tmp, 'packs');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(packs, 'smoke'), { recursive: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  fs.writeFileSync(
    path.join(packs, 'smoke', 'sotto-pack.json'),
    JSON.stringify({ name: 'Smoke project', mode: 'research', description: 'Test pack', prompt: 'Quote facts.md exactly.', files: ['facts.md', 'sample.pdf'] })
  );
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'sample.pdf'), path.join(packs, 'smoke', 'sample.pdf'));
  fs.writeFileSync(path.join(packs, 'smoke', 'facts.md'), '# Facts\n\nThe magic number is 4417.\n');

  const server = await startMock();
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    // Content protection is off here only so the test can screenshot its own windows.
    JSON.stringify({ provider: 'openai', openai: { baseUrl, model: 'mock', fastModel: 'mock-fast' }, overlay: { contentProtection: false }, stt: { provider: 'openai', openaiBaseUrl: baseUrl, openaiModel: 'mock-stt' } })
  );

  try {
    await runApp({ SOTTO_SMOKE: '1', SOTTO_USER_DATA: userData, SOTTO_SMOKE_OUT: OUT, SOTTO_SMOKE_PACKS: packs });
  } finally {
    server.close();
  }

  const result = JSON.parse(fs.readFileSync(path.join(OUT, 'result.json'), 'utf8'));
  assert.deepEqual(result.errors, [], 'no errors in the main process or either window');
  assert.deepEqual(result.imported, { imported: ['Smoke project'], errors: [] }, 'the pack imports as a profile');

  // The answer streamed back whole and reached the overlay as rendered markdown.
  assert.equal(result.answer, ANSWER);
  assert.match(result.overlayText, /The magic number is 4417\./);
  assert.doesNotMatch(result.overlayText, /\*\*/, 'markdown is rendered, not shown raw');
  assert.ok(result.overlayBounds.height > 150, 'the overlay grew to fit the answer');

  // Listening started, audio frames flowed from the page to the main process, and it stopped.
  assert.equal(result.listening, true, 'listening started');
  assert.equal(result.listeningAfterStop, false, 'listening stopped');
  assert.ok(result.audioFrames.me + result.audioFrames.them > 0, 'audio frames arrived');
  console.log(`audio frames in 2.5 s: microphone ${result.audioFrames.me}, system audio ${result.audioFrames.them}`);

  // Hotkeys, tray, click-through and profile cycling.
  console.log(`shortcuts registered: ${result.registeredShortcuts} of 12${result.failedShortcuts.length ? ', taken by another app: ' + result.failedShortcuts.join(', ') : ''}`);
  assert.ok(result.registeredShortcuts >= 10, 'global shortcuts registered');
  assert.equal(result.tray, true, 'tray icon created');
  assert.equal(result.clickThroughShown, true, 'click-through reaches the overlay');
  assert.equal(result.profileAfterCycle, 'general', 'next-profile wraps from the last profile to the first');

  // With content protection on, the overlay is missing from a screen capture.
  console.log(`screen pixels that changed when protection was turned on: ${(result.captureChangedFraction * 100).toFixed(1)}%`);
  if (process.platform === 'win32') assert.ok(result.captureChangedFraction > 0.05, 'the overlay disappears from screen capture');

  // The request carried the profile, the pack file and a screenshot.
  const ask = requests[0];
  assert.equal(ask.model, 'mock');
  assert.equal(ask.stream, true);
  assert.match(ask.messages[0].content, /The magic number is 4417\./, 'knowledge file is in the system prompt');
  assert.match(ask.messages[0].content, /The battery limit is 4\.2 V/, 'PDF text is in the system prompt');
  assert.match(ask.messages[0].content, /Quote facts\.md exactly\./, 'pack instructions are in the system prompt');
  const user = ask.messages[ask.messages.length - 1];
  assert.equal(user.content[0].text.includes('What is the magic number?'), true);
  assert.match(user.content[1].image_url.url, /^data:image\/jpeg;base64,\/9j\//, 'a JPEG screenshot is attached');

  // Ending the session wrote notes from the transcript and saved everything.
  assert.match(requests[1].messages[1].content, /Them: How does the mock work\?/);
  assert.deepEqual(
    { title: result.session.title, lines: result.session.lines, turns: result.session.turns },
    { title: 'Smoke session', lines: 2, turns: 2 }
  );
  assert.equal(result.session.notes, NOTES);
  const saved = fs.readdirSync(path.join(userData, 'sessions'));
  assert.equal(saved.length, 1, 'one session file on disk');

  // The dashboard rendered with the imported profile.
  assert.match(result.dashboardText, /Smoke project/);
  assert.match(result.dashboardText, /facts\.md/);
  for (const name of ['overlay.png', 'dashboard.png']) {
    assert.ok(fs.statSync(path.join(OUT, name)).size > 2000, `${name} was captured`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`smoke test passed: ${requests.length} model requests, screenshots in ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

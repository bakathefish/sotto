'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, safeStorage, screen,
  session, shell,
} = require('electron');

const { Store } = require('./store');
const { Sessions, toMarkdown, newSessionId } = require('./sessions');
const { loadProfileKnowledge, isSupported } = require('./knowledge');
const { streamChat } = require('./llm');
const { createStream } = require('./stt');
const { Transcript } = require('../core/transcript');
const { isQuestion } = require('../core/questions');
const { buildContext, estimateTokens } = require('../core/retrieval');
const { ACTIONS, MODES, BUILTIN_PROFILES, listProfiles, parsePack, profileFromPack, slugify } = require('../core/profiles');
const { buildSystemPrompt, buildUserText, buildSuggestionText, buildNotesPrompt, titleFromNotes } = require('../core/prompts');

const SMOKE = process.env.SOTTO_SMOKE === '1';
if (process.env.SOTTO_USER_DATA) app.setPath('userData', process.env.SOTTO_USER_DATA);

const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const MOVE_STEP = 60;

let store;
let sessions;
let overlay = null;
let dashboard = null;
let tray = null;
let clickThrough = false;

const transcript = new Transcript();
let chat = []; // { role, text, ts }
let current = { id: newSessionId(), started: Date.now() };
let sttStreams = null;
let answerSeq = 0;
let answerAbort = null;
let suggestAbort = null;
let lastSuggestAt = 0;
const audioFrames = { me: 0, them: 0 }; // 100 ms frames received, per speaker

// ---------------------------------------------------------------- helpers

function sendOverlay(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function sendDashboard(channel, payload) {
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send(channel, payload);
}

function profiles() {
  return listProfiles(store.get().userProfiles);
}

function activeProfile() {
  const all = profiles();
  return all.find((p) => p.id === store.get().activeProfile) || all[0];
}

function apiKey() {
  return store.getSecret(store.get().provider === 'openai' ? 'openai' : 'anthropic');
}

function overlayState() {
  const settings = store.get();
  const profile = activeProfile();
  return {
    profiles: profiles().map((p) => ({ id: p.id, name: p.name, mode: p.mode })),
    activeProfile: profile.id,
    actions: profile.actions.map((id) => ({ id, label: ACTIONS[id].label })),
    listening: Boolean(sttStreams),
    sttReady: settings.stt.provider !== 'off',
    clickThrough,
    contentProtection: settings.overlay.contentProtection,
    shortcuts: settings.shortcuts,
  };
}

function pushState() {
  sendOverlay('state', overlayState());
}

function lockDownNavigation(win) {
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------- windows

function createOverlay() {
  const settings = store.get();
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(settings.overlay.width, area.width - 40);
  overlay = new BrowserWindow({
    width,
    height: 120,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 24,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(RENDERER, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setContentProtection(settings.overlay.contentProtection);
  overlay.setOpacity(settings.overlay.opacity);
  lockDownNavigation(overlay);
  overlay.loadFile(path.join(RENDERER, 'overlay.html'));
  overlay.once('ready-to-show', () => {
    overlay.showInactive();
    if (SMOKE) runSmoke();
  });
  overlay.on('closed', () => {
    overlay = null;
  });
}

function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    return;
  }
  dashboard = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'Sotto',
    icon: ICON,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(RENDERER, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  dashboard.setContentProtection(store.get().overlay.contentProtection);
  lockDownNavigation(dashboard);
  dashboard.loadFile(path.join(RENDERER, 'dashboard.html'));
  dashboard.on('closed', () => {
    dashboard = null;
  });
}

function toggleOverlay() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

function focusOverlay() {
  if (!overlay) return;
  setClickThrough(false);
  overlay.show();
  overlay.focus();
  sendOverlay('focus-input');
}

function moveOverlay(dx, dy) {
  if (!overlay) return;
  const b = overlay.getBounds();
  overlay.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
}

function setClickThrough(on) {
  clickThrough = on;
  if (overlay) overlay.setIgnoreMouseEvents(on, { forward: true });
  pushState();
}

function cycleProfile() {
  const all = profiles();
  const idx = all.findIndex((p) => p.id === activeProfile().id);
  setProfile(all[(idx + 1) % all.length].id);
}

function setProfile(id) {
  if (!profiles().some((p) => p.id === id)) return;
  store.update({ activeProfile: id });
  pushState();
  sendDashboard('changed');
}

// -------------------------------------------------------------- shortcuts

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = store.get().shortcuts;
  const handlers = {
    toggle: toggleOverlay,
    assist: () => {
      if (overlay && !overlay.isVisible()) overlay.showInactive();
      ask({ actionId: 'assist', useScreen: true });
    },
    focus: focusOverlay,
    listen: () => sendOverlay('toggle-listen'),
    clickThrough: () => setClickThrough(!clickThrough),
    newSession: () => endSession({ withNotes: false }),
    dashboard: openDashboard,
    nextProfile: cycleProfile,
    moveLeft: () => moveOverlay(-MOVE_STEP, 0),
    moveRight: () => moveOverlay(MOVE_STEP, 0),
    moveUp: () => moveOverlay(0, -MOVE_STEP),
    moveDown: () => moveOverlay(0, MOVE_STEP),
  };
  const failed = [];
  for (const [name, handler] of Object.entries(handlers)) {
    const accelerator = s[name];
    if (!accelerator) continue;
    try {
      if (!globalShortcut.register(accelerator, handler)) failed.push(`${name} (${accelerator})`);
    } catch {
      failed.push(`${name} (${accelerator})`);
    }
  }
  return failed;
}

// ----------------------------------------------------------------- screen

async function captureScreen() {
  const bounds = overlay ? overlay.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  const w = display.size.width * display.scaleFactor;
  const h = display.size.height * display.scaleFactor;
  const scale = Math.min(1, 1568 / Math.max(w, h));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(w * scale), height: Math.round(h * scale) },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture failed. Check screen recording permission.');
  return source.thumbnail.toJPEG(75).toString('base64');
}

// -------------------------------------------------------------------- ask

async function buildSystem(query) {
  const settings = store.get();
  const profile = activeProfile();
  const files = (await loadProfileKnowledge(profile, settings)).filter((f) => f.text);
  const knowledge = buildContext(files, query, settings.knowledgeBudgetTokens);
  return buildSystemPrompt({ profile, customInstructions: settings.customInstructions, knowledge });
}

async function ask({ question = '', actionId = '', useScreen = true }) {
  const settings = store.get();
  if (answerAbort) answerAbort.abort();
  const controller = new AbortController();
  answerAbort = controller;
  const id = ++answerSeq;
  const label = question.trim() || (ACTIONS[actionId] && ACTIONS[actionId].label) || ACTIONS.assist.label;
  sendOverlay('answer:start', { id, kind: 'answer', label });
  try {
    const transcriptText = transcript.recentText();
    const system = await buildSystem(`${question}\n${actionId}\n${transcriptText.slice(-1500)}`);
    const imageBase64 = useScreen && settings.includeScreenshot ? await captureScreen() : null;
    const text = buildUserText({ question, actionId, transcriptText, hasScreenshot: Boolean(imageBase64) });
    const history = chat.slice(-12).map((t) => ({ role: t.role, text: t.text }));
    const full = await streamChat({
      settings,
      apiKey: apiKey(),
      system,
      messages: history.concat([{ role: 'user', text, imageBase64 }]),
      signal: controller.signal,
      onText: (piece) => sendOverlay('answer:delta', { id, text: piece }),
    });
    chat.push({ role: 'user', text: label, ts: Date.now() }, { role: 'assistant', text: full, ts: Date.now() });
    sendOverlay('answer:done', { id });
    return full;
  } catch (err) {
    if (controller.signal.aborted) sendOverlay('answer:done', { id, cancelled: true });
    else sendOverlay('answer:error', { id, message: err.message });
    return null;
  } finally {
    if (answerAbort === controller) answerAbort = null;
  }
}

// A quick spoken-answer suggestion when the other side asks a question.
async function suggest(utterance) {
  const settings = store.get();
  if (suggestAbort) suggestAbort.abort();
  const controller = new AbortController();
  suggestAbort = controller;
  const id = ++answerSeq;
  sendOverlay('answer:start', { id, kind: 'suggestion', label: utterance });
  try {
    const transcriptText = transcript.recentText(3000);
    const full = await streamChat({
      settings,
      apiKey: apiKey(),
      system: await buildSystem(utterance),
      messages: [{ role: 'user', text: buildSuggestionText({ utterance, transcriptText }) }],
      fast: true,
      signal: controller.signal,
      onText: (piece) => sendOverlay('answer:delta', { id, text: piece }),
    });
    chat.push({ role: 'user', text: `They asked: ${utterance}`, ts: Date.now() }, { role: 'assistant', text: full, ts: Date.now() });
    sendOverlay('answer:done', { id });
  } catch (err) {
    if (controller.signal.aborted) sendOverlay('answer:done', { id, cancelled: true });
    else sendOverlay('answer:error', { id, message: err.message });
  } finally {
    if (suggestAbort === controller) suggestAbort = null;
  }
}

// -------------------------------------------------------------- listening

function pushTranscript() {
  sendOverlay('transcript', { lines: transcript.lines.slice(-40), interim: transcript.interim });
}

function onSpeech(speaker, { text, final }) {
  const line = transcript.add({ speaker, text, final });
  pushTranscript();
  if (!line || speaker !== 'them') return;
  const settings = store.get();
  if (!settings.autoSuggest || !activeProfile().autoSuggest) return;
  if (!isQuestion(text) || Date.now() - lastSuggestAt < 6000) return;
  lastSuggestAt = Date.now();
  suggest(text);
}

function startListening() {
  if (sttStreams) return { ok: true };
  const settings = store.get();
  const secrets = {
    deepgram: store.getSecret('deepgram'),
    openai: store.getSecret('openai'),
    sttOpenai: store.getSecret('sttOpenai'),
  };
  const onError = (err) => sendOverlay('toast', { message: err.message });
  try {
    sttStreams = {
      me: createStream({ settings, secrets, onResult: (r) => onSpeech('me', r), onError }),
      them: createStream({ settings, secrets, onResult: (r) => onSpeech('them', r), onError }),
    };
  } catch (err) {
    sttStreams = null;
    return { ok: false, error: err.message };
  }
  pushState();
  return { ok: true };
}

function stopListening() {
  if (!sttStreams) return;
  sttStreams.me.close();
  sttStreams.them.close();
  sttStreams = null;
  pushState();
}

// --------------------------------------------------------------- sessions

async function endSession({ withNotes }) {
  stopListening();
  sendOverlay('stop-audio');
  if (answerAbort) answerAbort.abort();
  if (suggestAbort) suggestAbort.abort();
  let saved = null;
  if (!transcript.isEmpty() || chat.length > 0) {
    const fallbackTitle = `Session ${new Date(current.started).toISOString().slice(0, 16).replace('T', ' ')}`;
    const record = {
      id: current.id,
      title: fallbackTitle,
      profile: activeProfile().name,
      started: current.started,
      ended: Date.now(),
      transcript: transcript.lines.map((l) => ({ speaker: l.speaker, text: l.text, start: l.start })),
      chat,
      notes: '',
    };
    if (withNotes) {
      sendOverlay('toast', { message: 'Writing notes...' });
      try {
        const chatText = chat.map((t) => `${t.role === 'user' ? 'Me' : 'Assistant'}: ${t.text}`).join('\n');
        record.notes = await streamChat({
          settings: store.get(),
          apiKey: apiKey(),
          system: 'You write accurate, compact notes. You never add facts that are not in the source.',
          messages: [{ role: 'user', text: buildNotesPrompt({ transcriptText: transcript.fullText(), chatText }) }],
        });
        record.title = titleFromNotes(record.notes, fallbackTitle);
      } catch (err) {
        sendOverlay('toast', { message: `Notes failed: ${err.message}. Session saved without notes.` });
      }
    }
    saved = sessions.save(record);
    sendDashboard('changed');
  }
  transcript.clear();
  chat = [];
  current = { id: newSessionId(), started: Date.now() };
  sendOverlay('session:reset', saved ? { id: saved.id, title: saved.title, hasNotes: Boolean(saved.notes) } : null);
  pushTranscript();
  return saved;
}

// --------------------------------------------------------------- dashboard

async function knowledgeStatus(profileId) {
  const settings = store.get();
  const profile = profiles().find((p) => p.id === profileId) || activeProfile();
  const files = await loadProfileKnowledge(profile, settings);
  const own = new Set(settings.knowledge[profile.id] || []);
  const shared = new Set(settings.knowledge['*'] || []);
  const rows = files.map((f) => ({
    name: f.name,
    path: f.path,
    error: f.error || '',
    tokens: f.text ? estimateTokens(f.text) : 0,
    source: own.has(f.path) ? 'profile' : shared.has(f.path) ? 'all' : 'pack',
  }));
  const total = rows.reduce((sum, r) => sum + r.tokens, 0);
  return { profileId: profile.id, files: rows, total, budget: settings.knowledgeBudgetTokens, whole: total <= settings.knowledgeBudgetTokens };
}

function importPackFolder(folder) {
  const imported = [];
  const errors = [];
  const tryFolder = (dir) => {
    const manifest = path.join(dir, 'sotto-pack.json');
    if (!fs.existsSync(manifest)) return false;
    try {
      imported.push(profileFromPack(parsePack(JSON.parse(fs.readFileSync(manifest, 'utf8')), dir)));
    } catch (err) {
      errors.push(`${path.basename(dir)}: ${err.message}`);
    }
    return true;
  };
  // Either a single pack folder or a folder of pack folders.
  if (!tryFolder(folder)) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) tryFolder(path.join(folder, entry.name));
    }
  }
  if (imported.length > 0) {
    const ids = new Set(imported.map((p) => p.id));
    store.update({ userProfiles: store.get().userProfiles.filter((p) => !ids.has(p.id)).concat(imported) });
    pushState();
  }
  return { imported: imported.map((p) => p.name), errors };
}

function saveUserProfile({ id, name, mode, prompt, description }) {
  if (!name || !name.trim()) throw new Error('A profile needs a name');
  const base = BUILTIN_PROFILES.find((p) => p.mode === mode) || BUILTIN_PROFILES[0];
  const existing = store.get().userProfiles.find((p) => p.id === id);
  const profile = {
    ...(existing || {}),
    id: existing ? existing.id : 'user-' + slugify(name),
    name: name.trim(),
    mode: base.mode,
    description: description || '',
    actions: base.actions,
    autoSuggest: base.autoSuggest,
    prompt: prompt && prompt.trim() ? prompt : base.prompt,
    builtin: false,
  };
  store.update({ userProfiles: store.get().userProfiles.filter((p) => p.id !== profile.id).concat([profile]) });
  pushState();
  return profile;
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, arg) => fn(arg || {}));

  // Overlay
  handle('state:get', () => overlayState());
  handle('ask', (arg) => {
    ask(arg);
  });
  handle('ask:cancel', () => {
    if (answerAbort) answerAbort.abort();
    if (suggestAbort) suggestAbort.abort();
  });
  handle('profile:set', ({ id }) => setProfile(id));
  handle('listen:start', () => startListening());
  handle('listen:stop', () => stopListening());
  handle('session:end', ({ withNotes = true }) => endSession({ withNotes }).then((s) => (s ? { id: s.id } : null)));
  handle('overlay:hide', () => overlay && overlay.hide());
  handle('overlay:height', ({ height }) => {
    if (!overlay) return;
    const b = overlay.getBounds();
    const max = screen.getDisplayMatching(b).workArea.height - 40;
    overlay.setBounds({ ...b, height: Math.max(56, Math.min(Math.round(height), max)) });
  });
  handle('dashboard:open', () => openDashboard());
  ipcMain.on('audio:chunk', (_event, { speaker, pcm }) => {
    if (!sttStreams || !sttStreams[speaker]) return;
    audioFrames[speaker] += 1;
    sttStreams[speaker].write(Buffer.from(pcm));
  });

  // Dashboard
  handle('dash:get', () => ({
    settings: store.get(),
    secrets: store.secretStatus(),
    canEncrypt: store.canEncrypt(),
    profiles: profiles(),
    activeProfile: activeProfile().id,
    modes: MODES,
    version: app.getVersion(),
  }));
  handle('settings:update', (patch) => {
    const before = store.get();
    const after = store.update(patch);
    let failedShortcuts = [];
    if (patch.shortcuts) failedShortcuts = registerShortcuts();
    if (patch.overlay && overlay) {
      overlay.setContentProtection(after.overlay.contentProtection);
      overlay.setOpacity(after.overlay.opacity);
      if (dashboard) dashboard.setContentProtection(after.overlay.contentProtection);
      if (after.overlay.width !== before.overlay.width) overlay.setBounds({ ...overlay.getBounds(), width: after.overlay.width });
    }
    pushState();
    return { failedShortcuts };
  });
  handle('secret:set', ({ name, value }) => {
    store.setSecret(name, value);
    return store.secretStatus();
  });
  handle('knowledge:status', ({ profileId }) => knowledgeStatus(profileId));
  handle('knowledge:add', async ({ profileId, paths }) => {
    let picked = paths;
    if (!picked) {
      const result = await dialog.showOpenDialog(dashboard, {
        title: 'Add knowledge files',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documents', extensions: ['md', 'txt', 'pdf', 'docx', 'json', 'csv', 'py', 'js', 'ts', 'c', 'h', 'cpp', 'ino', 'tex', 'yaml', 'yml'] }, { name: 'All files', extensions: ['*'] }],
      });
      picked = result.canceled ? [] : result.filePaths;
    }
    const knowledge = { ...store.get().knowledge };
    knowledge[profileId] = [...new Set((knowledge[profileId] || []).concat(picked.filter(isSupported)))];
    store.update({ knowledge });
    return knowledgeStatus(profileId === '*' ? activeProfile().id : profileId);
  });
  handle('knowledge:remove', ({ profileId, filePath }) => {
    const knowledge = { ...store.get().knowledge };
    for (const key of [profileId, '*']) knowledge[key] = (knowledge[key] || []).filter((p) => p !== filePath);
    store.update({ knowledge });
    return knowledgeStatus(profileId);
  });
  handle('pack:import', async ({ folder }) => {
    let dir = folder;
    if (!dir) {
      const result = await dialog.showOpenDialog(dashboard, {
        title: 'Choose a pack folder, or a folder that contains pack folders',
        properties: ['openDirectory'],
      });
      if (result.canceled) return { imported: [], errors: [], cancelled: true };
      dir = result.filePaths[0];
    }
    return importPackFolder(dir);
  });
  handle('profile:save', (profile) => saveUserProfile(profile));
  handle('profile:delete', ({ id }) => {
    const settings = store.get();
    const knowledge = { ...settings.knowledge };
    delete knowledge[id];
    store.update({
      userProfiles: settings.userProfiles.filter((p) => p.id !== id),
      knowledge,
      activeProfile: settings.activeProfile === id ? 'general' : settings.activeProfile,
    });
    pushState();
  });
  handle('sessions:list', () => sessions.list());
  handle('sessions:get', ({ id }) => sessions.get(id));
  handle('sessions:delete', ({ id }) => sessions.remove(id));
  handle('sessions:export', async ({ id }) => {
    const record = sessions.get(id);
    const result = await dialog.showSaveDialog(dashboard, {
      title: 'Export session',
      defaultPath: slugify(record.title) + '.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled) return { saved: false };
    fs.writeFileSync(result.filePath, toMarkdown(record));
    return { saved: true, path: result.filePath };
  });
  handle('llm:test', async () => {
    try {
      const text = await streamChat({
        settings: store.get(),
        apiKey: apiKey(),
        system: 'You are a connection test.',
        messages: [{ role: 'user', text: 'Reply with the single word: ready' }],
        fast: true,
      });
      return { ok: true, text: text.trim().slice(0, 80) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ------------------------------------------------------------------- tray

function createTray() {
  const image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) return;
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Sotto');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show or hide overlay', click: toggleOverlay },
      { label: 'Dashboard', click: openDashboard },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleOverlay);
}

// ------------------------------------------------------------------ smoke

// End-to-end check used by `npm run smoke`: ask once through the real window
// and IPC path against a local mock server, screenshot both windows, exit.
async function runSmoke() {
  const outDir = process.env.SOTTO_SMOKE_OUT;
  const result = { errors: [] };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A freshly shown window can take a moment to produce its first frame.
  const snap = async (win) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await win.webContents.capturePage()).toPNG();
      } catch (err) {
        if (attempt === 5) throw err;
        await wait(500);
      }
    }
  };
  try {
    overlay.webContents.on('console-message', (event) => {
      if (event.level === 'error') result.errors.push(`overlay: ${event.message}`);
    });
    if (overlay.webContents.isLoading()) await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
    await wait(300);
    result.imported = importPackFolder(process.env.SOTTO_SMOKE_PACKS);
    setProfile('pack-smoke-project');
    result.answer = await ask({ question: 'What is the magic number?', useScreen: true });
    await wait(600);
    fs.writeFileSync(path.join(outDir, 'overlay.png'), await snap(overlay));
    result.overlayText = await overlay.webContents.executeJavaScript('document.body.innerText');
    result.overlayBounds = overlay.getBounds();

    // Listening: the microphone and system audio should both deliver PCM frames.
    await overlay.webContents.executeJavaScript('toggleListen()', true);
    await wait(2500);
    result.listening = Boolean(sttStreams);
    result.audioFrames = { ...audioFrames };
    await overlay.webContents.executeJavaScript('toggleListen()', true);
    result.listeningAfterStop = Boolean(sttStreams);

    // Capture hiding: grab the screen with protection off and on, and compare
    // the part of the screen where the overlay sits.
    const overlayOnScreen = async (name) => {
      const image = nativeImage.createFromBuffer(Buffer.from(await captureScreen(), 'base64'));
      const b = overlay.getBounds();
      const display = screen.getDisplayMatching(b);
      const k = image.getSize().width / display.size.width;
      const crop = image.crop({
        x: Math.round((b.x - display.bounds.x) * k),
        y: Math.round((b.y - display.bounds.y) * k),
        width: Math.round(b.width * k),
        height: Math.round(b.height * k),
      });
      fs.writeFileSync(path.join(outDir, name), crop.toPNG());
      return crop.toBitmap();
    };
    const visible = await overlayOnScreen('screen-unprotected.png');
    overlay.setContentProtection(true);
    await wait(700);
    const hidden = await overlayOnScreen('screen-protected.png');
    overlay.setContentProtection(false);
    await wait(300);
    let changed = 0;
    for (let i = 0; i < visible.length; i += 4) {
      if (Math.abs(visible[i] - hidden[i]) + Math.abs(visible[i + 1] - hidden[i + 1]) + Math.abs(visible[i + 2] - hidden[i + 2]) > 60) changed++;
    }
    result.captureChangedFraction = changed / (visible.length / 4);

    // Hotkeys, tray and click-through.
    result.failedShortcuts = registerShortcuts();
    result.registeredShortcuts = Object.values(store.get().shortcuts).filter((a) => globalShortcut.isRegistered(a)).length;
    result.tray = Boolean(tray);
    setClickThrough(true);
    await wait(200);
    result.clickThroughShown = await overlay.webContents.executeJavaScript('document.body.classList.contains("click-through")');
    setClickThrough(false);
    cycleProfile();
    result.profileAfterCycle = store.get().activeProfile;
    setProfile('pack-smoke-project');

    transcript.add({ speaker: 'them', text: 'How does the mock work?' });
    transcript.add({ speaker: 'me', text: 'It streams a fixed reply.', ts: Date.now() + 5000 });
    const saved = await endSession({ withNotes: true });
    result.session = saved && { title: saved.title, notes: saved.notes, lines: saved.transcript.length, turns: saved.chat.length };

    openDashboard();
    dashboard.webContents.on('console-message', (event) => {
      if (event.level === 'error') result.errors.push(`dashboard: ${event.message}`);
    });
    await new Promise((resolve) => dashboard.webContents.once('did-finish-load', resolve));
    await wait(800);
    fs.writeFileSync(path.join(outDir, 'dashboard.png'), await snap(dashboard));
    result.dashboardText = await dashboard.webContents.executeJavaScript('document.body.innerText');
  } catch (err) {
    result.errors.push(`smoke: ${err.stack || err.message}`);
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(0);
}

// -------------------------------------------------------------------- app

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => overlay && overlay.showInactive());

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'), safeStorage);
    sessions = new Sessions(path.join(app.getPath('userData'), 'sessions'));

    // The overlay asks for microphone and system audio; grant only those, only to our own pages.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const ours = webContents.getURL().startsWith('file://');
      callback(ours && ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
    });
    // System audio: hand back the primary screen with loopback audio. The
    // renderer drops the video track and keeps the audio.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    });

    registerIpc();
    createOverlay();
    createTray();
    const failed = registerShortcuts();
    if (failed.length > 0) {
      overlay.webContents.once('did-finish-load', () =>
        sendOverlay('toast', { message: `Shortcut already in use: ${failed.join(', ')}. Change it in the dashboard.` })
      );
    }
  });

  app.on('before-quit', () => {
    // Keep unsaved work: store the session without notes.
    if (!SMOKE && sessions && (!transcript.isEmpty() || chat.length > 0)) {
      sessions.save({
        id: current.id,
        title: `Session ${new Date(current.started).toISOString().slice(0, 16).replace('T', ' ')}`,
        profile: activeProfile().name,
        started: current.started,
        ended: Date.now(),
        transcript: transcript.lines.map((l) => ({ speaker: l.speaker, text: l.text, start: l.start })),
        chat,
        notes: '',
      });
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    // Stay alive in the tray; quit from the tray menu.
  });
}

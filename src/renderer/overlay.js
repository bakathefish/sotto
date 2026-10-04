'use strict';

const $ = (id) => document.getElementById(id);
const api = window.sotto;
const md = window.SottoMarkdown;

const cards = new Map(); // answer id -> { el, body, text, dirty }
let state = null;
let audio = null; // { context, streams }
let statusTimer = null;

// ------------------------------------------------------------------ layout

// The window is frameless and sized to its content.
new ResizeObserver(() => {
  api.invoke('overlay:height', { height: $('root').offsetHeight });
}).observe($('root'));

function showStatus(message, ms = 6000) {
  const el = $('status');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function pretty(accelerator) {
  const mac = navigator.platform.startsWith('Mac');
  return accelerator.replace('CommandOrControl', mac ? 'Cmd' : 'Ctrl').replace(/\+/g, ' + ');
}

function applyState(next) {
  state = next;
  const select = $('profile');
  select.replaceChildren(
    ...state.profiles.map((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      return option;
    })
  );
  select.value = state.activeProfile;

  $('chips').replaceChildren(
    ...state.actions.map((action) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = action.label;
      chip.addEventListener('click', () => ask({ actionId: action.id }));
      return chip;
    })
  );

  document.body.classList.toggle('listening', state.listening);
  document.body.classList.toggle('click-through', state.clickThrough);
  $('listen').textContent = state.listening ? 'Stop' : 'Listen';

  const s = state.shortcuts;
  const hints = [`${pretty(s.assist)} assist`, `${pretty(s.toggle)} hide`, `${pretty(s.focus)} type`, `${pretty(s.nextProfile)} profile`];
  if (state.clickThrough) hints.unshift(`Click-through on (${pretty(s.clickThrough)} to turn off)`);
  if (!state.contentProtection) hints.push('visible to screen share');
  $('hints').textContent = hints.join('  |  ');
}

// ----------------------------------------------------------------- answers

function ask({ question = '', actionId = '' }) {
  api.invoke('ask', { question, actionId, useScreen: $('useScreen').checked });
}

function submitQuestion() {
  const input = $('question');
  const question = input.value.trim();
  if (!question) return ask({ actionId: 'assist' });
  input.value = '';
  ask({ question });
}

function renderCard(card) {
  card.dirty = false;
  card.body.innerHTML = md.render(card.text);
  const list = $('answers');
  list.scrollTop = list.scrollHeight;
}

api.on('answer:start', ({ id, kind, label }) => {
  const el = document.createElement('div');
  el.className = `card ${kind}`;
  const head = document.createElement('div');
  head.className = 'card-head';
  if (kind === 'suggestion') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'They asked';
    head.append(tag);
  }
  const title = document.createElement('span');
  title.className = 'label';
  title.textContent = label;
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  head.append(title, copy);
  const body = document.createElement('div');
  body.className = 'body cursor';
  el.append(head, body);

  const card = { el, body, text: '', dirty: false };
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(card.text);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  });
  cards.set(id, card);
  const list = $('answers');
  list.append(el);
  while (list.children.length > 20) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
});

api.on('answer:delta', ({ id, text }) => {
  const card = cards.get(id);
  if (!card) return;
  card.text += text;
  if (card.dirty) return;
  card.dirty = true;
  requestAnimationFrame(() => renderCard(card));
});

api.on('answer:done', ({ id, cancelled }) => {
  const card = cards.get(id);
  if (!card) return;
  card.body.classList.remove('cursor');
  if (cancelled && !card.text) card.el.remove();
  else renderCard(card);
  cards.delete(id);
});

api.on('answer:error', ({ id, message }) => {
  const card = cards.get(id);
  if (!card) return;
  card.el.classList.add('failed');
  card.body.classList.remove('cursor');
  card.body.textContent = message;
  cards.delete(id);
});

// -------------------------------------------------------------- transcript

api.on('transcript', ({ lines, interim }) => {
  const rows = lines.map((l) => ({ ...l, interim: false }));
  for (const speaker of ['me', 'them']) {
    if (interim[speaker]) rows.push({ speaker, text: interim[speaker], interim: true });
  }
  const box = $('lines');
  box.replaceChildren(
    ...rows.map((row) => {
      const el = document.createElement('div');
      el.className = `line ${row.speaker}${row.interim ? ' interim' : ''}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = row.speaker === 'me' ? 'Me' : 'Them';
      el.append(who, row.text);
      return el;
    })
  );
  box.scrollTop = box.scrollHeight;
});

// ------------------------------------------------------------------- audio

async function tap(context, stream, speaker) {
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-worklet', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
  node.port.onmessage = (event) => api.sendAudio(speaker, event.data);
  source.connect(node);
}

async function startAudio() {
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule('pcm-worklet.js');
  const streams = [];
  const problems = [];
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    streams.push(mic);
    await tap(context, mic, 'me');
  } catch {
    problems.push('microphone');
  }
  try {
    // The main process answers this with the screen plus loopback audio.
    const system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    system.getVideoTracks().forEach((track) => track.stop());
    if (system.getAudioTracks().length === 0) throw new Error('no audio track');
    streams.push(system);
    await tap(context, system, 'them');
  } catch {
    problems.push('system audio');
  }
  if (streams.length === 0) {
    await context.close();
    throw new Error('No audio source available. Check microphone and screen recording permissions.');
  }
  audio = { context, streams };
  if (problems.length > 0) showStatus(`Listening without ${problems.join(' and ')}.`);
}

function stopAudio() {
  if (!audio) return;
  for (const stream of audio.streams) stream.getTracks().forEach((track) => track.stop());
  audio.context.close();
  audio = null;
}

async function toggleListen() {
  if (state && state.listening) {
    stopAudio();
    await api.invoke('listen:stop');
    return;
  }
  const result = await api.invoke('listen:start');
  if (!result.ok) return showStatus(result.error);
  $('transcript').hidden = false;
  try {
    await startAudio();
  } catch (err) {
    await api.invoke('listen:stop');
    showStatus(err.message);
  }
}

// ------------------------------------------------------------------ events

$('ask').addEventListener('click', submitQuestion);
$('question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitQuestion();
  if (event.key === 'Escape') api.invoke('ask:cancel');
});
$('profile').addEventListener('change', (event) => api.invoke('profile:set', { id: event.target.value }));
$('listen').addEventListener('click', toggleListen);
$('more').addEventListener('click', () => {
  $('transcript').hidden = !$('transcript').hidden;
});
$('end').addEventListener('click', () => api.invoke('session:end', { withNotes: true }));
$('dash').addEventListener('click', () => api.invoke('dashboard:open'));
$('hide').addEventListener('click', () => api.invoke('overlay:hide'));

api.on('state', applyState);
api.on('focus-input', () => $('question').focus());
api.on('toggle-listen', toggleListen);
api.on('stop-audio', stopAudio);
api.on('toast', ({ message }) => showStatus(message));
api.on('session:reset', (saved) => {
  $('answers').replaceChildren();
  cards.clear();
  if (saved) showStatus(`Saved "${saved.title}"${saved.hasNotes ? ' with notes' : ''}. Open the dashboard to read or export it.`);
});

api.invoke('state:get').then(applyState);

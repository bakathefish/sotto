'use strict';

const $ = (id) => document.getElementById(id);
const api = window.sotto;
const md = window.SottoMarkdown;

let data = null; // result of dash:get
let selectedProfile = null;
let selectedSession = null;
let editingProfileId = null;

const SHORTCUT_LABELS = {
  toggle: 'Show or hide the overlay',
  assist: 'Assist with what is on screen',
  focus: 'Type a question',
  listen: 'Start or stop listening',
  clickThrough: 'Click-through on or off',
  newSession: 'Start a new session',
  dashboard: 'Open this dashboard',
  nextProfile: 'Next profile',
  moveLeft: 'Move overlay left',
  moveRight: 'Move overlay right',
  moveUp: 'Move overlay up',
  moveDown: 'Move overlay down',
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else node[key] = value;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function flashSaved(text = 'Saved') {
  $('saved').textContent = text;
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => ($('saved').textContent = ''), 1500);
}

function getPath(object, path) {
  return path.split('.').reduce((o, key) => (o === undefined || o === null ? o : o[key]), object);
}

function patchFor(path, value) {
  const keys = path.split('.');
  const patch = {};
  let cursor = patch;
  keys.forEach((key, i) => {
    cursor[key] = i === keys.length - 1 ? value : {};
    cursor = cursor[key];
  });
  return patch;
}

// --------------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    for (const name of ['profiles', 'sessions', 'settings']) $(`tab-${name}`).hidden = name !== tab.dataset.tab;
    if (tab.dataset.tab === 'sessions') loadSessions();
  });
}

// ----------------------------------------------------------------- settings

function fillSettings() {
  for (const input of document.querySelectorAll('[data-path]')) {
    const value = getPath(data.settings, input.dataset.path);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value === undefined ? '' : value;
  }
  for (const input of document.querySelectorAll('[data-secret]')) {
    input.value = '';
    if (data.secrets[input.dataset.secret]) input.placeholder = 'Saved. Type a new key to replace it.';
  }
  $('encryption').textContent = data.canEncrypt
    ? 'Keys are encrypted with your operating system keychain and never leave this computer except to call the provider.'
    : 'Warning: no system keychain is available, so keys are stored in plain text in the settings folder.';
  $('version').textContent = `v${data.version}`;

  $('shortcuts').replaceChildren(
    ...Object.entries(SHORTCUT_LABELS).map(([name, label]) => {
      const input = el('input', { type: 'text', value: data.settings.shortcuts[name] || '' });
      input.addEventListener('change', async () => {
        const result = await api.invoke('settings:update', { shortcuts: { [name]: input.value.trim() } });
        $('shortcutResult').textContent = result.failedShortcuts.length
          ? `Could not register: ${result.failedShortcuts.join(', ')}. Another app may be using it.`
          : '';
        flashSaved();
      });
      return el('label', {}, label, input);
    })
  );
}

for (const input of document.querySelectorAll('[data-path]')) {
  input.addEventListener('change', async () => {
    let value = input.value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number' || input.type === 'range') value = Number(input.value);
    await api.invoke('settings:update', patchFor(input.dataset.path, value));
    flashSaved();
    await refresh({ keepForm: true });
  });
}

for (const button of document.querySelectorAll('[data-save-secret]')) {
  button.addEventListener('click', async () => {
    const name = button.dataset.saveSecret;
    const input = document.querySelector(`[data-secret="${name}"]`);
    data.secrets = await api.invoke('secret:set', { name, value: input.value.trim() });
    input.value = '';
    input.placeholder = data.secrets[name] ? 'Saved. Type a new key to replace it.' : 'Removed';
    flashSaved(data.secrets[name] ? 'Key saved' : 'Key removed');
  });
}

$('testLlm').addEventListener('click', async () => {
  $('testResult').textContent = 'Testing...';
  const result = await api.invoke('llm:test');
  $('testResult').textContent = result.ok ? `Working. The model said: ${result.text}` : `Failed. ${result.error}`;
});

// ----------------------------------------------------------------- profiles

function renderProfileList() {
  $('profileList').replaceChildren(
    ...data.profiles.map((p) =>
      el(
        'button',
        {
          class: `item${p.id === selectedProfile ? ' selected' : ''}`,
          onclick: () => {
            selectedProfile = p.id;
            renderProfileList();
            renderProfileDetail();
          },
        },
        el('span', { class: 'name' }, p.name, p.id === data.activeProfile ? el('span', { class: 'badge on' }, 'active') : null),
        el('span', { class: 'meta' }, p.builtin ? `built-in, ${p.mode}` : p.packFolder ? `pack, ${p.mode}` : `custom, ${p.mode}`)
      )
    )
  );
}

async function renderProfileDetail() {
  const profile = data.profiles.find((p) => p.id === selectedProfile);
  const pane = $('profileDetail');
  if (!profile) return pane.replaceChildren();
  const status = await api.invoke('knowledge:status', { profileId: profile.id });
  if (selectedProfile !== profile.id) return;

  const removable = (row) => row.source !== 'pack';
  const table = el(
    'table',
    {},
    el('tr', {}, el('th', {}, 'File'), el('th', {}, 'From'), el('th', {}, 'Tokens'), el('th', {}, '')),
    ...status.files.map((row) =>
      el(
        'tr',
        {},
        el('td', { title: row.path }, row.name, row.error ? el('span', { class: 'warn' }, `  ${row.error}`) : null),
        el('td', { class: 'muted' }, row.source === 'pack' ? 'pack' : row.source === 'all' ? 'all profiles' : 'this profile'),
        el('td', { class: 'num' }, row.tokens.toLocaleString('en-US')),
        el(
          'td',
          {},
          removable(row)
            ? el('button', {
                textContent: 'Remove',
                onclick: async () => {
                  await api.invoke('knowledge:remove', { profileId: profile.id, filePath: row.path });
                  await refresh();
                },
              })
            : null
        )
      )
    )
  );

  const total = status.total.toLocaleString('en-US');
  const budget = status.budget.toLocaleString('en-US');
  const summary =
    status.files.length === 0
      ? 'No files yet. Add notes, papers, datasheets or code and Sotto will answer from them.'
      : status.whole
        ? `About ${total} tokens. Under the ${budget} budget, so every file is sent whole with each question.`
        : `About ${total} tokens. Over the ${budget} budget, so Sotto searches the files and sends the best matching passages.`;

  const buttons = [
    profile.id === data.activeProfile
      ? el('span', { class: 'badge on' }, 'active in the overlay')
      : el('button', {
          class: 'primary',
          textContent: 'Use this profile',
          onclick: async () => {
            await api.invoke('profile:set', { id: profile.id });
            await refresh();
          },
        }),
  ];
  if (profile.id.startsWith('user-')) buttons.push(el('button', { textContent: 'Edit', onclick: () => openProfileDialog(profile) }));
  if (!profile.builtin) {
    buttons.push(
      el('button', {
        class: 'danger',
        textContent: 'Delete',
        onclick: async () => {
          if (!confirm(`Delete the profile "${profile.name}"? Its files stay on disk.`)) return;
          await api.invoke('profile:delete', { id: profile.id });
          selectedProfile = 'general';
          await refresh();
        },
      })
    );
  }

  const addFiles = (profileId) => async () => {
    await api.invoke('knowledge:add', { profileId });
    await refresh();
  };

  pane.replaceChildren(
    el('h2', {}, profile.name, el('span', { class: 'badge' }, profile.mode)),
    profile.description ? el('p', { class: 'muted' }, profile.description) : null,
    el('div', { class: 'row' }, ...buttons),
    el('h3', {}, 'Knowledge'),
    el('p', { class: 'muted' }, summary),
    status.files.length > 0 ? table : null,
    el(
      'div',
      { class: 'row' },
      el('button', { textContent: 'Add files to this profile', onclick: addFiles(profile.id) }),
      el('button', { textContent: 'Add files to all profiles', onclick: addFiles('*') })
    ),
    profile.packFolder ? el('p', { class: 'muted' }, `Pack folder: ${profile.packFolder}`) : null,
    el('h3', {}, 'Instructions'),
    el('pre', { class: 'prompt' }, profile.prompt)
  );
}

function openProfileDialog(profile) {
  editingProfileId = profile ? profile.id : null;
  $('profileDialogTitle').textContent = profile ? 'Edit profile' : 'New profile';
  $('pdMode').replaceChildren(...data.modes.map((mode) => el('option', { value: mode, textContent: mode })));
  $('pdName').value = profile ? profile.name : '';
  $('pdMode').value = profile ? profile.mode : 'general';
  $('pdDescription').value = profile ? profile.description || '' : '';
  $('pdPrompt').value = profile ? profile.prompt : '';
  $('profileDialog').showModal();
}

$('profileDialog').addEventListener('close', async () => {
  if ($('profileDialog').returnValue !== 'save') return;
  try {
    const saved = await api.invoke('profile:save', {
      id: editingProfileId,
      name: $('pdName').value,
      mode: $('pdMode').value,
      description: $('pdDescription').value,
      prompt: $('pdPrompt').value,
    });
    selectedProfile = saved.id;
    flashSaved('Profile saved');
  } catch (err) {
    alert(err.message);
  }
  await refresh();
});

$('newProfile').addEventListener('click', () => openProfileDialog(null));

$('importPack').addEventListener('click', async () => {
  const result = await api.invoke('pack:import');
  if (result.imported.length > 0) flashSaved(`Imported ${result.imported.length} pack${result.imported.length === 1 ? '' : 's'}`);
  if (result.errors.length > 0) alert(`Some packs could not be imported:\n${result.errors.join('\n')}`);
  else if (result.imported.length === 0 && !result.cancelled) alert('No sotto-pack.json found in that folder or its subfolders.');
  await refresh();
});

// ----------------------------------------------------------------- sessions

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadSessions() {
  const list = await api.invoke('sessions:list');
  $('sessionList').replaceChildren(
    ...(list.length === 0 ? [el('p', { class: 'muted' }, 'No sessions yet.')] : []),
    ...list.map((s) =>
      el(
        'button',
        {
          class: `item${s.id === selectedSession ? ' selected' : ''}`,
          onclick: () => {
            selectedSession = s.id;
            loadSessions();
            showSession(s.id);
          },
        },
        el('span', { class: 'name' }, s.title),
        el('span', { class: 'meta' }, `${formatDate(s.started)}, ${s.profile}, ${s.lines} lines, ${s.turns / 2} answers`)
      )
    )
  );
}

async function showSession(id) {
  const s = await api.invoke('sessions:get', { id });
  const notes = el('div', { class: 'notes' });
  notes.innerHTML = md.render(s.notes || '*No notes were written for this session.*');
  $('sessionDetail').replaceChildren(
    el('h2', {}, s.title),
    el('p', { class: 'muted' }, `${formatDate(s.started)}, profile: ${s.profile}`),
    el(
      'div',
      { class: 'row' },
      el('button', {
        textContent: 'Export markdown',
        onclick: async () => {
          const result = await api.invoke('sessions:export', { id });
          if (result.saved) flashSaved('Exported');
        },
      }),
      el('button', {
        class: 'danger',
        textContent: 'Delete',
        onclick: async () => {
          if (!confirm(`Delete "${s.title}"?`)) return;
          await api.invoke('sessions:delete', { id });
          selectedSession = null;
          $('sessionDetail').replaceChildren();
          loadSessions();
        },
      })
    ),
    el('h3', {}, 'Notes'),
    notes,
    s.chat.length > 0 ? el('h3', {}, 'Assistant chat') : null,
    ...s.chat.map((turn) => {
      const body = el('span', {});
      body.innerHTML = turn.role === 'assistant' ? md.render(turn.text) : md.escapeHtml(turn.text);
      return el('div', { class: `turn ${turn.role}` }, el('span', { class: 'who' }, turn.role === 'user' ? 'Me' : 'Sotto'), body);
    }),
    s.transcript.length > 0 ? el('h3', {}, 'Transcript') : null,
    ...s.transcript.map((line) =>
      el('div', { class: `turn ${line.speaker}` }, el('span', { class: 'who' }, line.speaker === 'me' ? 'Me' : 'Them'), line.text)
    )
  );
}

// --------------------------------------------------------------------- load

async function refresh({ keepForm = false } = {}) {
  data = await api.invoke('dash:get');
  if (!selectedProfile || !data.profiles.some((p) => p.id === selectedProfile)) selectedProfile = data.activeProfile;
  if (!keepForm) fillSettings();
  renderProfileList();
  await renderProfileDetail();
}

api.on('changed', () => {
  refresh({ keepForm: true });
  if (!$('tab-sessions').hidden) loadSessions();
});

refresh();

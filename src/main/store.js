'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  provider: 'anthropic', // 'anthropic' | 'openai' (any OpenAI-compatible endpoint)
  anthropic: { model: 'claude-opus-5-5', fastModel: 'claude-haiku-4-5-20251001', webSearch: false },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', fastModel: 'gpt-4o-mini' },
  stt: {
    provider: 'off', // 'off' | 'deepgram' | 'openai'
    language: 'en',
    deepgramModel: 'nova-3',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'whisper-1',
  },
  activeProfile: 'general',
  userProfiles: [],
  knowledge: {}, // profile id (or '*' for every profile) -> absolute file paths
  customInstructions: '',
  includeScreenshot: true,
  autoSuggest: true,
  knowledgeBudgetTokens: 60000,
  maxTokens: 2048,
  overlay: { contentProtection: true, opacity: 0.96, width: 720 },
  shortcuts: {
    toggle: 'CommandOrControl+\\',
    assist: 'CommandOrControl+Enter',
    focus: 'CommandOrControl+Shift+Space',
    listen: 'CommandOrControl+Shift+L',
    clickThrough: 'CommandOrControl+Shift+X',
    newSession: 'CommandOrControl+Shift+R',
    dashboard: 'CommandOrControl+Shift+D',
    nextProfile: 'CommandOrControl+Shift+P',
    moveLeft: 'CommandOrControl+Alt+Left',
    moveRight: 'CommandOrControl+Alt+Right',
    moveUp: 'CommandOrControl+Alt+Up',
    moveDown: 'CommandOrControl+Alt+Down',
  },
};

const SECRET_NAMES = ['anthropic', 'openai', 'deepgram', 'sttOpenai'];

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Saved settings win, but keys added in newer versions still get defaults.
function mergeDefaults(defaults, saved) {
  if (!isPlainObject(saved)) return structuredClone(defaults);
  const out = { ...saved };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in saved)) out[key] = structuredClone(value);
    else if (isPlainObject(value) && key !== 'knowledge') out[key] = mergeDefaults(value, saved[key]);
  }
  return out;
}

class Store {
  // safeStorage is Electron's OS-backed encryption; injected so tests can stub it.
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.settingsPath = path.join(dir, 'settings.json');
    this.secretsPath = path.join(dir, 'secrets.json');
    fs.mkdirSync(dir, { recursive: true });
    this.settings = mergeDefaults(DEFAULTS, this.readJson(this.settingsPath));
    this.secrets = this.readJson(this.secretsPath) || {};
  }

  readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  writeJson(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  get() {
    return this.settings;
  }

  update(patch) {
    this.settings = mergeDefaults(this.settings, { ...this.settings, ...patch });
    this.writeJson(this.settingsPath, this.settings);
    return this.settings;
  }

  canEncrypt() {
    return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
  }

  setSecret(name, value) {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    if (!value) delete this.secrets[name];
    else if (this.canEncrypt()) this.secrets[name] = { enc: this.safeStorage.encryptString(value).toString('base64') };
    else this.secrets[name] = { plain: value };
    this.writeJson(this.secretsPath, this.secrets);
  }

  getSecret(name) {
    const entry = this.secrets[name];
    if (!entry) return '';
    try {
      if (entry.enc) return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
    } catch {
      return '';
    }
    return entry.plain || '';
  }

  // Which secrets exist, never their values. Safe to send to a renderer.
  secretStatus() {
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, Boolean(this.secrets[n])]));
  }
}

module.exports = { Store, DEFAULTS, SECRET_NAMES, mergeDefaults };

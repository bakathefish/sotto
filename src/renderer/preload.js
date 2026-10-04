'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only channels a page may use. Anything else is rejected here.
const INVOKE = new Set([
  'state:get', 'ask', 'ask:cancel', 'profile:set', 'listen:start', 'listen:stop', 'session:end',
  'overlay:hide', 'overlay:height', 'dashboard:open',
  'dash:get', 'settings:update', 'secret:set', 'knowledge:status', 'knowledge:add', 'knowledge:remove',
  'pack:import', 'profile:save', 'profile:delete',
  'sessions:list', 'sessions:get', 'sessions:delete', 'sessions:export', 'llm:test',
]);
const EVENTS = new Set([
  'state', 'focus-input', 'toggle-listen', 'stop-audio', 'transcript', 'toast', 'session:reset',
  'answer:start', 'answer:delta', 'answer:done', 'answer:error', 'changed',
]);

contextBridge.exposeInMainWorld('sotto', {
  invoke(channel, arg) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`));
    return ipcRenderer.invoke(channel, arg);
  },
  on(channel, listener) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event: ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
  // pcm: ArrayBuffer of 16 kHz mono Int16 samples.
  sendAudio(speaker, pcm) {
    ipcRenderer.send('audio:chunk', { speaker, pcm });
  },
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Sessions are plain JSON files, one per session, in <userData>/sessions.
class Sessions {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Bad session id');
    return path.join(this.dir, id + '.json');
  }

  save(session) {
    fs.writeFileSync(this.file(session.id), JSON.stringify(session, null, 2));
    return session;
  }

  get(id) {
    return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
  }

  remove(id) {
    fs.rmSync(this.file(id), { force: true });
  }

  // Newest first, without the heavy fields.
  list() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        out.push({
          id: s.id,
          title: s.title,
          profile: s.profile,
          started: s.started,
          ended: s.ended,
          lines: (s.transcript || []).length,
          turns: (s.chat || []).length,
        });
      } catch {
        // skip unreadable files
      }
    }
    return out.sort((a, b) => b.started - a.started);
  }
}

function toMarkdown(session) {
  const date = new Date(session.started).toISOString().replace('T', ' ').slice(0, 16);
  const parts = [`# ${session.title}`, `${date} UTC, profile: ${session.profile}`];
  if (session.notes) parts.push(session.notes.replace(/^##\s*Title\s*\n+[^\n]*\n*/m, '').trim());
  if (session.chat && session.chat.length) {
    parts.push('## Assistant chat');
    for (const turn of session.chat) parts.push(`**${turn.role === 'user' ? 'Me' : 'Sotto'}:** ${turn.text}`);
  }
  if (session.transcript && session.transcript.length) {
    parts.push('## Transcript');
    parts.push(session.transcript.map((l) => `**${l.speaker === 'me' ? 'Me' : 'Them'}:** ${l.text}`).join('\n\n'));
  }
  return parts.join('\n\n') + '\n';
}

function newSessionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

module.exports = { Sessions, toMarkdown, newSessionId };

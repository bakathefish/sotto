'use strict';

// Rolling meeting transcript. Speakers are 'me' (microphone) and 'them'
// (system audio). Interim results replace each other until a final arrives.
class Transcript {
  constructor() {
    this.lines = [];
    this.interim = { me: '', them: '' };
  }

  add({ speaker, text, final = true, ts = Date.now() }) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!final) {
      this.interim[speaker] = clean;
      return null;
    }
    this.interim[speaker] = '';
    if (!clean) return null;
    const last = this.lines[this.lines.length - 1];
    // Merge consecutive finals from the same speaker within 4 seconds.
    if (last && last.speaker === speaker && ts - last.end < 4000) {
      last.text += ' ' + clean;
      last.end = ts;
      return last;
    }
    const line = { speaker, text: clean, start: ts, end: ts };
    this.lines.push(line);
    return line;
  }

  label(speaker) {
    return speaker === 'me' ? 'Me' : 'Them';
  }

  // Most recent lines that fit in maxChars, oldest first.
  recentText(maxChars = 6000) {
    const out = [];
    let used = 0;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const row = `${this.label(this.lines[i].speaker)}: ${this.lines[i].text}`;
      if (used + row.length > maxChars && out.length > 0) break;
      out.unshift(row);
      used += row.length + 1;
    }
    return out.join('\n');
  }

  fullText() {
    return this.lines.map((l) => `${this.label(l.speaker)}: ${l.text}`).join('\n');
  }

  isEmpty() {
    return this.lines.length === 0;
  }

  clear() {
    this.lines = [];
    this.interim = { me: '', them: '' };
  }
}

module.exports = { Transcript };

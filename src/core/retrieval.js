'use strict';

// Knowledge-base retrieval. Small knowledge bases go into the prompt whole
// (more accurate than any retrieval); large ones fall back to BM25 over chunks.

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have how i if in into is it its me my of on or our so that the ' +
    'their then there these they this to was we were what when where which who why will with you your')
    .split(' ')
);

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function tokenize(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) || [];
  return words.filter((w) => !STOPWORDS.has(w));
}

// Split on blank lines, keep each chunk under `size` characters, and carry the
// nearest heading so a chunk still says what it is about.
function chunkText(text, { size = 1600 } = {}) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const chunks = [];
  let heading = '';
  let current = '';

  const flush = () => {
    const body = current.trim();
    if (body) chunks.push(heading && !body.startsWith(heading) ? `${heading}\n${body}` : body);
    current = '';
  };

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const firstLine = block.split('\n', 1)[0];
    if (/^#{1,6}\s/.test(firstLine)) {
      flush();
      heading = firstLine;
    }
    if (current.length + block.length + 2 > size) flush();
    if (block.length > size) {
      for (let i = 0; i < block.length; i += size) {
        current = block.slice(i, i + size);
        flush();
      }
    } else {
      current += (current ? '\n\n' : '') + block;
    }
  }
  flush();
  return chunks;
}

function buildIndex(files) {
  const docs = [];
  const df = new Map();
  for (const file of files) {
    for (const text of chunkText(file.text)) {
      const tokens = tokenize(text);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      docs.push({ file: file.name, text, tf, length: tokens.length });
    }
  }
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);
  return { docs, df, avgLength };
}

function search(index, query, k = 8) {
  const K1 = 1.5;
  const B = 0.75;
  const terms = [...new Set(tokenize(query))];
  const n = index.docs.length;
  const scored = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const df = index.df.get(term);
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / (index.avgLength || 1)));
    }
    if (score > 0) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// Returns { text, mode: 'none' | 'full' | 'retrieved', files }.
function buildContext(files, query, budgetTokens = 60000) {
  const usable = files.filter((f) => f.text && f.text.trim());
  if (usable.length === 0) return { text: '', mode: 'none', files: [] };

  const total = usable.reduce((sum, f) => sum + estimateTokens(f.text), 0);
  if (total <= budgetTokens) {
    const text = usable.map((f) => `<file name="${f.name}">\n${f.text.trim()}\n</file>`).join('\n\n');
    return { text, mode: 'full', files: usable.map((f) => f.name) };
  }

  const index = buildIndex(usable);
  let hits = search(index, query || '', 400);
  // Nothing matched (an empty or very general question): send the files from
  // the top rather than nothing at all.
  if (hits.length === 0) hits = index.docs.map((doc) => ({ doc }));
  const picked = [];
  let used = 0;
  for (const { doc } of hits) {
    const cost = estimateTokens(doc.text);
    if (used + cost > budgetTokens) continue;
    picked.push(doc);
    used += cost;
  }
  const text = picked.map((d) => `<excerpt file="${d.file}">\n${d.text}\n</excerpt>`).join('\n\n');
  return { text, mode: 'retrieved', files: [...new Set(picked.map((d) => d.file))] };
}

module.exports = { estimateTokens, tokenize, chunkText, buildIndex, search, buildContext };

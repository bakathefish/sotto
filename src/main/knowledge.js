'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.ini', '.cff', '.tex', '.rst', '.html',
  '.py', '.js', '.ts', '.c', '.h', '.cpp', '.ino', '.rs', '.go', '.java', '.sh', '.ps1', '.sql',
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const cache = new Map(); // path -> { mtimeMs, text }

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    return (await pdfParse(fs.readFileSync(file))).text;
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ path: file })).value;
  }
  if (TEXT_EXTENSIONS.has(ext) || ext === '') return fs.readFileSync(file, 'utf8');
  throw new Error(`Unsupported file type: ${ext}`);
}

// Returns { name, path, text } or { name, path, error }.
async function readKnowledgeFile(file) {
  const name = path.basename(file);
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is larger than 20 MB');
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return { name, path: file, text: hit.text };
    const text = (await extractText(file)).replace(/\u0000/g, '');
    cache.set(file, { mtimeMs: stat.mtimeMs, text });
    return { name, path: file, text };
  } catch (err) {
    return { name, path: file, error: err.message };
  }
}

// Files for a profile: its pack files, files added to it, and files added to every profile.
function profileFilePaths(profile, settings) {
  const paths = [];
  if (profile.packFolder && Array.isArray(profile.packFiles)) {
    for (const rel of profile.packFiles) paths.push(path.join(profile.packFolder, rel));
  }
  const knowledge = settings.knowledge || {};
  for (const p of knowledge[profile.id] || []) paths.push(p);
  for (const p of knowledge['*'] || []) paths.push(p);
  return [...new Set(paths)];
}

async function loadProfileKnowledge(profile, settings) {
  return Promise.all(profileFilePaths(profile, settings).map(readKnowledgeFile));
}

function isSupported(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.pdf' || ext === '.docx' || TEXT_EXTENSIONS.has(ext);
}

module.exports = { readKnowledgeFile, profileFilePaths, loadProfileKnowledge, isSupported, TEXT_EXTENSIONS };

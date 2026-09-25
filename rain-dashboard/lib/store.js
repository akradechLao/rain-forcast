'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOCK = new Map(); // กันเขียนทับซ้อนแบบ synchronize ต่อไฟล์

function file(name) {
  return path.join(config.dataDir, name);
}

function appendJsonl(name, obj) {
  const f = file(name);
  const line = JSON.stringify(obj) + '\n';
  fs.appendFileSync(f, line, 'utf8');
}

function readJsonl(name, { maxLines = 0, filter = null } = {}) {
  const f = file(name);
  if (!fs.existsSync(f)) return [];
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt) return [];
  let lines = txt.split(/\r?\n/).filter(Boolean);
  if (maxLines > 0 && lines.length > maxLines) lines = lines.slice(-maxLines);
  const out = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (!filter || filter(o)) out.push(o);
    } catch (_) { /* skip corrupt line */ }
  }
  return out;
}

function writeJson(name, obj) {
  const f = file(name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function readJson(name, def = null) {
  const f = file(name);
  if (!fs.existsSync(f)) return def;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return def;
  }
}

// กันงานเขียนชุดเดียวกันรันทับกัน
async function withLock(name, fn) {
  while (LOCK.get(name)) await new Promise((r) => setTimeout(r, 25));
  LOCK.set(name, true);
  try {
    return await fn();
  } finally {
    LOCK.delete(name);
  }
}

module.exports = { appendJsonl, readJsonl, writeJson, readJson, withLock, file };

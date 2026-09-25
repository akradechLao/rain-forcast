'use strict';
const config = require('../config');
const store = require('../store');

const REAL_FILE = 'internal-rain.jsonl';
const DEMO_FILE = 'internal-demo.jsonl';

function parsePath(obj, pathStr) {
  if (!pathStr) return undefined;
  let cur = obj;
  for (const k of pathStr.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

let lastCumulative = null;

/**
 * บันทึกค่าฝนจากเซนเซอร์ภายใน
 * @param {object} p { mm, timestamp, source, stationId, raw }
 *  mode=delta: mm คือฝนของช่วงเวลานั้น; mode=cumulative: mm คือตัวเลขสะสม (แปลงเป็น delta เอง)
 */
function recordReading({ mm, timestamp, source = 'http', stationId = 'park-gauge-1', raw = null }) {
  const value = toNumber(mm);
  if (value === null) return { ok: false, error: 'ค่า mm ไม่ถูกต้อง' };
  const ts = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(ts.getTime())) return { ok: false, error: 'timestamp ไม่ถูกต้อง' };

  let delta = value;
  if (config.internal.mode === 'cumulative') {
    if (lastCumulative !== null) {
      delta = value - lastCumulative;
      if (delta < 0) delta = value; // รีเซ็ตตัวนับ (เช่น เปลี่ยนวัน)
    } else {
      delta = 0;
    }
    lastCumulative = value;
  }
  delta = Math.max(0, Math.round(delta * 100) / 100);

  const rec = {
    t: ts.toISOString(),
    mm: delta,
    stationId,
    source,
    ingestAt: new Date().toISOString(),
  };
  store.appendJsonl(REAL_FILE, rec);
  return { ok: true, record: rec };
}

function readReal() {
  return store.readJsonl(REAL_FILE);
}

function ensureDemo() {
  let rows = store.readJsonl(DEMO_FILE);
  const now = Date.now();
  const needFrom = now - 7 * 86400000;
  const lastT = rows.length ? new Date(rows[rows.length - 1].t).getTime() : 0;
  if (rows.length && lastT > needFrom && now - lastT < 3 * 3600000) return rows;

  // สร้าง/ต่ออายุชุดข้อมูลจำลอง (ฝนเป็นหย่อม ๆ ตามช่วงบ่าย-ค่ำ)
  const start = rows.length ? lastT : needFrom;
  const fresh = [];
  let seed = 20260925;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let t = start; t <= now; t += 600000) { // ทุก 10 นาที
    const d = new Date(t);
    const hour = d.getHours();
    const storm = rand();
    let mm = 0;
    if (hour >= 13 && hour <= 21 && storm > 0.62) {
      mm = Math.round(rand() * rand() * 26 * 10) / 10; // 0-26 มม./10 นาที
    } else if (storm > 0.93) {
      mm = Math.round(rand() * 3 * 10) / 10;
    }
    if (mm > 0 || rand() > 0.55) {
      fresh.push({ t: new Date(t).toISOString(), mm, stationId: 'park-gauge-1', source: 'demo' });
    }
  }
  const all = rows.concat(fresh).slice(-12000);
  if (fresh.length) {
    store.writeJson(DEMO_FILE.replace('.jsonl', '.json'), all);
    // 保持ไฟล์ jsonl ให้ตรงกับ json (เขียนทับ)
    const fs = require('fs');
    fs.writeFileSync(store.file(DEMO_FILE), all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return all;
}

function hourlyAggregate(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.t.slice(0, 13) + ':00';
    if (!by.has(key)) by.set(key, { t: key, mm: 0 });
    by.get(key).mm += r.mm;
  }
  return [...by.values()].map((h) => ({ t: h.t, mm: Math.round(h.mm * 10) / 10 })).sort((a, b) => (a.t < b.t ? -1 : 1));
}

function summarise(rows) {
  const now = Date.now();
  const sumSince = (ms) => {
    const from = now - ms;
    return Math.round(rows.filter((r) => new Date(r.t).getTime() >= from).reduce((s, r) => s + r.mm, 0) * 10) / 10;
  };
  const last = rows[rows.length - 1];
  const lastAt = last ? new Date(last.t).getTime() : null;
  const hourly = hourlyAggregate(rows);
  const lastHour = hourly.length ? hourly[hourly.length - 1].mm : 0;
  return {
    lastAt: last ? last.t : null,
    staleMin: lastAt ? Math.round((now - lastAt) / 60000) : null,
    latestMm: last ? last.mm : null,
    rain1h: lastHour,
    rain24h: sumSince(24 * 3600000),
    rain7d: sumSince(7 * 86400000),
    source: last ? last.source : null,
    count: rows.length,
  };
}

function readHistory({ days = 7 } = {}) {
  let rows = readReal();
  let demo = false;
  if (!rows.length && config.internal.demoWhenEmpty) {
    rows = ensureDemo();
    demo = rows.some((r) => r.source === 'demo');
  } else {
    // เติม demo ชั่วคราวเฉพาะช่วงที่ยังไม่มีข้อมูลจริง (กันกราฟว่าง)
    demo = false;
  }
  const from = Date.now() - days * 86400000;
  const filtered = rows.filter((r) => new Date(r.t).getTime() >= from);
  return { ...summarise(filtered), demo, hourly: hourlyAggregate(filtered), readings: filtered.length };
}

function importCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  let imported = 0;
  const errors = [];
  for (const line of lines) {
    const cells = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2) { errors.push(`ข้าม: ${line.slice(0, 40)}`); continue; }
    if (/^(timestamp|time|datetime|วันที่)/i.test(cells[0])) continue; // header
    const [tsRaw, mmRaw] = cells;
    const r = recordReading({ mm: mmRaw, timestamp: tsRaw, source: 'csv' });
    if (r.ok) imported++; else errors.push(`${line.slice(0, 40)} → ${r.error}`);
  }
  return { imported, errors };
}

function resetDemo() {
  const fs = require('fs');
  for (const f of [DEMO_FILE, DEMO_FILE.replace('.jsonl', '.json')]) {
    try { fs.unlinkSync(store.file(f)); } catch (_) {}
  }
}

module.exports = { recordReading, readHistory, importCsv, resetDemo, parsePath, toNumber };

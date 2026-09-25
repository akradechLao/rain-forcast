'use strict';
const config = require('../config');
const store = require('../store');

const TZ = 'Asia/Bangkok';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function getJson(url, timeoutMs = 30000, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'rain-dashboard/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function hourlyToMap(hourly) {
  const map = new Map();
  if (!hourly || !hourly.time) return map;
  for (let i = 0; i < hourly.time.length; i++) {
    const v = hourly.precipitation ? hourly.precipitation[i] : null;
    if (v === null || v === undefined) continue;
    map.set(hourly.time[i], Number(v) || 0);
  }
  return map;
}

async function fetchArchive(daysBack = 10, anchorMs = Date.now()) {
  // Open-Meteo archive มี latency ~1 วัน — end_date ห้ามเกิน "วันก่อนวันนี้" (HTTP 400)
  let end = new Date(anchorMs);
  const maxEnd = new Date();
  maxEnd.setHours(0, 0, 0, 0);
  maxEnd.setDate(maxEnd.getDate() - 1);
  if (end.getTime() > maxEnd.getTime()) end = maxEnd;
  const start = new Date(end.getTime() - daysBack * 86400000);
  const url = `${ARCHIVE}?latitude=${config.park.lat}&longitude=${config.park.lon}` +
    `&start_date=${fmtDate(start)}&end_date=${fmtDate(end)}` +
    `&hourly=precipitation&timezone=${encodeURIComponent(TZ)}`;
  const j = await getJson(url);
  return hourlyToMap(j.hourly);
}

async function fetchForecast(pastDays = 7, forecastDays = 7) {
  const url = `${FORECAST}?latitude=${config.park.lat}&longitude=${config.park.lon}` +
    `&past_days=${pastDays}&forecast_days=${forecastDays}` +
    `&hourly=precipitation&timezone=${encodeURIComponent(TZ)}&precipitation_unit=mm`;
  const j = await getJson(url);
  return hourlyToMap(j.hourly);
}

/**
 * รวมซีรีส์รายชั่วโมง: ย้อนหลังใช้ archive (reaanalysis) / อนาคตใช้ forecast
 * คืนค่า array {t, mm, src} เรียงตามเวลา + ค่าสะสม running total
 */
function mergeSeries(archiveMap, forecastMap) {
  // "ชั่วโมงปัจจุบัน" แบบ Asia/Bangkok ตรงกับ timestamp ที่ API คืนมา (ไม่พึ่ง timezone ของเครื่องเซิร์ฟ)
  const bkk = new Date(Date.now() + 7 * 3600000);
  const nowHourStr = `${bkk.getUTCFullYear()}-${pad(bkk.getUTCMonth() + 1)}-${pad(bkk.getUTCDate())}T${pad(bkk.getUTCHours())}:00`;
  const keys = new Set([...archiveMap.keys(), ...forecastMap.keys()]);
  const sorted = [...keys].sort();
  const out = [];
  let cum = 0;
  for (const t of sorted) {
    let mm = null;
    let src = '';
    const isPast = t <= nowHourStr;
    if (isPast && archiveMap.has(t)) {
      mm = archiveMap.get(t);
      src = 'archive';
    } else if (forecastMap.has(t)) {
      mm = forecastMap.get(t);
      src = 'forecast';
    } else if (archiveMap.has(t)) {
      mm = archiveMap.get(t);
      src = 'archive';
    }
    if (mm === null) continue;
    cum = Math.round((cum + mm) * 10) / 10;
    out.push({ t, mm, cum, src });
  }
  return out;
}

function toDaily(series) {
  const byDay = new Map();
  for (const p of series) {
    const day = p.t.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { day, mm: 0 });
    byDay.get(day).mm += p.mm;
  }
  return [...byDay.values()].map((d) => ({ day: d.day, mm: Math.round(d.mm * 10) / 10 }));
}

/** สร้าง/อัปเดต merged series แล้วเก็บลง data/hourly-<ปี>.jsonl (append เฉพาะชั่วโมงใหม่) */
async function refresh() {
  const [archiveMap, forecastMap] = await Promise.all([
    fetchArchive(10).catch((e) => { throw new Error('archive: ' + e.message); }),
    fetchForecast(7, 7).catch((e) => { throw new Error('forecast: ' + e.message); }),
  ]);
  const series = mergeSeries(archiveMap, forecastMap);
  const daily = toDaily(series);
  const year = String(new Date().getFullYear());
  const name = `hourly-${year}.jsonl`;

  await store.withLock(name, () => {
    // อ่านจาก .json (ฉบับสมบูรณ์รวมย้อนหลัง backfill) ก่อน — .jsonl เป็น fallback ของรุ่นเก่า
    const jsonRows = store.readJson(name.replace('.jsonl', '.json'), null);
    const existing = (Array.isArray(jsonRows) && jsonRows.length) ? jsonRows : store.readJsonl(name);
    const byTime = new Map(existing.map((r) => [r.t, r]));
    let added = 0;
    for (const p of series) {
      const prev = byTime.get(p.t);
      // อัปเดตเมื่อค่าเปลี่ยน (ฝนตกเพิ่ม/ปรับปรุงข้อมูล) หรือเป็นชั่วโมงใหม่
      if (!prev || prev.mm !== p.mm) {
        byTime.set(p.t, { t: p.t, mm: p.mm, src: p.src, updatedAt: new Date().toISOString() });
        added++;
      }
    }
    if (added > 0 || existing.length !== byTime.size) {
      const rows = [...byTime.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
      // เก็บย้อนหลัง 10 ปี (รองรับกราฟย้อนหลัง 5 ปี + เผื่อโต)
      const cutoff = fmtDate(new Date(Date.now() - 10 * 365 * 86400000)) + 'T00:00';
      const kept = rows.filter((r) => r.t >= cutoff);
      store.writeJson(name.replace('.jsonl', '.json'), kept);
    }
    hourlyCache = null;
  });

  return { series, daily, archiveCount: archiveMap.size, forecastCount: forecastMap.size };
}

// อ่านข้อมูลรวมทุกปี (แยกไฟล์ hourly-<year>.json) + cache ในหน่วยความจำ
// (5 ปี ≈ 44,000 แถว — ไม่ parse ไฟล์ใหม่ทุก request)
let hourlyCache = null;

function invalidateHourlyCache() {
  hourlyCache = null;
}

function readHourly() {
  if (hourlyCache) return hourlyCache;
  const thisYear = new Date().getFullYear();
  const rows = [];
  for (let y = thisYear; y >= thisYear - 10; y--) {
    const data = store.readJson(`hourly-${y}.json`, null);
    if (Array.isArray(data) && data.length) {
      rows.push(...data);
    } else {
      const jl = store.readJsonl(`hourly-${y}.jsonl`);
      if (jl.length) rows.push(...jl);
    }
  }
  rows.sort((a, b) => (a.t < b.t ? -1 : 1));
  hourlyCache = rows;
  return rows;
}

module.exports = { refresh, readHourly, toDaily, mergeSeries, fetchArchive, invalidateHourlyCache };

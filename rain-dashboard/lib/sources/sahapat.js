'use strict';
// สถานีฝน/น้ำจากหน้าแดชบอร์ดสวนอุตสาหกรรมเครือสหพัฒน์ ศรีราชา
// (https://rain-sahapat-sriracha.northernthai.co.th — Laravel/Inertia SPA)
// ดึง JSON ด้วย header X-Inertia (ต้องส่ง X-Inertia-Version ที่ตรงกับแอป)
// ถ้า 409/พลาด → fallback ดึง HTML แล้ว parse attribute data-page (JSON ฝังอยู่)

const BASE = 'https://rain-sahapat-sriracha.northernthai.co.th/';
const UA = 'rain-dashboard/1.0';

let cache = null;
let inertiaVersion = null;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

async function getText(headers, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, ...headers },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} จากแดชบอร์ดสวนฯ`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseDataPage(html) {
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) throw new Error('ไม่พบ data-page ในหน้าเว็บสวนฯ');
  return JSON.parse(decodeEntities(m[1]));
}

function normalize(page) {
  const props = (page && page.props) || {};
  const mon = props.monitor || {};
  // เวลาไทยตอนนี้ (sv = YYYY-MM-DD HH:MM:ss → ตัดวินาที) ใช้เทียบ string ร่วมกับ hour_start ได้
  const nowIct = new Date().toLocaleString('sv', { timeZone: 'Asia/Bangkok' }).slice(0, 16).replace(' ', 'T');
  const today = nowIct.slice(0, 10);
  const rain = (Array.isArray(mon.rain_stations) ? mon.rain_stations : []).map((s) => {
    const hourly = (Array.isArray(s.hourly_mm) ? s.hourly_mm : [])
      .map((h) => ({ t: String(h.hour_start || ''), mm: num(h.mm) || 0 }))
      .filter((h) => h.t)
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    let todayMm = 0;
    let hourMm = null;
    let hourAt = null;
    for (const h of hourly) {
      // ฝนวันนี้ + ฝนชั่วโมงล่าสุดที่เริ่มแล้วจริง (ไม่เอาแถวอนาคต)
      if (h.t <= nowIct && h.t.slice(0, 10) === today) {
        todayMm += h.mm;
        hourMm = h.mm;
        hourAt = h.t;
      }
    }
    return {
      id: String(s.id || ''),
      name: String(s.name || '').trim(),
      color: s.color || null,
      online: Boolean(s.online),
      lastSeenAt: s.last_seen_at || null,
      hourly,
      todayMm: round1(todayMm),
      hourMm: hourMm === null ? null : round1(hourMm),
      hourAt,
    };
  });
  const w = mon.water_station || null;
  return {
    siteName: mon.site_name || null,
    updatedAt: mon.updated_at || null,
    refreshSeconds: Number(props.refreshSeconds) || 60,
    rain,
    water: w
      ? {
          id: String(w.id || ''),
          name: String(w.name || '').trim(),
          online: Boolean(w.online),
          level: num(w.level),
          lastSeenAt: w.last_seen_at || null,
          floats: Array.isArray(w.floats)
            ? w.floats.map((f) => ({ level: f.level, cm: num(f.cm), status: String(f.status || '') }))
            : [],
        }
      : null,
    sourceUrl: BASE,
    fetchedAt: new Date().toISOString(),
  };
}

async function refresh() {
  let page = null;
  // ลอง JSON ผ่าน Inertia ก่อน (เล็กกว่า) — ใช้ได้เฉพาะเมื่อ version ตรงกับแอป
  if (inertiaVersion) {
    try {
      const text = await getText({
        'x-inertia': 'true',
        'x-inertia-version': inertiaVersion,
        accept: 'text/html, application/xhtml+xml',
      });
      if (text.startsWith('{')) page = JSON.parse(text);
    } catch (_) {
      page = null; // 409 version ไม่ตรง / เน็ตหลุด → fallback HTML
    }
  }
  if (!page) {
    page = parseDataPage(await getText({ accept: 'text/html, application/xhtml+xml' }));
  }
  if (page.version) inertiaVersion = page.version;
  cache = normalize(page);
  return cache;
}

function read() {
  return cache;
}

module.exports = { refresh, read, BASE };

'use strict';
const config = require('../config');
const store = require('../store');

const BASE = 'https://data.tmd.go.th/api';

async function getJson(path, timeoutMs = 30000, retries = 3) {
  const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}uid=${encodeURIComponent(config.tmd.uid)}&ukey=${encodeURIComponent(config.tmd.ukey)}&format=json`;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'rain-dashboard/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
      const j = await res.json();
      if (j && j.Message && /error/i.test(j.Message)) throw new Error(j.Message);
      return j;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function arr(x) {
  if (x === null || x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function normStation(s, extra = {}) {
  const lat = Number(s.Latitude);
  const lon = Number(s.Longitude);
  const obs = s.Observation || {};
  return {
    code: String(s.WmoStationNumber || s.StationID || s.stationCode || ''),
    nameTh: (s.StationNameThai || s.ProvinceNameThai || '').trim(),
    nameEn: (s.StationNameEnglish || '').trim(),
    province: (s.Province || s.ProvinceNameThai || extra.province || '').trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    rain3h: numOrNull(obs.Rainfall !== undefined ? obs.Rainfall : s.Rainfall),
    rain24h: numOrNull(obs.Rainfall24Hr),
    observedAt: obs.DateTime || obs.dateTime || null,
    temp: numOrNull(obs.AirTemperature !== undefined ? obs.AirTemperature : obs.Temperature),
    humidity: numOrNull(obs.RelativeHumidity),
    distKm: Number.isFinite(lat) && Number.isFinite(lon)
      ? distKm(config.park.lat, config.park.lon, lat, lon)
      : null,
  };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** สถานีใกล้พื้นที่: จ.ชลบุรี/ระยอง หรือรัศมี 80 กม. */
function nearStations(stations) {
  return stations
    .filter((s) => {
      if (!s.lat || !s.lon) return false;
      const prov = s.province || '';
      if (prov.includes('ชลบุรี') || prov.includes('ระยอง')) return true;
      return s.distKm !== null && s.distKm <= 80;
    })
    .sort((a, b) => (a.distKm ?? 999) - (b.distKm ?? 999));
}

async function fetchStations3h() {
  const j = await getJson('Weather3Hours/v2/');
  const all = arr(j.Stations && j.Stations.Station).map((s) => normStation(s));
  const near = nearStations(all);
  const now = new Date().toISOString();
  // เก็บ snapshot เพื่อสร้างประวัติรายชั่วโมงของสถานีจริงเมื่อเวลาผ่านไป
  store.appendJsonl('tmd-stations.jsonl', {
    at: now,
    stations: near.map((s) => ({ code: s.code, name: s.nameEn || s.nameTh, rain3h: s.rain3h, rain24h: s.rain24h, observedAt: s.observedAt })),
  });
  return { fetchedAt: now, header: j.Header || null, stations: near };
}

async function fetchDailyRegions() {
  const j = await getJson('RainRegions/v1/');
  const out = [];
  for (const region of arr(j.Regions && j.Regions.Region)) {
    for (const prov of arr(region.Provinces && region.Provinces.Province)) {
      const stations = arr(prov.Stations && prov.Stations.Station);
      for (const st of stations) {
        const s = normStation(st, { province: prov.ProvinceName });
        s.province = prov.ProvinceName || s.province;
        out.push(s);
      }
    }
  }
  return {
    dateOfData: (j.Header && j.Header.DateOfData) || null,
    stations: out.filter((s) => (s.province || '').includes('ชลบุรี') || (s.province || '').includes('ระยอง')
      || (s.distKm !== null && s.distKm <= 80)),
  };
}

async function fetchToday() {
  const j = await getJson('WeatherToday/v2/');
  const all = arr(j.Stations && j.Stations.Station).map((s) => normStation(s));
  return {
    observedAt: (j.Header && j.Header.LastBuildDate) || null,
    stations: nearStations(all),
  };
}

/** "YYYY-MM-DD HH:mm:ss[.SSS]" = เวลาไทย +07:00 — ห้ามพึ่ง timezone ของเซิร์ฟเวอร์ */
function parseBkk(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+07:00`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normWarning(x) {
  return {
    title: String(x.TitleThai || x.TitleEnglish || '').trim(),
    titleEn: String(x.TitleEnglish || '').trim(),
    datetime: x.AnnounceDate || x.AnnounceDateTime || null,
    desc: String(x.DescriptionThai || x.HeadlineThai || x.DescriptionEnglish || '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    url: x.WebUrlThai || x.DocumentFile || null,
    effectStart: x.EffectStartDate || null,
    effectEnd: x.EffectEndDate || null,
  };
}

// แสดงเฉพาะประกาศที่อัปเดตภายใน 7 วันล่าสุด — ถ้าไม่มี ให้เว้นว่าง
const WARN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

async function fetchWarningsFrom(path, field) {
  const j = await getJson(path);
  const raw = arr(j[field]);
  if (j.Warnings) raw.push(...arr(j.Warnings.Warning || j.Warnings));
  const list = raw.filter((x) => x && typeof x === 'object' && (x.TitleThai || x.TitleEnglish));
  return { list, lastBuildDate: (j.header && j.header.lastBuildDate) || null };
}

async function fetchWarnings() {
  let list = [];
  let lastBuildDate = null;
  // v2 = feed ปัจจุบันของกรมอุตุ (มีประกาศล่าสุด) · v1 = fallback (feed เก่าค้างปี 2022)
  try {
    const r = await fetchWarningsFrom('WeatherWarningNews/v2/', 'Warning');
    list = r.list;
    lastBuildDate = r.lastBuildDate;
  } catch (e) { /* ต่อ fallback v1 ด้านล่าง */ }
  if (!list.length) {
    try {
      const r = await fetchWarningsFrom('WeatherWarningNews/v1/', 'WarningNews');
      list = r.list;
      lastBuildDate = r.lastBuildDate || lastBuildDate;
    } catch (e) { /* ไม่มีประกาศก็ถือว่าว่าง */ }
  }
  const now = Date.now();
  const warnings = list.map(normWarning).filter((w) => {
    const dt = parseBkk(w.datetime);
    if (!dt) return false;
    const age = now - dt.getTime();
    return age <= WARN_MAX_AGE_MS && age >= -6 * 3600 * 1000;
  });
  return { warnings, lastBuildDate };
}

module.exports = { fetchStations3h, fetchDailyRegions, fetchToday, fetchWarnings, distKm };

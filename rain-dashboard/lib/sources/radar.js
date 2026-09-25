'use strict';

async function getJson(url, timeoutMs = 40000, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'rain-dashboard/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** RainViewer: metadata เรดาร์ฝน (tiles + nowcast) สำหรับซ้อนแผนที่ Leaflet */
async function fetchRainViewer() {
  const j = await getJson('https://api.rainviewer.com/public/weather-maps.json');
  const past = (j.radar && j.radar.past) || [];
  const nowcast = (j.radar && j.radar.nowcast) || [];
  return {
    host: j.host || 'https://tilecache.rainviewer.com',
    frames: [...past, ...nowcast].map((f) => ({ time: f.time, path: f.path })),
    pastCount: past.length,
    nowcastCount: nowcast.length,
    past: past.map((f) => ({ time: f.time, path: f.path })),
  };
}

/** เรดาร์ฝนหลวง (กรมฝนหลวงฯ) สถานีสัตหีบ — ภาพ CAPPI ทุก 6 นาที */
async function fetchRoyalRain() {
  const j = await getJson('https://file.royalrain.go.th/opendata/radar_data/cappi/api.php?station=sattahip');
  const frames = (j.data || []).slice(0, 30).map((f) => ({
    datetimeBangkok: f.datetime_bangkok,
    datetimeUtc: f.datetime_utc,
    // เก็บ path ไว้ proxy ผ่านเซิร์ฟเวอร์กันปัญหา hotlink/mixed-content
    path: String(f.url || '').replace(/^https?:\/\/[^/]+/i, ''),
    fullUrl: f.url,
  }));
  return { station: 'sattahip', count: j.count || frames.length, frames };
}

module.exports = { fetchRainViewer, fetchRoyalRain };

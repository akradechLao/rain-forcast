'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./lib/config');
const store = require('./lib/store');
const openmeteo = require('./lib/sources/openmeteo');
const tmd = require('./lib/sources/tmd');
const radar = require('./lib/sources/radar');
const notify = require('./lib/notify');
const internal = require('./lib/ingest/internal');
const mqttIngest = require('./lib/ingest/mqttIngest');
const waterLevel = require('./lib/ingest/waterLevel');

// ---------- source status ----------
const sources = {};
function sourceStart(name) {
  sources[name] = { ...(sources[name] || {}), name, loading: true };
}
function sourceOk(name, extra = {}) {
  sources[name] = { ...(sources[name] || {}), name, ok: true, loading: false, lastOkAt: new Date().toISOString(), lastError: null, ...extra };
}
function sourceErr(name, err) {
  sources[name] = {
    ...(sources[name] || {}),
    name,
    ok: false,
    loading: false,
    lastError: String(err && err.message ? err.message : err).slice(0, 300),
    failedAt: new Date().toISOString(),
  };
}

// ---------- cached payloads ----------
const cache = {
  stations: null,
  dailyRegions: null,
  today: null,
  warnings: null,
  radar: null,
};

// ---------- jobs ----------
async function jobMeteo() {
  sourceStart('openmeteo');
  try {
    const r = await openmeteo.refresh();
    sourceOk('openmeteo', { archiveCount: r.archiveCount, forecastCount: r.forecastCount });
    await evaluateAlerts();
  } catch (e) {
    sourceErr('openmeteo', e);
  }
}

async function jobTmd() {
  sourceStart('tmd');
  try {
    const [st, dr, ty, wa] = await Promise.all([
      tmd.fetchStations3h(),
      tmd.fetchDailyRegions(),
      tmd.fetchToday(),
      tmd.fetchWarnings(),
    ]);
    cache.stations = st;
    cache.dailyRegions = dr;
    cache.today = ty;
    cache.warnings = wa;
    sourceOk('tmd', { stations: st.stations.length });
    await evaluateAlerts();
  } catch (e) {
    sourceErr('tmd', e);
  }
}

async function jobRadar() {
  sourceStart('radar');
  const [rv, rr] = await Promise.allSettled([radar.fetchRainViewer(), radar.fetchRoyalRain()]);
  const prev = cache.radar || {};
  const errors = {};
  if (rv.status === 'rejected') errors.rainviewer = String((rv.reason && rv.reason.message) || rv.reason).slice(0, 200);
  if (rr.status === 'rejected') errors.royalrain = String((rr.reason && rr.reason.message) || rr.reason).slice(0, 200);
  cache.radar = {
    rainviewer: rv.status === 'fulfilled' ? rv.value : prev.rainviewer || null,
    royalrain: rr.status === 'fulfilled' ? rr.value : prev.royalrain || null,
    errors,
    fetchedAt: new Date().toISOString(),
  };
  if (rv.status === 'fulfilled' || rr.status === 'fulfilled') {
    const frames = (cache.radar.royalrain && cache.radar.royalrain.frames ? cache.radar.royalrain.frames.length : 0);
    sourceOk('radar', { frames, partial: Object.keys(errors).length > 0 });
  } else {
    sourceErr('radar', { message: errors.rainviewer || errors.royalrain || 'radar fetch failed' });
  }
}

// ---------- metrics + alerts ----------
function sumRange(series, fromMs, toMs = Date.now()) {
  let sum = 0;
  for (const p of series) {
    const t = new Date(p.t).getTime();
    if (t >= fromMs && t <= toMs) sum += p.mm;
  }
  return Math.round(sum * 10) / 10;
}

function computeMetrics() {
  const series = openmeteo.readHourly();
  const now = Date.now();
  const m = {
    rainHour: null,
    rain24h: null,
    rain7d: null,
    tmdRain24h: null,
    tmdStation: null,
    internalRain24h: null,
    internalStaleMin: null,
    seriesPoints: series.length,
    waterLevel: null,
    waterStaleMin: null,
    waterLastAt: null,
    waterUnit: config.water.unit,
    waterLevels: waterLevel.LEVELS,
  };
  if (series.length) {
    const last = series[series.length - 1];
    m.rainHour = last.mm;
    m.rain24h = sumRange(series, now - 24 * 3600000);
    m.rain7d = sumRange(series, now - 7 * 86400000);
  }
  if (cache.stations && cache.stations.stations.length) {
    const withRain = cache.stations.stations.filter((s) => s.rain24h !== null && s.rain24h !== undefined);
    if (withRain.length) {
      const nearest = withRain[0]; // เรียงตามระยะทางแล้ว
      m.tmdRain24h = nearest.rain24h;
      m.tmdStation = { name: nearest.nameEn || nearest.nameTh, distKm: nearest.distKm, rain24h: nearest.rain24h, observedAt: nearest.observedAt };
      m.tmdMax24h = Math.max(...withRain.map((s) => s.rain24h));
    }
  }
  try {
    const ih = internal.readHistory({ days: 7 });
    m.internalRain24h = ih.rain24h;
    m.internalSource = ih.source;
    m.internalDemo = ih.demo;
    m.internalStaleMin = ih.source === 'demo' || ih.lastAt === null ? null : ih.staleMin;
    m.internalRain7d = ih.rain7d;
    m.internalRain1h = ih.rain1h;
    m.internalLastAt = ih.lastAt;
  } catch (_) { /* internal ไม่กระทบหลัก */ }
  try {
    const w = waterLevel.readHistory({ hours: 24 });
    m.waterStaleMin = w.staleMin;
    m.waterLastAt = w.latest ? w.latest.t : null;
    // ใช้ค่าล่าสุดเฉพาะเมื่อไม่ขาดสัญญาณ (กันค่าค้างเตือนมั่ว)
    if (w.latest && w.staleMin !== null && w.staleMin <= config.water.staleMinutes) {
      m.waterLevel = w.latest.level;
    }
  } catch (_) { /* water ไม่กระทบหลัก */ }
  return m;
}

async function evaluateAlerts() {
  try {
    const metrics = computeMetrics();
    const events = notify.evaluate(metrics);
    if (!events.length) return { triggered: [] };
    const result = await notify.dispatch({ events, metrics, parkName: config.park.name });
    return { triggered: events, result };
  } catch (e) {
    sourceErr('alerts', e);
    return { error: e.message };
  }
}

// ---------- http helpers ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body ใหญ่เกินไป'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(config.publicDir, rel);
  if (!file.startsWith(config.publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function proxyImage(res, rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { res.writeHead(400); res.end('bad url'); return; }
  if (!/(^|\.)royalrain\.go\.th$/.test(u.hostname)) {
    res.writeHead(403); res.end('host not allowed');
    return;
  }
  try {
    const r = await fetch(u.toString(), { headers: { 'user-agent': 'rain-dashboard/1.0' } });
    if (!r.ok) { res.writeHead(502); res.end('upstream error'); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'content-type': r.headers.get('content-type') || 'image/png',
      'cache-control': 'public, max-age=120',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502); res.end(String(e.message));
  }
}

function requireToken(req) {
  if (!config.internal.token) return true;
  return req.headers['x-internal-token'] === config.internal.token;
}

// ---------- api routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-internal-token',
    });
    res.end();
    return true;
  }

  if (p === '/api/config') {
    sendJson(res, 200, {
      park: config.park,
      refresh: config.refresh,
      internal: { mode: config.internal.mode, staleMinutes: config.internal.staleMinutes, tokenRequired: Boolean(config.internal.token) },
      water: { unit: config.water.unit, warnLevel: config.water.warnLevel, levels: waterLevel.LEVELS },
      notify: notify.channelStatus(),
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  if (p === '/api/kpi') {
    sendJson(res, 200, { metrics: computeMetrics(), generatedAt: new Date().toISOString() });
    return true;
  }

  if (p === '/api/series') {
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14));
    const all = openmeteo.readHourly();
    const windowed = all.filter((x) => new Date(x.t).getTime() >= Date.now() - days * 86400000);
    // ฝนสะสม (running total) เริ่มจาก 0 ที่ขอบซ้ายของช่วงที่ดู — แถวในไฟล์ไม่ได้เก็บ cum
    let acc = 0;
    const series = windowed.map((row) => {
      acc = Math.round((acc + (row.mm || 0)) * 10) / 10;
      return { ...row, cum: acc };
    });
    const daily = openmeteo.toDaily(all);
    const internalData = internal.readHistory({ days });
    sendJson(res, 200, {
      days,
      hourly: series,
      daily,
      internal: { hourly: internalData.hourly, demo: internalData.demo, summary: { lastAt: internalData.lastAt, rain24h: internalData.rain24h, rain7d: internalData.rain7d, rain1h: internalData.rain1h, source: internalData.source, staleMin: internalData.staleMin } },
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  if (p === '/api/stations') {
    sendJson(res, 200, cache.stations || { fetchedAt: null, stations: [], note: 'ยังโหลดไม่เสร็จ' });
    return true;
  }

  if (p === '/api/daily') {
    const grid = openmeteo.toDaily(openmeteo.readHourly());
    sendJson(res, 200, {
      grid,
      regions: cache.dailyRegions || { dateOfData: null, stations: [] },
      today: cache.today || { stations: [] },
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  if (p === '/api/radar') {
    sendJson(res, 200, cache.radar || { fetchedAt: null, note: 'ยังโหลดไม่เสร็จ' });
    return true;
  }

  if (p === '/api/radar/frame') {
    await proxyImage(res, url.searchParams.get('u') || '');
    return true;
  }

  if (p === '/api/warnings') {
    sendJson(res, 200, cache.warnings || { warnings: [], lastBuildDate: null });
    return true;
  }

  if (p === '/api/water') {
    const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    const data = waterLevel.readHistory({ hours });
    const rule = notify.loadRules().find((r) => r.metric === 'waterLevel' && r.enabled);
    sendJson(res, 200, {
      ...data,
      levels: waterLevel.LEVELS,
      warnLevel: rule ? rule.threshold : config.water.warnLevel,
      configured: Boolean(config.water.url && config.water.topic),
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  if (p === '/api/sources') {
    sendJson(res, 200, {
      sources: Object.values(sources),
      mqtt: mqttIngest.getStatus(),
      water: waterLevel.getStatus(),
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  if (p === '/api/internal') {
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 7));
    const h = internal.readHistory({ days });
    sendJson(res, 200, h);
    return true;
  }

  if (p === '/api/internal/rain' && req.method === 'POST') {
    if (!requireToken(req)) { sendJson(res, 401, { error: 'ต้องส่ง header x-internal-token' }); return true; }
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch (_) { sendJson(res, 400, { error: 'body ต้องเป็น JSON' }); return true; }
    const items = Array.isArray(payload) ? payload : [payload];
    const results = items.map((it) => internal.recordReading({
      mm: it.mm !== undefined ? it.mm : it.rainfall,
      timestamp: it.timestamp || it.time || it.t,
      source: 'http',
      stationId: it.stationId || 'park-gauge-1',
    }));
    const okCount = results.filter((r) => r.ok).length;
    await evaluateAlerts();
    sendJson(res, okCount ? 200 : 400, { ok: okCount > 0, imported: okCount, results });
    return true;
  }

  if (p === '/api/internal/csv' && req.method === 'POST') {
    if (!requireToken(req)) { sendJson(res, 401, { error: 'ต้องส่ง header x-internal-token' }); return true; }
    const body = await readBody(req, 8 * 1024 * 1024);
    const r = internal.importCsv(body);
    await evaluateAlerts();
    sendJson(res, 200, r);
    return true;
  }

  if (p === '/api/alerts/rules' && req.method === 'GET') {
    sendJson(res, 200, { rules: notify.loadRules() });
    return true;
  }

  if (p === '/api/alerts/rules' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.rules)) throw new Error('rules ต้องเป็น array');
      notify.saveRules(parsed.rules);
      sendJson(res, 200, { ok: true, rules: notify.loadRules() });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return true;
  }

  if (p === '/api/alerts/evaluate' && req.method === 'POST') {
    const r = await evaluateAlerts();
    sendJson(res, 200, r);
    return true;
  }

  if (p === '/api/notify/status') {
    sendJson(res, 200, { channels: notify.channelStatus(), history: notify.history(20) });
    return true;
  }

  if (p === '/api/notify/test' && req.method === 'POST') {
    try {
      const r = await notify.sendTest();
      sendJson(res, 200, r);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  if (p === '/api/internal/reset-demo' && req.method === 'POST') {
    internal.resetDemo();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }
    serveStatic(res, url.pathname);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

function startJobs() {
  const interval = (fn, ms, name) => {
    const run = () => fn().catch((e) => sourceErr(name, e));
    run();
    setInterval(run, ms);
  };
  interval(jobMeteo, config.refresh.meteoMs, 'openmeteo');
  interval(jobTmd, config.refresh.tmdMs, 'tmd');
  interval(jobRadar, config.refresh.radarMs, 'radar');
  // ประเมินกฎเตือนทุก 2 นาที (รวมกรณีเซนเซอร์ขาดสัญญาณ)
  interval(async () => { await evaluateAlerts(); }, 2 * 60 * 1000, 'alerts');
}

async function main() {
  mqttIngest.start();
  waterLevel.start();
  startJobs();
  server.listen(config.port, () => {
    console.log(`\n🌧  แดชบอร์ดน้ำฝน ศรีราชา  →  http://localhost:${config.port}`);
    console.log(`   พิกัดสวนฯ: ${config.park.lat}, ${config.park.lon}`);
    console.log(`   MQTT ฝน: ${config.mqtt.url ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า (เปิดภายหลังได้)'}`);
    console.log(`   MQTT ระดับน้ำ: ${config.water.url ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า (เปิดภายหลังได้)'}`);
    console.log(`   LINE: ${config.notify.line.enabled ? 'เปิด' : 'ปิด'} | อีเมล: ${config.notify.email.enabled ? 'เปิด' : 'ปิด'}\n`);
  });
}

main().catch((e) => {
  console.error('เริ่มต้นเซิร์ฟเวอร์ล้มเหลว:', e);
  process.exit(1);
});

'use strict';
const config = require('../config');
const store = require('../store');

const FILE = 'water-level.jsonl';

/**
 * รหัสสถานะจากเซนเซอร์ (ไม่ใช่ความสูงเป็นเมตร)
 * เทียบระดับความสูงของขอบทางน้ำล้น (spill way) คลองห้วยใหญ่
 */
const LEVELS = {
  1: { label: 'ปกติ', desc: 'ต่ำกว่าขอบน้ำล้น (spill way) คลองห้วยใหญ่ 75 ซม.' },
  2: { label: 'เฝ้าระวัง', desc: 'ต่ำกว่าขอบน้ำล้น (spill way) คลองห้วยใหญ่ 45 ซม.' },
  3: { label: 'วิกฤติ', desc: 'น้ำใกล้ล้น spill way คลองห้วยใหญ่ ต่ำกว่าขอบ 10 ซม.' },
};

/** คำอธิบายสถานะระดับน้ำ เช่น "วิกฤติ — น้ำใกล้ล้น spill way..." */
function describe(level) {
  const info = LEVELS[Number(level)];
  if (info) return `${info.label} — ${info.desc}`;
  if (level === null || level === undefined) return '';
  return `ไม่ทราบสถานะ (รหัส ${level})`;
}

let client = null;
let status = { configured: false, connected: false, lastMessageAt: null, lastError: null, count: 0 };

function dig(obj, pathStr) {
  if (!pathStr) return undefined;
  let cur = obj;
  for (const k of pathStr.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

function handleMessage(_topic, buf) {
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch (_) {
    payload = null;
  }
  if (payload === null || typeof payload !== 'object') {
    status.lastError = 'payload ไม่ใช่ JSON';
    return;
  }
  const raw = dig(payload, config.water.fieldPath);
  const level = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(level)) {
    status.lastError = `ไม่พบค่า "${config.water.fieldPath}" ใน payload`;
    return;
  }
  store.appendJsonl(FILE, { t: new Date().toISOString(), level, topic: _topic });
  status.count++;
  status.lastMessageAt = new Date().toISOString();
  status.lastError = null;
}

/** เปิดการเชื่อมต่อ MQTT เซนเซอร์ระดับน้ำ (ยังไม่ตั้งค่า = ปิดเงียบ) */
function start() {
  if (!config.water.url || !config.water.topic) {
    status = { ...status, configured: false, note: 'ยังไม่ได้ตั้ง WATER_MQTT_BROKER/WATER_MQTT_TOPIC (เปิดภายหลังได้)' };
    return null;
  }
  status.configured = true;
  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch (e) {
    status.lastError = 'ไม่พบ module mqtt (รัน npm install)';
    return null;
  }
  try {
    client = mqtt.connect(config.water.url, {
      username: config.water.username || undefined,
      password: config.water.password || undefined,
      reconnectPeriod: 10000,
      connectTimeout: 15000,
    });
    client.on('connect', () => {
      status.connected = true;
      status.lastError = null;
      client.subscribe(config.water.topic, (err) => {
        if (err) status.lastError = 'subscribe: ' + err.message;
      });
    });
    client.on('message', (topic, buf) => {
      try { handleMessage(topic, buf); } catch (e) { status.lastError = e.message; }
    });
    client.on('error', (e) => { status.lastError = e.message; });
    client.on('close', () => { status.connected = false; });
    client.on('reconnect', () => { status.lastError = 'กำลังเชื่อมต่อใหม่...'; });
  } catch (e) {
    status.lastError = e.message;
  }
  return client;
}

/** อ่านประวัติระดับน้ำย้อนหลัง (ชม.) */
function readHistory({ hours = 24 } = {}) {
  const rows = store.readJsonl(FILE);
  const from = Date.now() - hours * 3600000;
  const series = rows
    .filter((r) => new Date(r.t).getTime() >= from)
    .map((r) => ({ t: r.t, level: r.level }));
  const last = rows.length ? rows[rows.length - 1] : null;
  const staleMin = last ? Math.round((Date.now() - new Date(last.t).getTime()) / 60000) : null;
  const levels = series.map((s) => s.level);
  return {
    unit: config.water.unit,
    hours,
    series,
    latest: last ? { t: last.t, level: last.level } : null,
    staleMin,
    min: levels.length ? Math.min(...levels) : null,
    max: levels.length ? Math.max(...levels) : null,
    points: series.length,
  };
}

function getStatus() {
  return {
    ...status,
    topic: config.water.topic || null,
    broker: config.water.url ? config.water.url.replace(/:\/\/[^@]*@/, '://***@') : null,
    unit: config.water.unit,
  };
}

module.exports = { start, readHistory, getStatus, LEVELS, describe };

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---- minimal .env loader (no dependency) ----
function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) { /* no .env is fine */ }
}

loadEnv(path.join(ROOT, '.env'));

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function list(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  publicDir: PUBLIC_DIR,
  port: num(process.env.PORT, 8080),

  // ตำแหน่งสวนอุตสาหกรรมเครือสหพัฒน์ ศรีราชา (ต.หนองขาม อ.ศรีราชา)
  park: {
    name: process.env.PARK_NAME || 'สวนอุตสาหกรรมเครือสหพัฒน์ ศรีราชา',
    lat: num(process.env.PARK_LAT, 13.0833),
    lon: num(process.env.PARK_LON, 100.9667),
  },

  refresh: {
    tmdMs: num(process.env.REFRESH_TMD_MS, 5 * 60 * 1000),
    meteoMs: num(process.env.REFRESH_METEO_MS, 10 * 60 * 1000),
    radarMs: num(process.env.REFRESH_RADAR_MS, 3 * 60 * 1000),
    warnMs: num(process.env.REFRESH_WARN_MS, 10 * 60 * 1000),
  },

  tmd: {
    uid: process.env.TMD_UID || 'demo',
    ukey: process.env.TMD_UKEY || 'demokey',
  },

  dwr: {
    apiKey: process.env.DWR_API_KEY || '',
    ewsUid: process.env.EWS_UID || '',
    ewsPass: process.env.EWS_PASS || '',
  },

  internal: {
    // delta = ค่าฝนต่อครั้ง (มม.), cumulative = ตัวเลขค่าสะสมเดินหน้าอย่างเดียว
    mode: (process.env.INTERNAL_MODE || 'delta').toLowerCase(),
    token: process.env.INTERNAL_TOKEN || '',
    staleMinutes: num(process.env.INTERNAL_STALE_MINUTES, 15),
    demoWhenEmpty: bool(process.env.INTERNAL_DEMO_WHEN_EMPTY, false),
  },

  mqtt: {
    url: process.env.MQTT_BROKER || '',
    topic: process.env.MQTT_TOPIC || '',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    // JSON path ของค่าฝนใน payload เช่น "mm", "rain.mm", "data.rainfall"
    fieldPath: process.env.MQTT_FIELD_PATH || 'mm',
    timestampField: process.env.MQTT_TIMESTAMP_FIELD || 'timestamp',
    fieldPathDelta: process.env.MQTT_FIELD_PATH_DELTA || '',
  },

  // เซนเซอร์ระดับน้ำ (คนละช่องกับปริมาณน้ำฝน)
  water: {
    url: process.env.WATER_MQTT_BROKER || '',
    topic: process.env.WATER_MQTT_TOPIC || '',
    username: process.env.WATER_MQTT_USERNAME || '',
    password: process.env.WATER_MQTT_PASSWORD || '',
    fieldPath: process.env.WATER_FIELD_PATH || 'level',
    unit: process.env.WATER_UNIT || 'ม.',
    staleMinutes: num(process.env.WATER_STALE_MINUTES, 15),
    warnLevel: num(process.env.WATER_WARN_LEVEL, 1.5),
  },

  notify: {
    cooldownMin: num(process.env.NOTIFY_COOLDOWN_MIN, 60),
    line: {
      enabled: bool(process.env.LINE_ENABLED, false),
      token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
      to: list(process.env.LINE_TO),
    },
    email: {
      enabled: bool(process.env.EMAIL_ENABLED, false),
      host: process.env.SMTP_HOST || '',
      port: num(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
      to: list(process.env.ALERT_EMAIL_TO),
    },
  },
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = config;

'use strict';
const config = require('../config');
const internal = require('./internal');

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

function handleMessage(topic, buf) {
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch (_) {
    // ถ้า payload เป็นตัวเลขล้วน
    const n = Number(buf.toString());
    payload = Number.isFinite(n) ? { mm: n } : null;
  }
  if (!payload) {
    status.lastError = 'payload ไม่ใช่ JSON/ตัวเลข';
    return;
  }
  const mm = internal.toNumber(dig(payload, config.mqtt.fieldPath));
  const tsRaw = dig(payload, config.mqtt.timestampField);
  const r = internal.recordReading({
    mm,
    timestamp: tsRaw || new Date().toISOString(),
    source: 'mqtt',
    stationId: payload.stationId || payload.id || 'park-gauge-1',
    raw: payload,
  });
  if (r.ok) {
    status.count++;
    status.lastMessageAt = new Date().toISOString();
    status.lastError = null;
  } else {
    status.lastError = r.error;
  }
}

/**
 * เปิดการเชื่อมต่อ MQTT ถ้าตั้งค่าไว้ (ยังไม่ตั้ง = ปิดเงียบ ไม่กระทบระบบ)
 */
function start() {
  if (!config.mqtt.url || !config.mqtt.topic) {
    status = { ...status, configured: false, note: 'ยังไม่ได้ตั้ง MQTT_BROKER/MQTT_TOPIC (เปิดใช้ภายหลังได้)' };
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
    client = mqtt.connect(config.mqtt.url, {
      username: config.mqtt.username || undefined,
      password: config.mqtt.password || undefined,
      reconnectPeriod: 10000,
      connectTimeout: 15000,
    });
    client.on('connect', () => {
      status.connected = true;
      status.lastError = null;
      client.subscribe(config.mqtt.topic, (err) => {
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

function getStatus() {
  return { ...status, topic: config.mqtt.topic || null, broker: config.mqtt.url ? config.mqtt.url.replace(/:\/\/[^@]*@/, '://***@') : null };
}

module.exports = { start, getStatus };

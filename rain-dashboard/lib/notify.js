'use strict';
const config = require('./config');
const store = require('./store');
const water = require('./ingest/waterLevel');

const RULES_FILE = 'alert-rules.json';
const STATE_FILE = 'notify-state.json';

const DEFAULT_RULES = [
  { id: 'r24', label: 'ฝนสะสม 24 ชั่วโมง', metric: 'rain24h', op: '>', threshold: 60, unit: 'มม.', enabled: true },
  { id: 'r7d', label: 'ฝนสะสม 7 วัน', metric: 'rain7d', op: '>', threshold: 150, unit: 'มม.', enabled: true },
  { id: 'rh', label: 'ฝนตกหนักในชั่วโมงล่าสุด', metric: 'rainHour', op: '>', threshold: 30, unit: 'มม./ชม.', enabled: true },
  { id: 'rtmd', label: 'ฝนสะสม 24 ชม. (สถานีราชการใกล้สุด)', metric: 'tmdRain24h', op: '>', threshold: 60, unit: 'มม.', enabled: false },
  { id: 'rstale', label: 'เซนเซอร์ภายในขาดสัญญาณ', metric: 'internalStaleMin', op: '>', threshold: 15, unit: 'นาที', enabled: true },
  { id: 'rwater', label: 'ระดับน้ำเข้าใกล้ขอบน้ำล้น (spill way)', metric: 'waterLevel', op: '>=', threshold: 2, unit: 'ระดับ', enabled: true },
  { id: 'rd1', label: 'เริ่มแล้ง (SPI-3 ≤ -1.0)', metric: 'droughtSpi3', op: '<=', threshold: -1, unit: 'SPI', enabled: true },
  { id: 'rd2', label: 'แล้งรุนแรง (SPI-3 ≤ -1.5)', metric: 'droughtSpi3', op: '<=', threshold: -1.5, unit: 'SPI', enabled: true },
];

function loadRules() {
  const saved = store.readJson(RULES_FILE, null);
  if (saved && Array.isArray(saved.rules)) {
    let dirty = false;
    // เติมกฎใหม่ที่ยังไม่มีในไฟล์ (อัปเดตซอฟต์แวร์แล้วกฎเดิมไม่หาย)
    const known = new Set(saved.rules.map((r) => r.id));
    const missing = DEFAULT_RULES.filter((r) => !known.has(r.id));
    if (missing.length) {
      saved.rules.push(...missing);
      dirty = true;
    }
    // migrate: rwater รุ่นก่อนปล่อย (ตีความค่า 1.5 ผิดเป็นเมตร → เปลี่ยนเป็นรหัสระดับ >= 2)
    const rw = saved.rules.find((r) => r.id === 'rwater');
    const rwDef = DEFAULT_RULES.find((r) => r.id === 'rwater');
    if (rw && rwDef && rw.threshold === 1.5 && rw.op === '>') {
      Object.assign(rw, rwDef);
      dirty = true;
    }
    if (dirty) store.writeJson(RULES_FILE, { rules: saved.rules });
    return saved.rules;
  }
  store.writeJson(RULES_FILE, { rules: DEFAULT_RULES });
  return DEFAULT_RULES;
}

function saveRules(rules) {
  store.writeJson(RULES_FILE, { rules });
}

function evaluate(metrics, rules = loadRules()) {
  const triggered = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const val = metrics[r.metric];
    if (val === null || val === undefined || Number.isNaN(val)) continue;
    let hit = false;
    if (r.op === '>') hit = val > r.threshold;
    else if (r.op === '>=') hit = val >= r.threshold;
    else if (r.op === '<') hit = val < r.threshold;
    else if (r.op === '<=') hit = val <= r.threshold;
    if (hit) triggered.push({ ...r, value: val });
  }
  return triggered;
}

function fmtVal(v, unit) {
  const n = Number(v);
  const s = Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : String(v);
  return unit ? `${s} ${unit}` : s;
}

function buildMessage(events, metrics, parkName) {
  const now = new Date();
  const drought = events.some((e) => e.metric && e.metric.startsWith('drought'));
  const lines = [
    drought ? `🌿 แจ้งเตือนฝนแล้ง — ${parkName}` : `⚠️ เฝ้าระวังน้ำท่วม — ${parkName}`,
    `เวลา ${now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })}`,
    '',
    'เกณฑ์ที่ถูกกระตุ้น:',
  ];
  for (const e of events) {
    // ระดับน้ำเป็นรหัสสถานะ แสดงเป็น "ระดับ N" ไม่ใช่หน่วยเมตร
    const fmtEv = (v) => (e.metric === 'waterLevel' ? `ระดับ ${v}` : fmtVal(v, e.unit));
    lines.push(`• ${e.label}: ${fmtEv(e.value)} (เกณฑ์ ${e.op} ${fmtEv(e.threshold)})`);
  }
  lines.push('');
  lines.push('สรุป ณ ขณะนี้:');
  if (metrics.rain24h !== null && metrics.rain24h !== undefined) lines.push(`• ฝนสะสม 24 ชม. (พื้นที่สวนฯ): ${fmtVal(metrics.rain24h, 'มม.')}`);
  if (metrics.rain7d !== null && metrics.rain7d !== undefined) lines.push(`• ฝนสะสม 7 วัน: ${fmtVal(metrics.rain7d, 'มม.')}`);
  if (metrics.rainHour !== null && metrics.rainHour !== undefined) lines.push(`• ฝนชั่วโมงล่าสุด: ${fmtVal(metrics.rainHour, 'มม.')}`);
  if (metrics.internalRain24h !== null && metrics.internalRain24h !== undefined) lines.push(`• ฝนจากเซนเซอร์ภายใน (24 ชม.): ${fmtVal(metrics.internalRain24h, 'มม.')}`);
  if (metrics.waterLevel !== null && metrics.waterLevel !== undefined) {
    lines.push(`• ระดับน้ำล่าสุด: ระดับ ${metrics.waterLevel} (${water.describe(Number(metrics.waterLevel))})`);
  }
  if (metrics.droughtSpi3 !== null && metrics.droughtSpi3 !== undefined) {
    lines.push(`• SPI-1/3/6/12: ${fmtVal(metrics.droughtSpi1)} / ${fmtVal(metrics.droughtSpi3)} / ${fmtVal(metrics.droughtSpi6)} / ${fmtVal(metrics.droughtSpi12)}`);
    if (metrics.droughtCdd !== null && metrics.droughtCdd !== undefined) lines.push(`• วันแห้งต่อเนื่อง: ${fmtVal(metrics.droughtCdd, 'วัน')}`);
    if (metrics.droughtPct !== null && metrics.droughtPct !== undefined) lines.push(`• ฝนเดือนนี้เทียบปกติ: ${fmtVal(metrics.droughtPct, '%')}`);
  }
  lines.push('');
  lines.push('เปิดดูแดชบอร์ด: ' + (process.env.DASHBOARD_URL || '(ตั้ง DASHBOARD_URL ใน .env)'));
  return lines.join('\n');
}

function loadState() {
  return store.readJson(STATE_FILE, {}) || {};
}
function saveState(s) {
  store.writeJson(STATE_FILE, s);
}

function cooldownOk(key) {
  const st = loadState();
  const last = st[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= config.notify.cooldownMin * 60000;
}
function markSent(key) {
  const st = loadState();
  st[key] = new Date().toISOString();
  saveState(st);
}

// ---------- channels ----------

async function sendLine(text) {
  const { token, to } = config.notify.line;
  if (!config.notify.line.enabled) return { ok: false, skip: true, reason: 'LINE ยังไม่เปิดใช้ (LINE_ENABLED=false)' };
  if (!token) return { ok: false, reason: 'ไม่พบ LINE_CHANNEL_ACCESS_TOKEN' };
  if (!to.length) return { ok: false, reason: 'ไม่พบผู้รับ LINE_TO' };
  const results = [];
  for (const target of to) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: target, messages: [{ type: 'text', text }] }),
    });
    results.push({ target, status: res.status, ok: res.ok });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      results[results.length - 1].body = body.slice(0, 300);
    }
  }
  const allOk = results.every((r) => r.ok);
  return { ok: allOk, results };
}

async function sendEmail(subject, text) {
  const e = config.notify.email;
  if (!e.enabled) return { ok: false, skip: true, reason: 'อีเมลยังไม่เปิดใช้ (EMAIL_ENABLED=false)' };
  if (!e.host || !e.to.length) return { ok: false, reason: 'ตั้ง SMTP_HOST / ALERT_EMAIL_TO ก่อน' };
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    return { ok: false, reason: 'ไม่พบ module nodemailer (รัน npm install)' };
  }
  const transport = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
  });
  await transport.sendMail({ from: e.from, to: e.to.join(','), subject, text });
  return { ok: true, to: e.to };
}

/**
 * ส่งการแจ้งเตือนเหตุการณ์ (มี cooldown ต่อ event key)
 * mode='alert' = เตือนเมื่อเกินเกณฑ์, 'test' = ทดสอบส่ง (ไม่สน cooldown)
 */
async function dispatch({ events, metrics, parkName, mode = 'alert' }) {
  const key = 'events:' + events.map((e) => e.id).sort().join(',');
  if (mode === 'alert' && !cooldownOk(key)) {
    return { ok: false, skipped: true, reason: 'อยู่ในช่วง cooldown' };
  }
  const text = buildMessage(events, metrics, parkName);
  const isDrought = events.some((e) => e.metric && e.metric.startsWith('drought'));
  const subject = isDrought ? `🌿 แจ้งเตือนฝนแล้ง ${parkName}` : `⚠️ แจ้งเตือนน้ำฝน ${parkName}`;
  const [line, email] = await Promise.all([sendLine(text), sendEmail(subject, text)]);
  // cooldown กันทั้งส่งซ้ำและกัน history รั่ว — ต่อให้ยังไม่มี channel ใดส่งได้ก็ต้อง mark
  if (mode === 'alert') markSent(key);
  store.appendJsonl('notify-history.jsonl', {
    at: new Date().toISOString(),
    mode,
    events: events.map((e) => ({ id: e.id, label: e.label, value: e.value, threshold: e.threshold })),
    line,
    email,
  });
  return { ok: line.ok || email.ok, line, email };
}

async function sendTest() {
  return dispatch({
    events: [{ id: 'test', label: 'ทดสอบการแจ้งเตือน', value: 0, unit: '', op: '>', threshold: 0 }],
    metrics: {},
    parkName: config.park.name,
    mode: 'test',
  });
}

function channelStatus() {
  return {
    line: {
      enabled: config.notify.line.enabled,
      configured: Boolean(config.notify.line.token && config.notify.line.to.length),
      recipients: config.notify.line.to.length,
    },
    email: {
      enabled: config.notify.email.enabled,
      configured: Boolean(config.notify.email.host && config.notify.email.to.length),
      recipients: config.notify.email.to.length,
    },
    cooldownMin: config.notify.cooldownMin,
  };
}

function history(limit = 30) {
  return store.readJsonl('notify-history.jsonl').slice(-limit).reverse();
}

module.exports = { loadRules, saveRules, evaluate, dispatch, sendTest, channelStatus, history, DEFAULT_RULES };

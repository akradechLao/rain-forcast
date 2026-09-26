'use strict';

// ---------------- helpers ----------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TOKEN_KEY = 'internalToken';

function authHeaders() {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? { 'x-internal-token': t } : {};
  } catch (_) {
    return {};
  }
}

async function api(path, opts = {}, retried = false) {
  const headers = {
    ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
    ...authHeaders(),
    ...(opts.headers || {}),
  };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !retried) {
    const t = window.prompt('ระบบเปิดการป้องกัน INTERNAL_TOKEN ไว้\nกรุณาใส่รหัส (INTERNAL_TOKEN ใน .env) เพื่อดำเนินการต่อ:');
    if (t && t.trim()) {
      try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch (_) {}
      return api(path, opts, true);
    }
  }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : Number(n).toFixed(d));
const pad = (n) => String(n).padStart(2, '0');
const fmtDateTime = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '–');

const state = {
  config: null,
  rules: [],
  days: 7,
  metrics: null,
  charts: {},
  map: null,
  stationLayer: null,
  radarLayer: null,
  rvFrames: [],
  capiFrames: [],
  capiIdx: 0,
  capiTimer: null,
  rvIdx: 0,
  nextRefreshAt: Date.now() + 60000,
  seriesCache: null,
  stationsCache: null,
  backDays: 7,
};

const hasChart = typeof Chart !== 'undefined';
const hasDataLabels = typeof ChartDataLabels !== 'undefined';
const hasLeaflet = typeof L !== 'undefined';

// ตัวเลขชิดเกือบปลายแท่งด้านใน: สีเข้มเมื่อตัวเลขอยู่เต็มในแท่ง (อ่านง่าย) ไม่เช่นนั้นสีขาวให้เห็นชัดบนพื้นมืด
function numFitsOnBar(ctx, axis) {
  const v = Number(ctx.dataset.data[ctx.dataIndex]);
  const ch = ctx.chart.chartArea;
  const scale = ctx.chart.scales[axis];
  if (!ch || !scale || !(scale.max > 0) || !(v > 0)) return false;
  const span = axis === 'y' ? ch.height : ch.width;
  if ((v / scale.max) * span < (axis === 'y' ? 16 : 44)) return false;
  if (axis === 'y') {
    const n = (ctx.chart.data.labels || []).length || 1;
    return ch.width / n >= 24;
  }
  return true;
}
const barNumColor = (ctx, axis) => (numFitsOnBar(ctx, axis) ? '#0f172a' : '#ffffff');

// ?days=1 เปิดลิงก์มุมมองชั่วโมงตามจำนวนวันที่ต้องการได้โดยตรง (share link)
{
  const daysQ = Number(new URLSearchParams(location.search).get('days'));
  if (daysQ >= 1 && daysQ <= 3650) state.days = daysQ;
}

const THEME_KEY = 'dashboardTheme';
function currentTheme() {
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'light' || q === 'dark') return q;
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch (_) { return 'dark'; }
}
function setThemeButton() {
  const b = $('#themeToggle');
  if (b) b.textContent = currentTheme() === 'light' ? '🌙 ธีมเข้ม' : '☀️ ธีมสว่าง';
}
function toggleTheme() {
  try { localStorage.setItem(THEME_KEY, currentTheme() === 'light' ? 'dark' : 'light'); } catch (_) {}
  const u = new URL(window.location.href);
  u.searchParams.delete('theme');
  location.href = u.pathname + u.search + u.hash;
}

if (hasChart) {
  const light = currentTheme() === 'light';
  Chart.defaults.color = light ? '#475569' : '#93a4c3';
  Chart.defaults.borderColor = light ? '#d7e0ec' : '#22304f';
  Chart.defaults.font.family = "'Sarabun', sans-serif";
}

// ---------------- boot ----------------
async function init() {
  bindUI();
  setThemeButton();
  startClock();
  try {
    state.config = await api('/api/config');
    $('#parkName').textContent = state.config.park.name;
    document.title = `เฝ้าระวังน้ำท่วม — ${state.config.park.name}`;
  } catch (e) {
    console.error(e);
  }
  initMap();
  await refreshAll();
  setInterval(tick, 1000);
}

function bindUI() {
  $('#btnRefresh').addEventListener('click', () => refreshAll(true));
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#radarImg').addEventListener('error', () => {
    $('#radarTime').textContent = 'โหลดภาพเรดาร์ไม่สำเร็จ — จะลองใหม่ในการรีเฟรชถัดไป';
  });
  $('#btnFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  });
  $('#btnDismissBanner').addEventListener('click', () => $('#alertBanner').classList.add('hidden'));
  $('#btnSaveRules').addEventListener('click', saveRules);
  $('#btnTestNotify').addEventListener('click', testNotify);
  $('#btnRadarPlay').addEventListener('click', toggleCapiPlay);
  $('#toggleRadar').addEventListener('change', toggleRadarLayer);
  const daysInitBtn = $(`#rangeSwitch .btn[data-days="${state.days}"]`);
  if (daysInitBtn) $$('#rangeSwitch .btn').forEach((x) => x.classList.toggle('active', x === daysInitBtn));
  $$('#rangeSwitch .btn').forEach((b) => b.addEventListener('click', () => {
    $$('#rangeSwitch .btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.days = Number(b.dataset.days);
    loadSeries();
  }));
  // ปุ่มเลือกช่วงดูค่าย้อนหลัง (การ์ดล่าง) — ?back=365 ใน URL ตั้งค่าเริ่มต้นได้ (share link)
  const backParam = Number(new URLSearchParams(location.search).get('back'));
  if (backParam) state.backDays = backParam;
  const backBtn = $(`#backSwitch .btn[data-back="${state.backDays}"]`);
  if (backBtn) $$('#backSwitch .btn').forEach((x) => x.classList.toggle('active', x === backBtn));
  $('#backSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('.btn');
    if (!b) return;
    $$('#backSwitch .btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.backDays = Number(b.dataset.back);
    if (state.seriesCache) renderCumDailyChart(state.seriesCache);
  });
  $('#csvFile').addEventListener('change', uploadCsv);
  // ขยาย/ย่อข้อความประกาศเตือนแบบเต็ม
  $('#warningsBox').addEventListener('click', (e) => {
    const btn = e.target.closest('.w-toggle');
    if (!btn) return;
    const desc = document.getElementById(btn.dataset.target);
    if (!desc) return;
    const collapsed = desc.classList.toggle('clamped');
    btn.textContent = collapsed ? 'แสดงข้อความทั้งหมด' : 'ย่อข้อความ';
  });
}

function startClock() {
  const el = $('#clock');
  const upd = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
    $('#footerTime').textContent = now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  };
  upd();
  setInterval(upd, 1000);
}

function tick() {
  const remain = Math.max(0, Math.round((state.nextRefreshAt - Date.now()) / 1000));
  $('#countdown').textContent = remain > 0 ? `รีเฟรชอัตโนมัติใน ${remain} วินาที` : 'กำลังรีเฟรช...';
  if (remain <= 0) refreshAll();
}

async function refreshAll(manual = false) {
  state.nextRefreshAt = Date.now() + (state.config?.refresh?.tmdMs || 300000);
  $('#btnRefresh').disabled = true;
  try {
    await Promise.allSettled([loadKpi(), loadSeries(), loadStations(), loadSahapat(), loadRadar(), loadWater(), loadWarnings(), loadSources(), loadNotify(), loadRules()]);
    $('#lastUpdated').textContent = 'อัปเดตล่าสุด ' + new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
    $('#offlineBanner').classList.add('hidden');
  } catch (e) {
    console.error(e);
    $('#offlineBanner').classList.remove('hidden');
  } finally {
    $('#btnRefresh').disabled = false;
    if (manual) state.nextRefreshAt = Date.now() + (state.config?.refresh?.tmdMs || 300000);
  }
}

// ---------------- KPI + alerts ----------------
async function loadKpi() {
  const { metrics } = await api('/api/kpi');
  state.metrics = metrics;
  $('#kpiHour').textContent = fmt(metrics.rainHour);
  $('#kpiHourNote').textContent = metrics.rainHourAt
    ? `ชั่วโมง ${metrics.rainHourAt.slice(11, 16)} น. ของวัน ${metrics.rainHourAt.slice(0, 10)}`
    : 'ณ เวลาปัจจุบัน';
  $('#kpiToday').textContent = fmt(metrics.rainToday);
  $('#kpiRg').textContent = fmt(metrics.rgToday);
  $('#kpiRgNote').textContent = metrics.rgStation
    ? `${metrics.rgStation.name} · ชั่วโมงนี้ ${fmt(metrics.rgHour)} มม. · ${metrics.rgStation.online ? 'ออนไลน์' : 'ออฟไลน์'}`
    : 'ยังไม่มีข้อมูลสถานีสวนฯ';
  $('#kpi24h').textContent = fmt(metrics.rain24h);
  $('#kpi7d').textContent = fmt(metrics.rain7d);
  $('#kpiInternal').textContent = fmt(metrics.internalRain24h);
  $('#kpiInternalNote').textContent = metrics.internalDemo
    ? 'โหมดข้อมูลจำลอง (ยังไม่รับเซนเซอร์จริง)'
    : metrics.internalLastAt
      ? `ล่าสุด ${fmtTime(metrics.internalLastAt)}${metrics.internalStaleMin !== null ? ` (ขาดสัญญาณ ${metrics.internalStaleMin} นาที)` : ''}`
      : 'ยังไม่มีข้อมูลเซนเซอร์จริง';
  $('#kpiTmd').textContent = fmt(metrics.tmdRain24h);
  $('#kpiTmdNote').textContent = metrics.tmdStation
    ? `${metrics.tmdStation.name} · ห่าง ${metrics.tmdStation.distKm} กม. · เกินสุด ${fmt(metrics.tmdMax24h)} มม.`
    : '–';

  const wLevels = metrics.waterLevels || {};
  const wInfo = wLevels[Number(metrics.waterLevel)];
  const hasWater = metrics.waterLevel !== null && metrics.waterLevel !== undefined;
  $('#kpiWaterUnit').textContent = '';
  $('#kpiWater').textContent = hasWater ? `ระดับ ${Number(metrics.waterLevel)}` : '–';
  $('#kpiWaterNote').textContent = metrics.waterLastAt
    ? (hasWater
        ? `${wInfo ? `${wInfo.label} — ${wInfo.desc} · ` : ''}ล่าสุด ${fmtTime(metrics.waterLastAt)}${metrics.waterStaleMin !== null ? ` (ขาดสัญญาณ ${metrics.waterStaleMin} นาที)` : ''}`
        : `ขาดสัญญาณ ${metrics.waterStaleMin} นาที`)
    : 'ยังไม่มีข้อมูลเซนเซอร์ระดับน้ำ';

  renderAlertBanner();
}

function evaluateLocal() {
  if (!state.metrics || !state.rules.length) return [];
  const m = state.metrics;
  const out = [];
  for (const r of state.rules) {
    if (!r.enabled) continue;
    const v = m[r.metric];
    if (v === null || v === undefined || Number.isNaN(Number(v))) continue;
    let hit = false;
    if (r.op === '>') hit = v > r.threshold;
    else if (r.op === '>=') hit = v >= r.threshold;
    else if (r.op === '<') hit = v < r.threshold;
    else if (r.op === '<=') hit = v <= r.threshold;
    if (hit) out.push({ ...r, value: v });
  }
  return out;
}

function renderAlertBanner() {
  const ev = evaluateLocal();
  const banner = $('#alertBanner');
  if (!ev.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  const danger = ev.some((e) => e.metric === 'rain24h' || e.metric === 'rain7d'
    || (e.metric === 'waterLevel' && Number(e.value) >= 3));
  banner.classList.toggle('severity-low', !danger);
  $('#alertBannerText').innerHTML =
    `<b>เกินเกณฑ์แจ้งเตือน:</b> ` +
    ev.map((e) => {
      if (e.metric === 'waterLevel') {
        const info = (state.metrics.waterLevels || {})[Number(e.value)];
        return `${e.label} = ระดับ ${e.value}${info ? ` (${info.label})` : ''}`;
      }
      return `${e.label} = ${fmt(e.value)} ${e.unit || ''} (เกณฑ์ ${e.op} ${e.threshold})`;
    }).join(' · ');
  // ระบายสี KPI ตามระดับ
  const level = (el, metric) => {
    const node = $(el);
    node.classList.remove('level-warn', 'level-danger');
    const trig = ev.find((e) => e.metric === metric);
    if (!trig) return;
    // น้ำ: ระดับ 2 = เฝ้าระวัง (สีเหลือง), ระดับ 3 = วิกฤติ (สีแดง)
    if (metric === 'waterLevel' && Number(trig.value) < 3) node.classList.add('level-warn');
    else node.classList.add('level-danger');
  };
  level('#kpi24h', 'rain24h');
  level('#kpi7d', 'rain7d');
  level('#kpiHour', 'rainHour');
  level('#kpiWater', 'waterLevel');
}

// ---------------- series / charts ----------------
async function loadSeries() {
  const data = await api(`/api/series?days=${state.days}`);
  state.seriesCache = data;
  renderHourlyChart(data);
  renderDailyChart(data);
  renderCumDailyChart(data);
}

function labelFor(t) {
  if (state.days === 1) return t.slice(11, 16);
  const day = t.slice(5, 10).replace('-', '/');
  const hh = t.slice(11, 16);
  return state.days <= 7 ? `${day} ${hh}` : day;
}

function renderHourlyChart(data) {
  if (!hasChart) return;
  const rows = data.hourly;
  const labels = rows.map((r) => labelFor(r.t));
  // มุมมอง 1 วัน: แสดงตัวเลขบนแท่ง (ฝนรายชั่วโมง) กดปุ่มอื่นกลับเป็นกราฟเปล่าไม่ให้รก
  const oneDay = state.days === 1 && hasDataLabels;
  // ระบายสีตามเวลาจริง (ผ่าน now = ย้อนหลัง/ปัจจุบัน, อนาคต = พยากรณ์) ไม่พึ่ง src ของแหล่งข้อมูล
  const nowMs = Date.now();
  const barColors = rows.map((r) => (new Date(r.t).getTime() > nowMs ? 'rgba(129,140,248,0.75)' : 'rgba(56,189,248,0.8)'));
  const cfg = {
    type: 'bar',
    ...(oneDay ? { plugins: [ChartDataLabels] } : {}),
    data: {
      labels,
      datasets: [
        {
          label: 'ฝน (มม.)',
          data: rows.map((r) => r.mm),
          backgroundColor: barColors,
          borderRadius: 2,
          order: 2,
        },
        {
          label: 'ฝนสะสมรายวัน (มม.)',
          data: rows.map((r) => r.cumDay),
          type: 'line',
          borderColor: '#fbbf24',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          yAxisID: 'y1',
          tension: 0.25,
          order: 1,
        },
        {
          label: 'ฝน 24 ชม.ย้อนหลัง (มม.)',
          data: rows.map((r) => r.roll24),
          type: 'line',
          borderColor: '#22d3ee',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          borderDash: [5, 3],
          yAxisID: 'y1',
          tension: 0.25,
          order: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      ...(oneDay ? { layout: { padding: { top: 4 } } } : {}),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y} มม.` } },
        ...(oneDay ? {
          datalabels: {
            display: (ctx) => ctx.datasetIndex === 0 && Number(ctx.dataset.data[ctx.dataIndex]) > 0,
            anchor: 'end',
            align: 'start',
            clamp: true,
            offset: 3,
            color: (ctx) => barNumColor(ctx, 'y'),
            font: { size: 10, weight: '700' },
            formatter: (v) => (v >= 10 ? String(Math.round(v)) : Number(v).toFixed(1)),
          },
        } : {}),
      },
      scales: {
        x: { ticks: { maxTicksLimit: state.days === 1 ? 25 : state.days <= 7 ? 16 : 12, maxRotation: 0, font: { size: 10 } } },
        y: { beginAtZero: true, title: { display: true, text: 'มม./ชม.' } },
        y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'สะสม' } },
      },
    },
  };
  upsertChart('chartHourly', cfg);
}

function renderDailyChart(data) {
  if (!hasChart) return;
  const grid = data.daily.slice(-14);
  const internalByDay = {};
  for (const h of data.internal.hourly) {
    const d = h.t.slice(0, 10);
    internalByDay[d] = (internalByDay[d] || 0) + h.mm;
  }
  const labels = grid.map((g) => g.day.slice(5).replace('-', '/'));
  const internalSeries = grid.map((g) => Math.round((internalByDay[g.day] || 0) * 10) / 10);
  const datasets = [
    { label: 'พื้นที่สวนฯ (Open-Meteo)', data: grid.map((g) => g.mm), backgroundColor: 'rgba(56,189,248,0.8)', borderRadius: 3 },
  ];
  // เซนเซอร์ภายใน: แสดงเฉพาะข้อมูลจริง (โหมดเดโม่/ยังไม่มีข้อมูลจะไม่โผล่ในกราฟ)
  if (!data.internal.demo && internalSeries.some((v) => v > 0)) {
    datasets.push({ label: `เซนเซอร์ภายใน${data.internal.demo ? ' (จำลอง)' : ''}`, data: internalSeries, backgroundColor: 'rgba(251,191,36,0.8)', borderRadius: 3 });
  }
  const cfg = {
    type: 'bar',
    ...(hasDataLabels ? { plugins: [ChartDataLabels] } : {}),
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 4 } },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        ...(hasDataLabels ? {
          datalabels: {
            display: 'auto',
            anchor: 'end',
            align: 'start',
            clamp: true,
            offset: 3,
            color: (ctx) => barNumColor(ctx, 'y'),
            font: { size: 10, weight: '700' },
            formatter: (v) => (v >= 10 ? String(Math.round(v)) : (v === 0 ? '0' : Number(v).toFixed(1))),
          },
        } : {}),
      },
      scales: {
        x: { stacked: false, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, title: { display: true, text: 'มม./วัน' } },
      },
    },
  };
  upsertChart('chartDaily', cfg);
}

function renderCumDailyChart(data) {
  if (!hasChart) return;
  const b = state.backDays;
  let labels = [];
  let bars = [];
  let barLabel = 'ฝนรายวัน (มม.)';
  let unit = 'มม./วัน';
  if (b <= 1) {
    // 24 ชม. ย้อนหลัง — รายชั่วโมง
    const rows = (data.hourly || []).slice(-24);
    labels = rows.map((r) => r.t.slice(11, 16));
    bars = rows.map((r) => r.mm);
    barLabel = 'ฝนรายชั่วโมง (มม.)';
    unit = 'มม./ชม.';
  } else if (b <= 90) {
    // รายวัน (ตัดวันตามปฏิทิน เวลาไทย) — เปรียบเทียบวันต่อวัน
    const grid = (data.daily || []).slice(-b);
    labels = grid.map((g) => g.day.slice(5).replace('-', '/'));
    bars = grid.map((g) => g.mm);
  } else {
    // ช่วงยาวรวมเป็นรายเดือน (ตามแบบวิชาการ — 5 ปี = 1,825 แท่งรายวัน อ่านยาก)
    const byMonth = new Map();
    for (const g of data.daily || []) {
      const m = g.day.slice(0, 7);
      byMonth.set(m, Math.round(((byMonth.get(m) || 0) + g.mm) * 10) / 10);
    }
    const months = [...byMonth.entries()].slice(-Math.max(12, Math.round(b / 30.4)));
    labels = months.map(([m]) => `${m.slice(5)}/${m.slice(2, 4)}`);
    bars = months.map(([, v]) => v);
    barLabel = 'ฝนรายเดือน (มม.)';
    unit = 'มม./เดือน';
  }
  let cum = 0;
  const cums = bars.map((v) => { cum = Math.round((cum + (v || 0)) * 10) / 10; return cum; });
  const cfg = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: barLabel,
          data: bars,
          backgroundColor: 'rgba(56,189,248,0.8)',
          borderRadius: 2,
          order: 2,
        },
        {
          label: 'ฝนสะสม (มม.)',
          data: cums,
          type: 'line',
          borderColor: '#fbbf24',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: b <= 30 ? 2 : 0,
          tension: 0.25,
          yAxisID: 'y1',
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y} มม.` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 24, maxRotation: 0, font: { size: 10 } } },
        y: { beginAtZero: true, title: { display: true, text: unit } },
        y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'สะสม' } },
      },
    },
  };
  upsertChart('chartCumDaily', cfg);
  const note = $('#backSourceNote');
  if (note) note.textContent = b > 90
    ? 'ช่วงยาว: ค่าประมาณการเชิงวิชาการ — ที่มา Open-Meteo (ERA5 reanalysis) ไม่ใช่ฝนวัดจริง · รวมเป็นรายเดือนเพื่ออ่านง่าย'
    : '';
}

function upsertChart(id, cfg) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const old = state.charts[id];
  if (old) {
    // config.plugins ของ Chart.js เป็น getter อ่านอย่างเดียว — แก้ด้วยการสร้าง chart ใหม่เมื่อชุด plugin เปลี่ยน
    const want = cfg.plugins || [];
    const have = old.config.plugins || [];
    const same = have.length === want.length && want.every((p, i) => have[i] === p);
    if (same) {
      old.data = cfg.data;
      old.options = cfg.options;
      old.update('none');
      return;
    }
    old.destroy();
  }
  state.charts[id] = new Chart(canvas.getContext('2d'), cfg);
}

// ---------------- stations ----------------
async function loadStations() {
  const data = await api('/api/stations');
  state.stationsCache = data;
  renderStationTable(data);
  renderStationsChart(data);
  updateStationMarkers(data);
}

async function loadSahapat() {
  const data = await api('/api/sahapat');
  renderSahapatTable(data);
}

function renderSahapatTable(data) {
  const tbody = $('#sahapatTable tbody');
  const note = $('#sahapatNote');
  if (!data || !data.rain || !data.rain.length) {
    tbody.innerHTML = '<tr><td colspan="5">ยังไม่มีข้อมูลสถานี (กำลังโหลด...)</td></tr>';
    if (note) note.textContent = (data && data.note) || '–';
    return;
  }
  tbody.innerHTML = data.rain.map((s) => {
    const badge = s.online
      ? '<span class="badge badge-ok">ออนไลน์</span>'
      : '<span class="badge badge-danger">ออฟไลน์</span>';
    return `<tr>
      <td>${s.name} <span style="color:var(--muted)">(${s.id})</span></td>
      <td class="num">${fmt(s.hourMm)}${s.hourAt ? ` <span style="color:var(--muted)">น. ${s.hourAt.slice(11, 16)}</span>` : ''}</td>
      <td class="num"><b>${fmt(s.todayMm)}</b></td>
      <td>${badge}</td>
      <td>${fmtTime(s.lastSeenAt)}</td>
    </tr>`;
  }).join('');
  if (note) {
    note.textContent = data.updatedAt
      ? `อัปเดต ${fmtTime(data.updatedAt)} · เว็บต้นทางรีเฟรชทุก ${data.refreshSeconds} วิ`
      : '–';
  }
}

function renderStationTable(data) {
  const tbody = $('#stationTable tbody');
  if (!data.stations || !data.stations.length) {
    tbody.innerHTML = '<tr><td colspan="5">ยังไม่มีข้อมูลสถานี</td></tr>';
    return;
  }
  tbody.innerHTML = data.stations.map((s) => {
    const badge = (v) => {
      if (v === null || v === undefined) return '<span class="badge badge-warn">–</span>';
      if (v >= 60) return `<span class="badge badge-danger">${v}</span>`;
      if (v >= 30) return `<span class="badge badge-warn">${v}</span>`;
      return `<span class="badge badge-ok">${v}</span>`;
    };
    const name = s.nameEn || s.nameTh;
    return `<tr>
      <td>${name}${s.nameEn && s.nameTh ? ` <span style="color:var(--muted)">(${s.nameTh})</span>` : ''}</td>
      <td class="num">${s.distKm ?? '–'} กม.</td>
      <td class="num">${fmt(s.rain3h)}</td>
      <td class="num">${badge(s.rain24h)}</td>
      <td>${fmtTime(s.observedAt)}</td>
    </tr>`;
  }).join('');
}

function renderStationsChart(data) {
  if (!hasChart || !data.stations) return;
  const st = data.stations.filter((s) => s.rain24h !== null && s.rain24h !== undefined).slice(0, 10);
  const cfg = {
    type: 'bar',
    ...(hasDataLabels ? { plugins: [ChartDataLabels] } : {}),
    data: {
      labels: st.map((s) => `${s.nameEn || s.nameTh} (${s.distKm ?? '-'} กม.)`),
      datasets: [{
        label: 'ฝนสะสม 24 ชม. (มม.)',
        data: st.map((s) => s.rain24h),
        backgroundColor: st.map((s) => (s.rain24h >= 60 ? '#f87171' : s.rain24h >= 30 ? '#fbbf24' : '#38bdf8')),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 36 } },
      plugins: {
        legend: { display: false },
        ...(hasDataLabels ? {
          datalabels: {
            display: 'auto',
            anchor: 'end',
            align: (ctx) => (numFitsOnBar(ctx, 'x') ? 'start' : 'end'),
            clamp: true,
            offset: 3,
            color: (ctx) => barNumColor(ctx, 'x'),
            font: { size: 11, weight: '700' },
            formatter: (v) => String(Math.round(v * 10) / 10),
          },
        } : {}),
      },
      scales: { x: { beginAtZero: true, suggestedMax: Math.max(...st.map((s) => s.rain24h), 0) * 1.16 || undefined } },
    },
  };
  upsertChart('chartStations', cfg);
}

// ---------------- map ----------------
function initMap() {
  if (!hasLeaflet) {
    $('#map').innerHTML = '<div style="padding:20px;color:#93a4c3">ไม่สามารถโหลด Leaflet (ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต)</div>';
    return;
  }
  const p = state.config ? state.config.park : { lat: 13.0833, lon: 100.9667, name: 'สวนอุตสาหกรรมเครือสหพัฒน์ ศรีราชา' };
  state.map = L.map('map', { zoomControl: true }).setView([p.lat, p.lon], 11);
  // basemap คนละ pane กับเรดาร์ เพื่อให้ปรับโทนสีได้โดยไม่กระทบชั้นเรดาร์/หมุด
  state.map.createPane('basemapPane');
  state.map.getPane('basemapPane').style.zIndex = 190;
  state.map.getPane('basemapPane').classList.add('basemap-pane');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    pane: 'basemapPane',
  }).addTo(state.map);
  L.marker([p.lat, p.lon]).addTo(state.map)
    .bindPopup(`<b>${p.name}</b><br>ตำแหน่งสวนฯ`);
  state.stationLayer = L.layerGroup().addTo(state.map);
}

function updateStationMarkers(data) {
  if (!hasLeaflet || !state.stationLayer) return;
  state.stationLayer.clearLayers();
  (data.stations || []).forEach((s) => {
    if (!s.lat || !s.lon) return;
    const r = s.rain24h ?? 0;
    const color = r >= 60 ? '#f87171' : r >= 30 ? '#fbbf24' : '#38bdf8';
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 8, color, fillColor: color, fillOpacity: 0.75, weight: 2,
    });
    m.bindPopup(
      `<b>${s.nameEn || s.nameTh}</b><br>` +
      `ฝน 3 ชม.: ${fmt(s.rain3h)} มม.<br>` +
      `ฝน 24 ชม.: ${fmt(s.rain24h)} มม.<br>` +
      `ห่างสวนฯ: ${s.distKm ?? '-'} กม.<br>` +
      `ตรวจล่าสุด: ${fmtTime(s.observedAt)}`
    );
    state.stationLayer.addLayer(m);
  });
}

async function loadRadar() {
  const data = await api('/api/radar');
  if (data.rainviewer && (data.rainviewer.frames || []).length) {
    state.rvFrames = data.rainviewer.frames || [];
    state.rvHost = data.rainviewer.host || 'https://tilecache.rainviewer.com';
    $('#mapNote').textContent = `เวลาเรดาร์ (ล่าสุด): ${state.rvFrames.length ? new Date(state.rvFrames[state.rvFrames.length - 1].time * 1000).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' }) : '–'}`;
    if ($('#toggleRadar').checked) setRadarFrame(state.rvFrames.length - 1);
  } else {
    $('#mapNote').textContent = 'เรดาร์ RainViewer: ยังโหลดไม่สำเร็จ — จะลองใหม่ในการรีเฟรชถัดไป';
  }
  updateRadarLegend();
  if (data.royalrain && data.royalrain.frames && data.royalrain.frames.length) {
    state.capiFrames = data.royalrain.frames;
    state.capiIdx = 0;
    showCapi(state.capiFrames.length - 1);
  } else if (!state.capiFrames.length) {
    $('#radarTime').textContent = 'เรดาร์ฝนหลวง: ยังโหลดไม่สำเร็จ — จะลองใหม่ในการรีเฟรชถัดไป';
  }
}

function setRadarFrame(idx) {
  if (!hasLeaflet || !state.map || !state.rvFrames.length) return;
  state.rvIdx = Math.max(0, Math.min(idx, state.rvFrames.length - 1));
  const f = state.rvFrames[state.rvIdx];
  const host = state.rvHost || 'https://tilecache.rainviewer.com';
  // RainViewer 2025: เหลือ color scheme เดียว = 2 (Universal Blue) — รูปแบบ /color/ คืนภาพ grayscale อ๊อปะค (แถบดำ)
  const tileUrl = `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
  if (state.radarLayer) state.map.removeLayer(state.radarLayer);
  if (!$('#toggleRadar').checked) return;
  // RainViewer free รองรับ tile ถึง z7 เท่านั้น (z8+ คืนภาพ "Zoom Level Not Supported")
  // -> maxNativeZoom 7 ให้ Leaflet ย่อขยาย tile เอง ภาพเรดาร์จะเบลสนิดหน่อยแต่แสดงครบ
  state.radarLayer = L.tileLayer(tileUrl, { opacity: 0.7, zIndex: 200, maxNativeZoom: 7, maxZoom: 19 });
  state.radarLayer.addTo(state.map);
}

/** legend เรดาร์แสดงเฉพาะตอนมีเฟรมและเปิดชั้นเรดาร์อยู่ */
function updateRadarLegend() {
  const el = $('#radarLegend');
  if (!el) return;
  el.style.display = (state.rvFrames.length && $('#toggleRadar').checked) ? 'flex' : 'none';
}

function toggleRadarLayer() {
  if ($('#toggleRadar').checked) setRadarFrame(state.rvFrames.length - 1);
  else if (state.radarLayer && state.map) { state.map.removeLayer(state.radarLayer); state.radarLayer = null; }
  updateRadarLegend();
}

function showCapi(idx) {
  if (!state.capiFrames.length) return;
  state.capiIdx = Math.max(0, Math.min(idx, state.capiFrames.length - 1));
  const f = state.capiFrames[state.capiIdx];
  $('#radarImg').src = `/api/radar/frame?u=${encodeURIComponent(f.fullUrl)}`;
  // รูปแบบ datetime_bangkok: "YYYYMMDD HH:MM"
  const bkk = String(f.datetimeBangkok || '');
  $('#radarTime').textContent = bkk.length >= 14
    ? `${bkk.slice(6, 8)}/${bkk.slice(4, 6)} เวลา ${bkk.slice(9, 11)}:${bkk.slice(12, 14)} น.`
    : (bkk || '');
}

function toggleCapiPlay() {
  const btn = $('#btnRadarPlay');
  if (state.capiTimer) {
    clearInterval(state.capiTimer);
    state.capiTimer = null;
    btn.textContent = '▶ เล่น';
    return;
  }
  btn.textContent = '⏸ หยุด';
  state.capiTimer = setInterval(() => {
    showCapi(state.capiIdx >= state.capiFrames.length - 1 ? 0 : state.capiIdx + 1);
  }, 900);
}

// ---------------- water level ----------------
async function loadWater() {
  const data = await api('/api/water?hours=24');
  renderWaterChart(data);
}

function renderWaterChart(data) {
  if (!hasChart) return;
  const unit = data.unit || 'ระดับ';
  const levels = data.levels || {};
  const rows = data.series || [];
  // ยืดแกน x ไปถึงเวลาปัจจุบันเสมอ (ถ้าข้อมูลล่าสุดค้างเกิน 10 นาที จะเพิ่มจุด dummy ต่อท้าย)
  const seriesRows = [...rows];
  if (seriesRows.length) {
    const lastTs = new Date(seriesRows[seriesRows.length - 1].t).getTime();
    const now = Date.now();
    if (now - lastTs > 10 * 60000) {
      const lastLevel = seriesRows[seriesRows.length - 1].level;
      const nowIct = new Date(now + 7 * 3600000);
      const nowStr = `${nowIct.getUTCFullYear()}-${String(nowIct.getUTCMonth() + 1).padStart(2, '0')}-${String(nowIct.getUTCDate()).padStart(2, '0')}T${String(nowIct.getUTCHours()).padStart(2, '0')}:${String(nowIct.getUTCMinutes()).padStart(2, '0')}:00`;
      seriesRows.push({ t: nowStr, level: lastLevel });
    }
  }
  const labels = seriesRows.map((r) => {
    const d = new Date(r.t);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const datasets = [
    {
      label: 'ระดับน้ำ',
      data: seriesRows.map((r) => r.level),
      borderColor: '#38bdf8',
      backgroundColor: 'rgba(56,189,248,0.15)',
      fill: true,
      tension: 0.3,
      pointRadius: seriesRows.length > 60 ? 0 : 2,
      borderWidth: 2,
    },
  ];
  if (data.warnLevel !== null && data.warnLevel !== undefined) {
    datasets.push({
      label: `เกณฑ์เตือน (ระดับ ${data.warnLevel})`,
      data: seriesRows.map(() => data.warnLevel),
      borderColor: '#f87171',
      borderDash: [6, 6],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    });
  }
  const cfg = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (c.dataset.label.startsWith('เกณฑ์')) return c.dataset.label;
              const info = levels[Number(c.parsed.y)];
              return `ระดับน้ำ: ระดับ ${c.parsed.y}${info ? ` — ${info.label}` : ''}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 14, maxRotation: 0, font: { size: 10 } } },
        y: {
          min: 0,
          max: 4,
          ticks: { stepSize: 1 },
          title: { display: true, text: unit },
        },
      },
    },
  };
  upsertChart('chartWater', cfg);
}

// ---------------- warnings / sources ----------------
async function loadWarnings() {
  const data = await api('/api/warnings');
  const box = $('#warningsBox');
  if (!data.warnings || !data.warnings.length) {
    box.innerHTML = '– ไม่มีประกาศเตือนภัยใหม่ –';
    return;
  }
  box.innerHTML = data.warnings.slice(0, 4).map((w, i) => `
    <div class="warning-item">
      <div class="w-head"><b>${escapeHtml(w.title || '')}</b> <span class="w-dt">${escapeHtml(w.datetime || '')}</span></div>
      <div class="w-desc clamped" id="wdesc-${i}">${escapeHtml(w.desc || '')}</div>
      <div class="w-actions">
        <button type="button" class="btn btn-ghost btn-sm w-toggle" data-target="wdesc-${i}">แสดงข้อความทั้งหมด</button>
        ${w.url ? `<a class="w-link" href="${escapeHtml(w.url)}" target="_blank" rel="noopener">อ่านประกาศฉบับเต็ม ↗</a>` : ''}
      </div>
    </div>`).join('');
}

async function loadSources() {
  const data = await api('/api/sources');
  const box = $('#sourcesBox');
  const names = {
    openmeteo: 'Open-Meteo (ย้อนหลัง+พยากรณ์)',
    tmd: 'กรมอุตุนิยมวิทยา (สถานีฝน)',
    sahapat: 'สถานีฝนสวนฯ (RG จริง)',
    radar: 'เรดาร์ (RainViewer+ฝนหลวง)',
    alerts: 'ระบบประเมินแจ้งเตือน',
  };
  const rows = data.sources.map((s) => {
    const ok = s.ok;
    const cls = ok ? 'dot-ok' : 'dot-err';
    const meta = ok
      ? `ล่าสุด ${fmtTime(s.lastOkAt)}${s.stations ? ` · ${s.stations} สถานี` : ''}${s.online !== undefined ? ` · ออนไลน์ ${s.online}` : ''}${s.frames ? ` · ${s.frames} เฟรม` : ''}`
      : `ผิดพลาด: ${s.lastError || 'ไม่ทราบสาเหตุ'} (${fmtTime(s.failedAt)})`;
    return `<div class="source-row"><span class="dot ${cls}"></span><span class="source-name">${names[s.name] || s.name}</span><span class="source-meta">${meta}</span></div>`;
  });
  const mqtt = data.mqtt;
  const mqttOk = mqtt.configured && mqtt.connected;
  rows.push(`<div class="source-row"><span class="dot ${mqtt.configured ? (mqttOk ? 'dot-ok' : 'dot-err') : 'dot-warn'}"></span>
    <span class="source-name">เซนเซอร์ฝน (MQTT)</span>
    <span class="source-meta">${mqtt.configured ? (mqttOk ? `เชื่อมต่อแล้ว · รับข้อมูล ${mqtt.count} ข้อความ` : `ยังเชื่อมไม่ต่อ: ${mqtt.lastError || '-'}`) : (mqtt.note || 'ยังไม่ได้ตั้งค่า (เปิดภายหลังได้)')}</span></div>`);

  const water = data.water;
  const waterOk = water.configured && water.connected;
  rows.push(`<div class="source-row"><span class="dot ${water.configured ? (waterOk ? 'dot-ok' : 'dot-err') : 'dot-warn'}"></span>
    <span class="source-name">เซนเซอร์ระดับน้ำ (MQTT)</span>
    <span class="source-meta">${water.configured ? (waterOk ? `เชื่อมต่อแล้ว · ${water.count} ข้อความ · ${water.topic}` : `ยังเชื่อมไม่ต่อ: ${water.lastError || '-'}`) : (water.note || 'ยังไม่ได้ตั้งค่า (เปิดภายหลังได้)')}</span></div>`);

  box.innerHTML = rows.join('');

  const okCount = data.sources.filter((s) => s.ok).length;
  $('#kpiSources').textContent = `${okCount}/${data.sources.length}`;
  $('#kpiSourcesNote').textContent = okCount === data.sources.length ? 'ทุกแหล่งข้อมูลปกติ' : 'มีแหล่งข้อมูลขัดข้อง';
}

// ---------------- rules / notify ----------------
async function loadRules() {
  const data = await api('/api/alerts/rules');
  state.rules = data.rules || [];
  renderRules();
  renderAlertBanner();
}

function renderRules() {
  const box = $('#rulesBox');
  box.innerHTML = state.rules.map((r, i) => `
    <div class="rule-row">
      <input type="checkbox" data-i="${i}" data-k="enabled" ${r.enabled ? 'checked' : ''}>
      <input type="text" data-i="${i}" data-k="label" value="${escapeAttr(r.label)}">
      <input type="number" data-i="${i}" data-k="threshold" value="${r.threshold}" step="any">
      <span class="rule-op">${escapeHtml(r.op)}</span>
      <span class="rule-unit">${escapeHtml(r.unit || '')}</span>
    </div>`).join('');
}

async function saveRules() {
  const rules = state.rules.map((r, i) => ({ ...r }));
  $$('#rulesBox input').forEach((inp) => {
    const i = Number(inp.dataset.i);
    const k = inp.dataset.k;
    if (k === 'enabled') rules[i].enabled = inp.checked;
    else if (k === 'threshold') rules[i].threshold = Number(inp.value);
    else if (k === 'label') rules[i].label = inp.value;
  });
  try {
    const res = await api('/api/alerts/rules', { method: 'POST', body: JSON.stringify({ rules }) });
    state.rules = res.rules;
    renderRules();
    renderAlertBanner();
    flash($('#btnSaveRules'), '✓ บันทึกแล้ว');
  } catch (e) {
    alert('บันทึกไม่สำเร็จ: ' + e.message);
  }
}

async function loadNotify() {
  const data = await api('/api/notify/status');
  const c = data.channels;
  const row = (name, ch, note) => `
    <div class="channel-row">
      <span class="dot ${ch.enabled && ch.configured ? 'dot-ok' : ch.configured || ch.enabled ? 'dot-warn' : 'dot-warn'}"></span>
      <span class="ch-name">${name}</span>
      <span>${ch.enabled ? 'เปิดใช้' : 'ปิดอยู่'}</span>
      <span class="source-meta">${ch.configured ? `ตั้งค่าแล้ว (${ch.recipients} ผู้รับ)` : 'ยังไม่ตั้งค่า'} · ${note}</span>
    </div>`;
  $('#channelsBox').innerHTML =
    row('LINE', c.line, 'LINE Messaging API (LINE_NOTIFY ยุติบริการแล้ว)') +
    row('อีเมล', c.email, 'SMTP') +
    `<div class="channel-row"><span class="dot dot-warn"></span><span class="ch-name">Cooldown</span><span>${c.cooldownMin} นาที/ครั้ง</span></div>`;

  const hist = data.history || [];
  $('#notifyHistory').innerHTML = hist.length
    ? hist.map((h) => {
        const t = new Date(h.at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const line = h.line ? (h.line.ok ? 'LINE ✓' : h.line.skip ? 'LINE –' : 'LINE ✗') : '';
        const em = h.email ? (h.email.ok ? 'เมล ✓' : h.email.skip ? 'เมล –' : 'เมล ✗') : '';
        const ev = (h.events || []).map((e) => e.label).join(', ');
        return `<div class="nh-item">${t} · ${h.mode === 'test' ? '[ทดสอบ]' : ''} ${ev} · ${line} ${em}</div>`;
      }).join('')
    : '– ยังไม่เคยส่ง –';
}

async function testNotify() {
  flash($('#btnTestNotify'), 'กำลังส่ง...');
  try {
    const r = await api('/api/notify/test', { method: 'POST' });
    const lineMsg = r.line.ok ? 'LINE: ส่งสำเร็จ' : `LINE: ${r.line.reason || 'ไม่สำเร็จ'}`;
    const emMsg = r.email.ok ? 'อีเมล: ส่งสำเร็จ' : `อีเมล: ${r.email.reason || r.email.error || 'ไม่สำเร็จ'}`;
    flash($('#btnTestNotify'), '✓ เสร็จ');
    alert(`${lineMsg}\n${emMsg}\n\n(หากยังปิดช่องทางอยู่ ให้ตั้งค่าใน .env แล้วรีสตาร์ทเซิร์ฟเวอร์)`);
    loadNotify();
  } catch (e) {
    alert('ทดสอบไม่สำเร็จ: ' + e.message);
  }
}

// ---------------- internal ----------------
async function uploadCsv(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const r = await api('/api/internal/csv', { method: 'POST', body: text });
    alert(`นำเข้าเสร็จสิ้น: ${r.imported} แถว` + (r.errors.length ? `\nมีข้อผิดพลาด ${r.errors.length} แถว` : ''));
    loadSeries();
    loadKpi();
  } catch (err) {
    alert('นำเข้าไม่สำเร็จ: ' + err.message);
  }
  e.target.value = '';
}

// ---------------- utils ----------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1800);
}

init().catch((e) => {
  console.error('init error', e);
  $('#offlineBanner').classList.remove('hidden');
});

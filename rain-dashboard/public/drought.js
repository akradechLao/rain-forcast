'use strict';

// ---------------- helpers ----------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : Number(n).toFixed(d));

const state = {
  config: null,
  rules: [],
  metrics: null,
  drought: null,
  spiScale: 3,
  charts: {},
  nextRefreshAt: Date.now() + 60000,
};

const hasChart = typeof Chart !== 'undefined';

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

function upsertChart(id, cfg) {
  if (!hasChart) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (state.charts[id]) {
    const c = state.charts[id];
    c.data = cfg.data;
    c.options = { ...c.options, ...cfg.options };
    c.update();
    return;
  }
  state.charts[id] = new Chart(el.getContext('2d'), cfg);
}

// ---------------- boot ----------------
async function init() {
  bindUI();
  setThemeButton();
  startClock();
  try {
    state.config = await api('/api/config');
    $('#parkName').textContent = state.config.park.name;
    document.title = `เฝ้าระวังฝนแล้ง — ${state.config.park.name}`;
  } catch (e) { console.error(e); }
  await refreshAll();
  setInterval(tick, 1000);
}

function bindUI() {
  $('#btnRefresh').addEventListener('click', () => refreshAll(true));
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#btnDismissBanner').addEventListener('click', () => $('#alertBanner').classList.add('hidden'));
  $('#btnTestNotify').addEventListener('click', testNotify);
  $('#spiSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('.btn');
    if (!b) return;
    $$('#spiSwitch .btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.spiScale = Number(b.dataset.scale);
    if (state.drought) renderSpiChart(state.drought);
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
  state.nextRefreshAt = Date.now() + 300000;
  $('#btnRefresh').disabled = true;
  try {
    await Promise.allSettled([loadKpi(), loadDrought(), loadRules(), loadNotify()]);
    $('#lastUpdated').textContent = 'อัปเดตล่าสุด ' + new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
    $('#offlineBanner').classList.add('hidden');
  } catch (e) {
    console.error(e);
    $('#offlineBanner').classList.remove('hidden');
  } finally {
    $('#btnRefresh').disabled = false;
    if (manual) state.nextRefreshAt = Date.now() + 300000;
  }
}

// ---------------- KPI + banner ----------------
async function loadKpi() {
  const { metrics } = await api('/api/kpi');
  state.metrics = metrics;
  renderKpis();
  renderBanner();
}

function renderKpis() {
  const m = state.metrics || {};
  const d = state.drought ? state.drought.current : null;

  $('#kpiSpi1').textContent = fmt(m.droughtSpi1, 2);
  $('#kpiSpi3').textContent = fmt(m.droughtSpi3, 2);
  $('#kpiSpi6').textContent = fmt(m.droughtSpi6, 2);
  $('#kpiSpi12').textContent = fmt(m.droughtSpi12, 2);
  $('#kpiPct').textContent = m.droughtPct === null || m.droughtPct === undefined ? '–' : m.droughtPct;
  $('#kpiCdd').textContent = m.droughtCdd === null || m.droughtCdd === undefined ? '–' : m.droughtCdd;

  // สีตามระดับ SPI-3
  const spi3 = Number(m.droughtSpi3);
  const v3 = $('#kpiSpi3');
  v3.classList.remove('level-warn', 'level-danger');
  if (Number.isFinite(spi3)) {
    if (spi3 <= -1.5) v3.classList.add('level-danger');
    else if (spi3 <= -1) v3.classList.add('level-warn');
  }
  const cdd = Number(m.droughtCdd);
  const vc = $('#kpiCdd');
  vc.classList.remove('level-warn', 'level-danger');
  if (Number.isFinite(cdd)) {
    if (cdd >= 30) vc.classList.add('level-danger');
    else if (cdd >= 14) vc.classList.add('level-warn');
  }
  if (d) {
    $('#kpiPctNote').textContent = `${d.monthMtd} มม. / ปกติ ${d.monthNormalMtd} มม. ถึงวันนี้ · ${d.monthPctLabel}`;
    $('#kpiCddNote').textContent = d.lastRainDay ? `ฝนล่าสุด ${d.lastRainDay} · น้อยกว่า 1 มม./วัน` : 'ฝนน้อยกว่า 1 มม./วัน';
  }
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

function renderBanner() {
  const ev = evaluateLocal();
  const banner = $('#alertBanner');
  if (!ev.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  const severe = ev.some((e) => e.id === 'rd2' || (e.metric === 'droughtSpi3' && Number(e.value) <= -1.5));
  banner.classList.toggle('severity-low', !severe);
  $('#alertBannerText').innerHTML =
    `<b>🌵 เกณฑ์ฝนแล้ง:</b> ` +
    ev.map((e) => `${e.label} = ${fmt(e.value, 2)} ${e.unit || ''}`).join(' · ');
}

// ---------------- drought data ----------------
async function loadDrought() {
  const d = await api('/api/drought');
  state.drought = d;
  renderHero(d);
  renderKpis();
  renderSpiChart(d);
  renderMonthlyChart(d);
  renderClimChart(d);
}

function renderHero(d) {
  const c = d.current;
  const badge = $('#heroBadge');
  badge.textContent = c.levelLabel;
  badge.style.background = c.color;
  badge.style.color = '#0b1220';
  $('#heroTitle').textContent = `สถานะฝนแล้งระดับ ${c.level} / 5 — ${c.levelLabel}`;
  $('#heroDesc').textContent = c.levelDesc;
  $('#heroSpi').textContent = fmt(c.spi3, 2);
  $('#heroSpi').style.color = c.color;
  const partialNote = c.partial ? ' (เดือนนี้ยังไม่จบ — ประมาณการเต็มเดือน)' : '';
  $('#heroMeta').textContent =
    `ณ วันที่ ${c.asOfDay}${partialNote} · ฝนเดือนนี้ ${c.monthMtd} มม. เทียบปกติ ${c.monthNormalMtd} มม. (${c.monthPct}%) · ` +
    `วันแห้งต่อเนื่อง ${c.cdd} วัน · ${d.meta.years} ปีข้อมูลย้อนหลัง`;
}

function renderSpiChart(d) {
  const k = state.spiScale;
  const key = 'spi' + k;
  const rows = d.spiSeries.filter((r) => r[key] !== null);
  const labels = rows.map((r) => r.ym);
  const data = rows.map((r) => r[key]);
  const line = (y, color, dash) => ({
    label: y === 0 ? 'ปกติ' : `SPI ${y}`,
    data: labels.map(() => y),
    borderColor: color,
    borderWidth: 1,
    borderDash: dash,
    pointRadius: 0,
  });
  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `SPI-${k} เดือน`,
          data,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,0.12)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
        },
        line(0, 'rgba(148,163,184,0.8)', []),
        line(-1, 'rgba(248,113,113,0.9)', [6, 4]),
        line(-2, 'rgba(239,68,68,1)', [3, 3]),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 }, filter: (i) => !i.text.startsWith('ปกติ') } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '–' : Number(c.parsed.y).toFixed(2)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 24, maxRotation: 0, font: { size: 10 } } },
        y: {
          title: { display: true, text: 'ค่า SPI' },
          suggestedMin: -3,
          suggestedMax: 3,
        },
      },
    },
  };
  upsertChart('chartSpi', cfg);
}

function renderMonthlyChart(d) {
  const rows = d.monthly;
  const cfg = {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.ym.slice(2).replace('-', '/')),
      datasets: [
        {
          label: 'ฝนจริง (มม.)',
          data: rows.map((r) => r.mm),
          backgroundColor: rows.map((r) => (r.partial ? 'rgba(56,189,248,0.4)' : 'rgba(56,189,248,0.85)')),
          borderRadius: 2,
        },
        {
          label: 'ค่าปกติ 30 ปี (มม.)',
          data: rows.map((r) => r.normal),
          type: 'line',
          borderColor: '#fbbf24',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 0, font: { size: 10 } } },
        y: { beginAtZero: true, title: { display: true, text: 'มม./เดือน' } },
      },
    },
  };
  upsertChart('chartMonthly', cfg);
}

function renderClimChart(d) {
  const M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const cfg = {
    type: 'bar',
    data: {
      labels: d.climatology.map((c) => M[c.month - 1]),
      datasets: [{
        label: 'ฝนเฉลี่ย (มม.)',
        data: d.climatology.map((c) => c.normal),
        backgroundColor: 'rgba(129,140,248,0.8)',
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'มม./เดือน' } } },
    },
  };
  upsertChart('chartClim', cfg);
}

// ---------------- rules / notify ----------------
async function loadRules() {
  try {
    const data = await api('/api/alerts/rules');
    state.rules = data.rules || [];
    const dr = state.rules.filter((r) => r.id === 'rd1' || r.id === 'rd2');
    $('#droughtRules').innerHTML = dr.length
      ? dr.map((r) => `<div class="rule-row"><b>${r.enabled ? 'เปิด' : 'ปิด'}</b> — ${r.label} (${r.op} ${r.threshold})</div>`).join('')
      : 'ไม่พบกฎฝนแล้ง (อัปเดตซอฟต์แวร์แล้วรีสตาร์ทใหม่)';
    renderBanner();
  } catch (e) { console.error(e); }
}

async function loadNotify() {
  try {
    const data = await api('/api/notify/status');
    const hist = (data.history || []).slice(0, 10);
    $('#notifyHistory').innerHTML = hist.length
      ? hist.map((h) => {
        const drought = (h.events || []).some((ev) => ev.id === 'rd1' || ev.id === 'rd2');
        const when = new Date(h.at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const labels = (h.events || []).map((ev) => ev.label).join(', ');
        const ch = h.line && h.line.ok ? 'LINE ✓' : h.email && h.email.ok ? 'อีเมล ✓' : 'บนเว็บ';
        return `<div class="history-row${drought ? ' history-drought' : ''}">${when} — ${labels} · ${ch}${h.mode === 'test' ? ' (ทดสอบ)' : ''}</div>`;
      }).join('')
      : 'ยังไม่มีประวัติ';
  } catch (e) { console.error(e); }
}

async function testNotify() {
  try {
    await api('/api/notify/test', { method: 'POST' });
    await loadNotify();
    alert('ส่งข้อความทดสอบแล้ว — ดูผลได้ในช่อง "ผลการส่ง" ของหน้าน้ำท่วม (ช่องทาง LINE/อีเมลยังปิดอยู่ จึงบันทึกเป็นรายการทดสอบเท่านั้น)');
  } catch (e) {
    alert('ส่งไม่สำเร็จ: ' + e.message);
  }
}

init();

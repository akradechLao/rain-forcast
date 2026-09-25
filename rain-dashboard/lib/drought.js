'use strict';
// ฝนแล้ง — คำนวณ SPI (Standardized Precipitation Index) มาตรฐาน WMO:
// ประเมินปริมาณฝนรายเดือน (1/3/6/12 เดือน) fit gamma (method of moments)
// แปลงค่าฝนเป็นค่า Z (normal standard)
// + ค่าเฉลี่ยภูมิอากาศ (climatology) + จำนวนวันแล้งต่อเนื่อง (CDD) ใช้ข้อมูลย้อนหลัง ~30 ปี

const openmeteo = require('./sources/openmeteo');

const SCALES = [1, 3, 6, 12];

// ---------- math ----------

function lgamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// regularized lower incomplete gamma P(a,x)
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
    }
    return Math.min(1, Math.max(0, sum * Math.exp(-x + a * Math.log(x) - lgamma(a))));
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  return Math.min(1, Math.max(0, 1 - q));
}

// inverse standard normal CDF (Acklam approximation)
function invNorm(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// fit gamma ด้วย method of moments → {alpha, beta} ถ้า sample น้อย/zerovariance คืน null
function fitGamma(samples) {
  const n = samples.length;
  if (n < 10) return null;
  let sum = 0;
  for (const v of samples) sum += v;
  const mean = sum / n;
  if (mean <= 0) return null;
  let ss = 0;
  for (const v of samples) ss += (v - mean) * (v - mean);
  const varr = ss / (n - 1);
  if (varr <= 1e-9) return null;
  const alpha = (mean * mean) / varr;
  const beta = varr / mean;
  return { alpha, beta };
}

function spiFromValue(value, fit) {
  if (!fit) return 0;
  const f = gammaP(fit.alpha, Math.max(value, 0) / fit.beta);
  const z = invNorm(Math.min(0.99999, Math.max(0.00001, f)));
  return Math.round(z * 100) / 100;
}

// ---------- levels (ระดับสถานการณ์ฝนแล้งตามเกณฑ์ SPI) ----------

const LEVELS = [
  { min: -Infinity, level: 0, label: 'ปกติ', desc: 'ไม่มีสภาวะฝนแล้ง', color: '#34d399' },
  { min: -0.5, level: 1, label: 'เริ่มมีฝนแล้ง', desc: 'เริ่มมีสภาวะฝนแล้งระดับเบาที่สุด (D0) — เฝ้าระวัง', color: '#facc15' },
  { min: -1.0, level: 2, label: 'เริ่มฝนแล้ง', desc: 'สภาวะฝนแล้งระดับเริ่มต้น (D1) — ติดตามใกล้ชิด', color: '#fb923c' },
  { min: -1.5, level: 3, label: 'ฝนแล้งปานกลาง', desc: 'สภาวะฝนแล้งปานกลาง (D2) — ระดับวิกฤต', color: '#f87171' },
  { min: -2.0, level: 4, label: 'ฝนแล้งรุนแรง', desc: 'สภาวะฝนแล้งรุนแรง (D3) — กระทบเกษตรกรมาก', color: '#ef4444' },
  { min: -3.0, level: 5, label: 'ฝนแล้งวิกฤต', desc: 'สภาวะฝนแล้งวิกฤตรุนแรงที่สุด (D4) — วิกฤติ', color: '#b91c1c' },
];

function levelOf(spi) {
  let out = LEVELS[0];
  for (const l of LEVELS) if (spi < l.min) out = l;
  return out;
}

// ---------- main ----------

function pad(n) { return String(n).padStart(2, '0'); }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

function compute() {
  const all = openmeteo.readHourly();
  if (all.length < 8760 * 2) return null; // ต่ำกว่า 2 ปี ยังไม่พอ
  // ตัดแถวพยากรณ์อนาคตออก (ฝนแล้งต้องคิดจากข้อมูลที่ "เกิดขึ้นแล้ว" เท่านั้น)
  const nowIct = new Date().toLocaleString('sv', { timeZone: 'Asia/Bangkok' }).slice(0, 16).replace(' ', 'T');
  const rows = all.length && all[all.length - 1].t > nowIct ? all.filter((r) => r.t <= nowIct) : all;
  const daily = openmeteo.toDaily(rows);
  if (daily.length < 730) return null;

  const asOfDay = daily[daily.length - 1].day; // YYYY-MM-DD (วันล่าสุด)

  // ---- การรวมปริมาณฝนรายเดือน ----
  const monthly = [];
  let curM = null;
  for (const d of daily) {
    const ym = d.day.slice(0, 7);
    if (!curM || curM.ym !== ym) {
      curM = { ym, mm: 0, days: 0 };
      monthly.push(curM);
    }
    curM.mm += d.mm;
    curM.days++;
  }
  const last = monthly[monthly.length - 1];
  const [ly, lm] = last.ym.split('-').map(Number);
  const lastPartial = last.days < daysInMonth(ly, lm);
  const dayOfMonth = Number(asOfDay.slice(8, 10));
  // เดือนปัจจุบันยังไม่จบ → ประมาณปริมาณทั้งเดือน (extrapolate) ก่อนใช้คำนวณ SPI
  const monthFactor = lastPartial && dayOfMonth > 0 ? daysInMonth(ly, lm) / dayOfMonth : 1;
  for (const m of monthly) m.mm = Math.round(m.mm * 10) / 10;
  const mmLatestEst = Math.round(last.mm * monthFactor * 10) / 10;
  const monthlyEst = monthly.slice(0, -1).concat([{ ym: last.ym, mm: mmLatestEst, days: last.days, partial: true }]);

  // ---- climatology: ค่าเฉลี่ยปริมาณฝนรายเดือนตามฤดู (ไม่รวมเดือนปัจจุบัน) ----
  const climSum = new Array(13).fill(0);
  const climN = new Array(13).fill(0);
  for (let i = 0; i < monthly.length - (lastPartial ? 1 : 0); i++) {
    const m = monthly[i];
    const mo = Number(m.ym.slice(5, 7));
    climSum[mo] += m.mm;
    climN[mo]++;
  }
  const climatology = [];
  for (let mo = 1; mo <= 12; mo++) {
    climatology.push({ month: mo, normal: climN[mo] ? Math.round((climSum[mo] / climN[mo]) * 10) / 10 : 0, years: climN[mo] });
  }

  // ---- rolling sum ของปริมาณฝนตาม scale ----
  // ใช้ค่า estimated (เดือนปัจจุบัน extrapolate) สำหรับ sample สุดท้าย fit
  // ยกเว้นค่าเฉลี่ยภูมิอากาศ
  const rollingByScale = {};
  for (const k of SCALES) {
    const arr = [];
    let sum = 0;
    const q = [];
    for (let i = 0; i < monthlyEst.length; i++) {
      q.push(monthlyEst[i].mm);
      sum += monthlyEst[i].mm;
      if (q.length > k) sum -= q.shift();
      arr.push({ ym: monthlyEst[i].ym, sum: q.length === k ? Math.round(sum * 10) / 10 : null });
    }
    rollingByScale[k] = arr;
  }

  // ---- fit gamma ของปริมาณฝนรายเดือน x scale (ไม่รวมเดือนปัจจุบัน partial) ----
  const fits = {};
  for (const k of SCALES) {
    fits[k] = {};
    const buckets = Array.from({ length: 13 }, () => []);
    const arr = rollingByScale[k];
    const lastIdx = monthly.length - 1;
    for (let i = 0; i < arr.length; i++) {
      if (i === lastIdx && lastPartial) continue; // ไม่ fit ด้วยเดือนที่ยังไม่จบ
      if (arr[i].sum === null) continue;
      const mo = Number(arr[i].ym.slice(5, 7));
      buckets[mo].push(arr[i].sum);
    }
    for (let mo = 1; mo <= 12; mo++) fits[k][mo] = fitGamma(buckets[mo]);
  }

  // ---- SPI series รายเดือน (ย้อนหลังสูงสุด 120 เดือน) ----
  const spiByScale = {};
  for (const k of SCALES) {
    spiByScale[k] = rollingByScale[k].map((r) => ({
      ym: r.ym,
      spi: r.sum === null ? null : spiFromValue(r.sum, fits[k][Number(r.ym.slice(5, 7))]),
    }));
  }
  const n = spiByScale[1].length;
  const show = Math.min(120, n);
  const spiSeries = [];
  for (let i = n - show; i < n; i++) {
    spiSeries.push({
      ym: spiByScale[1][i].ym,
      spi1: spiByScale[1][i].spi,
      spi3: spiByScale[3][i].spi,
      spi6: spiByScale[6][i].spi,
      spi12: spiByScale[12][i].spi,
    });
  }

  const cur = spiSeries[spiSeries.length - 1];
  const lvl = levelOf(cur.spi3 !== null ? cur.spi3 : 0);

  // ---- จำนวนวันแล้งต่อเนื่อง (ฝน < 1 มม.) ----
  let cdd = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].mm < 1) cdd++;
    else break;
  }
  let lastRainDay = null;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].mm >= 1) { lastRainDay = daily[i].day; break; }
  }

  // ---- ปริมาณฝนเดือนถึงวันนี้ (MTD) ----
  const mo = Number(last.ym.slice(5, 7));
  const normalMonth = climatology[mo - 1].normal;
  const dim = daysInMonth(ly, lm);
  const normalMtd = Math.round(normalMonth * (lastPartial ? dayOfMonth / dim : 1) * 10) / 10;
  const pct = normalMtd > 0 ? Math.round((last.mm / normalMtd) * 100) : null;

  // ---- ปริมาณฝนรายเดือน 24 เดือนล่าสุด เทียบค่าปกติ ----
  const monthlyOut = monthly.slice(-24).map((m) => ({
    ym: m.ym,
    mm: Math.round(m.mm * 10) / 10,
    normal: climatology[Number(m.ym.slice(5, 7)) - 1].normal,
    partial: m.ym === last.ym && lastPartial,
  }));

  return {
    current: {
      spi1: cur.spi1,
      spi3: cur.spi3,
      spi6: cur.spi6,
      spi12: cur.spi12,
      level: lvl.level,
      levelLabel: lvl.label,
      levelDesc: lvl.desc,
      color: lvl.color,
      cdd,
      lastRainDay,
      monthMtd: Math.round(last.mm * 10) / 10,
      monthNormalMtd: normalMtd,
      monthPct: pct,
      monthPctLabel: pct === null ? 'ยังไม่ประเมิน' : (pct >= 80 ? 'ฝนมากกว่าค่าปกติ' : pct >= 50 ? 'ฝนใกล้เคียงค่าปกติ' : 'ฝนต่ำกว่าค่าปกติ'),
      partial: lastPartial,
      asOfDay,
      ym: last.ym,
    },
    spiSeries,
    monthly: monthlyOut,
    climatology,
    meta: {
      firstYm: monthly[0].ym,
      months: monthly.length,
      years: Math.floor(monthly.length / 12),
      source: 'Open-Meteo (ERA5 reanalysis)',
      method: 'SPI (WMO) — gamma fit ตามฤดูกาลรายเดือน, สเกล 1/3/6/12 เดือน',
      computedAt: new Date().toISOString(),
    },
  };
}

// cache: อ้างอิง identity ของแถว readHourly (เปลี่ยนเมื่อมีข้อมูลใหม่เข้า) + TTL 10 นาที
let cache = { rowsRef: null, at: 0, data: null };

function get() {
  const rows = openmeteo.readHourly();
  const now = Date.now();
  if (cache.data && cache.rowsRef === rows && now - cache.at < 10 * 60000) return cache.data;
  const data = compute();
  cache = { rowsRef: rows, at: now, data };
  return data;
}

function metrics() {
  const d = get();
  if (!d) return null;
  const c = d.current;
  return {
    droughtSpi1: c.spi1,
    droughtSpi3: c.spi3,
    droughtSpi6: c.spi6,
    droughtSpi12: c.spi12,
    droughtLevel: c.level,
    droughtCdd: c.cdd,
    droughtPct: c.monthPct,
  };
}

module.exports = { get, metrics, LEVELS };


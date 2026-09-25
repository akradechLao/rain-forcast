'use strict';
// ดึงข้อมูลฝนย้อนหลังจาก Open-Meteo archive (ERA5 reanalysis) เติมลง data/hourly-<ปี>.json
// รันครั้งเดียวหลัง deploy:  node scripts/backfill.js [จำนวนปี=5]
// แถว forecast ปัจจุบันไม่ถูกแตะ — ให้ job refresh ปกติดูแลเอง

const store = require('../lib/store');
const openmeteo = require('../lib/sources/openmeteo');

const YEARS = Math.max(1, Math.min(10, Number(process.argv[2]) || 5));
const CHUNK_DAYS = 180;
const SLEEP_MS = 1200;

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchChunk(days, anchor) {
  try {
    return await openmeteo.fetchArchive(days, anchor);
  } catch (e) {
    console.error(`  ล้มเหลว (${e.message}) — รอ 5 วินาทีแล้วลองใหม่...`);
    await sleep(5000);
    return await openmeteo.fetchArchive(days, anchor);
  }
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - Math.round(YEARS * 365.25 * 86400000);
  console.log(`Backfill ${YEARS} ปี: ${fmtDate(new Date(startMs))} -> ${fmtDate(new Date(endMs))}`);

  const rows = openmeteo.readHourly();
  const byTime = new Map(rows.map((r) => [r.t, r]));
  console.log(`ข้อมูลเดิม: ${byTime.size} แถว`);

  let cursor = startMs;
  let fetched = 0;
  let added = 0;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_DAYS * 86400000, endMs);
    const days = Math.ceil((chunkEnd - cursor) / 86400000);
    const map = await fetchChunk(days, chunkEnd);
    fetched += map.size;
    for (const [t, mm] of map) {
      const prev = byTime.get(t);
      if (!prev) {
        byTime.set(t, { t, mm, src: 'archive', updatedAt: new Date().toISOString() });
        added++;
      } else if (prev.src === 'archive' && prev.mm !== mm) {
        prev.mm = mm;
        prev.updatedAt = new Date().toISOString();
        added++;
      }
    }
    console.log(`  ${fmtDate(new Date(cursor))} -> ${fmtDate(new Date(chunkEnd - 86400000))}: ได้ ${map.size} แถว (เพิ่ม/อัปเดตสะสม ${added})`);
    cursor = chunkEnd;
    await sleep(SLEEP_MS);
  }

  const cutoff = fmtDate(new Date(Date.now() - 10 * 365 * 86400000)) + 'T00:00';
  const kept = [...byTime.values()].filter((r) => r.t >= cutoff).sort((a, b) => (a.t < b.t ? -1 : 1));
  const byYear = new Map();
  for (const r of kept) {
    const y = r.t.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  for (const [y, list] of [...byYear.entries()].sort()) {
    store.writeJson(`hourly-${y}.json`, list);
    console.log(`เขียน hourly-${y}.json: ${list.length} แถว`);
  }
  openmeteo.invalidateHourlyCache();
  console.log(`เสร็จสิ้น: ดึงจาก archive ${fetched} แถว, เพิ่ม/อัปเดต ${added} แถว, เก็บรวม ${kept.length} แถว (${byYear.size} ไฟล์ปี)`);
}

main().catch((e) => {
  console.error('ล้มเหลว:', e);
  process.exit(1);
});

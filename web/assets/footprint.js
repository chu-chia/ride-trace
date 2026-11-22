// 全年足跡：深藍底圖上用黃色畫出騎過的每一條路（可切換日期範圍與一天中的時段）。
// 「迷霧模式」是選配：地圖蓋一層霧，去過的格子把霧擦掉。
import { api, $, $$, initPanel, setLabel } from '/assets/common.js';
import { swr } from '/assets/swr.js';
import { createMap, addCompass, labelLayerId, styleMenu } from '/assets/mapbase.js';
import { initRecords } from '/assets/fp-records.js';

const TAIWAN = [[119.3, 21.85], [122.1, 25.35]];
const BUCKETS = ['dawn', 'day', 'dusk', 'night'];
const BUCKET_NAME = { dawn: '清晨', day: '白天', dusk: '傍晚', night: '夜間' };
const WEEK = '日一二三四五六';
const TABS = new Set(['footprint', 'towns', 'heat', 'stats']);
let tab = new URLSearchParams(location.search).get('tab') || 'footprint';
if (!TABS.has(tab)) tab = 'footprint';
let rangeMode = 'all';

const M = createMap($('#map'), { style: 'navy', styles: ['navy', 'dark', 'sat', 'light'], center: [120.95, 23.7], zoom: 7, interactive3d: false });
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
const map = M.map;
const records = initRecords(map, M, () => tab, sidePad);
const uid = (await api('/api/me')).uid;
map.keyboard.disableRotation();
window.qijiMap = map; // 方便用 CDP 驗證鏡頭狀態（其他地圖頁也有）

const F = {
  summary: null, cellDeg: 0.0015, all: null, sel: null, selFlat: null,
  from: null, to: null, buckets: new Set(BUCKETS), lines: null, allLines: null, req: 0, playing: false, anchor: null,
};

/* ---------- 日期工具 ---------- */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const keyOf = (s) => s.replaceAll('-', '');
const slash = (s) => s.replaceAll('-', '/');
const tsDay = (ms) => iso(new Date(ms + (new Date(ms).getTimezoneOffset() + 480) * 60000)); // 台灣時間

/* ---------- 投影（地圖不旋轉、不傾斜，直接用 Web Mercator 計算，十幾萬格也很快） ---------- */
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
function toMerc(flat) {
  const n = flat.length / 2, out = new Float64Array(n * 2), c = F.cellDeg;
  for (let i = 0; i < n; i++) { out[2 * i] = mx((flat[2 * i + 1] + 0.5) * c); out[2 * i + 1] = my((flat[2 * i] + 0.5) * c); }
  return out;
}

/* ---------- 迷霧繪製 ---------- */
const cv = $('#fog');
const ctx = cv.getContext('2d');
function fogColor(z) {
  // 深色底圖配灰藍色的霧，去過的地方才露出底下深色、清楚的地圖
  const a = z < 9 ? 0.72 : 0.8;
  return M.style === 'light' ? `rgba(226,230,236,${a})` : `rgba(12,20,52,${a})`;
}
function draw() {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  if (tab !== 'footprint' || !$('#optFog').checked) { cv.style.filter = 'none'; return; }
  const z = map.getZoom();
  ctx.fillStyle = fogColor(z);
  ctx.fillRect(0, 0, w, h);
  const c = map.getCenter(), cp = map.project(c), ws = 512 * 2 ** z;
  const cx = mx(c.lng), cy = my(c.lat);
  const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / ws;
  const r = (F.cellDeg * 111320 * 0.8) / mpp;
  cv.style.filter = r > 4 ? `blur(${Math.min(6, r / 4).toFixed(1)}px)` : 'none';
  ctx.globalCompositeOperation = 'destination-out';
  const holes = (arr, alpha) => {
    if (!arr) return;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    if (r < 2) {
      const s = Math.max(1.5, r * 2), gw = Math.ceil(w / s) + 1, seen = new Uint8Array(gw * (Math.ceil(h / s) + 1));
      for (let i = 0; i < arr.length; i += 2) {
        const x = (arr[i] - cx) * ws + cp.x, y = (arr[i + 1] - cy) * ws + cp.y;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const k = ((y / s) | 0) * gw + ((x / s) | 0);
        if (seen[k]) continue;
        seen[k] = 1;
        ctx.rect(x - s / 2, y - s / 2, s, s);
      }
    } else {
      for (let i = 0; i < arr.length; i += 2) {
        const x = (arr[i] - cx) * ws + cp.x, y = (arr[i + 1] - cy) * ws + cp.y;
        if (x < -r || y < -r || x > w + r || y > h + r) continue;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  };
  if ($('#optAll').checked && F.all && F.sel !== F.all) holes(F.all, 0.45);
  holes(F.sel, 1);
}
map.on('render', draw);
addEventListener('resize', draw);

/* ---------- 軌跡線圖層 ---------- */
// 黃色在深藍與衛星底圖上都最醒目；淺色底圖改用琥珀色
const LINE_COLOR = { navy: '#ffe14d', dark: '#ffe14d', sat: '#ffe14d', light: '#c2410c' };
const EMPTY = { type: 'FeatureCollection', features: [] };
const isAll = () => F.summary && F.from === F.summary.first && F.to === F.summary.last && F.buckets.size === 4;
function syncLayers() {
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const lines = tab === 'footprint' && $('#optLines').checked;
  vis('fp-lines', lines); vis('fp-glow', lines);
  // 只看一段時間時，其他時間去過的路淡淡留著當參考（迷霧模式下改由迷霧呈現）
  vis('fp-all', lines && $('#optAll').checked && !$('#optFog').checked && !isAll());
}
// 地名、路名在黃色軌跡上要讀得到：文字層一律加粗的深色外框（淺色底圖用白框）
function boostLabels(map, style) {
  const light = style === 'light';
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol' || !l.layout?.['text-field']) continue;
    try {
      map.setPaintProperty(l.id, 'text-halo-color', light ? 'rgba(255,255,255,.95)' : 'rgba(8,12,24,.92)');
      map.setPaintProperty(l.id, 'text-halo-width', 2.2);
      map.setPaintProperty(l.id, 'text-halo-blur', 0.4);
      if (style === 'dark') map.setPaintProperty(l.id, 'text-color', '#dfe3ec');  // 深色底圖的字是灰的，壓在黃線上看不到；深藍底圖保留原本分層的顏色
    } catch { /* 有些圖層沒有文字 */ }
  }
}
M.onStyle((style) => {
  boostLabels(map, style);
  if (!map.getSource('fp-lines')) map.addSource('fp-lines', { type: 'geojson', data: F.lines || EMPTY });
  if (!map.getSource('fp-all')) map.addSource('fp-all', { type: 'geojson', data: F.allLines || EMPTY });
  const c = LINE_COLOR[style] || '#ffe14d';
  // 全島看要粗一點才看得到；拉近到街道時要細，路名、地標才讀得到
  const width = (k) => ['interpolate', ['linear'], ['zoom'], 6, 1.5 * k, 10, 2 * k, 13, 2.6 * k, 16, 4 * k];
  const layout = { 'line-join': 'round', 'line-cap': 'round' };
  // 軌跡畫在地名、路名底下，字才不會被黃線蓋住
  // 找「所有道路、橋、建築之後」的第一個文字層（Liberty 的單行道箭頭在橋之前，不能用它）
  const below = labelLayerId(map);
  if (!map.getLayer('fp-all')) map.addLayer({ id: 'fp-all', type: 'line', source: 'fp-all', layout, paint: { 'line-color': style === 'light' ? '#6e6e73' : '#c9d1f5', 'line-opacity': 0.28, 'line-width': width(0.7) } }, below);
  if (!map.getLayer('fp-glow')) map.addLayer({ id: 'fp-glow', type: 'line', source: 'fp-lines', layout, paint: { 'line-color': c, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.22, 13, 0.1], 'line-width': width(2.6), 'line-blur': ['interpolate', ['linear'], ['zoom'], 6, 2, 14, 4] } }, below);
  if (!map.getLayer('fp-lines')) map.addLayer({ id: 'fp-lines', type: 'line', source: 'fp-lines', layout, paint: { 'line-color': c, 'line-opacity': 0.92, 'line-width': width(1) } }, below);
  syncLayers();
  setLabel($('#bStyle'), M.styleName);
  draw();
});
styleMenu(M, $('#bStyle'));

/* ---------- 讀資料 ---------- */
let timer = null;
function schedule(fit) { clearTimeout(timer); timer = setTimeout(() => load(fit), 180); }
let refreshing = 0;
function refreshStart() { refreshing++; $('#refreshing').hidden = false; }
function refreshEnd() { refreshing = Math.max(0, refreshing - 1); $('#refreshing').hidden = refreshing === 0; }
const allUrl = () => `/api/footprint/lines?from=${F.summary.first}&to=${F.summary.last}&buckets=${BUCKETS.join(',')}`;

function applyLines(lines, id, fit = false) {
  if (id !== F.req) return;
  F.lines = lines || EMPTY;
  map.getSource('fp-lines')?.setData(F.lines);
  if (isAll()) { F.allLines = lines; map.getSource('fp-all')?.setData(lines); }
  syncLayers();
  if (fit) fitSelection();
}

function applyCells(cells, id, fit = false) {
  if (id !== F.req) return;
  F.cellDeg = cells.cell_deg || F.cellDeg;
  F.selFlat = cells.cells;
  F.sel = toMerc(cells.cells);
  $('#stArea').textContent = cells.area_km2.toLocaleString();
  $('#stCells').textContent = cells.count.toLocaleString();
  $('#stKm').textContent = Math.round(cells.km).toLocaleString();
  $('#stDays').textContent = cells.days;
  if (fit) fitSelection();
  draw();
}

async function load(fit = false) {
  const id = ++F.req;
  const q = `from=${F.from}&to=${F.to}&buckets=${[...F.buckets].join(',')}`;
  $('#loading').hidden = false;
  renderRange();
  try {
    const wantLines = $('#optLines').checked;
    const full = isAll();
    const cellsTask = api('/api/footprint/cells?' + q).then((cells) => applyCells(cells, id, fit));
    const linesTask = wantLines ? (full
      ? (refreshStart(), swr(allUrl(), { key: uid, onData: (lines, meta) => {
        if (!meta.unchanged) applyLines(lines, id);
      } }).finally(refreshEnd))
      : api('/api/footprint/lines?' + q).then((lines) => applyLines(lines, id))) : Promise.resolve();
    await Promise.all([cellsTask, linesTask]);
    if (id !== F.req) return;
    if (!F.allLines && !isAll() && $('#optAll').checked) loadAllLines();
    syncLayers();
    draw();
  } catch (e) {
    if (id === F.req) $('#rangeSub').textContent = '讀取失敗：' + e.message;
  } finally {
    if (id === F.req) $('#loading').hidden = true;
  }
}

// 全部時間的路線（當淡色參考用），只抓一次
let allReq = null;
function loadAllLines() {
  if (allReq || !F.summary) return;
  refreshStart();
  allReq = swr(allUrl(), { key: uid, onData: (l, meta) => {
    if (meta.unchanged) return;
    F.allLines = l; map.getSource('fp-all')?.setData(l); syncLayers();
  } })
    .catch(() => { allReq = null; });
  allReq.finally(refreshEnd);
}

function sidePad() {
  return innerWidth <= 760 ? { top: 70, left: 30, right: 64, bottom: $('#side').offsetHeight + 20 } : { top: 40, bottom: 40, right: 90, left: $('#side').offsetWidth + 60 };
}
function fitSelection() {
  const f = F.selFlat;
  if (!f || !f.length) return;
  const lats = [], lons = [];
  for (let i = 0; i < f.length; i += 2) { lats.push((f[i] + 0.5) * F.cellDeg); lons.push((f[i + 1] + 0.5) * F.cellDeg); }
  lats.sort((a, b) => a - b); lons.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
  const lo = lats.length > 50 ? 0.02 : 0, hi = 1 - lo;
  map.fitBounds([[q(lons, lo), q(lats, lo)], [q(lons, hi), q(lats, hi)]], { padding: sidePad(), maxZoom: 13, duration: 900 });
}

/* ---------- 範圍與畫面 ---------- */
function setRange(from, to, fit = true) {
  const first = F.summary.first, last = F.summary.last;
  if (from > to) [from, to] = [to, from];
  F.from = from < first ? first : from;
  F.to = to > last ? last : to;
  $('#from').value = F.from;
  $('#to').value = F.to;
  syncChips();
  renderCalendar();
  if (F.from === first && F.to === last && fit) { map.fitBounds(TAIWAN, { padding: sidePad(), duration: 900 }); schedule(false); }
  else schedule(fit);
}

function syncChips() {
  $$('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.p === rangeMode));
  $('#customRange').hidden = rangeMode !== 'custom';
  $$('#months button').forEach((b) => {
    const [y, m] = b.dataset.m.split('-').map(Number);
    const a = iso(new Date(y, m - 1, 1)), z = iso(new Date(y, m, 0));
    b.classList.toggle('on', F.from.slice(0, 7) === b.dataset.m && F.to.slice(0, 7) === b.dataset.m && F.from <= a && F.to >= z);
  });
  $$('#buckets button').forEach((b) => b.classList.toggle('on', F.buckets.has(b.dataset.b)));
}

function renderRange() {
  const d = parse(F.from);
  $('#rangeTitle').textContent = F.from === F.to ? `${slash(F.from)}（星期${WEEK[d.getDay()]}）`
    : F.from === F.summary.first && F.to === F.summary.last ? '全部紀錄' : `${slash(F.from)} – ${slash(F.to)}`;
  $('#rangeSub').textContent = F.buckets.size === 4 ? '全天' : '只看 ' + [...F.buckets].map((b) => BUCKET_NAME[b]).join('、');
}

// 每天一根長條，整段可橫滑；更新選取時保留捲動位置。
function renderCalendar() {
  if (!F.summary) return;
  const host = $('#cal'), oldLeft = host.scrollLeft, first = F.summary.first, last = F.summary.last;
  const days = []; for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  const step = 8, top = 27, baseline = 112, max = Math.max(1, ...Object.values(F.summary.days));
  let out = `<line x1="0" y1="${baseline}" x2="${days.length * step}" y2="${baseline}" stroke="var(--line)"/>`;
  days.forEach((day, i) => {
    const km = F.summary.days[keyOf(day)] || 0, strength = Math.min(1, Math.log1p(km) / Math.log1p(max));
    const height = km ? Math.max(3, strength * 76) : 2, selected = day >= F.from && day <= F.to;
    const color = km ? `hsl(${18 + strength * 30} 95% ${43 + strength * 18}%)` : 'var(--muted)';
    if (day.endsWith('-01') || i === 0) out += `<text x="${i * step}" y="13" fill="var(--muted)" font-size="12">${day.slice(0, 7).replace('-', '/')}</text>`;
    out += `<rect tabindex="0" role="button" aria-label="${day} ${km.toFixed(1)} 公里" data-d="${day}" data-km="${km.toFixed(1)}" x="${i * step + 1}" y="${baseline - height}" width="5" height="${height}" rx="2" fill="${color}" opacity="${selected ? 1 : .28}" ${selected ? 'stroke="var(--fg)" stroke-width=".4"' : ''}/>`;
  });
  host.innerHTML = `<svg width="${days.length * step}" height="125" viewBox="0 0 ${days.length * step} 125" aria-label="每日里程長條圖">${out}</svg>`;
  host.scrollLeft = oldLeft;
  if (!host.dataset.ready) { host.scrollLeft = host.scrollWidth; host.dataset.ready = '1'; }
}

/* ---------- 互動 ---------- */
$('#cal').onclick = (e) => {
  const d = e.target.closest('rect')?.dataset.d;
  if (!d) return;
  rangeMode = 'custom';
  if (e.shiftKey && F.anchor) setRange(F.anchor, d);
  else { F.anchor = d; setRange(d, d); }
};
$('#presets').onclick = (e) => {
  const p = e.target.closest('button')?.dataset.p;
  if (!p) return;
  if (!F.summary) return;
  rangeMode = p;
  if (p === 'custom') { syncChips(); return; }
  const { first, last } = F.summary;
  setRange(p === 'all' ? first : addDays(last, 1 - +p), last);
};
$('#months').onclick = (e) => {
  const m = e.target.closest('button')?.dataset.m;
  if (!m) return;
  rangeMode = 'custom';
  const [y, mo] = m.split('-').map(Number);
  setRange(iso(new Date(y, mo - 1, 1)), iso(new Date(y, mo, 0)));
};
$('#from').onchange = () => { rangeMode = 'custom'; setRange($('#from').value, F.to); };
$('#to').onchange = () => { rangeMode = 'custom'; setRange(F.from, $('#to').value); };
$('#buckets').onclick = (e) => {
  const b = e.target.closest('button')?.dataset.b;
  if (!b) return;
  if (F.buckets.has(b) && F.buckets.size === 1) return;
  F.buckets.has(b) ? F.buckets.delete(b) : F.buckets.add(b);
  syncChips();
  schedule(false);
};
$('#optLines').onchange = () => { syncLayers(); if ($('#optLines').checked) schedule(false); };
$('#optAll').onchange = () => { syncLayers(); draw(); if (!F.allLines) loadAllLines(); };
$('#optFog').onchange = () => { syncLayers(); draw(); };

$('#play').onclick = async () => {
  if (F.playing) { F.playing = false; return; }
  F.playing = true;
  $('#play').textContent = '■ 停止播放';
  const { first } = F.summary;
  const months = $$('#months button').map((b) => b.dataset.m);
  map.fitBounds(TAIWAN, { padding: sidePad(), duration: 800 });
  for (const m of months) {
    if (!F.playing) break;
    const [y, mo] = m.split('-').map(Number);
    F.from = first; F.to = iso(new Date(y, mo, 0)) > F.summary.last ? F.summary.last : iso(new Date(y, mo, 0));
    $('#from').value = F.from; $('#to').value = F.to;
    renderCalendar();
    await load(false);
    $('#rangeTitle').textContent = `累積到 ${y}/${mo}`;
    await new Promise((ok) => setTimeout(ok, 1100));
  }
  F.playing = false;
  rangeMode = 'custom';
  $('#play').textContent = '▶ 逐月播放';
  syncChips();
  schedule(false);
};

/* ---------- 開始 ---------- */
map.once('load', () => map.fitBounds(TAIWAN, { padding: sidePad(), duration: 0 }));
let allCellsStarted = false;
function loadAllCells() {
  if (allCellsStarted) return;
  allCellsStarted = true;
  refreshStart();
  swr('/api/footprint/cells/all', { key: uid, onData: (all, meta) => {
    if (meta.unchanged) return;
    F.cellDeg = all.cell_deg;
    F.all = toMerc(all.cells);
    if (isAll()) {
      F.sel = F.all;
      F.selFlat = all.cells;
      $('#stCells').textContent = all.count.toLocaleString();
      draw();
    }
  } }).catch((e) => { $('#rangeSub').textContent = '讀取失敗：' + e.message; }).finally(refreshEnd);
}

function applySummary(s, meta) {
  if (meta.unchanged) return;
  if (!s.points) {
    $('#overall').textContent = '還沒有足跡。騎完第一趟，走過的路就會亮起來。';
    return;
  }
  const previous = F.summary;
  const wasAll = previous && F.from === previous.first && F.to === previous.last && F.buckets.size === 4;
  F.cellDeg = s.cell_deg;
  F.summary = { ...s, first: tsDay(s.first_ts), last: tsDay(s.last_ts) };
  const totalKm = Object.values(s.days).reduce((a, b) => a + b, 0);
  $('#overall').textContent = `${slash(F.summary.first)} – ${slash(F.summary.last)} · ${s.points.toLocaleString()} 個點 · 約 ${Math.round(totalKm).toLocaleString()} km`;
  const months = [];
  for (let d = parse(F.summary.first.slice(0, 8) + '01'); iso(d) <= F.summary.last; d.setMonth(d.getMonth() + 1)) months.push(iso(d).slice(0, 7));
  $('#months').innerHTML = months.map((m) => `<button data-m="${m}">${m.replace('-', '/')}</button>`).join('');
  if (!previous) {
    F.from = F.summary.first; F.to = F.summary.last;
    $('#from').value = F.from; $('#to').value = F.to;
    renderRange(); syncChips(); renderCalendar();
    loadAllCells();
    load(false);
  } else {
    if (wasAll) {
      F.from = F.summary.first; F.to = F.summary.last;
      $('#from').value = F.from; $('#to').value = F.to;
      if (previous.first !== F.summary.first || previous.last !== F.summary.last) F.allLines = null;
      if (!meta.stale) load(false);
    }
    renderRange(); syncChips(); renderCalendar();
  }
}
refreshStart();
swr('/api/footprint/summary', { key: uid, onData: applySummary })
  .catch((e) => { $('#overall').textContent = '讀取失敗：' + e.message; })
  .finally(refreshEnd);

// 側欄收合與手機抽屜：和其他地圖頁同一套（common.js initPanel）
const PANEL = initPanel($('#side'), 'footprint', { onChange: () => map.resize() });
// 網址分頁與手機抽屜。
function setTab(next, writeUrl = true) {
  if (!TABS.has(next)) return;
  tab = next;
  if (writeUrl) { const u = new URL(location.href); if (next === 'footprint') u.searchParams.delete('tab'); else u.searchParams.set('tab', next); history.replaceState(null, '', u); }  // 換分頁不疊歷史紀錄：返回（含 iOS 左滑）直接離開足跡頁，不會一格一格退回上一個分頁
  $$('#tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.t === tab); b.setAttribute('aria-selected', b.dataset.t === tab); });
  $$('.panel-body').forEach((b) => { b.hidden = b.dataset.b !== tab; });
  records.applyTab(); syncLayers(); draw();
  PANEL.set(false, false);
  map.resize();
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button[data-t]'); if (b) setTab(b.dataset.t); };
addEventListener('popstate', () => setTab(new URLSearchParams(location.search).get('tab') || 'footprint', false));
setTab(tab, false);
const tip = $('#dayTip');
$('#cal').addEventListener('pointermove', (e) => { const r = e.target.closest('rect[data-d]'); if (!r || e.pointerType === 'touch') { tip.hidden = true; return; } tip.textContent = `${r.dataset.d} · ${r.dataset.km} km`; tip.style.left = `${Math.min(innerWidth - 140, e.clientX + 10)}px`; tip.style.top = `${e.clientY - 35}px`; tip.hidden = false; });
$('#cal').addEventListener('pointerleave', () => { tip.hidden = true; });
$('#cal').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { const r = e.target.closest('rect[data-d]'); if (r) { e.preventDefault(); r.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey })); } } });

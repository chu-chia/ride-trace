// 全年足跡：深藍底圖上用黃色畫出騎過的每一條路（可切換日期範圍與一天中的時段）。
// 「迷霧模式」是選配：地圖蓋一層霧，去過的格子把霧擦掉。
import { api, $, $$ } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const TAIWAN = [[119.3, 21.85], [122.1, 25.35]];
const BUCKETS = ['dawn', 'day', 'dusk', 'night'];
const BUCKET_NAME = { dawn: '清晨', day: '白天', dusk: '傍晚', night: '夜間' };
const WEEK = '日一二三四五六';

const M = createMap($('#map'), { style: 'navy', styles: ['navy', 'sat', 'light'], center: [120.95, 23.7], zoom: 7, interactive3d: false });
const map = M.map;
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
  if (!$('#optFog').checked) { cv.style.filter = 'none'; return; }
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
const LINE_COLOR = { navy: '#ffe14d', sat: '#ffe14d', light: '#c2410c' };
const EMPTY = { type: 'FeatureCollection', features: [] };
const isAll = () => F.summary && F.from === F.summary.first && F.to === F.summary.last && F.buckets.size === 4;
function syncLayers() {
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const lines = $('#optLines').checked;
  vis('fp-lines', lines); vis('fp-glow', lines);
  // 只看一段時間時，其他時間去過的路淡淡留著當參考（迷霧模式下改由迷霧呈現）
  vis('fp-all', lines && $('#optAll').checked && !$('#optFog').checked && !isAll());
}
M.onStyle((style) => {
  if (!map.getSource('fp-lines')) map.addSource('fp-lines', { type: 'geojson', data: F.lines || EMPTY });
  if (!map.getSource('fp-all')) map.addSource('fp-all', { type: 'geojson', data: F.allLines || EMPTY });
  const c = LINE_COLOR[style] || '#ffe14d';
  // 全島看要粗一點才看得到；拉近到街道時要細，路名、地標才讀得到
  const width = (k) => ['interpolate', ['linear'], ['zoom'], 6, 1.5 * k, 10, 2 * k, 13, 2.6 * k, 16, 4 * k];
  const layout = { 'line-join': 'round', 'line-cap': 'round' };
  // 軌跡畫在地名、路名底下，字才不會被黃線蓋住
  // 找「所有道路、橋、建築之後」的第一個文字層（Liberty 的單行道箭頭在橋之前，不能用它）
  const ls = map.getStyle().layers;
  const lastShape = ls.findLastIndex((l) => l.type !== 'symbol' && !l.id.startsWith('fp-') && l.id !== 'hillshade');
  const below = ls.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;
  if (!map.getLayer('fp-all')) map.addLayer({ id: 'fp-all', type: 'line', source: 'fp-all', layout, paint: { 'line-color': style === 'light' ? '#6e6e73' : '#c9d1f5', 'line-opacity': 0.28, 'line-width': width(0.7) } }, below);
  if (!map.getLayer('fp-glow')) map.addLayer({ id: 'fp-glow', type: 'line', source: 'fp-lines', layout, paint: { 'line-color': c, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.22, 13, 0.1], 'line-width': width(2.6), 'line-blur': ['interpolate', ['linear'], ['zoom'], 6, 2, 14, 4] } }, below);
  if (!map.getLayer('fp-lines')) map.addLayer({ id: 'fp-lines', type: 'line', source: 'fp-lines', layout, paint: { 'line-color': c, 'line-opacity': 0.92, 'line-width': width(1) } }, below);
  syncLayers();
  $('#bStyle').textContent = M.styleName;
  draw();
});
$('#bStyle').onclick = () => { $('#bStyle').textContent = M.nextStyle(); };

/* ---------- 讀資料 ---------- */
let timer = null;
function schedule(fit) { clearTimeout(timer); timer = setTimeout(() => load(fit), 180); }

async function load(fit = false) {
  const id = ++F.req;
  const q = `from=${F.from}&to=${F.to}&buckets=${[...F.buckets].join(',')}`;
  $('#loading').hidden = false;
  renderRange();
  try {
    const wantLines = $('#optLines').checked;
    const [cells, lines] = await Promise.all([
      api('/api/footprint/cells?' + q),
      wantLines ? api('/api/footprint/lines?' + q) : Promise.resolve(null),
    ]);
    if (id !== F.req) return;
    F.selFlat = cells.cells;
    F.sel = toMerc(cells.cells);
    $('#stArea').textContent = cells.area_km2.toLocaleString();
    $('#stCells').textContent = cells.count.toLocaleString();
    $('#stKm').textContent = Math.round(cells.km).toLocaleString();
    $('#stDays').textContent = cells.days;
    F.lines = lines || EMPTY;
    map.getSource('fp-lines')?.setData(F.lines);
    if (isAll() && lines && !F.allLines) { F.allLines = lines; map.getSource('fp-all')?.setData(lines); }
    if (!F.allLines && !isAll() && $('#optAll').checked) loadAllLines();
    syncLayers();
    if (fit) fitSelection();
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
  allReq = api(`/api/footprint/lines?from=${F.summary.first}&to=${F.summary.last}&buckets=${BUCKETS.join(',')}`)
    .then((l) => { F.allLines = l; map.getSource('fp-all')?.setData(l); syncLayers(); })
    .catch(() => { allReq = null; });
}

function sidePad() {
  return innerWidth <= 760 ? { top: 40, left: 30, right: 30, bottom: $('#side').offsetHeight + 20 } : { top: 40, bottom: 40, right: 60, left: 440 };
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
  const { first, last } = F.summary;
  const span = (parse(F.to) - parse(F.from)) / 86400000 + 1;
  $$('#presets button').forEach((b) => {
    const p = b.dataset.p;
    b.classList.toggle('on', p === 'all' ? F.from === first && F.to === last : F.to === last && span === +p);
  });
  $$('#months button').forEach((b) => {
    const [y, m] = b.dataset.m.split('-').map(Number);
    const a = iso(new Date(y, m - 1, 1)), z = iso(new Date(y, m, 0));
    b.classList.toggle('on', (F.from === a || F.from === first) && (F.to === z || F.to === last) && F.from.slice(0, 7) === b.dataset.m && F.to.slice(0, 7) === b.dataset.m);
  });
  $$('#buckets button').forEach((b) => b.classList.toggle('on', F.buckets.has(b.dataset.b)));
}

function renderRange() {
  const d = parse(F.from);
  $('#rangeTitle').textContent = F.from === F.to ? `${slash(F.from)}（星期${WEEK[d.getDay()]}）`
    : F.from === F.summary.first && F.to === F.summary.last ? '全部紀錄' : `${slash(F.from)} – ${slash(F.to)}`;
  $('#rangeSub').textContent = F.buckets.size === 4 ? '全天' : '只看 ' + [...F.buckets].map((b) => BUCKET_NAME[b]).join('、');
}

// 每個月一個小月曆，四欄排列；顏色深淺 = 那天騎了多遠
function renderCalendar() {
  const s = F.summary, cell = 10, gap = 2, colW = 7 * (cell + gap) + 6, head = 16, rowH = head + 6 * (cell + gap) + 10;
  const max = Math.max(1, ...Object.values(s.days));
  const months = [];
  for (let d = parse(s.first.slice(0, 8) + '01'); iso(d) <= s.last; d.setMonth(d.getMonth() + 1)) months.push(new Date(d));
  let out = '';
  months.forEach((m, i) => {
    const ox = (i % 4) * colW, oy = Math.floor(i / 4) * rowH;
    out += `<text x="${ox}" y="${oy + 11}" font-size="11" font-weight="600" fill="var(--muted)">${m.getFullYear() % 100}/${m.getMonth() + 1}</text>`;
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(), lead = m.getDay();
    for (let dd = 1; dd <= days; dd++) {
      const day = iso(new Date(m.getFullYear(), m.getMonth(), dd));
      const p = lead + dd - 1, x = ox + (p % 7) * (cell + gap), y = oy + head + Math.floor(p / 7) * (cell + gap);
      const outside = day < s.first || day > s.last;
      const km = s.days[keyOf(day)] || 0;
      const o = km ? 0.25 + 0.75 * Math.min(1, Math.log10(km + 1) / Math.log10(max + 1)) : 1;
      const inSel = !outside && day >= F.from && day <= F.to;
      out += `<rect ${outside ? '' : `data-d="${day}"`} x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${km ? 'var(--track)' : 'var(--surface-2)'}" fill-opacity="${outside ? 0.35 : o.toFixed(2)}" ${inSel ? 'stroke="var(--fg)" stroke-width="1.3"' : ''}><title>${slash(day)} · ${km ? km.toFixed(1) + ' km' : '沒有紀錄'}</title></rect>`;
    }
  });
  const wpx = 4 * colW, hpx = Math.ceil(months.length / 4) * rowH;
  $('#cal').innerHTML = `<svg width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}" role="img" aria-label="每日里程月曆">${out}</svg>`;
}

/* ---------- 互動 ---------- */
$('#cal').onclick = (e) => {
  const d = e.target.closest('rect')?.dataset.d;
  if (!d) return;
  if (e.shiftKey && F.anchor) setRange(F.anchor, d);
  else { F.anchor = d; setRange(d, d); }
};
$('#presets').onclick = (e) => {
  const p = e.target.closest('button')?.dataset.p;
  if (!p) return;
  const { first, last } = F.summary;
  setRange(p === 'all' ? first : addDays(last, 1 - +p), last);
};
$('#months').onclick = (e) => {
  const m = e.target.closest('button')?.dataset.m;
  if (!m) return;
  const [y, mo] = m.split('-').map(Number);
  setRange(iso(new Date(y, mo - 1, 1)), iso(new Date(y, mo, 0)));
};
$('#from').onchange = () => setRange($('#from').value, F.to);
$('#to').onchange = () => setRange(F.from, $('#to').value);
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
  $('#play').textContent = '停止播放';
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
  $('#play').textContent = '逐月播放：看足跡一個月一個月長出來';
  syncChips();
  schedule(false);
};

/* ---------- 開始 ---------- */
map.once('load', () => map.fitBounds(TAIWAN, { padding: sidePad(), duration: 0 }));
const s = await api('/api/footprint/summary');
if (!s.points) {
  $('#overall').textContent = '還沒有足跡資料。用 tools/import_gpx 匯入 GPX，或開始一趟行程。';
} else {
  F.cellDeg = s.cell_deg;
  F.summary = { ...s, first: tsDay(s.first_ts), last: tsDay(s.last_ts) };
  const totalKm = Object.values(s.days).reduce((a, b) => a + b, 0);
  $('#overall').textContent = `${slash(F.summary.first)} – ${slash(F.summary.last)} · ${s.points.toLocaleString()} 個點 · 約 ${Math.round(totalKm).toLocaleString()} km`;
  const months = [];
  for (let d = parse(F.summary.first.slice(0, 8) + '01'); iso(d) <= F.summary.last; d.setMonth(d.getMonth() + 1)) months.push(iso(d).slice(0, 7));
  $('#months').innerHTML = months.map((m) => `<button data-m="${m}">${m.replace('-', '/')}</button>`).join('');
  const all = await api('/api/footprint/cells/all');
  F.all = toMerc(all.cells);
  setRange(F.summary.first, F.summary.last, false);
}

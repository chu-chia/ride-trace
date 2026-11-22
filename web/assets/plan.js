// 規劃路線頁：版面照改版原型（ride-trace-redesign/plan.html，Google 地圖式），資料和 API 用正式版：
// 地點搜尋 /api/poi/suggest／search、預覽 /api/routes/preview（1～3 個方案）、沿途 /api/poi/along、
// Google Maps 匯入 /api/routes/parse-gmaps、套用 PUT /api/trips/{id}/route（停靠站可以順便加成休息點）。
import { api, $, esc, setLabel, press, sheetDrag, armConfirm } from '/assets/common.js';
import { createMap, addCompass, styleMenu } from '/assets/mapbase.js';

const tid = new URLSearchParams(location.search).get('trip');
if (!tid) location.href = '/';
$('#back').href = `/trip?id=${tid}`;

const M = createMap($('#map'), { style: 'dark', center: [121.0, 23.8], zoom: 7, terrain: false, interactive3d: false });
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
const map = M.map;
window.qijiMap = map;
const LANDQ = matchMedia('(orientation:landscape) and (max-height:520px)');

/* ───── 狀態 ─────
   pts：起點、停靠站、目的地；via: true＝拖路線產生的經過點（不加成休息點）；lat 是 NaN＝還沒選 */
const EMPTY = () => ({ name: '', lat: NaN, lon: NaN });
const S = { pts: [EMPTY(), EMPTY()], routes: [], sel: 0, trip: null, vehicle: 'scooter', sourceUrl: '', seq: 0, along: null, alongItems: [], saved: false, me: null };
window.qijiPlan = S; // 除錯用
const ok = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon);
const route = () => S.routes[S.sel] || null;

/* ───── 工具 ───── */
const toRad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => { const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2; return 6371000 * 2 * Math.asin(Math.sqrt(s)); };
const fmtKm = (km) => (km >= 10 ? `${Math.round(km)} 公里` : `${(+km).toFixed(1)} 公里`);
// 時間寫成「1 小時 07 分」（1:07 容易看成 1 點 07 分，UX-27）
const fmtMin = (min) => { min = Math.round(min); return min >= 60 ? `${Math.floor(min / 60)} 小時 ${String(min % 60).padStart(2, '0')} 分` : `${Math.max(1, min)} 分`; };
const fmtDist = (km) => (km >= 1 ? `${km.toFixed(1)} 公里` : `${Math.round((km * 1000) / 10) * 10} 公尺`);
const minOf = (r) => r.summary.min_personal || r.summary.min;
let toastT;
function ptoast(text, undo) {
  let el = document.querySelector('.ptoast');
  if (!el) { el = document.createElement('div'); el.className = 'ptoast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text;
  if (undo) { const b = document.createElement('button'); b.type = 'button'; b.textContent = '復原'; b.onclick = () => { undo(); el.classList.add('hidden'); }; el.append(b); }
  el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), undo ? 8000 : 2600);
}
const VERB = { 1: '出發', 2: '出發', 3: '出發', 4: '抵達', 5: '抵達', 6: '抵達', 8: '直行', 9: '靠右', 10: '右轉', 11: '急右轉', 12: '迴轉', 13: '迴轉', 14: '急左轉', 15: '左轉', 16: '靠左', 17: '靠右', 18: '靠左', 19: '靠右', 20: '靠左', 24: '靠左', 23: '靠右', 26: '進入圓環', 27: '離開圓環' };
const A = (d, mirror) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"${mirror ? ' style="transform:scaleX(-1)"' : ''}>${d}</svg>`;
const PR = '<path d="M7 21v-7a5 5 0 0 1 5-5h7M15 5l4 4-4 4"/>', PS = '<path d="M9 21v-6.5c0-1.6.6-3 1.8-4.1L18 4M12 4h6v6"/>';
function iconFor(t) {
  if (t === 10 || t === 11) return A(PR); if (t === 15 || t === 14) return A(PR, true);
  if ([9, 17, 19, 23].includes(t)) return A(PS); if ([16, 18, 20, 24].includes(t)) return A(PS, true);
  if (t === 12 || t === 13) return A('<path d="M8 21V9a4 4 0 0 1 8 0v6M12 11l4 4 4-4"/>');
  if (t >= 4 && t <= 6) return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
  return A('<path d="M12 21V4M6.5 9.5 12 4l5.5 5.5"/>');
}
const PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z" fill="#ea4335" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>';
const fc = (features) => ({ type: 'FeatureCollection', features });
const line = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

/* ───── 地圖圖層（照原型：灰色其他方案、藍色選中的；各有一條看不見的粗線好點） ───── */
let ready = false;
M.onStyle(() => {
  if (!map.getSource('alts')) map.addSource('alts', { type: 'geojson', data: fc([]) });
  if (!map.getSource('sel')) map.addSource('sel', { type: 'geojson', data: fc([]) });
  const w = (a, b) => ['interpolate', ['exponential', 1.5], ['zoom'], 9, a, 16, b];
  const lay = { 'line-join': 'round', 'line-cap': 'round' };
  if (!map.getLayer('alt-casing')) map.addLayer({ id: 'alt-casing', type: 'line', source: 'alts', layout: lay, paint: { 'line-color': '#1b1d22', 'line-width': w(7, 16) } });
  if (!map.getLayer('alt-line')) map.addLayer({ id: 'alt-line', type: 'line', source: 'alts', layout: lay, paint: { 'line-color': '#7a8190', 'line-width': w(4.5, 11) } });
  if (!map.getLayer('alt-hit')) map.addLayer({ id: 'alt-hit', type: 'line', source: 'alts', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 } });
  if (!map.getLayer('sel-casing')) map.addLayer({ id: 'sel-casing', type: 'line', source: 'sel', layout: lay, paint: { 'line-color': '#1d4fb8', 'line-width': w(8, 18) } });
  if (!map.getLayer('sel-line')) map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', layout: lay, paint: { 'line-color': '#4c8dff', 'line-width': w(5, 12) } });
  if (!map.getLayer('sel-hit')) map.addLayer({ id: 'sel-hit', type: 'line', source: 'sel', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 20 } });
  ready = true; draw(false);
  setLabel($('#bStyle'), M.styleName);
});
map.on('click', 'alt-hit', (e) => { const i = e.features?.[0]?.properties?.i; if (i != null && !S.lineDrag) select(+i); });
styleMenu(M, $('#bStyle'));
$('#b3d').onclick = () => { M.set3d(!M.is3d); press($('#b3d'), M.is3d); };

/* ───── 起終點列表 ───── */
function stopNo(i) { let n = 0; for (let k = 1; k <= i; k++) if (!S.pts[k].via) n++; return n; }
function iconHTML(i) {
  const p = S.pts[i];
  if (i === 0) return '<div class="dot-start"></div>';
  if (i === S.pts.length - 1) return `<div class="dot-dest">${PIN}</div>`;
  return p.via ? '<div class="dot-via"></div>' : `<div class="dot-num">${stopNo(i)}</div>`;
}
const label = (i) => { const p = S.pts[i]; return p.via ? `經過：${p.name || '地圖上的點'}` : p.name || (ok(p) ? '地圖上的點' : ''); };
function renderRows() {
  const n = S.pts.length;
  $('#rows').innerHTML = S.pts.map((p, i) => `
    <div class="row" data-i="${i}">
      <div class="ic">${iconHTML(i)}</div>
      <button type="button" class="fld ${ok(p) ? '' : 'ph'}" data-f="${i}">${ok(p) ? esc(label(i)) : i === 0 ? '選擇起點' : i === n - 1 ? '選擇目的地' : '選擇停靠站'}</button>
      ${n > 2 ? `<span class="h" data-h="${i}" aria-label="拖曳排序"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg></span>
      <button type="button" class="x" data-x="${i}" aria-label="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : ''}
    </div>`).join('');
  $('#swap').classList.toggle('hidden', n !== 2); document.querySelector('.dir').classList.toggle('two', n === 2);
  $('#addStop').classList.toggle('hidden', n >= 25);  // 後端最多 25 個點
  layout();
}
$('#rows').addEventListener('click', (e) => {
  const f = e.target.closest('[data-f]'), x = e.target.closest('[data-x]');
  if (x) { const i = +x.dataset.x; const old = S.pts.splice(i, 1)[0]; changed(); ptoast(`已移除「${old.name || '經過點'}」`, () => { S.pts.splice(i, 0, old); changed(); }); }
  else if (f) openSearch(+f.dataset.f);
});
// 拖曳排序（按住 ≡）
{
  let drag = null;
  $('#rows').addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-h]'); if (!h) return;
    const row = h.closest('.row'), rows = [...$('#rows').children];
    drag = { i: +h.dataset.h, y0: e.clientY, row, rows, hgt: row.offsetHeight, to: +h.dataset.h };
    row.classList.add('drag'); h.setPointerCapture(e.pointerId); e.preventDefault();
  });
  $('#rows').addEventListener('pointermove', (e) => {
    if (!drag) return; const dy = e.clientY - drag.y0;
    drag.row.style.transform = `translateY(${dy}px)`;
    drag.to = Math.max(0, Math.min(drag.rows.length - 1, drag.i + Math.round(dy / drag.hgt)));
    drag.rows.forEach((r, k) => { if (r === drag.row) return; let s = 0; if (drag.i < drag.to && k > drag.i && k <= drag.to) s = -1; if (drag.i > drag.to && k < drag.i && k >= drag.to) s = 1; r.style.transform = s ? `translateY(${s * drag.hgt}px)` : ''; });
  });
  const end = () => {
    if (!drag) return; const { i, to } = drag; drag = null;
    if (i !== to) { const p = S.pts.splice(i, 1)[0]; S.pts.splice(to, 0, p); changed(); } else renderRows();
  };
  $('#rows').addEventListener('pointerup', end); $('#rows').addEventListener('pointercancel', end);
}
$('#swap').onclick = () => { S.pts.reverse(); changed(); };
$('#addStop').onclick = () => openSearch(S.pts.length - 1, true);

/* ───── 搜尋畫面：打字自動完成（FT.SUGGET），Enter 全文搜尋（FT.SEARCH） ───── */
let sTarget = 0, sInsert = false, sTimer = 0, sSeq = 0, sItems = [];
// 距離的基準（UX-25）：有起點用起點、定位過用定位，都沒有才用畫面中心
function basis() {
  const p0 = S.pts.find(ok);
  if (p0) return { lon: p0.lon, lat: p0.lat, label: '離起點' };
  if (S.me) return { ...S.me, label: '離你' };
  const c = map.getCenter();
  return { lon: c.lng, lat: c.lat, label: '離畫面中心' };
}
const near = (b) => `&lon=${b.lon.toFixed(5)}&lat=${b.lat.toFixed(5)}`;
function openSearch(i, insert = false) {
  sTarget = i; sInsert = insert; $('#search').classList.remove('hidden');
  $('#sInput').value = ''; $('#sInput').placeholder = insert ? '新增停靠站' : i === 0 ? '選擇起點' : i === S.pts.length - 1 ? '選擇目的地' : '選擇停靠站';
  sItems = []; renderSearch(); setTimeout(() => $('#sInput').focus(), 50);
}
function renderSearch(full) {
  const q = $('#sInput').value.trim(), b = basis(), rows = [];
  if (!q) rows.push(`<button type="button" class="pli" data-here><span class="bx" style="background:var(--pblue)"><svg viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="12" r="5"/></svg></span><span class="m"><b>你的位置</b><span>用 GPS 目前位置</span></span></button>`,
    `<button type="button" class="pli" data-mappick><span class="bx"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/></svg></span><span class="m"><b>在地圖上選擇</b><span>關掉這頁後，長按地圖</span></span></button>`);
  rows.push(...sItems.map((x, k) => `<button type="button" class="pli" data-k="${k}"><span class="bx"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg></span>
    <span class="m"><b>${esc(x.name)}</b><span>${esc([x.kind_name, x.area].filter(Boolean).join('・'))}</span></span>${x.dist_km != null ? `<span class="d">${b.label}<br>${x.dist_km} km</span>` : ''}</button>`));
  // 改既有的點：也可以只改名稱、位置不動（使用者回報 11-19：改了名稱以為路線會換，所以寫清楚）
  const cur = !sInsert && S.pts[sTarget];
  if (q && cur && ok(cur) && q !== cur.name) rows.push(`<button type="button" class="pli" data-rename><span class="bx">名</span><span class="m"><b>只改名稱為「${esc(q)}」</b><span>位置不變，路線不會改</span></span></button>`);
  if (q && !sItems.length) rows.push(`<div class="pnote">${full ? `找不到「${esc(q)}」<br>試試只打地名或店名，例如「金山」「淡水老街」` : '還沒有建議，按 Enter 搜尋全部'}</div>`);
  $('#sList').innerHTML = rows.join('');
}
async function runSearch(full) {
  const q = $('#sInput').value.trim();
  if (!q) { sItems = []; renderSearch(); return; }
  const seq = ++sSeq, b = basis();
  try {
    // 打字時的自動完成只吃一個詞；有空白就直接走全文搜尋（會拆詞，UX-26）；自動完成沒結果也改全文搜尋
    let items = await api(`/api/poi/${full || /\s/.test(q) ? 'search' : 'suggest'}?q=${encodeURIComponent(q)}${near(b)}`);
    if (!items.length && !full && seq === sSeq) { items = await api(`/api/poi/search?q=${encodeURIComponent(q)}${near(b)}`); full = true; }
    if (seq !== sSeq) return;
    sItems = items; renderSearch(full);
  } catch { /* 略過 */ }
}
$('#sInput').addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(() => runSearch(false), 180); });
$('#sInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sTimer); runSearch(true); } else if (e.key === 'Escape') closeSearch(); });
const closeSearch = () => $('#search').classList.add('hidden');
$('#sBack').onclick = closeSearch;
function setPoint(p) {
  if (sInsert) S.pts.splice(S.pts.length - 1, 0, p); else S.pts[sTarget] = p;
  closeSearch(); changed();
  if (S.pts.filter(ok).length === 1) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 11), padding: pad(), duration: 700 });
}
$('#sList').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-mappick')) { closeSearch(); ptoast('長按地圖上的位置來選點'); return; }
  if (b.hasAttribute('data-rename')) { S.pts[sTarget] = { ...S.pts[sTarget], name: $('#sInput').value.trim().slice(0, 30) }; closeSearch(); renderRows(); drawMarkers(); return; }
  if (b.hasAttribute('data-here')) {
    if (!navigator.geolocation) { ptoast('這個瀏覽器不能定位'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { S.me = { lon: pos.coords.longitude, lat: pos.coords.latitude }; setPoint({ name: '我的位置', lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6) }); },
      () => ptoast('取得位置失敗（要允許定位）'), { enableHighAccuracy: true, timeout: 10000 });
    return;
  }
  const x = sItems[+b.dataset.k];
  if (x) setPoint({ name: (x.name || '').slice(0, 30), lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6) });
});

/* ───── 地圖上的點（可拖曳） ───── */
let wpMarkers = [];
function drawMarkers() {
  wpMarkers.forEach((m) => m?.remove());
  wpMarkers = S.pts.map((p, i) => {
    if (!ok(p)) return null;
    const el = document.createElement('div'); el.className = 'wp'; el.innerHTML = iconHTML(i);
    const last = i === S.pts.length - 1;
    if (last) el.querySelector('svg').style.cssText = 'width:36px;height:36px';
    const m = new maplibregl.Marker({ element: el, draggable: true, anchor: last ? 'bottom' : 'center' }).setLngLat([p.lon, p.lat]).addTo(map);
    m.on('dragend', () => { const g = m.getLngLat(); S.pts[i] = { ...S.pts[i], lat: +g.lat.toFixed(6), lon: +g.lng.toFixed(6), name: S.pts[i].via ? '' : '地圖上的點' }; changed(); });
    el.addEventListener('click', (e) => e.stopPropagation());
    return m;
  });
}

/* ───── 長按地圖選點（電腦：右鍵） ───── */
let pickLL = null, lpT = null, lpXY = null, pickMk = null;
function showPick(ll) {
  pickLL = ll; $('#pickSub').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  $('#pick').classList.remove('hidden'); layout();
  if (!pickMk) { const el = document.createElement('div'); el.innerHTML = PIN; el.querySelector('svg').style.cssText = 'width:34px;height:34px;opacity:.85'; pickMk = new maplibregl.Marker({ element: el, anchor: 'bottom' }); }
  pickMk.setLngLat(ll).addTo(map);
}
function hidePick() { $('#pick').classList.add('hidden'); pickMk?.remove(); }
map.on('contextmenu', (e) => showPick(e.lngLat));
map.on('touchstart', (e) => { if (e.points.length !== 1 || S.lineDrag) return; lpXY = e.point; const ll = e.lngLat; lpT = setTimeout(() => { navigator.vibrate?.(20); showPick(ll); }, 550); });
map.on('touchmove', (e) => { if (lpT && lpXY && Math.hypot(e.point.x - lpXY.x, e.point.y - lpXY.y) > 10) { clearTimeout(lpT); lpT = null; } });
map.on('touchend', () => { clearTimeout(lpT); lpT = null; });
map.on('movestart', () => { clearTimeout(lpT); lpT = null; });
map.on('click', (e) => { if (!ready || !map.queryRenderedFeatures(e.point, { layers: ['alt-hit'] }).length) hidePick(); });
const pickPt = () => ({ name: '地圖上的點', lat: +pickLL.lat.toFixed(6), lon: +pickLL.lng.toFixed(6) });
$('#pStart').onclick = () => { S.pts[0] = pickPt(); hidePick(); changed(); };
$('#pDest').onclick = () => { S.pts[S.pts.length - 1] = pickPt(); hidePick(); changed(); };
$('#pStop').onclick = () => { S.pts.splice(bestInsert(pickLL), 0, pickPt()); hidePick(); changed(); };
// 新的停靠站插在哪一段最順：選「繞最少路」的那段（還沒選的點跳過）
function bestInsert(ll) {
  let best = S.pts.length - 1, cost = Infinity; const q = [ll.lng, ll.lat];
  for (let i = 0; i < S.pts.length - 1; i++) {
    const a = S.pts[i], b = S.pts[i + 1];
    if (!ok(a) || !ok(b)) continue;
    const c = hav([a.lon, a.lat], q) + hav(q, [b.lon, b.lat]) - hav([a.lon, a.lat], [b.lon, b.lat]);
    if (c < cost) { cost = c; best = i + 1; }
  }
  return best;
}

/* ───── 拖藍色路線加經過點（照原型）：放開的位置插在那一段的兩個點之間 ───── */
{
  let ghost = null, last = null, legAt = 0;
  const start = (e) => {
    const r = route(); if (!r) return;
    e.preventDefault(); S.lineDrag = true; clearTimeout(lpT); lpT = null; hidePick();
    legAt = legOf(r, [e.lngLat.lng, e.lngLat.lat]);
    const el = document.createElement('div'); el.className = 'ghost';
    ghost = new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(map); last = e.lngLat;
    map.getCanvas().style.cursor = 'grabbing';
  };
  const move = (e) => { if (!ghost) return; last = e.lngLat; ghost.setLngLat(last); };
  const end = () => {
    if (!ghost) return; ghost.remove(); ghost = null; map.getCanvas().style.cursor = '';
    setTimeout(() => { S.lineDrag = false; }, 50);
    S.pts.splice(legAt + 1, 0, { name: '', lat: +last.lat.toFixed(6), lon: +last.lng.toFixed(6), via: true }); changed();
  };
  map.on('mousedown', 'sel-hit', start); map.on('touchstart', 'sel-hit', (e) => { if (e.points.length === 1) start(e); });
  map.on('mousemove', move); map.on('touchmove', move);
  map.on('mouseup', end); map.on('touchend', end);
  map.on('mouseenter', 'sel-hit', () => { if (!ghost) map.getCanvas().style.cursor = 'grab'; });
  map.on('mouseleave', 'sel-hit', () => { if (!ghost) map.getCanvas().style.cursor = ''; });
}
// 手指在路線第幾段：每個點投影到路線上的位置排好，看拖的位置落在哪兩個點之間
function legOf(r, q) {
  const nearest = (pt) => { let bi = 0, bd = Infinity; for (let i = 0; i < r.coords.length; i++) { const d = hav(r.coords[i], pt); if (d < bd) { bd = d; bi = i; } } return bi; };
  const at = nearest(q), idx = S.pts.map((p) => nearest([p.lon, p.lat]));
  let leg = 0; for (let k = 0; k < idx.length - 1; k++) if (at >= idx[k]) leg = k;
  return leg;
}

/* ───── 交通工具 ───── */
function setVehicle(v) { S.vehicle = v; document.querySelectorAll('#veh [data-v]').forEach((b) => { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-pressed', String(b.dataset.v === v)); }); }
$('#veh').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b && b.dataset.v !== S.vehicle) { setVehicle(b.dataset.v); preview(); } });
setVehicle('scooter');

/* ───── 預覽（點有變動就自動重算） ───── */
const cleanPts = () => S.pts.filter(ok).map(({ lat, lon, name }) => ({ lat, lon, name: name || '' }));
let rT = 0;
function changed() { renderRows(); drawMarkers(); clearTimeout(rT); rT = setTimeout(preview, 300); }
async function preview() {
  const seq = ++S.seq, pts = cleanPts();
  if (pts.length < 2 || S.pts.some((p) => !ok(p))) { S.routes = []; draw(false); return; }
  $('#sheet').classList.add('loading'); $('#sVia').textContent = '計算路線中…';
  try {
    const res = await api('/api/routes/preview', { method: 'POST', body: { points: pts, vehicle: S.vehicle } });
    if (seq !== S.seq) return; // 已經有更新的請求
    S.routes = res.routes; S.sel = 0; clearAlong();
    $('#sheet').classList.remove('loading'); draw(true);
  } catch (err) {
    if (seq !== S.seq) return;
    S.routes = []; $('#sheet').classList.remove('loading'); draw(false);
    $('#sVia').textContent = `這幾個點之間找不到路（${err.message}）。試著把點拖到道路上。`;
  }
}

/* ───── 畫路線、方案泡泡、抽屜內容 ───── */
let bubbles = [];
const fastest = () => S.routes.reduce((b, r, i, a) => (minOf(r) < minOf(a[b]) ? i : b), 0);
const shortest = () => S.routes.reduce((b, r, i, a) => (r.summary.km < a[b].summary.km ? i : b), 0);
function draw(fitIt) {
  const R = S.routes;
  if (ready) {
    map.getSource('alts')?.setData(fc(R.map((r, i) => (i === S.sel ? null : line(r.coords, { i }))).filter(Boolean)));
    map.getSource('sel')?.setData(fc(R[S.sel] ? [line(R[S.sel].coords)] : []));
  }
  bubbles.forEach((b) => b.remove());
  bubbles = R.length > 1 ? R.map((r, i) => {
    const el = document.createElement('div'); el.className = `bub ${i === S.sel ? 'sel' : ''}`;
    el.innerHTML = `${fmtMin(minOf(r))}${i === fastest() ? '<small>最快</small>' : ''}`;
    el.onclick = (e) => { e.stopPropagation(); select(i); };
    return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(bubbleAt(i)).addTo(map);
  }) : [];
  renderSheet();
  if (fitIt) fit();
}
// 泡泡放在這條路線「離其他路線最遠」的地方，才不會疊在一起
function bubbleAt(i) {
  const r = S.routes[i].coords, others = S.routes.filter((_, k) => k !== i).map((x) => x.coords);
  let best = r[Math.floor(r.length / 2)], bd = -1;
  const step = Math.max(1, Math.floor(r.length / 60));
  for (let k = step * 3; k < r.length - step * 3; k += step) {
    let dmin = Infinity;
    for (const o of others) { const st = Math.max(1, Math.floor(o.length / 120)); for (let j = 0; j < o.length; j += st) dmin = Math.min(dmin, hav(r[k], o[j])); }
    if (dmin > bd) { bd = dmin; best = r[k]; }
  }
  return best;
}
function select(i) { S.sel = i; clearAlong(); draw(false); }
function tagOf(i) {
  const t = [];
  if (S.routes.length > 1 && i === fastest()) t.push('最快');
  if (S.routes.length > 1 && i === shortest()) t.push('最短');
  if (S.routes[i]?.summary.min_personal) t.push('依你的速度');
  return t.join('・');
}
const VEH_TXT = { scooter: '・不走國道、快速道路', heavy: '・不走國道（3甲例外）', car: '' };
function renderSheet() {
  const r = route(), owner = !!S.trip?.is_owner && S.trip?.status !== 'ended';
  $('#goNav').disabled = !r;
  $('#apply').disabled = !r || !owner;
  if ($('#apply').dataset.armed !== '1') $('#apply').textContent = !S.trip || owner ? (S.trip?.status === 'live' ? '改用這條路線' : '套用到行程') : S.trip.status === 'ended' ? '行程已結束' : '只有建立者能套用';
  $('#clr').classList.toggle('hidden', !owner || !S.saved);
  $('#asRestWrap').classList.toggle('hidden', !owner);
  if (!r) {
    $('#sTm').textContent = '—'; $('#sKm').textContent = ''; $('#sTag').textContent = ''; $('#sWarn').innerHTML = '';
    if (!$('#sheet').classList.contains('loading')) $('#sVia').textContent = S.pts.filter(ok).length < 2 ? '選擇目的地開始規劃' : $('#sVia').textContent;
    $('#alts').innerHTML = ''; $('#steps').innerHTML = ''; $('#stepN').textContent = ''; $('#altNote').textContent = '';
    return;
  }
  $('#sTm').textContent = fmtMin(minOf(r)); $('#sKm').textContent = `(${fmtKm(r.summary.km)})`;
  $('#sTag').textContent = tagOf(S.sel);
  const stops = S.pts.filter((p, i) => i > 0 && i < S.pts.length - 1 && !p.via).length;
  $('#sVia').textContent = `經 ${r.via || '—'}${stops ? `・${stops} 個停靠站` : ''}${VEH_TXT[S.vehicle]}`;
  const w = r.warnings || [];
  $('#sWarn').innerHTML = (w.length ? `<div class="pwarn">注意：這條路線用到${{ scooter: '機車', heavy: '重機' }[S.vehicle] || ''}不能走的路段：${w.map(esc).join('、')}。可能是沒有其他路可以到，請加停靠站改道。</div>` : '')
    + (r.uses_3a ? '<div class="pnote" style="margin-bottom:10px">這條路線有走國道3甲（重機可以行駛）。</div>' : '');
  $('#alts').innerHTML = S.routes.map((x, i) => `<button type="button" class="alt ${i === S.sel ? 'sel' : ''}" data-a="${i}" aria-pressed="${i === S.sel}">
      <span class="l"><span class="a">${fmtMin(minOf(x))}</span><span class="b">經 ${esc(x.via || '—')}${x.summary.min_personal ? `・一般估計 ${fmtMin(x.summary.min)}` : ''}</span></span>
      <span class="r">${fmtKm(x.summary.km)}<br><span style="color:var(--eta);font-weight:700;font-size:12px">${tagOf(i)}</span></span></button>`).join('');
  $('#altNote').textContent = S.pts.length > 2 ? '' : `${S.routes.length} 條`;
  if (S.pts.length > 2) $('#alts').insertAdjacentHTML('beforeend', '<div class="pnote">有停靠站或經過點時只會算一條路線；想比較方案，先把停靠站移掉。</div>');
  $('#stepN').textContent = `${r.maneuvers.length} 步`;
  $('#steps').innerHTML = r.maneuvers.map((m, k) => `<button type="button" class="pli" data-s="${m.i}"><span class="bx">${iconFor(m.type)}</span>
      <span class="m"><b>${esc(m.act)}${m.street ? ` ${esc(m.street)}` : ''}</b><span>${m.km.toFixed(1)} 公里處${k < r.maneuvers.length - 1 && m.len_km ? `・接著 ${fmtDist(m.len_km)}` : ''}</span></span></button>`).join('');
  layout();
}
$('#alts').addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) select(+b.dataset.a); });
$('#steps').addEventListener('click', (e) => {
  const b = e.target.closest('[data-s]'); if (!b) return; const p = route().coords[+b.dataset.s];
  setSheet(false); map.easeTo({ center: p, zoom: 16.5, duration: 800, padding: pad() });
});

/* ───── 沿途（每 2 km 取一點，後端 Pipeline 一次 GEOSEARCH） ───── */
let alongMk = [];
function clearAlong() {
  S.along = null; alongMk.forEach((m) => m.remove()); alongMk = [];
  $('#alongList').innerHTML = '';
  document.querySelectorAll('#along [data-k]').forEach((b) => { b.classList.remove('on'); const n = b.querySelector('.cnt'); if (n) n.remove(); });
}
const COLOR = { fuel: '#e8710a', convenience: '#188038', rest: '#188038', food: '#c5221f', sight: '#a142f4', toilet: '#5f6368', moto: '#5f6368', lodging: '#1a73e8', charging: '#0b8043', roadevent: '#d93025', weather: '#1a73e8' };
$('#along').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-k]'); if (!c) return;
  const kind = c.dataset.k, was = S.along === kind;
  clearAlong();
  const r = route();
  if (was || !r) return;
  S.along = kind; c.classList.add('on');
  $('#alongList').innerHTML = '<div class="pnote">正在找沿線的地點…</div>';
  const samples = [], step = Math.max(2, r.summary.km / 380);
  let next = 0;
  r.coords.forEach((p, i) => { if (r.cum_km[i] >= next) { samples.push([p[0], p[1], r.cum_km[i]]); next += step; } });
  const wx = kind === 'weather', ev = kind === 'roadevent' || wx;  // 路況、天氣只能看、不能加入路線
  try {
    const kmh = r.summary.min ? r.summary.km / (r.summary.min / 60) : 40;
    const items = await api('/api/poi/along', { method: 'POST', body: { kind, samples, radius_m: kind === 'roadevent' ? 500 : 800, kmh: Math.min(150, Math.max(5, kmh)) } });
    if (S.along !== kind) return;
    S.alongItems = items;
    c.insertAdjacentHTML('beforeend', ` <span class="cnt">${items.length}</span>`);
    const col = COLOR[kind] || '#5f6368', ch = c.querySelector('svg')?.outerHTML || '';
    $('#alongList').innerHTML = items.length ? items.map((x, k) => `<div class="pli" data-al="${k}"><span class="bx" style="background:${col}">${ch}</span>
        <span class="m"><b>${esc(x.name)}</b><span>${x.route_km} 公里處${x.area ? `・${esc(x.area)}` : ''}${x.off_m > 150 ? `・離路線 ${x.off_m} m` : ''}</span></span>
        ${ev ? `<span class="evt">${esc(x.type || '')}</span>` : `<button type="button" class="addb" data-add="${k}">加入</button>`}</div>`).join('')
      : `<div class="pnote">${wx ? '查不到沿途的天氣預報' : ev ? '沿線沒有路況事件（交通部 TDX 省道施工、事故、管制，離路線 500 m 內）' : '路線 800 m 內沒有找到'}</div>`;
    alongMk = items.map((x, k) => {
      const el = document.createElement('div'); el.className = 'poi';
      el.innerHTML = wx ? `<b style="background:${col}">雨</b>${esc(x.name.slice(3, 10))} ${x.pop}%` : `<b style="background:${col}">${ch}</b>${esc(x.name.slice(0, 10))}`;
      if (!ev) { el.title = '點一下加入路線'; el.onclick = (e2) => { e2.stopPropagation(); addStop(S.alongItems[k]); }; }
      return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.lon, x.lat]).addTo(map);
    });
  } catch (err) {
    if (S.along === kind) $('#alongList').innerHTML = `<div class="pnote">查不到：${esc(err.message)}</div>`;
  }
});
function addStop(x) {
  const ll = { lat: +x.lat, lng: +x.lon };
  S.pts.splice(bestInsert(ll), 0, { name: (x.name || '').slice(0, 30), lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6) });
  ptoast(`已加入停靠站「${x.name}」`); changed();
}
$('#alongList').addEventListener('click', (e) => {
  const a = e.target.closest('[data-add]'), g = e.target.closest('[data-al]');
  if (a) { addStop(S.alongItems[+a.dataset.add]); return; }
  if (g) { const x = S.alongItems[+g.dataset.al]; setSheet(false); map.easeTo({ center: [x.lon, x.lat], zoom: 15.5, duration: 800, padding: pad() }); }
});

/* ───── 鏡頭 ───── */
function pad() {
  if (LANDQ.matches) return { top: 30, bottom: 30, left: $('#sheet').getBoundingClientRect().right + 30, right: 70 }; // 橫向：左欄讓出來
  const top = $('#top').getBoundingClientRect().bottom + 16;
  // 抽屜收起來時露出的高度（不管現在開到哪），才不會因為抽屜還沒收好就把地圖拉很遠
  const peek = +$('#sheet').dataset.minH || 200;
  return { top: Math.min(top, innerHeight * 0.45), bottom: Math.min(peek + 16, innerHeight * 0.45), left: 30, right: 70 };
}
function fit() { requestAnimationFrame(() => setTimeout(fitNow, 60)); }
function fitNow() {
  const r = route(); if (!r) return;
  const b = new maplibregl.LngLatBounds();
  S.routes.forEach((x) => x.coords.forEach((p, k) => { if (k % 5 === 0 || x === r) b.extend(p); }));
  map.fitBounds(b, { padding: pad(), duration: 700, maxZoom: 16 });
}
LANDQ.addEventListener('change', () => fit()); // 手機轉向：重新框住整條路線

/* ───── 抽屜（共用 sheetDrag：照原型的手感） ───── */
const sheet = $('#sheet');
const setSheet = (open) => { sheet.classList.toggle('small', !open); };
sheetDrag(sheet, { isOpen: () => !sheet.classList.contains('small'), setOpen: setSheet, scroll: '.sheet-body', peek: '.handle, .peek', mq: matchMedia('all') });
sheet.querySelector('.handle').onclick = () => setSheet(sheet.classList.contains('small'));
new MutationObserver(() => { document.body.classList.toggle('sheet-open', !sheet.classList.contains('small')); setTimeout(layout, 300); }).observe(sheet, { attributes: true, attributeFilter: ['class'] });
function layout() {
  const above = innerHeight - sheet.getBoundingClientRect().top;
  $('#pick').style.bottom = `${LANDQ.matches ? 12 : above + 10}px`;
  document.documentElement.style.setProperty('--top-h', `${$('#top').getBoundingClientRect().bottom}px`);
}
addEventListener('resize', layout);
if ('ResizeObserver' in window) new ResizeObserver(layout).observe($('#top'));

/* ───── 按鈕 ───── */
// 預覽導航：把這條路線交給導航頁（同一個分頁的 sessionStorage），導航頁沿路線模擬騎一遍
$('#goNav').onclick = () => {
  const r = route(); if (!r) return;
  try { sessionStorage.setItem(`qiji:navPreview:${tid}`, JSON.stringify({ coords: r.coords, cum_km: r.cum_km, maneuvers: r.maneuvers, summary: r.summary, points: cleanPts(), vehicle: S.vehicle })); } catch { /* 存不了就算了 */ }
  location.href = `/nav?id=${tid}&preview=1`;
};
// 騎乘中套用＝全隊改走這條路：先要再按一次確認。後端會幫已經不在新路線上的人（例如過了分岔口）各自算接回的路，
// 原本的路線留在回放
$('#apply').onclick = () => {
  if (S.trip?.status === 'live') armConfirm($('#apply'), '再按一次：全隊改走這條', applyRoute);
  else applyRoute();
};
async function applyRoute() {
  $('#apply').disabled = true;
  try {
    const r = await api(`/api/trips/${tid}/route`, { method: 'PUT', body: { points: cleanPts(), vehicle: S.vehicle, source_url: S.sourceUrl, alt: S.sel } });
    if ($('#asRest').checked) {
      // 停靠站（不含拖路線產生的經過點）加成休息點
      const stops = S.pts.slice(1, -1).filter((p) => ok(p) && !p.via);
      for (const [i, p] of stops.entries()) {
        await api(`/api/trips/${tid}/waypoints`, { method: 'POST', body: { name: p.name || `停靠站 ${i + 1}`, lat: p.lat, lon: p.lon, kind: 'rest' } }).catch(() => {});
      }
    }
    ptoast(S.trip?.status === 'live' ? `已改路線：${r.summary.km} km，不在新路線上的人會自動規劃接回` : `已套用到這趟行程：${r.summary.km} km，隊友馬上看到新路線`);
    setTimeout(() => (location.href = `/trip?id=${tid}`), 1100);
  } catch (err) { ptoast(err.message); $('#apply').disabled = false; }
}
$('#imp').onclick = () => { $('#gForm').classList.toggle('hidden'); if (!$('#gForm').classList.contains('hidden')) $('#gUrl').focus(); };
$('#gForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#gUrl').value.trim(); if (!url) return;
  try {
    const r = await api('/api/routes/parse-gmaps', { method: 'POST', body: { url } });
    S.pts = r.points.map((p) => ({ name: p.name || '', lat: +p.lat, lon: +p.lon })); S.sourceUrl = url;
    ptoast(`匯入 ${r.points.length} 個點`); $('#gForm').classList.add('hidden'); changed();
  } catch (err) { ptoast(err.message); }
});
// 清除行程上的路線：要按兩次（會影響全隊）
$('#clr').onclick = async () => {
  const b = $('#clr');
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.lastChild.textContent = '再按一次清除'; setTimeout(() => { delete b.dataset.confirm; b.lastChild.textContent = '清除路線'; }, 4000); return; }
  try { await api(`/api/trips/${tid}/route`, { method: 'DELETE' }); S.saved = false; S.pts = [EMPTY(), EMPTY()]; S.routes = []; changed(); ptoast('已清除行程的路線'); }
  catch (err) { ptoast(err.message); }
};

/* ───── 載入 ───── */
renderRows(); layout();
(async () => {
  try {
    S.trip = await api(`/api/trips/${tid}`);
    document.title = `規劃路線 · ${S.trip.name} · 騎跡`;
    const saved = await api(`/api/trips/${tid}/route`);
    if (saved?.points) {
      S.saved = true;
      S.pts = saved.points.map((p) => ({ name: p.name || '', lat: +p.lat, lon: +p.lon })); S.sourceUrl = saved.source_url || '';
      setVehicle(saved.vehicle || (saved.avoid_highways === false ? 'heavy' : 'scooter'));
      renderRows(); drawMarkers(); preview();
    } else { renderSheet(); openSearchHint(); }
  } catch (err) { ptoast(err.message); }
})();
// 還沒有路線：提示從目的地開始（照原型）
function openSearchHint() { $('#sVia').textContent = '選擇目的地開始規劃（點上方欄位搜尋，或長按地圖選點）'; }

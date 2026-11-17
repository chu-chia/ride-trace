// 規劃路線頁：在網頁裡搜尋地點、加停靠點（自動插在繞路最少的位置）、選交通工具、比較 1～3 條路線、
// 沿路線找加油站等，最後套用到行程。Google Maps 匯入只是選用。
import { api, $, esc, toast } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const tid = new URLSearchParams(location.search).get('trip');
if (!tid) location.href = '/';
$('#back').href = `/trip?id=${tid}`;

const M = createMap($('#map'), { style: 'dark', center: [121.0, 23.8], zoom: 7, terrain: false });
const map = M.map;
window.qijiMap = map;
const P = { pts: [], routes: [], sel: 0, trip: null, markers: [], seq: 0, sourceUrl: '', vehicle: 'scooter', along: null, alongPins: [] };
window.qijiPlan = P; // 除錯用
const route = () => P.routes[P.sel] || null;

const VEH_NOTE = {
  scooter: '機車：國道、快速道路都不走',
  heavy: '重機（550cc 以上紅牌）：不走國道（國道3甲例外），可以走快速道路',
  car: '汽車：國道、快速道路都可以',
};
const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const pad = () => (innerWidth <= 760 ? { top: 60, bottom: innerHeight * 0.58 + 30, left: 30, right: 30 } : { top: 60, bottom: 60, left: 440, right: 80 });
const dist = (a, b) => new maplibregl.LngLat(a.lon, a.lat).distanceTo(new maplibregl.LngLat(b.lon, b.lat));

/* ---------- 地圖圖層：選中的路線＋其他方案（灰色，可點） ---------- */
const fc = () => ({
  type: 'FeatureCollection',
  features: P.routes.map((r, i) => ({ type: 'Feature', properties: { i, on: i === P.sel }, geometry: { type: 'LineString', coordinates: r.coords } })),
});
M.onStyle(() => {
  if (!map.getSource('plan')) map.addSource('plan', { type: 'geojson', data: fc() });
  if (!map.getLayer('plan-alt')) map.addLayer({ id: 'plan-alt', type: 'line', source: 'plan', filter: ['!', ['get', 'on']], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#8e8e93', 'line-width': 5, 'line-opacity': 0.7 } });
  if (!map.getLayer('plan-casing')) map.addLayer({ id: 'plan-casing', type: 'line', source: 'plan', filter: ['get', 'on'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b3d91', 'line-width': 8, 'line-opacity': 0.6 } });
  if (!map.getLayer('plan-line')) map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', filter: ['get', 'on'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2997ff', 'line-width': 4.5 } });
  $('#bStyle').textContent = M.styleName;
});
map.on('click', 'plan-alt', (e) => { const i = e.features?.[0]?.properties?.i; if (i != null) { e.preventDefault(); selectRoute(+i); } });
map.on('mouseenter', 'plan-alt', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'plan-alt', () => (map.getCanvas().style.cursor = ''));
$('#bStyle').onclick = () => { $('#bStyle').textContent = M.nextStyle(); };
$('#b3d').onclick = () => { M.set3d(!M.is3d); $('#b3d').classList.toggle('on', M.is3d); };

/* ---------- 停靠點 ---------- */
const label = (i) => (i === 0 ? '起' : i === P.pts.length - 1 && P.pts.length > 1 ? '終' : String(i));
function drawMarkers() {
  P.markers.forEach((m) => m.remove());
  P.markers = P.pts.map((p, i) => {
    const el = document.createElement('div');
    el.className = 'wpno' + (i === 0 ? ' s' : i === P.pts.length - 1 && P.pts.length > 1 ? ' e' : '');
    el.textContent = label(i);
    el.title = p.name || '';
    const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([p.lon, p.lat]).addTo(map);
    mk.on('dragend', () => { const ll = mk.getLngLat(); P.pts[i] = { ...P.pts[i], lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6) }; changed(); });
    return mk;
  });
}
function renderPts() {
  const n = P.pts.length;
  $('#pts').innerHTML = n ? P.pts.map((p, i) => `
    <div class="pt${i === 0 ? ' s' : i === n - 1 && n > 1 ? ' e' : ''}">
      <span class="no">${label(i)}</span>
      <input value="${esc(p.name)}" placeholder="${i === 0 ? '起點' : i === n - 1 ? '終點' : '停靠點'}（可命名）" maxlength="30" data-name="${i}">
      <button data-up="${i}" title="往前" ${i ? '' : 'disabled'}>↑</button>
      <button data-down="${i}" title="往後" ${i < n - 1 ? '' : 'disabled'}>↓</button>
      <button data-del="${i}" title="移除">✕</button>
    </div>`).join('') : '<div class="empty">搜尋地點，或在地圖上點一下<br>第一個點是起點、第二個是終點，之後加的都是停靠點</div>';
}
$('#pts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const i = +(b.dataset.up ?? b.dataset.down ?? b.dataset.del);
  if (b.dataset.up != null) [P.pts[i - 1], P.pts[i]] = [P.pts[i], P.pts[i - 1]];
  else if (b.dataset.down != null) [P.pts[i + 1], P.pts[i]] = [P.pts[i], P.pts[i + 1]];
  else P.pts.splice(i, 1);
  changed();
});
$('#pts').addEventListener('change', (e) => { const i = e.target.dataset.name; if (i != null) { P.pts[+i].name = e.target.value.trim(); drawMarkers(); } });

// 加一個點：0 個→起點，1 個→終點，之後→插在「繞路最少」的兩點之間（不會改掉終點）
function addPoint(p, { asStart = false } = {}) {
  if (P.pts.length >= 25) { toast('停靠點最多 25 個', { icon: '!', color: '#ff9f0a' }); return; }
  const pt = { lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6), name: (p.name || '').slice(0, 30) };
  if (asStart) { P.pts.unshift(pt); changed(); return; }
  if (P.pts.length < 2) { P.pts.push(pt); changed(); return; }
  let best = 1, cost = Infinity;
  for (let i = 1; i < P.pts.length; i++) {
    const c = dist(P.pts[i - 1], pt) + dist(pt, P.pts[i]) - dist(P.pts[i - 1], P.pts[i]);
    if (c < cost) { cost = c; best = i; }
  }
  P.pts.splice(best, 0, pt);
  toast(`加入停靠點${pt.name ? '「' + pt.name + '」' : ''}（第 ${best} 站）`, { icon: '+', color: '#0a84ff' });
  changed();
}
map.on('click', (e) => {
  if (e.defaultPrevented) return;
  if (e.originalEvent?.target?.closest?.('.wpno,.poipin')) return;
  addPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng });
});
$('#useMe').onclick = () => {
  if (!navigator.geolocation) { toast('這個瀏覽器不能定位', { icon: '!', color: '#ff3b30' }); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => addPoint({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: '我的位置' }, { asStart: true }),
    () => toast('取得位置失敗（要允許定位）', { icon: '!', color: '#ff3b30' }), { enableHighAccuracy: true, timeout: 10000 });
};

/* ---------- 地點搜尋：打字時自動完成（FT.SUGGET），Enter 全文搜尋（FT.SEARCH） ---------- */
let sTimer = 0, sSeq = 0, sItems = [], sOn = -1;
function center() { const c = map.getCenter(); return `&lon=${c.lng.toFixed(5)}&lat=${c.lat.toFixed(5)}`; }
async function runSearch(full) {
  const q = $('#q').value.trim();
  if (!q) { $('#sres').hidden = true; return; }
  const seq = ++sSeq;
  try {
    const items = await api(`/api/poi/${full ? 'search' : 'suggest'}?q=${encodeURIComponent(q)}${center()}`);
    if (seq !== sSeq) return;
    sItems = items; sOn = -1;
    $('#sres').innerHTML = items.length ? items.map((x, i) => `<div class="sr" data-i="${i}"><span class="k">${esc(x.kind_name)}</span>
      <div class="n"><b>${esc(x.name)}</b><span>${esc(x.area || '')}</span></div>${x.dist_km != null ? `<span class="d">${x.dist_km} km</span>` : ''}</div>`).join('')
      : `<div class="empty">${full ? '找不到' : '按 Enter 搜尋更多'}</div>`;
    $('#sres').hidden = false;
  } catch { /* 略過 */ }
}
$('#q').addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(() => runSearch(false), 180); });
$('#q').addEventListener('keydown', (e) => {
  const rows = [...document.querySelectorAll('#sres .sr')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sOn = Math.max(0, Math.min(rows.length - 1, sOn + (e.key === 'ArrowDown' ? 1 : -1)));
    rows.forEach((r, i) => r.classList.toggle('on', i === sOn));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (sOn >= 0 && sItems[sOn]) pick(sItems[sOn]); else runSearch(true);
  } else if (e.key === 'Escape') $('#sres').hidden = true;
});
$('#sres').addEventListener('click', (e) => { const r = e.target.closest('.sr'); if (r) pick(sItems[+r.dataset.i]); });
document.addEventListener('click', (e) => { if (!e.target.closest('.sbox')) $('#sres').hidden = true; });
function pick(x) {
  $('#sres').hidden = true; $('#q').value = '';
  addPoint(x);
  if (P.pts.length === 1) map.easeTo({ center: [x.lon, x.lat], zoom: Math.max(map.getZoom(), 11), padding: pad(), duration: 700 });
}

/* ---------- 交通工具 ---------- */
function setVehicle(v) {
  P.vehicle = v;
  document.querySelectorAll('#veh button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $('#vehNote').textContent = VEH_NOTE[v];
}
$('#veh').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.v !== P.vehicle) { setVehicle(b.dataset.v); preview(); } });
setVehicle('scooter');

/* ---------- 預覽（點有變動就自動重算） ---------- */
let timer = 0;
function changed() {
  renderPts(); drawMarkers();
  clearTimeout(timer);
  timer = setTimeout(preview, 450);
}
async function preview() {
  const seq = ++P.seq;
  $('#msg').innerHTML = '';
  if (P.pts.length < 2) { P.routes = []; showRoutes(); return; }
  $('#msg').innerHTML = '<div class="note">計算路線中…</div>';
  try {
    const res = await api('/api/routes/preview', { method: 'POST', body: { points: P.pts, vehicle: P.vehicle } });
    if (seq !== P.seq) return; // 已經有更新的請求
    P.routes = res.routes; P.sel = 0;
    showRoutes(true);
  } catch (err) {
    if (seq !== P.seq) return;
    P.routes = []; showRoutes();
    $('#msg').innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
}

function selectRoute(i) { P.sel = i; showRoutes(false); }
function showRoutes(fit) {
  map.getSource('plan')?.setData(fc());
  const r = route();
  $('#result').hidden = !r;
  $('#apply').disabled = !r || !P.trip?.is_owner;
  clearAlong();
  if (!r) { $('#msg').innerHTML = ''; return; }
  const w = r.warnings || [];
  $('#msg').innerHTML = (w.length ? `<div class="warn">⚠ 這條路線用到${{ scooter: '機車', heavy: '重機' }[P.vehicle] || ''}不能走的路段：${w.map(esc).join('、')}。可能是沒有其他路可以到，請加停靠點改道。</div>` : '')
    + (r.uses_3a ? '<div class="note">這條路線有走國道3甲（重機可以行駛）。</div>' : '');
  $('#optTitle').textContent = P.routes.length > 1 ? `路線（${P.routes.length} 個方案，點選或點地圖上的灰線切換）` : '路線';
  $('#opts').innerHTML = P.routes.map((x, i) => {
    const s = x.summary;
    return `<button class="opt${i === P.sel ? ' on' : ''}" data-opt="${i}">
      <div class="r1"><b class="num">${s.min_personal ? hm(s.min_personal) : hm(s.min)}</b>
        ${s.min_personal ? `<span class="me">依你的速度</span><span class="vh">一般估計 ${hm(s.min)}</span>` : ''}
        <span class="tag">${s.km.toFixed(1)} km</span></div>
      <div class="r2">${esc(x.via || '')}</div></button>`;
  }).join('');
  $('#paceNote').textContent = r.summary.min_personal ? '「依你的速度」是用你過去一年的足跡，依道路種類（省道／縣道、市區／郊區、彎路）算出的實際平均速度，含紅燈等短暫停車。' : '';
  $('#turnCount').textContent = `${r.maneuvers.length} 個`;
  $('#turns').innerHTML = r.maneuvers.map((m) => `<div class="turn"><i class="num">${m.km.toFixed(1)} km</i><span>${esc(m.act)}${m.street ? ' · ' + esc(m.street) : ''}</span></div>`).join('');
  if (fit) {
    const c = r.coords;
    const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
    map.fitBounds(b, { padding: pad(), maxZoom: 14, duration: 700 });
  }
}
$('#opts').addEventListener('click', (e) => { const b = e.target.closest('[data-opt]'); if (b) selectRoute(+b.dataset.opt); });

/* ---------- 沿路線找（每 2 km 取一點，後端 Pipeline 一次 GEOSEARCH） ---------- */
function clearAlong() {
  P.along = null; P.alongPins.forEach((m) => m.remove()); P.alongPins = [];
  $('#along').hidden = true;
  document.querySelectorAll('#chips button').forEach((b) => b.classList.remove('on'));
}
$('#chips').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const kind = b.dataset.k, was = P.along === kind;
  clearAlong();
  if (was) return;
  P.along = kind; b.classList.add('on');
  const r = route(), samples = [];
  const step = Math.max(2, r.summary.km / 380);
  let next = 0;
  r.coords.forEach((c, i) => { if (r.cum_km[i] >= next) { samples.push([c[0], c[1], r.cum_km[i]]); next += step; } });
  try {
    const ev = kind === 'roadevent';  // 路況：TDX 省道即時事件，只能看、不能加入路線
    const items = await api('/api/poi/along', { method: 'POST', body: { kind, samples, radius_m: ev ? 500 : 800 } });
    if (P.along !== kind) return;
    $('#along').hidden = false;
    $('#along').innerHTML = items.length ? items.map((x, i) => `<div class="al"><i class="num">${x.route_km} km</i>
      <div class="n" data-go="${i}"><b>${esc(x.name)}</b><span>${esc(x.area || '')}${x.off_m > 150 ? ` · 離路線 ${x.off_m} m` : ''}</span></div>
      ${ev ? `<span class="evt">${esc(x.type)}</span>` : `<button data-add="${i}">加入</button>`}</div>`).join('')
      : `<div class="empty">${ev ? '路線沿途目前沒有省道施工、事故或管制（交通部 TDX）' : '路線 800 m 內沒有找到'}</div>`;
    P.alongItems = items;
    P.alongPins = items.map((x, i) => {
      const el = document.createElement('div');
      el.className = 'poipin';
      el.innerHTML = `<b>${b.textContent[0]}</b>${esc(x.name.slice(0, 10))}`;
      if (ev) { el.classList.add('evpin'); el.title = `${x.name}：${x.area}`; }
      else { el.onclick = (e2) => { e2.stopPropagation(); addPoint(P.alongItems[i]); }; el.title = '點一下加入路線'; }
      return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.lon, x.lat]).addTo(map);
    });
  } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
});
$('#along').addEventListener('click', (e) => {
  const a = e.target.closest('[data-add]'), g = e.target.closest('[data-go]');
  if (a) addPoint(P.alongItems[+a.dataset.add]);
  else if (g) { const x = P.alongItems[+g.dataset.go]; map.easeTo({ center: [x.lon, x.lat], zoom: 15, padding: pad(), duration: 700 }); }
});

/* ---------- Google Maps 連結（選用） ---------- */
$('#gForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#gUrl').value.trim();
  if (!url) return;
  try {
    const r = await api('/api/routes/parse-gmaps', { method: 'POST', body: { url } });
    P.pts = r.points; P.sourceUrl = url;
    toast(`匯入 ${r.points.length} 個點`, { icon: 'G', color: '#30a46c' });
    changed();
  } catch (err) { $('#msg').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
});

/* ---------- 套用 ---------- */
$('#apply').onclick = async () => {
  $('#apply').disabled = true;
  try {
    const r = await api(`/api/trips/${tid}/route`, { method: 'PUT', body: { points: P.pts, vehicle: P.vehicle, source_url: P.sourceUrl, alt: P.sel } });
    if ($('#asRest').checked) {
      for (const [i, p] of P.pts.slice(1, -1).entries()) {
        await api(`/api/trips/${tid}/waypoints`, { method: 'POST', body: { name: p.name || `停靠點 ${i + 1}`, lat: p.lat, lon: p.lon, kind: 'rest' } }).catch(() => {});
      }
    }
    toast(`已套用：${r.summary.km} km`, { icon: '✓', color: '#30a46c' });
    setTimeout(() => (location.href = `/trip?id=${tid}`), 900);
  } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); $('#apply').disabled = false; }
};
$('#clear').onclick = async () => {
  if ($('#clear').dataset.confirm !== '1') { $('#clear').dataset.confirm = '1'; $('#clear').textContent = '確定清除？'; return; }
  try { await api(`/api/trips/${tid}/route`, { method: 'DELETE' }); P.pts = []; P.routes = []; changed(); $('#clear').hidden = true; toast('已清除路線'); }
  catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
};

/* ---------- 載入 ---------- */
(async () => {
  try {
    P.trip = await api(`/api/trips/${tid}`);
    $('#tName').textContent = P.trip.name;
    document.title = `規劃路線 · ${P.trip.name} · 騎跡`;
    if (P.trip.status === 'ended') { $('#apply').textContent = '行程已結束'; P.trip.is_owner = false; }
    else if (!P.trip.is_owner) $('#apply').textContent = '只有建立者可以套用路線';
    if (!P.trip.is_owner) $('#asRestWrap').hidden = true;
    const saved = await api(`/api/trips/${tid}/route`);
    if (saved?.points) {
      P.pts = saved.points; P.sourceUrl = saved.source_url || '';
      setVehicle(saved.vehicle || (saved.avoid_highways === false ? 'heavy' : 'scooter'));
      $('#clear').hidden = !P.trip.is_owner;
      renderPts(); drawMarkers();
      M.onStyle(() => preview());
    } else renderPts();
  } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
})();

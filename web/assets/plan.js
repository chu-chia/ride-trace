// 規劃路線頁：Google Maps 連結匯入、地圖點選途經點、Valhalla 機車路線預覽、套用到行程。
import { api, $, esc, toast } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const tid = new URLSearchParams(location.search).get('trip');
if (!tid) location.href = '/';
$('#back').href = `/trip?id=${tid}`;

const M = createMap($('#map'), { style: 'dark', center: [121.0, 23.8], zoom: 7, terrain: false });
const map = M.map;
window.qijiMap = map;
const P = { pts: [], route: null, trip: null, markers: [], seq: 0, sourceUrl: '', vehicle: 'scooter' };
const VEH_NOTE = {
  scooter: '機車模式，避開國道（550cc 以下不能上國道）',
  heavy: '機車模式，可走國道（550cc 以上紅牌；國道目前只開放部分路段，請以公告為準）',
  car: '汽車模式（同行的車或支援車）',
};
function setVehicle(v) {
  P.vehicle = v;
  document.querySelectorAll('#veh button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $('#vehNote').textContent = VEH_NOTE[v];
}
$('#veh').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.v !== P.vehicle) { setVehicle(b.dataset.v); preview(); } });
setVehicle('scooter');

const pad = () => (innerWidth <= 760 ? { top: 60, bottom: innerHeight * 0.52 + 30, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 80 });

/* ---------- 地圖圖層 ---------- */
const lineGeo = () => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: P.route?.coords || [] } });
M.onStyle(() => {
  if (!map.getSource('plan')) map.addSource('plan', { type: 'geojson', data: lineGeo() });
  if (!map.getLayer('plan-casing')) map.addLayer({ id: 'plan-casing', type: 'line', source: 'plan', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b3d91', 'line-width': 8, 'line-opacity': 0.6 } });
  if (!map.getLayer('plan-line')) map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2997ff', 'line-width': 4.5 } });
  $('#bStyle').textContent = M.styleName;
});
$('#bStyle').onclick = () => { $('#bStyle').textContent = M.nextStyle(); };
$('#b3d').onclick = () => { M.set3d(!M.is3d); $('#b3d').classList.toggle('on', M.is3d); };

/* ---------- 途經點 ---------- */
function drawMarkers() {
  P.markers.forEach((m) => m.remove());
  P.markers = P.pts.map((p, i) => {
    const el = document.createElement('div');
    el.className = 'wpno' + (i === 0 ? ' s' : i === P.pts.length - 1 && P.pts.length > 1 ? ' e' : '');
    el.textContent = i === 0 ? '起' : i === P.pts.length - 1 && P.pts.length > 1 ? '終' : i;
    el.title = p.name || '';
    const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([p.lon, p.lat]).addTo(map);
    mk.on('dragend', () => { const ll = mk.getLngLat(); P.pts[i] = { ...P.pts[i], lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6) }; changed(); });
    return mk;
  });
}
function renderPts() {
  $('#pts').innerHTML = P.pts.length ? P.pts.map((p, i) => `
    <div class="pt" data-i="${i}">
      <span class="no">${i === 0 ? '起' : i === P.pts.length - 1 && P.pts.length > 1 ? '終' : i}</span>
      <input value="${esc(p.name)}" placeholder="${i === 0 ? '起點' : i === P.pts.length - 1 ? '終點' : '途經點'}（可命名）" maxlength="30" data-name="${i}">
      <button data-up="${i}" title="往前" ${i ? '' : 'disabled'}>↑</button>
      <button data-down="${i}" title="往後" ${i < P.pts.length - 1 ? '' : 'disabled'}>↓</button>
      <button data-del="${i}" title="移除">✕</button>
    </div>`).join('') : '<div class="empty">還沒有途經點：貼 Google Maps 連結，或在地圖上點兩下以上</div>';
}
$('#pts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = +(b.dataset.up ?? b.dataset.down ?? b.dataset.del);
  if (b.dataset.up != null) [P.pts[i - 1], P.pts[i]] = [P.pts[i], P.pts[i - 1]];
  else if (b.dataset.down != null) [P.pts[i + 1], P.pts[i]] = [P.pts[i], P.pts[i + 1]];
  else P.pts.splice(i, 1);
  changed();
});
$('#pts').addEventListener('change', (e) => { const i = e.target.dataset.name; if (i != null) { P.pts[+i].name = e.target.value.trim(); drawMarkers(); } });
map.on('click', (e) => {
  if (e.originalEvent?.target?.closest?.('.wpno')) return; // 點到已有的途經點不算新增
  if (P.pts.length >= 25) { toast('途經點最多 25 個', { icon: '!', color: '#ff9f0a' }); return; }
  P.pts.push({ lat: +e.lngLat.lat.toFixed(6), lon: +e.lngLat.lng.toFixed(6), name: '' });
  changed();
});

/* ---------- 預覽（點有變動就自動重算） ---------- */
let timer = 0;
function changed() {
  renderPts(); drawMarkers();
  clearTimeout(timer);
  timer = setTimeout(preview, 500);
}
async function preview() {
  const seq = ++P.seq;
  $('#msg').innerHTML = '';
  if (P.pts.length < 2) { P.route = null; showRoute(); return; }
  $('#msg').innerHTML = '<div class="note">計算路線中…</div>';
  try {
    const route = await api('/api/routes/preview', { method: 'POST', body: { points: P.pts, vehicle: P.vehicle } });
    if (seq !== P.seq) return; // 已經有更新的請求
    P.route = route;
    $('#msg').innerHTML = '';
    showRoute();
  } catch (err) {
    if (seq !== P.seq) return;
    P.route = null; showRoute();
    $('#msg').innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
}

function showRoute() {
  map.getSource('plan')?.setData(lineGeo());
  $('#result').hidden = !P.route;
  $('#apply').disabled = !P.route || !P.trip?.is_owner;
  if (!P.route) return;
  const s = P.route.summary;
  $('#sKm').textContent = s.km.toFixed(1);
  $('#sMin').textContent = s.min >= 60 ? `${Math.floor(s.min / 60)}:${String(s.min % 60).padStart(2, '0')}` : `${s.min} 分`;
  const turns = P.route.maneuvers.filter((m) => ![1, 2, 3].includes(m.type));
  $('#sTurn').textContent = turns.length;
  $('#turns').innerHTML = P.route.maneuvers.map((m) => `<div class="turn"><i class="num">${m.km.toFixed(1)} km</i><span>${esc(m.act)}${m.street ? ' · ' + esc(m.street) : ''}</span></div>`).join('');
  const c = P.route.coords;
  const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
  map.fitBounds(b, { padding: pad(), maxZoom: 14, duration: 700 });
}

/* ---------- Google Maps 連結 ---------- */
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
    const r = await api(`/api/trips/${tid}/route`, { method: 'PUT', body: { points: P.pts, vehicle: P.vehicle, source_url: P.sourceUrl } });
    if ($('#asRest').checked) {
      for (const [i, p] of P.pts.slice(1, -1).entries()) {
        await api(`/api/trips/${tid}/waypoints`, { method: 'POST', body: { name: p.name || `途經點 ${i + 1}`, lat: p.lat, lon: p.lon, kind: 'rest' } }).catch(() => {});
      }
    }
    toast(`已套用：${r.summary.km} km`, { icon: '✓', color: '#30a46c' });
    setTimeout(() => (location.href = `/trip?id=${tid}`), 900);
  } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); $('#apply').disabled = false; }
};
$('#clear').onclick = async () => {
  if ($('#clear').dataset.confirm !== '1') { $('#clear').dataset.confirm = '1'; $('#clear').textContent = '確定清除？'; return; }
  try { await api(`/api/trips/${tid}/route`, { method: 'DELETE' }); P.pts = []; P.route = null; changed(); $('#clear').hidden = true; toast('已清除路線'); }
  catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
};

/* ---------- 載入 ---------- */
(async () => {
  try {
    P.trip = await api(`/api/trips/${tid}`);
    $('#tName').textContent = P.trip.name;
    document.title = `規劃路線 · ${P.trip.name} · 騎跡`;
    if (!P.trip.is_owner) {
      $('#apply').textContent = '只有建立者可以套用路線';
      $('#asRestWrap').hidden = true;
    }
    if (P.trip.status === 'ended') { $('#apply').textContent = '行程已結束'; P.trip.is_owner = false; }
    const route = await api(`/api/trips/${tid}/route`);
    if (route?.points) {
      P.pts = route.points; P.route = route; P.sourceUrl = route.source_url || '';
      setVehicle(route.vehicle || (route.avoid_highways === false ? 'heavy' : 'scooter'));
      $('#clear').hidden = !P.trip.is_owner || P.trip.status === 'ended';
      renderPts(); drawMarkers();
      M.onStyle(() => showRoute());
    } else renderPts();
  } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
})();

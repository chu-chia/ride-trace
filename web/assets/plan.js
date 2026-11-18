// 規劃路線頁：在網頁裡搜尋地點、加停靠點（自動插在繞路最少的位置）、選交通工具、比較 1～3 條路線、
// 沿路線找加油站等，最後套用到行程。Google Maps 匯入只是選用。
import { api, $, esc, toast, initPanel, setLabel, press } from '/assets/common.js';
import { createMap, addCompass } from '/assets/mapbase.js';

const tid = new URLSearchParams(location.search).get('trip');
if (!tid) location.href = '/';
$('#back').href = `/trip?id=${tid}`;

const M = createMap($('#map'), { style: 'dark', center: [121.0, 23.8], zoom: 7, terrain: false });
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
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
// 時間寫成「1 小時 07 分」（1:07 容易看成 1 點 07 分，UX-27）
const hm = (min) => { min = Math.round(min); return min < 60 ? `${min} 分` : `${Math.floor(min / 60)} 小時 ${String(min % 60).padStart(2, '0')} 分`; };
initPanel($('#panel'), 'plan', { defaultSmall: false });
// 地圖留白：避開左側欄（手機是下方抽屜）與右上工具列
const pad = () => (innerWidth <= 760
  ? { top: 60, bottom: innerHeight - $('#panel').getBoundingClientRect().top + 30, left: 30, right: 64 }
  : { top: 60, bottom: 60, left: $('#panel').offsetWidth + 50, right: 90 });
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
  setLabel($('#bStyle'), M.styleName);
});
map.on('click', 'plan-alt', (e) => { const i = e.features?.[0]?.properties?.i; if (i != null) { e.preventDefault(); selectRoute(+i); } });
map.on('mouseenter', 'plan-alt', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'plan-alt', () => (map.getCanvas().style.cursor = ''));
$('#bStyle').onclick = () => setLabel($('#bStyle'), M.nextStyle());
$('#b3d').onclick = () => { M.set3d(!M.is3d); press($('#b3d'), M.is3d); };

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
    (pos) => { P.me = { lon: pos.coords.longitude, lat: pos.coords.latitude }; addPoint({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: '我的位置' }, { asStart: true }); },
    () => toast('取得位置失敗（要允許定位）', { icon: '!', color: '#ff3b30' }), { enableHighAccuracy: true, timeout: 10000 });
};

/* ---------- 地點搜尋：打字時自動完成（FT.SUGGET），Enter 全文搜尋（FT.SEARCH） ---------- */
let sTimer = 0, sSeq = 0, sItems = [], sOn = -1;
// 距離的基準（UX-25）：有起點用起點、按過「用我的位置」用定位，都沒有才用畫面中心，並寫清楚是離哪裡
function basis() {
  if (P.pts.length) return { lon: P.pts[0].lon, lat: P.pts[0].lat, label: '離起點' };
  if (P.me) return { ...P.me, label: '離你' };
  const c = map.getCenter();
  return { lon: c.lng, lat: c.lat, label: '離畫面中心' };
}
function center(b) { return `&lon=${b.lon.toFixed(5)}&lat=${b.lat.toFixed(5)}`; }
async function runSearch(full) {
  const q = $('#q').value.trim();
  if (!q) { $('#sres').hidden = true; return; }
  const seq = ++sSeq, b = basis();
  try {
    // 打字時的自動完成只吃一個詞；有空白就直接走全文搜尋（會拆詞，UX-26）
    const items = await api(`/api/poi/${full || /\s/.test(q) ? 'search' : 'suggest'}?q=${encodeURIComponent(q)}${center(b)}`);
    if (seq !== sSeq) return;
    sItems = items; sOn = -1;
    $('#sres').innerHTML = items.length ? items.map((x, i) => `<div class="sr" data-i="${i}"><span class="k">${esc(x.kind_name)}</span>
      <div class="n"><b>${esc(x.name)}</b><span>${esc(x.area || '')}</span></div>${x.dist_km != null ? `<span class="d">${b.label}<br>${x.dist_km} km</span>` : ''}</div>`).join('')
      : full ? `<div class="empty">找不到「${esc(q)}」<br>試試只打地名或店名，例如「金山」「淡水老街」</div>`
        : '<div class="empty">還沒有建議，按 Enter 搜尋全部</div>';
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
    clearTimeout(sTimer);  // 還沒送出的自動完成不要蓋掉全文搜尋的結果
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
    P.routes = res.routes; P.sel = 0; resetChipCounts();
    showRoutes(true);
  } catch (err) {
    if (seq !== P.seq) return;
    P.routes = []; showRoutes();
    $('#msg').innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
}

function selectRoute(i) { P.sel = i; resetChipCounts(); showRoutes(false); }
function showRoutes(fit) {
  map.getSource('plan')?.setData(fc());
  const r = route();
  $('#result').hidden = !r;
  $('#apply').disabled = !r || !P.trip?.is_owner;
  clearAlong();
  if (!r) { $('#msg').innerHTML = ''; $('#miniRoute').textContent = '還沒有路線'; return; }
  const w = r.warnings || [];
  $('#msg').innerHTML = (w.length ? `<div class="warn">⚠ 這條路線用到${{ scooter: '機車', heavy: '重機' }[P.vehicle] || ''}不能走的路段：${w.map(esc).join('、')}。可能是沒有其他路可以到，請加停靠點改道。</div>` : '')
    + (r.uses_3a ? '<div class="note">這條路線有走國道3甲（重機可以行駛）。</div>' : '');
  $('#optTitle').textContent = P.routes.length > 1 ? `${P.routes.length} 個方案` : '路線';
  $('#miniRoute').textContent = `${r.summary.km.toFixed(1)} km · ${hm(r.summary.min_personal || r.summary.min)}`;
  // 自動標「最快」「最短」（UX-27）；選項用 radiogroup，螢幕報讀器念得出選了哪一個
  const t = (x) => x.summary.min_personal || x.summary.min;
  const many = P.routes.length > 1;
  const fastest = many ? P.routes.reduce((a, x, i) => (t(x) < t(P.routes[a]) ? i : a), 0) : -1;
  const shortest = many ? P.routes.reduce((a, x, i) => (x.summary.km < P.routes[a].summary.km ? i : a), 0) : -1;
  $('#opts').innerHTML = P.routes.map((x, i) => {
    const s = x.summary;
    const tags = [i === fastest ? '最快' : '', i === shortest ? '最短' : ''].filter(Boolean);
    return `<button class="opt${i === P.sel ? ' on' : ''}" data-opt="${i}" role="radio" aria-checked="${i === P.sel}" tabindex="${i === P.sel ? 0 : -1}"
        aria-label="方案 ${i + 1}${tags.length ? '（' + tags.join('、') + '）' : ''}：${hm(t(x))}，${s.km.toFixed(1)} 公里${x.via ? '，經 ' + esc(x.via) : ''}">
      <div class="r1"><b class="num">${hm(t(x))}</b>
        ${s.min_personal ? `<span class="me">依你的速度</span><span class="vh">一般估計 ${hm(s.min)}</span>` : ''}
        <span class="tag">${s.km.toFixed(1)} km</span></div>
      ${tags.length ? `<div class="badges">${tags.map((g) => `<span class="badge">${g}</span>`).join('')}</div>` : ''}
      <div class="r2">${esc(x.via || '')}</div></button>`;
  }).join('');
  // 有停靠點時路線引擎只算得出一條（停靠點本身就是在指定走法），說清楚，免得以為壞了
  $('#paceNote').textContent = P.pts.length > 2 && !many ? '有停靠點時只會算一條路線；想比較走法，可以先只留起點和終點。' : '';
  $('#turnCount').textContent = `${r.maneuvers.length} 個`;
  $('#turns').innerHTML = r.maneuvers.map((m) => `<div class="turn"><i class="num">${m.km.toFixed(1)} km</i><span>${esc(m.act)}${m.street ? ' · ' + esc(m.street) : ''}</span></div>`).join('');
  if (fit) {
    const c = r.coords;
    const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
    map.fitBounds(b, { padding: pad(), maxZoom: 14, duration: 700 });
  }
}
$('#opts').addEventListener('click', (e) => { const b = e.target.closest('[data-opt]'); if (b) selectRoute(+b.dataset.opt); });
// radiogroup 鍵盤操作：上下左右換方案
$('#opts').addEventListener('keydown', (e) => {
  const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!d || P.routes.length < 2) return;
  e.preventDefault();
  selectRoute((P.sel + d + P.routes.length) % P.routes.length);
  $(`#opts [data-opt="${P.sel}"]`)?.focus();
});

/* ---------- 沿路線找（每 2 km 取一點，後端 Pipeline 一次 GEOSEARCH） ---------- */
function clearAlong() {
  P.along = null; P.alongPins.forEach((m) => m.remove()); P.alongPins = [];
  $('#along').hidden = true; $('#along').innerHTML = '';
  document.querySelectorAll('#chips button').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
}
// chip 上顯示查過的結果數（「路況 0」，UX-36）；換路線就清掉
const chipName = (b) => b.dataset.name || (b.dataset.name = b.textContent);
function chipCount(b, n) { b.innerHTML = n == null ? esc(chipName(b)) : `${esc(chipName(b))} <span class="cnt">${n}</span>`; }
function resetChipCounts() { document.querySelectorAll('#chips button').forEach((b) => chipCount(b, null)); }
$('#chips').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const kind = b.dataset.k, was = P.along === kind;
  clearAlong();
  if (was) return;
  P.along = kind; b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
  $('#along').hidden = false;
  $('#along').innerHTML = `<div class="empty">正在找沿線的${esc(chipName(b))}…</div>`;
  const r = route(), samples = [];
  const step = Math.max(2, r.summary.km / 380);
  let next = 0;
  r.coords.forEach((c, i) => { if (r.cum_km[i] >= next) { samples.push([c[0], c[1], r.cum_km[i]]); next += step; } });
  try {
    const wx = kind === 'weather';    // 天氣：沿途鄉鎮在預計經過時的降雨機率
    const ev = kind === 'roadevent' || wx;  // 路況、天氣只能看、不能加入路線
    const kmh = r.summary.min ? r.summary.km / (r.summary.min / 60) : 40;
    const items = await api('/api/poi/along', { method: 'POST', body: { kind, samples, radius_m: kind === 'roadevent' ? 500 : 800, kmh: Math.min(150, Math.max(5, kmh)) } });
    if (P.along !== kind) return;
    chipCount(b, items.length);
    $('#along').hidden = false;
    $('#along').innerHTML = items.length ? items.map((x, i) => `<div class="al"><i class="num">${x.route_km} km</i>
      <div class="n" data-go="${i}"><b>${esc(x.name)}</b><span>${esc(x.area || '')}${x.off_m > 150 ? ` · 離路線 ${x.off_m} m` : ''}</span></div>
      ${ev ? `<span class="evt${wx && x.pop >= 60 ? ' wet' : ''}">${esc(x.type)}</span>` : `<button data-add="${i}">加入</button>`}</div>`).join('')
      : `<div class="empty">${wx ? '查不到沿途的天氣預報' : ev ? '沿線沒有路況事件<br>（交通部 TDX 省道施工、事故、管制，離路線 500 m 內）' : `路線 800 m 內沒有找到${esc(chipName(b))}`}</div>`;
    P.alongItems = items;
    P.alongPins = items.map((x, i) => {
      const el = document.createElement('div');
      el.className = 'poipin';
      el.innerHTML = wx ? `<b>雨</b>${esc(x.name.slice(3, 10))} ${x.pop}%` : `<b>${b.textContent[0]}</b>${esc(x.name.slice(0, 10))}`;
      if (wx) el.classList.add('wxpin');
      if (ev) { el.classList.add('evpin'); el.title = `${x.name}：${x.area}`; }
      else { el.onclick = (e2) => { e2.stopPropagation(); addPoint(P.alongItems[i]); }; el.title = '點一下加入路線'; }
      return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.lon, x.lat]).addTo(map);
    });
  } catch (err) {
    if (P.along !== kind) return;
    $('#along').innerHTML = `<div class="empty">查不到${esc(chipName(b))}：${esc(err.message)}</div>`;
  }
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
  } catch (err) {
    if (!P.trip) $('#tName').textContent = '載入失敗，請重新整理';
    toast(err.message, { icon: '!', color: '#ff3b30' });
  }
})();

// 行程頁的 M3 互動功能：集合點、前方測速（之後加快速訊息、標註、SOS）。
// 和 trip.js 分開放，避免和畫面設計的改動互相衝突。trip.js 只提供三個掛鉤：
//   window.qijiM（地圖包裝）、window.qijiState（頁面狀態）、window 的 'qiji:msg' 事件（每則 WebSocket 訊息）
import { api, $, esc, toast } from '/assets/common.js';

const tid = new URLSearchParams(location.search).get('id');
const M = window.qijiM, map = window.qijiMap, S = window.qijiState;
const X = { wps: [], pins: new Map(), open: null, pick: null };
const KIND = { meet: '集合點', rest: '休息點' };
const nameOf = (uid) => S.members.get(uid)?.u.nickname || '';

/* ---------- 左下角工具列＋彈出面板 ---------- */
const dock = document.createElement('div');
dock.className = 'qx-dock';
dock.innerHTML = `
  <div class="qx-pop glass" id="qxPop" hidden></div>
  <div class="qx-bar">
    <button class="tool glass" data-open="wp" title="集合點與休息點">集合點</button>
    <button class="tool glass" data-open="cam" title="測速照相查詢">測速</button>
  </div>`;
document.body.append(dock);
const pop = $('#qxPop');

// 手機版面板在下面，工具列要跟著面板頂端
function placeDock() {
  const panel = $('#panel');
  const narrow = innerWidth <= 760;
  dock.style.bottom = narrow && panel ? `${Math.max(12, innerHeight - panel.getBoundingClientRect().top + 12)}px` : '';
}
setInterval(placeDock, 400);
addEventListener('resize', placeDock);
placeDock();

dock.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (b) { X.open = X.open === b.dataset.open ? null : b.dataset.open; render(); }
});

function render() {
  dock.querySelectorAll('[data-open]').forEach((b) => b.classList.toggle('on', b.dataset.open === X.open));
  pop.hidden = !X.open;
  if (X.open === 'wp') renderWpPanel();
  if (X.open === 'cam') renderCamPanel();
}

/* ---------- 集合點 ---------- */
function circle(lon, lat, r, n = 48) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([lon + (r / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a), lat + (r / 110540) * Math.cos(a)]);
  }
  return out;
}
function wpGeo() {
  return {
    type: 'FeatureCollection',
    features: X.wps.map((w) => ({
      type: 'Feature', properties: { kind: w.kind, all: w.all_in },
      geometry: { type: 'Polygon', coordinates: [circle(w.lon, w.lat, w.radius_m)] },
    })),
  };
}
M.onStyle(() => {
  if (!map.getSource('qx-wp')) map.addSource('qx-wp', { type: 'geojson', data: wpGeo() });
  const color = ['case', ['get', 'all'], '#30d158', ['==', ['get', 'kind'], 'rest'], '#64d2ff', '#ffd60a'];
  if (!map.getLayer('qx-wp-fill')) map.addLayer({ id: 'qx-wp-fill', type: 'fill', source: 'qx-wp', paint: { 'fill-color': color, 'fill-opacity': 0.16 } });
  if (!map.getLayer('qx-wp-line')) map.addLayer({ id: 'qx-wp-line', type: 'line', source: 'qx-wp', paint: { 'line-color': color, 'line-width': 2, 'line-dasharray': [2, 1.5] } });
});

function drawWps() {
  map.getSource('qx-wp')?.setData(wpGeo());
  const seen = new Set();
  for (const w of X.wps) {
    seen.add(w.id);
    let p = X.pins.get(w.id);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'qx-pin';
      el.onclick = () => { X.open = 'wp'; render(); };
      p = { el, marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([w.lon, w.lat]).addTo(map) };
      X.pins.set(w.id, p);
    }
    p.marker.setLngLat([w.lon, w.lat]);
    p.el.dataset.kind = w.kind;
    p.el.classList.toggle('all', w.all_in);
    p.el.innerHTML = `<b>${w.kind === 'rest' ? '休' : '集'}</b><span>${esc(w.name)}${w.arrived.length ? ` · ${w.arrived.length} 人到` : ''}</span>`;
  }
  for (const [id, p] of X.pins) if (!seen.has(id)) { p.marker.remove(); X.pins.delete(id); }
}

function renderWpPanel() {
  const rows = X.wps.map((w) => {
    const who = w.arrived.map(nameOf).filter(Boolean).join('、');
    const st = w.all_in ? '<span class="chip ok">全員到齊</span>' : `<span class="chip">${w.arrived.length}/${w.total} 到</span>`;
    return `<div class="qx-row" data-wp="${w.id}">
      <div class="grow"><div class="t1"><span class="qx-kind" data-kind="${w.kind}">${KIND[w.kind]}</span> ${esc(w.name)} ${st}</div>
      <div class="t2">半徑 ${w.radius_m} m${who ? ' · ' + esc(who) : ''}</div></div>
      <button class="qx-x" data-del="${w.id}" title="刪除">刪除</button></div>`;
  }).join('');
  pop.innerHTML = `
    <div class="qx-head"><b>集合點與休息點</b><span class="small muted">大家都能改；進入半徑就通知全隊</span></div>
    <div class="qx-list">${rows || '<div class="small muted" style="padding:6px 2px">還沒有集合點</div>'}</div>
    ${X.pick?.lngLat ? `
      <form class="qx-form" id="wpForm">
        <input class="input" name="name" placeholder="名稱，例如：武嶺停車場" maxlength="30" required autocomplete="off">
        <div class="qx-inline">
          <select class="input" name="kind"><option value="meet">集合點</option><option value="rest">休息點</option></select>
          <select class="input" name="radius"><option value="100">半徑 100 m</option><option value="150" selected>半徑 150 m</option><option value="300">半徑 300 m</option><option value="500">半徑 500 m</option></select>
        </div>
        <div class="qx-inline"><button type="button" class="btn" id="wpCancel">取消</button><button class="btn primary">新增</button></div>
      </form>`
    : `<button class="btn block" id="wpAdd">${X.pick ? '點地圖選擇位置…（再按一次取消）' : '＋ 在地圖上點選新增'}</button>`}`;
  $('#wpAdd')?.addEventListener('click', () => { X.pick = X.pick ? null : { lngLat: null }; map.getCanvas().style.cursor = X.pick ? 'crosshair' : ''; render(); });
  $('#wpCancel')?.addEventListener('click', () => { clearPick(); render(); });
  $('#wpForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/api/trips/${tid}/waypoints`, { method: 'POST', body: { name: f.get('name'), kind: f.get('kind'), radius_m: +f.get('radius'), lat: X.pick.lngLat.lat, lon: X.pick.lngLat.lng } });
      clearPick();
      render();
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
  $('#wpForm input')?.focus();
}
function clearPick() { X.pick = null; X.pickMarker?.remove(); X.pickMarker = null; map.getCanvas().style.cursor = ''; }

pop.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '確定？'; return; }
    try { await api(`/api/trips/${tid}/waypoints/${del.dataset.del}`, { method: 'DELETE' }); } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    return;
  }
  const row = e.target.closest('[data-wp]');
  if (row) {
    const w = X.wps.find((x) => x.id === row.dataset.wp);
    if (w) { S.lastInteract = Date.now(); M.unfollow(); map.easeTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 15), duration: 900 }); }
  }
});

map.on('click', (e) => {
  if (!X.pick) return;
  X.pick.lngLat = e.lngLat;
  S.lastInteract = Date.now(); M.unfollow();
  X.pickMarker?.remove();
  const el = document.createElement('div'); el.className = 'qx-pin pick'; el.innerHTML = '<b>＋</b>';
  X.pickMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(e.lngLat).addTo(map);
  map.getCanvas().style.cursor = '';
  render();
});

async function loadWps() {
  try { X.wps = await api(`/api/trips/${tid}/waypoints`); drawWps(); if (X.open === 'wp') render(); } catch { /* 不是成員或網路錯誤時 trip.js 會處理 */ }
}

/* ---------- 測速照相 ---------- */
// 地圖：畫面附近的測速點（GEOSEARCH）；縮太小就不顯示
X.cams = new Map();
async function loadCams() {
  if (map.getZoom() < 11) { X.cams.forEach((c) => c.marker.remove()); X.cams.clear(); return; }
  const b = map.getBounds(), c = map.getCenter();
  const km = Math.min(30, Math.max(1, b.getNorthEast().distanceTo(b.getSouthWest()) / 2000));
  let list;
  try { list = await api(`/api/speedcam/near?lon=${c.lng.toFixed(5)}&lat=${c.lat.toFixed(5)}&km=${km.toFixed(1)}`); } catch { return; }
  const keep = new Set(list.map((x) => x.id));
  for (const [id, m] of X.cams) if (!keep.has(id)) { m.marker.remove(); X.cams.delete(id); }
  for (const cam of list) {
    if (X.cams.has(cam.id)) continue;
    const el = document.createElement('div');
    el.className = 'qx-cam';
    el.title = `${cam.addr}（${cam.direct}，速限 ${cam.limit}）`;
    el.innerHTML = `<b>${cam.limit}</b>`;
    X.cams.set(cam.id, { cam, el, marker: new maplibregl.Marker({ element: el }).setLngLat([cam.lon, cam.lat]).addTo(map) });
  }
}
// 跟隨模式每一格都 jumpTo（每一格都有 moveend），不能用「停下來再載」；改成每 2 秒看一次，移動超過 300 m 或縮放改變才重載
let camAt = null;
setInterval(() => {
  const c = map.getCenter(), z = Math.round(map.getZoom());
  if (camAt && camAt.z === z && c.distanceTo(camAt.c) < 300) return;
  camAt = { c, z };
  loadCams();
}, 2000);

// 個人提醒：只有騎到測速點前方的那個人會跳通知；超速時速度標紅
function camAlert(msg) {
  const over = msg.kmh > msg.limit;
  toast(`前方 ${msg.dist_m} m 測速照相 · 速限 ${msg.limit}`, {
    icon: '速', color: over ? '#ff3b30' : '#ff9f0a',
    sub: `${msg.addr}${over ? ` · 你目前 ${msg.kmh} km/h，請減速` : ''}`,
  });
  X.cams.get(msg.cam)?.el.classList.add('hit');
}

let camMeta = null;
function renderCamPanel() {
  const res = X.camRes;
  pop.innerHTML = `
    <div class="qx-head"><b>測速照相</b><span class="small muted">${camMeta ? `${esc(camMeta.source)} · ${camMeta.count} 個 · 更新 ${new Date(camMeta.updated).toLocaleDateString('zh-TW')}` : '騎到前方 1 km 會自動提醒'}</span></div>
    <form class="qx-form" id="camForm">
      <input class="input" name="q" placeholder="地址關鍵字，例如：臺14、國道一號" autocomplete="off" value="${esc(X.camQ?.q || '')}">
      <div class="qx-inline">
        <input class="input" name="city" placeholder="縣市" value="${esc(X.camQ?.city || '')}">
        <select class="input" name="lim"><option value="">所有速限</option><option value="0-50">50 以下</option><option value="51-70">60～70</option><option value="71-90">80～90</option><option value="91-200">100 以上</option></select>
      </div>
      <div class="qx-inline"><button type="button" class="btn" id="camNear">畫面附近 10 km</button><button class="btn primary">查詢</button></div>
    </form>
    ${res ? `<div class="small muted">${res.total} 筆${res.total > res.items.length ? `（顯示前 ${res.items.length}）` : ''} · <code>${esc(res.query)}</code></div>
      <div class="qx-list">${res.items.map((c) => `<div class="qx-row" data-cam="${c.id}" data-lon="${c.lon}" data-lat="${c.lat}">
        <span class="qx-cam static"><b>${c.limit}</b></span>
        <div class="grow"><div class="t1">${esc(c.addr)}</div><div class="t2">${esc(c.city)}${esc(c.region)} · ${esc(c.direct)}</div></div></div>`).join('')}</div>` : ''}`;
  if (X.camQ?.lim) $('#camForm [name=lim]').value = X.camQ.lim;
  const run = async (extra = {}) => {
    const f = new FormData($('#camForm'));
    X.camQ = { q: f.get('q'), city: f.get('city'), lim: f.get('lim') };
    const p = new URLSearchParams({ q: X.camQ.q, city: X.camQ.city });
    if (X.camQ.lim) { const [a, b] = X.camQ.lim.split('-'); p.set('min_limit', a); p.set('max_limit', b); }
    Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    try { X.camRes = await api(`/api/speedcam/search?${p}`); renderCamPanel(); } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  };
  $('#camForm').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  // 「附近」只保留速限條件，關鍵字和縣市清掉（不然常常查不到）
  $('#camNear').addEventListener('click', () => {
    $('#camForm [name=q]').value = ''; $('#camForm [name=city]').value = '';
    const c = map.getCenter(); run({ lon: c.lng.toFixed(5), lat: c.lat.toFixed(5), km: 10 });
  });
  if (!camMeta) api('/api/speedcam/meta').then((m) => { camMeta = m; if (X.open === 'cam') $('.qx-head .small').textContent = `${m.source} · ${m.count} 個 · 更新 ${new Date(m.updated).toLocaleDateString('zh-TW')}`; }).catch(() => {});
}
pop.addEventListener('click', (e) => {
  const row = e.target.closest('[data-cam]');
  if (!row) return;
  S.lastInteract = Date.now(); M.unfollow();
  map.easeTo({ center: [+row.dataset.lon, +row.dataset.lat], zoom: 15.5, duration: 900 });
});

/* ---------- WebSocket 訊息 ---------- */
addEventListener('qiji:msg', (e) => {
  const msg = e.detail;
  if (msg.kind === 'waypoints') { X.wps = msg.items; drawWps(); if (X.open === 'wp' && !X.pick?.lngLat) render(); }
  if (msg.kind === 'snapshot') loadWps();
  if (msg.kind === 'speedcam' && msg.uid === S.me) camAlert(msg);
});

loadWps();
window.qijiExtra = X; // 除錯用

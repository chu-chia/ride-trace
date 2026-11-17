// 行程頁的 M3／M4 功能：集合點、前方測速、快速訊息、地圖標註、SOS、路線（進度條、轉彎提示）。
// 和 trip.js 分開放，避免和畫面設計的改動互相衝突。trip.js 只提供三個掛鉤：
//   window.qijiM（地圖包裝）、window.qijiState（頁面狀態）、window 的 'qiji:msg' 事件（每則 WebSocket 訊息）
import { api, $, esc, toast, clock } from '/assets/common.js';
import { mountPushCard } from '/assets/push.js';

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
  <div class="qx-prog glass" id="qxProg" hidden></div>
  <div class="qx-bar">
    <button class="tool glass" data-open="route" title="路線與全隊進度">路線</button>
    <button class="tool glass" data-open="wp" title="集合點與休息點">集合點</button>
    <button class="tool glass" data-open="cam" title="測速照相查詢">測速</button>
    <button class="tool glass" data-open="msg" title="快速訊息">訊息</button>
    <button class="tool glass" data-open="mark" title="地圖標註">標註</button>
    <a class="tool glass qx-war" href="/war?id=${tid}" target="_blank" rel="noopener" title="戰情室：用電腦大螢幕看全隊">戰情室</a>
    <button class="qx-sos" id="qxSos" title="長按 1.5 秒發出 SOS"><i></i><span>SOS</span></button>
  </div>`;
document.body.append(dock);
const pop = $('#qxPop');

// 手機版面板在下面，工具列要跟著面板頂端
function placeDock() {
  const panel = $('#panel');
  const narrow = innerWidth <= 760;
  // 手機：放在面板上方，再多留地圖版權列（MapLibre attribution）的高度，按鈕列才不會壓在它上面
  const attr = document.querySelector('.maplibregl-ctrl-bottom-right')?.getBoundingClientRect();
  const extra = attr && attr.height ? attr.height + 6 : 0;
  dock.style.bottom = narrow && panel ? `${Math.max(12, innerHeight - panel.getBoundingClientRect().top + 12 + extra)}px` : '';
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
  if (X.open === 'msg') renderMsgPanel();
  if (X.open === 'mark') renderMarkPanel();
  if (X.open === 'route') renderRoutePanel();
  if (X.pick && X.pick.mode !== X.open) clearPick();
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
    ${X.pick?.mode === 'wp' && X.pick.lngLat ? `
      <form class="qx-form" id="wpForm">
        <input class="input" name="name" placeholder="名稱，例如：武嶺停車場" maxlength="30" required autocomplete="off">
        <div class="qx-inline">
          <select class="input" name="kind"><option value="meet">集合點</option><option value="rest">休息點</option></select>
          <select class="input" name="radius"><option value="100">半徑 100 m</option><option value="150" selected>半徑 150 m</option><option value="300">半徑 300 m</option><option value="500">半徑 500 m</option></select>
        </div>
        <div class="qx-inline"><button type="button" class="btn" id="wpCancel">取消</button><button class="btn primary">新增</button></div>
      </form>`
    : `<button class="btn block" id="wpAdd">${X.pick?.mode === 'wp' ? '點地圖選擇位置…（再按一次取消）' : '＋ 在地圖上點選新增'}</button>`}`;
  $('#wpAdd')?.addEventListener('click', () => startPick('wp'));
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
function startPick(mode) {
  if (X.pick?.mode === mode) { clearPick(); render(); return; }
  clearPick();
  X.pick = { mode, lngLat: null };
  map.getCanvas().style.cursor = 'crosshair';
  render();
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
  X.open = X.pick.mode;
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

/* ---------- 快速訊息＋聊天室 ---------- */
// 快速訊息：一鍵警示，寫進行程事件（隊友會跳提醒）。聊天：一串對話，存在 trip:{id}:chat。
const PRESETS = ['加油', '休息一下', '等我', '有狀況', '我先走'];
const C = { items: [], more: false, loaded: false, unread: 0, draft: '' };
const msgBtn = dock.querySelector('[data-open="msg"]');
function setUnread(n) {
  C.unread = n;
  msgBtn.dataset.badge = n ? (n > 99 ? '99+' : String(n)) : '';
  msgBtn.title = n ? `訊息（${n} 則未讀）` : '快速訊息與聊天';
}
async function sendMsg(text) {
  try { await api(`/api/trips/${tid}/messages`, { method: 'POST', body: { text } }); toast(`已送出「${text}」`, { icon: '訊' }); }
  catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
}
async function loadChat(before) {
  const q = new URLSearchParams({ limit: 40 });
  if (before) q.set('before', before);
  const d = await api(`/api/trips/${tid}/chat?${q}`);
  C.items = before ? [...d.items, ...C.items] : d.items;
  C.more = d.more; C.loaded = true;
  setUnread(d.unread);
}
async function markRead() {
  const last = C.items[C.items.length - 1];
  if (!last || !C.unread) return;
  try { setUnread((await api(`/api/trips/${tid}/chat/read`, { method: 'POST', body: { id: last.id } })).unread); } catch { /* 略過 */ }
}
function chatRow(m) {
  const mine = m.uid === S.me;
  return `<div class="qc-msg${mine ? ' me' : ''}"><div class="qc-meta">${mine ? '' : `<b>${esc(nameOf(m.uid) || '隊友')}</b> `}<time>${clock(m.ts)}</time></div><div class="qc-bubble">${esc(m.text)}</div></div>`;
}
function renderChatList(stick = true) {
  const box = $('#qcList');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = (C.more ? '<button class="qc-more" id="qcMore">載入更早的訊息</button>' : '')
    + (C.items.map(chatRow).join('') || '<div class="small muted qc-empty">還沒有人說話。休息時可以在這裡聊天，回放時也看得到。</div>');
  if (stick || nearBottom) box.scrollTop = box.scrollHeight;
}
function renderMsgPanel() {
  pop.innerHTML = `
    <div class="qx-head"><b>快速訊息</b><span class="small muted">一鍵送出，隊友會跳出提醒</span></div>
    <div class="qx-presets">${PRESETS.map((t) => `<button class="btn" data-say="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div class="qx-head qc-head"><b>聊天</b><span class="small muted">全隊都看得到，也會記在回放裡</span></div>
    <div class="qc-list" id="qcList"><div class="small muted qc-empty">載入中…</div></div>
    <form class="qx-inline" id="chatForm"><input class="input" id="chatInput" name="t" maxlength="200" placeholder="說點什麼…" autocomplete="off" enterkeyhint="send"><button class="btn primary" style="flex:none">送出</button></form>`;
  const input = $('#chatInput');
  input.value = C.draft;
  input.addEventListener('input', () => { C.draft = input.value; });
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await api(`/api/trips/${tid}/chat`, { method: 'POST', body: { text } });
      input.value = C.draft = '';
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
  if (C.loaded) { renderChatList(); markRead(); }
  loadChat().then(() => { renderChatList(); markRead(); }).catch(() => { $('#qcList').innerHTML = '<div class="small muted qc-empty">聊天紀錄載入失敗</div>'; });
}
pop.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-say]');
  if (b) sendMsg(b.dataset.say);
  if (e.target.closest('#qcMore')) {
    const box = $('#qcList'), h = box.scrollHeight;
    await loadChat(C.items[0]?.id);
    renderChatList(false);
    box.scrollTop = box.scrollHeight - h;  // 停在原本看的位置
  }
});
addEventListener('qiji:msg', (e) => {
  const m = e.detail;
  if (m.kind !== 'chat' || C.items.some((x) => x.id === m.id)) return;
  if (C.loaded) C.items.push(m);
  if (X.open === 'msg') { renderChatList(m.uid === S.me); markRead(); return; }
  if (m.uid !== S.me) {
    setUnread(C.unread + 1);
    toast(`${nameOf(m.uid) || '隊友'}：${m.text}`, { icon: '聊', sub: '點左下「訊息」回覆' });
  }
});
loadChat().catch(() => {});  // 進頁面先拿未讀數

/* ---------- 地圖標註 ---------- */
const MARK = { pothole: ['坑洞', '坑'], rock: ['落石', '石'], food: ['美食', '食'], view: ['風景', '景'], other: ['其他', '註'] };
X.marks = []; X.markPins = new Map();
function drawMarks() {
  const seen = new Set();
  for (const m of X.marks) {
    seen.add(m.id);
    let p = X.markPins.get(m.id);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'qx-mark';
      el.onclick = () => { X.open = 'mark'; render(); };
      p = { el, marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([m.lon, m.lat]).addTo(map) };
      X.markPins.set(m.id, p);
    }
    p.el.dataset.kind = m.kind;
    p.el.title = `${m.label}${m.note ? '：' + m.note : ''}（${nameOf(m.by)}）`;
    p.el.innerHTML = `<b>${MARK[m.kind]?.[1] || '註'}</b>`;
  }
  for (const [id, p] of X.markPins) if (!seen.has(id)) { p.marker.remove(); X.markPins.delete(id); }
}
async function loadMarks() { try { X.marks = await api(`/api/trips/${tid}/marks`); drawMarks(); } catch { /* 略過 */ } }
function renderMarkPanel() {
  const canDel = (m) => m.by === S.me || S.trip?.is_owner;
  pop.innerHTML = `
    <div class="qx-head"><b>地圖標註</b><span class="small muted">坑洞、落石會在隊友騎到前方 300 m 時提醒</span></div>
    <div class="qx-list">${X.marks.map((m) => `<div class="qx-row" data-lon="${m.lon}" data-lat="${m.lat}" data-goto="1">
      <span class="qx-mark static" data-kind="${m.kind}"><b>${MARK[m.kind]?.[1] || '註'}</b></span>
      <div class="grow"><div class="t1">${esc(m.label)}${m.note ? '：' + esc(m.note) : ''}</div><div class="t2">${esc(nameOf(m.by))}</div></div>
      ${canDel(m) ? `<button class="qx-x" data-delmark="${m.id}">刪除</button>` : ''}</div>`).join('') || '<div class="small muted" style="padding:6px 2px">還沒有標註</div>'}</div>
    ${X.pick?.mode === 'mark' && X.pick.lngLat ? `
      <form class="qx-form" id="markForm">
        <div class="qx-kinds">${Object.entries(MARK).map(([k, [n]], i) => `<label><input type="radio" name="kind" value="${k}"${i ? '' : ' checked'}><span>${n}</span></label>`).join('')}</div>
        <input class="input" name="note" maxlength="40" placeholder="說明（可不填）" autocomplete="off">
        <div class="qx-inline"><button type="button" class="btn" id="markCancel">取消</button><button class="btn primary">標註</button></div>
      </form>`
    : `<div class="qx-inline"><button class="btn" id="markHere">標在我的位置</button><button class="btn" id="markAdd">${X.pick?.mode === 'mark' ? '點地圖…（取消）' : '在地圖上點選'}</button></div>`}`;
  $('#markAdd')?.addEventListener('click', () => startPick('mark'));
  $('#markHere')?.addEventListener('click', () => {
    const me = S.members.get(S.me);
    if (!me?.pos) { toast('還沒有你的位置，先到「回報」分頁開始定位', { icon: '!', color: '#ff9f0a' }); return; }
    X.pick = { mode: 'mark', lngLat: { lng: me.pos[0], lat: me.pos[1] } };
    render();
  });
  $('#markCancel')?.addEventListener('click', () => { clearPick(); render(); });
  $('#markForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/api/trips/${tid}/marks`, { method: 'POST', body: { kind: f.get('kind'), note: f.get('note'), lat: X.pick.lngLat.lat, lon: X.pick.lngLat.lng } });
      clearPick(); render();
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
}
pop.addEventListener('click', async (e) => {
  const d = e.target.closest('[data-delmark]');
  if (d) {
    e.stopPropagation();
    if (d.dataset.confirm !== '1') { d.dataset.confirm = '1'; d.textContent = '確定？'; return; }
    try { await api(`/api/trips/${tid}/marks/${d.dataset.delmark}`, { method: 'DELETE' }); } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    return;
  }
  const g = e.target.closest('[data-goto]');
  if (g) { S.lastInteract = Date.now(); M.unfollow(); map.easeTo({ center: [+g.dataset.lon, +g.dataset.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 900 }); }
});

/* ---------- SOS：長按 1.5 秒發出，橫幅一直顯示到本人解除 ---------- */
const sosBtn = $('#qxSos');
const banner = document.createElement('div');
banner.className = 'qx-sosbar';
banner.hidden = true;
document.body.append(banner);
X.sos = [];
let hold = null;
function mineSos() { return X.sos.find((e) => e.uid === S.me); }
function syncSosBtn() { sosBtn.classList.toggle('active', !!mineSos()); sosBtn.querySelector('span').textContent = mineSos() ? '解除' : 'SOS'; }
sosBtn.addEventListener('pointerdown', (e) => {
  if (mineSos()) return;
  e.preventDefault();
  sosBtn.classList.add('holding');
  hold = setTimeout(async () => {
    hold = null; sosBtn.classList.remove('holding');
    try { await api(`/api/trips/${tid}/sos`, { method: 'POST' }); navigator.vibrate?.(300); }
    catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  }, 1500);
});
const stopHold = () => { if (hold) { clearTimeout(hold); hold = null; sosBtn.classList.remove('holding'); toast('SOS 要按住 1.5 秒才會發出', { icon: 'S', color: '#ff3b30' }); } };
sosBtn.addEventListener('pointerup', stopHold);
sosBtn.addEventListener('pointerleave', stopHold);
sosBtn.addEventListener('click', async () => {
  if (!mineSos()) return;
  if (sosBtn.dataset.confirm !== '1') { sosBtn.dataset.confirm = '1'; sosBtn.querySelector('span').textContent = '確定？'; setTimeout(() => { sosBtn.dataset.confirm = ''; syncSosBtn(); }, 3000); return; }
  sosBtn.dataset.confirm = '';
  try { await api(`/api/trips/${tid}/sos`, { method: 'DELETE' }); } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
});
function kmFromMe(lon, lat) {
  const me = S.members.get(S.me);
  if (!me?.pos || lon == null) return null;
  return new maplibregl.LngLat(me.pos[0], me.pos[1]).distanceTo(new maplibregl.LngLat(+lon, +lat)) / 1000;
}
function renderSos() {
  syncSosBtn();
  banner.hidden = !X.sos.length;
  banner.innerHTML = X.sos.map((e) => {
    const km = e.uid === S.me ? null : kmFromMe(e.lon, e.lat);
    return `<div class="qx-sosrow"><b>SOS</b><div class="grow"><div class="t1">${esc(nameOf(e.uid) || '隊友')} 需要幫忙</div>
      <div class="t2">${clock(+e.ts)}${km != null ? ` · 距離我 ${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km'}` : ''}${e.lat == null ? ' · 沒有位置' : ''}</div></div>
      ${e.lat != null ? `<button class="btn" data-sosgo="${e.lon},${e.lat}">看位置</button>` : ''}</div>`;
  }).join('');
}
banner.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sosgo]');
  if (!b) return;
  const [lon, lat] = b.dataset.sosgo.split(',').map(Number);
  S.lastInteract = Date.now(); M.unfollow();
  map.easeTo({ center: [lon, lat], zoom: 16, duration: 900 });
});
async function loadSos() { try { X.sos = await api(`/api/trips/${tid}/sos`); renderSos(); } catch { /* 略過 */ } }
setInterval(() => { if (X.sos.length) renderSos(); }, 5000); // 距離會變

/* ---------- 路線（M4）：路線線條、全隊進度條、我的下一個轉彎 ---------- */
X.route = null; X.prog = {}; // uid → { km, off }
const turnCard = document.createElement('div');
turnCard.className = 'qx-turn glass';
turnCard.hidden = true;
document.body.append(turnCard);

const routeGeo = () => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: X.route?.coords || [] } });
M.onStyle(() => {
  if (!map.getSource('qx-route')) map.addSource('qx-route', { type: 'geojson', data: routeGeo() });
  const before = map.getLayer('trails-casing') ? 'trails-casing' : undefined; // 路線畫在大家的軌跡下面
  if (!map.getLayer('qx-route-casing')) map.addLayer({ id: 'qx-route-casing', type: 'line', source: 'qx-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#04204a', 'line-width': 11, 'line-opacity': 0.75 } }, before);
  if (!map.getLayer('qx-route')) map.addLayer({ id: 'qx-route', type: 'line', source: 'qx-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3d9bff', 'line-width': 6, 'line-opacity': 0.9 } }, before);
});

async function loadRoute() {
  try { const r = await api(`/api/trips/${tid}/route`); X.route = r?.coords ? r : null; } catch { X.route = null; }
  for (const m of S.members.values()) {
    const st = m.state || {};
    if (st.route_km) X.prog[m.u.uid] = { km: +st.route_km, off: +st.off_m || 0 };
  }
  map.getSource('qx-route')?.setData(routeGeo());
  renderProgress();
  if (X.open === 'route') render();
}

// 集合點投影到路線上（前端算就好：點數少）
function routeKmOf(lon, lat) {
  const c = X.route.coords, cum = X.route.cum_km, kx = Math.cos((lat * Math.PI) / 180);
  let best = [Infinity, 0];
  for (let i = 0; i < c.length; i++) {
    const dx = (c[i][0] - lon) * kx, dy = c[i][1] - lat, d = dx * dx + dy * dy;
    if (d < best[0]) best = [d, i];
  }
  return cum[best[1]];
}
// 預估速度：自己有平均速度就用自己的，否則用路線的預估
function speedKmh(uid) {
  const avg = S.members.get(uid)?.u.stats?.avg_kmh;
  // 沒有即時平均速度時，用規劃時「依建立者的速度」的預估（有的話），否則用一般估計
  const s = X.route?.summary;
  return avg && avg > 8 ? avg : s ? (s.km / Math.max(1, s.min_personal || s.min)) * 60 : 40;
}
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 100 ? 1 : 0)} km`);
const etaClock = (min) => clock(Date.now() + min * 60000);

function renderProgress() {
  const bar = $('#qxProg');
  if (!X.route) { bar.hidden = true; turnCard.hidden = true; return; }
  const total = X.route.cum_km.at(-1);
  const riders = [...S.members.values()].filter((m) => X.prog[m.u.uid] && m.u.active);
  const ticks = X.wps.map((w) => ({ w, km: routeKmOf(w.lon, w.lat) }));
  const me = X.prog[S.me];
  const left = me ? total - me.km : null;
  bar.hidden = false;
  bar.innerHTML = `
    <div class="qx-prog-h"><b>全隊進度</b><span>${me ? `我 ${fmtKm(me.km)} / ${fmtKm(total)} · 剩 ${fmtKm(left)} · 約 ${etaClock((left / speedKmh(S.me)) * 60)} 到` : `全長 ${fmtKm(total)}`}</span></div>
    <div class="qx-track">
      ${ticks.map(({ w, km }) => `<i class="qx-tick" data-kind="${w.kind}" style="left:${(km / total) * 100}%" title="${esc(w.name)} · ${fmtKm(km)}"></i>`).join('')}
      ${riders.map((m) => `<b class="qx-dot${m.u.uid === S.me ? ' me' : ''}${X.prog[m.u.uid].off > 150 ? ' off' : ''}" style="left:${Math.min(100, (X.prog[m.u.uid].km / total) * 100)}%;--c:${m.u.color}" title="${esc(m.u.nickname)} · ${fmtKm(X.prog[m.u.uid].km)}"></b>`).join('')}
    </div>`;
  renderTurn();
}

const ARROW = { 7: '↑', 8: '↑', 22: '↑', 9: '↗', 10: '↱', 11: '↱', 12: '⤸', 13: '⤹', 14: '↰', 15: '↰', 16: '↖', 23: '↗', 24: '↖', 26: '⟳', 27: '⟳', 4: '⚑', 5: '⚑', 6: '⚑', 36: '⚑' };
function renderTurn() {
  const me = X.prog[S.me];
  if (!X.route || !me || S.trip?.status !== 'live' || !S.members.get(S.me)?.u.active) { turnCard.hidden = true; return; }
  turnCard.hidden = false;
  if (me.off > 150) {
    turnCard.className = 'qx-turn glass off';
    turnCard.innerHTML = `<b>!</b><div><div class="d">偏離路線 ${fmtKm(me.off / 1000)}</div><div class="s">回到藍色路線上就會繼續提示</div></div>`;
    return;
  }
  const next = X.route.maneuvers.find((m) => m.km > me.km + 0.02 && ![1, 2, 3].includes(m.type));
  turnCard.className = 'qx-turn glass';
  if (!next) { turnCard.innerHTML = `<b>⚑</b><div><div class="d">快到終點了</div></div>`; return; }
  turnCard.innerHTML = `<b>${ARROW[next.type] || '↑'}</b><div><div class="d">${fmtKm(next.km - me.km)} 後 ${esc(next.act)}</div><div class="s">${esc(next.street || '')}</div></div>`;
}

function renderRoutePanel() {
  const owner = S.trip?.is_owner;
  if (!X.route) {
    pop.innerHTML = `<div class="qx-head"><b>路線</b><span class="small muted">這個行程還沒有路線（臨時開團）：落隊用直線距離判斷</span></div>
      ${owner ? `<a class="btn primary block" href="/plan?trip=${tid}">規劃路線</a>` : '<div class="small muted">建立者可以在「規劃路線」設定</div>'}`;
    return;
  }
  const s = X.route.summary, total = X.route.cum_km.at(-1);
  const rows = [...S.members.values()].filter((m) => X.prog[m.u.uid]).sort((a, b) => X.prog[b.u.uid].km - X.prog[a.u.uid].km).map((m) => {
    const p = X.prog[m.u.uid], left = total - p.km, done = !m.u.active;
    return `<div class="qx-row"><span class="qx-dot static" style="--c:${m.u.color}"></span><div class="grow"><div class="t1">${esc(m.u.nickname)}${p.off > 150 ? ' <span class="chip warn">偏離路線</span>' : ''}</div>
      <div class="t2">${fmtKm(p.km)} / ${fmtKm(total)}${done ? ' · 已結束' : ` · 剩 ${fmtKm(left)} · 約 ${etaClock((left / speedKmh(m.u.uid)) * 60)} 到`}</div></div></div>`;
  }).join('');
  pop.innerHTML = `
    <div class="qx-head"><b>路線</b><span class="small muted">${s.km.toFixed(1)} km · 預估 ${Math.floor(s.min / 60)}:${String(s.min % 60).padStart(2, '0')} · ${{ scooter: '機車', heavy: '重機', car: '汽車' }[X.route.vehicle || (X.route.avoid_highways === false ? 'heavy' : 'scooter')]} · 落隊改用沿路線距離</span></div>
    <div class="qx-list">${rows || '<div class="small muted" style="padding:6px 2px">還沒有人開始回報位置</div>'}</div>
    <a class="btn block" href="/plan?trip=${tid}">${owner ? '修改路線' : '看路線規劃'}</a>`;
}
setInterval(() => { if (X.route) { renderProgress(); if (X.open === 'route') renderRoutePanel(); } }, 2000);

/* ---------- WebSocket 訊息 ---------- */
addEventListener('qiji:msg', (e) => {
  const msg = e.detail;
  if (msg.kind === 'waypoints') { X.wps = msg.items; drawWps(); if (X.open === 'wp' && !X.pick?.lngLat) render(); }
  if (msg.kind === 'marks') { X.marks = msg.items; drawMarks(); if (X.open === 'mark' && !X.pick?.lngLat) render(); }
  if (msg.kind === 'hazard' && msg.uid === S.me) {
    toast(`前方 ${msg.dist_m} m 有${msg.label}${msg.note ? '：' + msg.note : ''}`, { icon: '!', color: '#ff9f0a', sub: `${nameOf(msg.by)} 標註的` });
  }
  if (msg.kind === 'event' && (msg.type === 'sos' || msg.type === 'sos_off')) loadSos();
  if (msg.kind === 'snapshot') { loadWps(); loadMarks(); loadSos(); loadRoute(); }
  if (msg.kind === 'route') { X.prog = {}; loadRoute(); }
  if (msg.kind === 'progress') { X.prog[msg.uid] = { km: msg.km, off: msg.off_m }; if (msg.uid === S.me) renderTurn(); }
  if (msg.kind === 'speedcam' && msg.uid === S.me) camAlert(msg);
});

loadWps();
loadMarks();
loadSos();
loadRoute();
window.qijiExtra = X; // 除錯用

/* ---------- 推播通知（回報分頁） ---------- */
mountPushCard(document.getElementById('pushCard'));

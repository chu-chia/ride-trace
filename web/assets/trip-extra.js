// 行程頁的 M3／M4 功能：集合點、前方測速、快速訊息、地圖標註、SOS、路線（進度條、轉彎提示）。
// 和 trip.js 分開放，避免和畫面設計的改動互相衝突。trip.js 只提供三個掛鉤：
//   window.qijiM（地圖包裝）、window.qijiState（頁面狀態）、window 的 'qiji:msg' 事件（每則 WebSocket 訊息）
import { api, tripGate, armConfirm, $, esc, toast, clock, ago, avatar } from '/assets/common.js';
import { mountPushCard } from '/assets/push.js';

const tid = new URLSearchParams(location.search).get('id');
// 和 trip.js 共用同一次檢查：不是成員就不發集合點／SOS／聊天這些請求（不會留下一串 403，UX-02）。
// trip.js 也在等同一個 Promise、而且先註冊，所以這裡接著跑時 window.qijiM 已經設好了
await tripGate(tid);
const M = window.qijiM, map = window.qijiMap, S = window.qijiState;
const X = { wps: [], pins: new Map(), open: null, pick: null };
// 集合點給 trip.js 的「出發前／集合」清單用（到集合點幾個人）
const shareWps = () => { S.wps = X.wps; dispatchEvent(new Event('qiji:wps')); };
const KIND = { meet: '集合點', rest: '休息點' };
const nameOf = (uid) => S.members.get(uid)?.u.nickname || '';

/* ---------- 面板分頁：保留原功能渲染與事件處理，將內容掛進對應容器 ---------- */
const pop = document.createElement('div');
pop.id = 'qxPop';
pop.className = 'qx-pop';
const targets = { route: '#routeContent', wp: '#wpContent', msg: '#msgContent', mark: '#markContent', cam: '#camContent' };
addEventListener('qiji:tab', (e) => {
  X.open = e.detail.tab === 'more' ? (e.detail.more === 'cam' ? 'cam' : null) : (targets[e.detail.tab] ? e.detail.tab : null);
  render();
});
function openTab(tab) { dispatchEvent(new CustomEvent('qiji:open-tab', { detail: { tab } })); }

function render() {
  if (X.open) $(targets[X.open])?.append(pop);
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
      el.onclick = () => openTab('wp');
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
    <div class="qx-head"><b>集合點與休息點</b></div>
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
    : `<div class="qx-inline"><button class="btn" id="wpHere">用我的位置</button><button class="btn" id="wpAdd">${X.pick?.mode === 'wp' ? '點地圖…（取消）' : '在地圖上點選'}</button></div>`}`;
  $('#wpAdd')?.addEventListener('click', () => startPick('wp'));
  $('#wpHere')?.addEventListener('click', () => pickMine('wp'));
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
// 在地圖上點選位置：手機的抽屜會蓋住大半張地圖，進入點選時先收起來，上方浮一條提示（可取消）；選好再展開填表（UX-34）
const PICK_TEXT = { wp: '點地圖選擇集合點的位置', mark: '點地圖選擇標註的位置' };
function startPick(mode) {
  if (X.pick?.mode === mode) { clearPick(); render(); return; }
  clearPick();
  X.pick = { mode, lngLat: null };
  map.getCanvas().style.cursor = 'crosshair';
  if (innerWidth <= 760 && S.panel && !S.panel.small) { S.panel.set(true, false); X.pick.reopen = true; }
  showPickHint(PICK_TEXT[mode]);
  render();
}
function showPickHint(text) {
  hidePickHint();
  const el = document.createElement('div');
  el.id = 'qxPickHint';
  el.className = 'qx-pickhint glass';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(text)}</span><button type="button" class="btn">取消</button>`;
  el.querySelector('button').onclick = () => { const reopen = X.pick?.reopen; clearPick(); if (reopen) S.panel?.set(false, false); render(); };
  document.body.append(el);
}
function hidePickHint() { document.getElementById('qxPickHint')?.remove(); }
function clearPick() { X.pick = null; X.pickMarker?.remove(); X.pickMarker = null; map.getCanvas().style.cursor = ''; hidePickHint(); }
// 「用我的位置」：集合點、標註共用
function pickMine(mode) {
  const me = S.members.get(S.me);
  if (!me?.pos) { toast('還沒有你的位置，先到「更多 → 裝置與通知」開始定位', { icon: '!', color: '#ff9f0a' }); return; }
  clearPick();
  X.pick = { mode, lngLat: { lng: me.pos[0], lat: me.pos[1] } };
  X.pickMarker = pickPin(X.pick.lngLat);
  render();
}
function pickPin(lngLat) {
  const el = document.createElement('div'); el.className = 'qx-pin pick'; el.innerHTML = '<b>＋</b>';
  return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
}

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
    if (w) { S.goAway(); map.easeTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 15), duration: 900 }); }
  }
});

map.on('click', (e) => {
  if (!X.pick) return;
  X.pick.lngLat = e.lngLat;
  X.open = X.pick.mode;
  S.goAway();
  X.pickMarker?.remove();
  X.pickMarker = pickPin(e.lngLat);
  map.getCanvas().style.cursor = '';
  hidePickHint();
  if (X.pick.reopen) { X.pick.reopen = false; S.panel?.set(false, false); }
  render();
});

async function loadWps() {
  try { X.wps = await api(`/api/trips/${tid}/waypoints`); shareWps(); drawWps(); if (X.open === 'wp') render(); } catch { /* 不是成員或網路錯誤時 trip.js 會處理 */ }
}

/* ---------- 測速照相 ---------- */
// 地圖：畫面附近的測速點（GEOSEARCH）；縮太小就不顯示。
// 城市視角一次會有一百多個，逐一畫會整片都是數字（UX-19）：依縮放層級用固定網格聚合（網格釘在世界座標上，平移時不會跳），
// 一格只有一個才畫速限，多個就畫深色的數字圓（和白底的速限分得開），點了放大兩級
X.cams = new Map();        // 單獨顯示的測速點 id → { cam, el, marker }（camAlert 用它標「經過了」）
X.camGroups = new Map();   // 聚合圓 key → { el, marker }
X.camList = [];
const CAM_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>';
const CAM_CELL = (z) => (z < 12 ? 120 : z < 13 ? 100 : z < 14 ? 72 : 56);   // 一格多大（px）：越遠格子越大
function drawCams() {
  const z = Math.floor(map.getZoom());
  const cell = CAM_CELL(z) / (512 * 2 ** z);   // 換成 Mercator 0～1 座標
  const groups = new Map();
  for (const cam of X.camList) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([cam.lon, cam.lat]);
    const key = `${z}:${Math.floor(m.x / cell)}:${Math.floor(m.y / cell)}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(cam);
  }
  const singles = new Set(), multi = new Set();
  for (const [key, list] of groups) {
    if (list.length === 1) { singles.add(list[0].id); continue; }
    multi.add(key);
    if (X.camGroups.has(key)) { X.camGroups.get(key).el.querySelector('b').textContent = list.length; continue; }
    const lon = list.reduce((a, c) => a + c.lon, 0) / list.length, lat = list.reduce((a, c) => a + c.lat, 0) / list.length;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'qx-cam group';
    el.title = `這附近有 ${list.length} 個測速照相，點一下放大`;
    el.setAttribute('aria-label', el.title);
    el.innerHTML = `${CAM_ICO}<b>${list.length}</b>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); map.easeTo({ center: [lon, lat], zoom: Math.min(16, map.getZoom() + 2) }); });
    X.camGroups.set(key, { el, marker: new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map) });
  }
  for (const [key, g] of X.camGroups) if (!multi.has(key)) { g.marker.remove(); X.camGroups.delete(key); }
  for (const [id, m] of X.cams) if (!singles.has(id)) { m.marker.remove(); X.cams.delete(id); }
  for (const cam of X.camList) {
    if (!singles.has(cam.id) || X.cams.has(cam.id)) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'qx-cam';
    el.title = `測速照相：${cam.addr}（${cam.direct}，速限 ${cam.limit}）`;
    el.setAttribute('aria-label', el.title);
    el.innerHTML = `<b>${cam.limit}</b>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); toast(`測速照相・速限 ${cam.limit}`, { icon: '速', color: '#e5352b', sub: [cam.addr, cam.direct].filter(Boolean).join('・'), ms: 4000 }); });
    X.cams.set(cam.id, { cam, el, marker: new maplibregl.Marker({ element: el }).setLngLat([cam.lon, cam.lat]).addTo(map) });
  }
}
async function loadCams() {
  if (map.getZoom() < 11) { X.camList = []; drawCams(); return; }
  const b = map.getBounds(), c = map.getCenter();
  const km = Math.min(30, Math.max(1, b.getNorthEast().distanceTo(b.getSouthWest()) / 2000));
  let list;
  try { list = await api(`/api/speedcam/near?lon=${c.lng.toFixed(5)}&lat=${c.lat.toFixed(5)}&km=${km.toFixed(1)}`); } catch { return; }
  X.camList = list;
  drawCams();
  camHint();
}
// 第一次看到測速點時說明一次（紅框數字像隊友或事件數，第一次來看不懂）；導航中不跳
function camHint() {
  if (!X.camList.length || document.body.classList.contains('nav')) return;
  try { if (localStorage.getItem('qiji:camHint')) return; localStorage.setItem('qiji:camHint', '1'); } catch { return; }
  toast('地圖上紅框的數字是測速照相的速限', { icon: '速', color: '#e5352b', sub: '相機圖示＋數字＝那一帶有幾支，點一下放大；騎到前方 1 公里會提醒', ms: 8000 });
}
// 跟隨模式每一格都 jumpTo（每一格都有 moveend），不能用「停下來再載」；改成每 2 秒看一次，移動超過 300 m 或縮放改變才重載
let camAt = null;
setInterval(() => {
  const c = map.getCenter(), z = Math.floor(map.getZoom());
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
  if (!camMeta) api('/api/speedcam/meta').then((m) => { camMeta = m; if (X.open === 'cam') $('.qx-head .small', pop).textContent = `${m.source} · ${m.count} 個 · 更新 ${new Date(m.updated).toLocaleDateString('zh-TW')}`; }).catch(() => {});
}
pop.addEventListener('click', (e) => {
  const row = e.target.closest('[data-cam]');
  if (!row) return;
  S.goAway();
  map.easeTo({ center: [+row.dataset.lon, +row.dataset.lat], zoom: 15.5, duration: 900 });
});

/* ---------- 快速訊息＋聊天室 ---------- */
// 快速訊息：一鍵警示，寫進行程事件（隊友會跳提醒）。聊天：一串對話，存在 trip:{id}:chat。
const PRESETS = ['加油', '休息一下', '等我', '有狀況', '我先走'];
const C = { items: [], more: false, loaded: false, unread: 0, draft: '' };
const msgBtn = $('#tabs [data-t="msg"]');
function setUnread(n) {
  C.unread = n;
  msgBtn.dataset.badge = n ? (n > 99 ? '99+' : String(n)) : '';
  msgBtn.title = n ? `訊息（${n} 則未讀）` : '快速訊息與聊天';
  // 徽章是 CSS 偽元素，螢幕報讀器念不到：另外放一段看不見的文字（UX-57）
  msgBtn.innerHTML = `訊息${n ? `<span class="srOnly">（${n} 則未讀）</span>` : ''}`;
}
// 斷網（隧道、山區）時送不出去的快速訊息和聊天先存在這支手機（sessionStorage），恢復連線後依序補送（UX-56）
const OUT_KEY = `qiji:outbox:${tid}`;
let outbox = [];
try { outbox = JSON.parse(sessionStorage.getItem(OUT_KEY) || '[]'); } catch { outbox = []; }
const saveOutbox = () => { try { sessionStorage.setItem(OUT_KEY, JSON.stringify(outbox)); } catch { /* 私密模式 */ } };
const PATH = { msg: 'messages', chat: 'chat' };
function queueOut(kind, text) {
  outbox.push({ kind, text, at: Date.now() });
  saveOutbox();
  toast(`沒有網路，「${text}」先存在手機，恢復連線後自動送出`, { icon: '!', color: '#ff9f0a' });
  renderOutbox();
}
let flushing = false;
async function flushOutbox() {
  if (flushing || !outbox.length || navigator.onLine === false) return;
  flushing = true;
  let sent = 0;
  try {
    while (outbox.length) {
      const o = outbox[0];
      try { await api(`/api/trips/${tid}/${PATH[o.kind]}`, { method: 'POST', body: { text: o.text } }); sent++; }
      catch (err) {
        if (err.net) break;  // 還是連不上：留著下次再送
        toast(`「${o.text}」送不出去：${err.message}`, { icon: '!', color: '#ff3b30' });  // 例如行程已結束：丟掉，不要一直重試
      }
      outbox.shift(); saveOutbox();
      if (outbox.length) await new Promise((ok) => setTimeout(ok, 2100));  // 快速訊息 2 秒只能發一則
    }
  } finally { flushing = false; renderOutbox(); }
  if (sent) toast(`已補送 ${sent} 則訊息`, { icon: '訊' });
}
addEventListener('online', () => setTimeout(flushOutbox, 1500));
setInterval(flushOutbox, 10000);
function renderOutbox() {
  const el = $('#qcOutbox');
  if (!el) return;
  el.hidden = !outbox.length;
  el.innerHTML = outbox.length ? `待送 ${outbox.length} 則：${outbox.map((o) => `「${esc(o.text)}」`).join('、')}，恢復連線後自動送出 <button type="button" class="qc-more" id="qcRetry">現在重試</button>` : '';
}
async function sendMsg(text) {
  if (outbox.length) { queueOut('msg', text); flushOutbox(); return; }  // 前面還有沒送出的：排在後面，順序才不會亂
  try { await api(`/api/trips/${tid}/messages`, { method: 'POST', body: { text } }); toast(`已送出「${text}」`, { icon: '訊' }); }
  catch (err) { if (err.net) queueOut('msg', text); else toast(err.message, { icon: '!', color: '#ff3b30' }); }
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
  // 照原型：別人的訊息左邊放頭像、上面一行「名字・時間」；自己的靠右、橘色泡泡
  const mine = m.uid === S.me, u = S.members.get(m.uid)?.u;
  const av = mine ? '' : avatar(u || { nickname: nameOf(m.uid) || '隊友', color: '#8e8e93' });
  return `<div class="qc-msg${mine ? ' me' : ''}">${av}<div><div class="qc-meta">${mine ? '' : `<b>${esc(nameOf(m.uid) || '隊友')}</b>・`}<time>${clock(m.ts)}</time></div><div class="qc-bubble">${esc(m.text)}</div></div></div>`;
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
    <div class="qx-head"><b>快速訊息</b><small>一鍵通知全隊</small></div>
    <div class="qx-presets">${PRESETS.map((t) => `<button class="btn" data-say="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div class="qx-head qc-head"><b>聊天</b></div>
    <div class="qc-list" id="qcList"><div class="small muted qc-empty">載入中…</div></div>
    <div class="small qc-outbox" id="qcOutbox" role="status" hidden></div>
    <form class="qx-inline qc-form" id="chatForm"><input class="input" id="chatInput" name="t" maxlength="200" placeholder="說點什麼…" autocomplete="off" enterkeyhint="send"><button class="btn primary" style="flex:none">送出</button></form>`;
  const input = $('#chatInput');
  input.value = C.draft;
  input.addEventListener('input', () => { C.draft = input.value; });
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (outbox.length) { queueOut('chat', text); input.value = C.draft = ''; flushOutbox(); return; }
    try {
      await api(`/api/trips/${tid}/chat`, { method: 'POST', body: { text } });
      input.value = C.draft = '';
    } catch (err) {
      if (err.net) { queueOut('chat', text); input.value = C.draft = ''; }
      else toast(err.message, { icon: '!', color: '#ff3b30' });
    }
  });
  renderOutbox();
  if (C.loaded) { renderChatList(); markRead(); }
  loadChat().then(() => { renderChatList(); markRead(); }).catch(() => { $('#qcList').innerHTML = '<div class="small muted qc-empty">聊天紀錄載入失敗</div>'; });
}
pop.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-say]');
  if (b) sendMsg(b.dataset.say);
  if (e.target.closest('#qcRetry')) flushOutbox();
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
    toast(`${nameOf(m.uid) || '隊友'}：${m.text}`, { icon: '聊', sub: '打開面板「訊息」回覆' });
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
      el.onclick = () => openTab('mark');
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
    <div class="qx-head"><b>地圖標註</b></div>
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
  $('#markHere')?.addEventListener('click', () => pickMine('mark'));
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
  if (g) { S.goAway(); map.easeTo({ center: [+g.dataset.lon, +g.dataset.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 900 }); }
});

/* ---------- SOS：長按 1.5 秒發出，橫幅一直顯示到本人解除 ---------- */
const sosBtn = $('#qxSos');
const sosOpen = $('#sosOpen');
const sosDialog = $('#sosDialog');
const closeSosDialog = () => { sosDialog.hidden = true; sosOpen.focus(); };
sosOpen.addEventListener('click', () => { sosDialog.hidden = false; sosBtn.focus(); });
$('#sosClose').addEventListener('click', closeSosDialog);
sosDialog.addEventListener('click', (e) => { if (e.target === sosDialog) closeSosDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sosDialog.hidden) closeSosDialog(); });
const banner = document.createElement('div');
banner.className = 'qx-sosbar';
banner.hidden = true;
document.body.append(banner);
X.sos = [];
let hold = null;
function mineSos() { return X.sos.find((e) => e.uid === S.me); }
const HOLD_MS = 1500;
const sosHint = $('#sosHint');
function syncSosBtn() {
  const on = !!mineSos();
  sosOpen.textContent = on ? '解除' : 'SOS'; sosOpen.setAttribute('aria-label', on ? '開啟解除求救選單' : '開啟緊急求救選單');
  sosHint.textContent = on ? '你的 SOS 還在，隊友都看得到。沒事了就點一下按鈕，再點一次確認解除，隊友會收到「SOS 解除」。'
    : '按住不放 1.5 秒，圓環填滿就會發出，全隊都會收到通知和你的位置。';
  if (sosBtn.dataset.armed === '1' || hold) return;  // 正在確認解除／正在長按：不要洗掉倒數
  sosBtn.classList.toggle('active', on);
  sosBtn.querySelector('span').textContent = on ? '解除求救' : '按住 1.5 秒發出 SOS';
}
// 長按：按鈕裡的圓環和底色跟著填滿，旁邊倒數秒數（UX-22）
function beginSosHold() {
  if (mineSos() || hold) return;
  sosBtn.classList.add('holding');
  const t0 = performance.now(), span = sosBtn.querySelector('span');
  const step = (now) => {
    if (!hold) return;
    const k = Math.min(1, (now - t0) / HOLD_MS);
    sosBtn.style.setProperty('--p', k.toFixed(3));
    span.textContent = k < 1 ? `繼續按住… ${((HOLD_MS * (1 - k)) / 1000).toFixed(1)} 秒` : '發出中…';
    if (k < 1) hold.raf = requestAnimationFrame(step);
  };
  hold = { raf: 0, timer: setTimeout(async () => {
    cancelAnimationFrame(hold?.raf); hold = null; sosBtn.classList.remove('holding'); sosBtn.style.setProperty('--p', 0);
    try { await api(`/api/trips/${tid}/sos`, { method: 'POST' }); navigator.vibrate?.(300); }
    catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    syncSosBtn();
  }, HOLD_MS) };
  hold.raf = requestAnimationFrame(step);
}
sosBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); beginSosHold(); });
const stopHold = () => {
  if (!hold) return;
  clearTimeout(hold.timer); cancelAnimationFrame(hold.raf); hold = null;
  sosBtn.classList.remove('holding'); sosBtn.style.setProperty('--p', 0);
  syncSosBtn();
  toast('SOS 要按住 1.5 秒（圓環填滿）才會發出', { icon: 'S', color: '#ff3b30' });
};
sosBtn.addEventListener('pointerup', stopHold);
sosBtn.addEventListener('pointerleave', stopHold);
sosBtn.addEventListener('pointercancel', stopHold);
sosBtn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); beginSosHold(); } });
sosBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stopHold(); } });
// 解除：第一次點換成「再點一次解除 SOS」＋6 秒倒數條，時間到恢復（UX-22）
sosBtn.addEventListener('click', () => {
  if (!mineSos()) return;
  armConfirm(sosBtn, '再點一次解除 SOS', async () => {
    try {
      await api(`/api/trips/${tid}/sos`, { method: 'DELETE' });
      if (!sosDialog.hidden) closeSosDialog();  // 解除成功就關掉對話框，不要停在「按住 1.5 秒發出 SOS」
      toast('已解除 SOS，隊友會收到「沒事了」', { icon: '✓', color: '#30d158', ms: 4000 });
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    syncSosBtn();
  });
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
    // 位置是發出時伺服器上最後一個點；超過 1 分鐘就寫「最後位置 N 前」（UX-04）
    const old = e.pos_ts && Date.now() - +e.pos_ts > 60000 ? ` · 最後位置 ${ago(+e.pos_ts)}` : '';
    return `<div class="qx-sosrow"><b>SOS</b><div class="grow"><div class="t1">${esc(nameOf(e.uid) || '隊友')} 需要幫忙</div>
      <div class="t2">${clock(+e.ts)}${km != null ? ` · 距離我 ${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km'}` : ''}${old}${e.lat == null ? ' · 沒有位置紀錄' : ''}</div></div>
      ${e.lat != null ? `<button class="btn" data-sosgo="${e.lon},${e.lat}">看位置</button>` : ''}</div>`;
  }).join('');
}
banner.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sosgo]');
  if (!b) return;
  const [lon, lat] = b.dataset.sosgo.split(',').map(Number);
  S.goAway();
  map.easeTo({ center: [lon, lat], zoom: 16, duration: 900 });
});
async function loadSos() { try { X.sos = await api(`/api/trips/${tid}/sos`); renderSos(); } catch { /* 略過 */ } }
setInterval(() => { if (X.sos.length) renderSos(); }, 5000); // 距離會變

/* ---------- 路線（M4）：路線線條、全隊進度條、我的下一個轉彎 ---------- */
X.route = null; X.prog = {}; // uid → { km（全隊路線上的里程）, off, nkm（走個人路線時，個人路線上的里程） }
X.nav = null; // 偏離後幫我重算的個人路線（到下一個停靠點）；有它時轉彎提示照它，全隊路線改畫虛線
X.offSince = 0; X.rerouting = false; X.lastReroute = 0;
const REROUTE_AFTER_MS = 10000;   // 偏離持續 10 秒才重算（剛好經過路口、GPS 飄一下不會亂算）
const REROUTE_COOLDOWN_MS = 30000; // 兩次重算至少隔 30 秒
const turnCard = $('#qxTurn');

const routeGeo = () => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: X.route?.coords || [] } });
const navGeo = () => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: X.nav?.coords || [] } });
M.onStyle(() => {
  if (!map.getSource('qx-route')) map.addSource('qx-route', { type: 'geojson', data: routeGeo() });
  const before = map.getLayer('trails-casing') ? 'trails-casing' : undefined; // 路線畫在大家的軌跡下面
  if (!map.getLayer('qx-route-casing')) map.addLayer({ id: 'qx-route-casing', type: 'line', source: 'qx-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#04204a', 'line-width': 11, 'line-opacity': 0.75 } }, before);
  if (!map.getLayer('qx-route')) map.addLayer({ id: 'qx-route', type: 'line', source: 'qx-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3d9bff', 'line-width': 6, 'line-opacity': 0.9 } }, before);
  // 個人路線：畫在全隊路線上面
  if (!map.getSource('qx-nav')) map.addSource('qx-nav', { type: 'geojson', data: navGeo() });
  if (!map.getLayer('qx-nav-casing')) map.addLayer({ id: 'qx-nav-casing', type: 'line', source: 'qx-nav', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#04204a', 'line-width': 11, 'line-opacity': 0.75 } }, before);
  if (!map.getLayer('qx-nav')) map.addLayer({ id: 'qx-nav', type: 'line', source: 'qx-nav', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3d9bff', 'line-width': 6, 'line-opacity': 0.95 } }, before);
  styleNav();
});
// 走個人路線時，全隊路線改成灰色虛線：看得出車隊在哪條路，又不會跟自己要走的藍線搞混
function styleNav() {
  if (!map.getLayer('qx-route')) return;
  const on = !!X.nav;
  map.setPaintProperty('qx-route', 'line-color', on ? '#9aa0a6' : '#3d9bff');
  map.setPaintProperty('qx-route', 'line-dasharray', on ? [1.5, 1.5] : [1, 0]);
  map.setPaintProperty('qx-route', 'line-width', on ? 4 : 6);
  map.setPaintProperty('qx-route-casing', 'line-opacity', on ? 0 : 0.75);
}
async function loadNav(reason) {
  const had = !!X.nav, quiet = X.quietNavDrop;
  X.quietNavDrop = false;
  try { const r = await api(`/api/trips/${tid}/navroute`); X.nav = r?.coords ? r : null; } catch { X.nav = null; }
  map.getSource('qx-nav')?.setData(navGeo());
  styleNav();
  if (had && !X.nav && !quiet && S.trip?.status === 'live') toast('已接回車隊路線', { icon: '回', color: '#30a46c' });
  if (reason === 'routechange' && X.nav) {
    // 建立者改了路線、我不在新路線上（例如已經過了分岔口）：後端從我目前的位置幫我算好接回新路線的路
    X.offSince = 0; X.lastReroute = Date.now();
    toast(`你不在新路線上，已幫你規劃接回`, { icon: '算', color: '#0a84ff', sub: `${fmtKm(X.nav.summary.km)} 到「${X.nav.target.name}」，到了就接上新路線` });
  }
  renderTurn();
}
// 偏離 10 秒就從我目前的位置（含車頭方向）重算到下一個停靠點
async function autoReroute() {
  const me = S.members.get(S.me), st = me?.state || {};
  if (X.rerouting || Date.now() - X.lastReroute < REROUTE_COOLDOWN_MS || st.lat == null || st.lat === '') return;
  X.rerouting = true; X.lastReroute = Date.now(); renderTurn();
  const hd = st.heading !== '' && st.heading != null && +st.speed > 1 ? +st.heading : null;
  try {
    const r = await api(`/api/trips/${tid}/reroute`, { method: 'POST', body: { lat: +st.lat, lon: +st.lon, heading: hd } }); // api() 會自己轉 JSON
    X.nav = r?.coords ? r : null;
    map.getSource('qx-nav')?.setData(navGeo()); styleNav();
    if (X.nav) {
      const extra = X.nav.summary.km - (X.nav.team_to_km - X.nav.team_from_km);
      toast(`已重新規劃：到「${X.nav.target.name}」`, { icon: '算', color: '#0a84ff', sub: `${fmtKm(X.nav.summary.km)}・${extra >= 0 ? '多' : '少'} ${fmtKm(Math.abs(extra))}，到了就接回車隊路線` });
    }
  } catch (err) { toast(`重新規劃失敗：${err.message}`, { icon: '!', color: '#ff9f0a', sub: '30 秒後會再試' }); }
  X.rerouting = false; X.offSince = 0; renderTurn();
}

async function loadRoute() {
  try { const r = await api(`/api/trips/${tid}/route`); X.route = r?.coords ? r : null; } catch { X.route = null; }
  for (const m of S.members.values()) {
    const st = m.state || {};
    if (st.route_km) X.prog[m.u.uid] = { km: +st.route_km, off: +st.off_m || 0 };
  }
  map.getSource('qx-route')?.setData(routeGeo());
  renderProgress();
  if (X.open === 'route') render();
  // 還沒有人在騎時，鏡頭先框路線（trip.js fitFallback：沒有路線就框有位置的人，再不行就框台灣）
  S.routeCoords = X.route?.coords || null;
  S.fitFallback?.();
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
  if (!X.route) { bar.hidden = true; turnCard.hidden = true; $('#quickRoute').textContent = '尚未規劃路線'; return; }
  const total = X.route.cum_km.at(-1);
  const riders = [...S.members.values()].filter((m) => X.prog[m.u.uid] && m.u.active);
  const ticks = X.wps.map((w) => ({ w, km: routeKmOf(w.lon, w.lat) }));
  const me = X.prog[S.me];
  const left = me ? total - me.km : null;
  $('#quickRoute').textContent = me ? `剩 ${fmtKm(Math.max(0, left))}` : `全長 ${fmtKm(total)}`;
  // 行程頁收合區塊（照原型）：下一站＝我前面最近的停靠點，沒有就是終點
  const nx = me ? ticks.filter((t) => t.km > me.km + 0.03).sort((a, b) => a.km - b.km)[0] : null;
  const dest = X.route.points?.at(-1)?.name || '終點';
  S.nextStop = me ? (nx ? { name: nx.w.name, km: nx.km - me.km } : { name: dest, km: Math.max(0, left) }) : null;
  dispatchEvent(new Event('qiji:next'));
  bar.hidden = false;
  bar.innerHTML = `
    <div class="qx-prog-h"><b>全隊進度</b><span>${me ? `我在路線 ${fmtKm(me.km)} 處 / 全長 ${fmtKm(total)} · 剩 ${fmtKm(left)} · 約 ${etaClock((left / speedKmh(S.me)) * 60)} 到` : `全長 ${fmtKm(total)}`}</span></div>
    <div class="qx-track">
      ${ticks.map(({ w, km }) => `<i class="qx-tick" data-kind="${w.kind}" style="left:${(km / total) * 100}%" title="${esc(w.name)} · ${fmtKm(km)}"></i>`).join('')}
      ${riders.map((m) => `<b class="qx-dot${m.u.uid === S.me ? ' me' : ''}${X.prog[m.u.uid].off > 150 ? ' off' : ''}" style="left:${Math.min(100, (X.prog[m.u.uid].km / total) * 100)}%;--c:${m.u.color}" title="${esc(m.u.nickname)} · ${fmtKm(X.prog[m.u.uid].km)}"></b>`).join('')}
    </div>`;
  renderTurn();
}

const ARROW = { 7: '↑', 8: '↑', 22: '↑', 9: '↗', 10: '↱', 11: '↱', 12: '⤸', 13: '⤹', 14: '↰', 15: '↰', 16: '↖', 23: '↗', 24: '↖', 26: '⟳', 27: '⟳', 4: '⚑', 5: '⚑', 6: '⚑', 36: '⚑' };
function renderTurn() {
  const me = X.prog[S.me];
  // 自己的位置不是即時的（定位被拒、失聯、還沒回報）：舊位置算出來的「偏離路線」「N m 後右轉」會誤導，先收起來（UX-31）
  if (!X.route || !me || S.trip?.status !== 'live' || !S.members.get(S.me)?.u.active || !S.isLive?.(S.me)) { turnCard.hidden = true; return; }
  turnCard.hidden = false;
  if (me.off > 150) {
    // 偏離：持續 10 秒就自動重算（後端判斷偏離的門檻也是 150 m）
    if (!X.offSince) X.offSince = Date.now();
    if (Date.now() - X.offSince > REROUTE_AFTER_MS) autoReroute();
    turnCard.className = 'qx-turn glass off';
    turnCard.innerHTML = X.rerouting
      ? '<b>…</b><div><div class="d">重新規劃中…</div><div class="s">從你現在的位置算到下一個停靠點</div></div>'
      : `<b>!</b><div><div class="d">偏離路線 ${fmtKm(me.off / 1000)}</div><div class="s">${Date.now() - X.lastReroute < REROUTE_COOLDOWN_MS ? '回到藍色路線上就會繼續提示' : '再偏離一下就幫你重新規劃'}</div></div>`;
    return;
  }
  X.offSince = 0;
  // 走個人路線：照個人路線的轉彎提示；沒有就照全隊路線
  const useNav = X.nav && me.nkm != null;
  const R = useNav ? X.nav : X.route, at = useNav ? me.nkm : me.km;
  const next = R.maneuvers.find((m) => m.km > at + 0.02 && ![1, 2, 3].includes(m.type));
  turnCard.className = 'qx-turn glass';
  const tag = useNav ? `<div class="s">個人路線・到「${esc(X.nav.target.name)}」接回車隊</div>` : '';
  if (!next) { turnCard.innerHTML = `<b>⚑</b><div><div class="d">${useNav ? '快到停靠點了' : '快到終點了'}</div>${tag}</div>`; return; }
  turnCard.innerHTML = `<b>${ARROW[next.type] || '↑'}</b><div><div class="d">${fmtKm(next.km - at)} 後 ${esc(next.act)}</div><div class="s">${esc(next.street || '')}</div>${tag}</div>`;
}

function renderRoutePanel() {
  const owner = S.trip?.is_owner;
  if (!X.route) {
    pop.innerHTML = `<div class="qx-head"><b>路線</b><span class="small muted">臨時開團，沒有規劃路線</span></div>
      ${owner ? `<a class="btn primary block" href="/plan?trip=${tid}">規劃路線</a>` : '<div class="small muted">建立者可以在「規劃路線」設定</div>'}`;
    return;
  }
  const s = X.route.summary;
  const points = X.route.points || [];
  const rows = points.map((p, i) => {
    const kind = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'via';
    const label = i === 0 ? '起點' : i === points.length - 1 ? '終點' : `途經點 ${i}`;
    const name = p.name?.trim() || `${(+p.lat).toFixed(4)}, ${(+p.lon).toFixed(4)}`;
    return `<li class="routeStop ${kind}"><span class="routeNode" aria-hidden="true"></span><div class="routePlace"><small>${label}</small><b title="${esc(name)}">${esc(name)}</b></div><button type="button" data-goto data-lon="${+p.lon}" data-lat="${+p.lat}" aria-label="在地圖上查看${esc(name)}">查看</button></li>`;
  }).join('');
  pop.innerHTML = `
    <div class="qx-head"><b>行程路線</b><span class="small muted">${s.km.toFixed(1)} km · 預估 ${Math.floor(s.min / 60)} 小時 ${s.min % 60} 分 · ${{ scooter: '機車', heavy: '重機', car: '汽車' }[X.route.vehicle || (X.route.avoid_highways === false ? 'heavy' : 'scooter')]}</span></div>
    <ol class="routeStops">${rows || '<li class="small muted">尚無停靠點資料</li>'}</ol>
    <a class="btn block" href="/plan?trip=${tid}">${owner ? '修改路線' : '看路線規劃'}</a>`;
}
setInterval(() => { if (X.route) renderProgress(); }, 2000);

/* ---------- WebSocket 訊息 ---------- */
addEventListener('qiji:msg', (e) => {
  const msg = e.detail;
  if (msg.kind === 'waypoints') { X.wps = msg.items; shareWps(); drawWps(); if (X.open === 'wp' && !X.pick?.lngLat) render(); }
  if (msg.kind === 'marks') { X.marks = msg.items; drawMarks(); if (X.open === 'mark' && !X.pick?.lngLat) render(); }
  if (msg.kind === 'hazard' && msg.uid === S.me) {
    toast(`前方 ${msg.dist_m} m 有${msg.label}${msg.note ? '：' + msg.note : ''}`, { icon: '!', color: '#ff9f0a', sub: `${nameOf(msg.by)} 標註的` });
  }
  if ((msg.kind === 'event' && (msg.type === 'sos' || msg.type === 'sos_off')) || msg.kind === 'sos_refresh') loadSos();
  if (msg.kind === 'snapshot') { loadWps(); loadMarks(); loadSos(); loadRoute(); loadNav(); }
  if (msg.kind === 'route') {
    X.prog = {}; X.nav = null; X.quietNavDrop = true; loadRoute(); loadNav(); // 全隊路線換了，後端也刪了個人路線
    // 騎到一半建立者改路線：告訴大家改走哪、多或少幾公里；已經過分岔口的人，後端會另外送 navroute（reason=routechange）
    if (msg.changed && msg.by !== S.me) {
      const d = msg.diff_km;
      toast(`${nameOf(msg.by)} 改了路線`, { icon: '改', color: '#0a84ff', sub: `新路線 ${fmtKm(msg.km)}${d == null ? '' : `・${d >= 0 ? '多' : '少'} ${fmtKm(Math.abs(d))}`}・原本的路線保留在回放` });
    }
  }
  if (msg.kind === 'navroute' && msg.uid === S.me) loadNav(msg.reason);
  if (msg.kind === 'progress') { X.prog[msg.uid] = { km: msg.km, off: msg.off_m, nkm: msg.nkm }; if (msg.uid === S.me) renderTurn(); }
  if (msg.kind === 'speedcam' && msg.uid === S.me) camAlert(msg);
});

loadWps();
loadMarks();
loadSos();
loadRoute();
loadNav();
window.qijiExtra = X; // 除錯用

/* ---------- 推播通知（更多 → 裝置與通知） ---------- */
mountPushCard(document.getElementById('pushCard')).then(() => {
  // 第一次進行程頁、這台還沒開通知：提醒一次去哪裡開（UX-08），之後不再跳
  const card = document.getElementById('pushCard');
  if (!card.querySelector('#pushOn, .push-steps')) return;
  try { if (localStorage.getItem('qiji:pushHint')) return; localStorage.setItem('qiji:pushHint', '1'); } catch { return; }
  toast('要收隊友的 SOS、失聯通知嗎？', { icon: '鈴', sub: '到「更多 → 裝置與通知」開啟，首頁的「設定」也有同一個開關' });
});

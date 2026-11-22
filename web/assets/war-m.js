// 戰情室（規格 4.7，給在家看的人用的大螢幕）：3D 地圖自動運鏡（框住全隊＋慢慢旋轉）、騎士卡、事件、
// 行程進度＋海拔剖面。資料和行程頁一樣走 WebSocket（Pub/Sub）。
// 這個檔只給手機直拿（war.html 依螢幕選版面；電腦與手機橫向用 war.js）。版面照改版原型 B（ride-trace-redesign/war-phone.html?v=b）：
// 全螢幕地圖＋底部抽屜（收起：全程進度條＋三個數字＋分頁鈕；拉開：騎士／路線／事件／剖面），重要事件跳通知橫幅（往上滑掉）。
// 身分：role＝viewer（只看）的人不出現在畫面上，只算「N 人觀看」；car（後援車）用方塊圖示、不算名次和帶頭距離。
import { api, tripGate, $, esc, avatar, initialOf, inkOn, clock, ago, press, setLabel, frameGate, LOW_POWER, gapGlow, parkedJitter, reduceMotion, markFocus, isWeak, eventFilter, WATCH } from '/assets/common.js';
import { createMap, addCompass, styleMenu } from '/assets/mapbase.js';
import { cameraGestures, resumeMs } from '/assets/gestures.js';
import { liveSocket } from '/assets/livesock.js';

const tid = new URLSearchParams(location.search).get('id');
await tripGate(tid);  // 錯誤 id／非成員／被移出／沒登入：錯誤畫面或登入頁（UX-02）
const M = createMap($('#map'), { style: 'dark', zoom: 7, terrain: true });
const map = M.map;
window.qijiMap = map;
map.setPitch(60);
const S = { trip: null, members: new Map(), events: [], route: null, prog: {}, gaps: {}, flags: {}, sos: new Map(), waypoints: [], weather: [], traffic: [], profile: null, styleReady: false };
window.qijiWar = S;
const FEED_FILTER_KEY = 'qiji:war:feed-filter:v2';
const GAP_KEY = 'qiji:war:gap-mode';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

$('#back').href = `/trip?id=${encodeURIComponent(tid)}`;
if (WATCH) $('#back').hidden = true;  // 觀看連結：沒有行程頁可以回
styleMenu(M, $('#mapStyle'));
$('#b3d').onclick = () => { M.set3d(!M.is3d); press($('#b3d'), M.is3d); };
press($('#b3d'), M.is3d);
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
/* ---------- 底部抽屜：三段停（收起／半開／全開） ----------
   手感照共用 sheetDrag（超過 7px 才開始、跟著手指、拉過頭 1/3 阻力、放開看速度），但多一段「半開」：上半看地圖、下半看清單。
   放開時：用「目前位置＋速度 × 0.2 秒」推算會停在哪，選最近的一段（甩快一點就會跳到下一段）。
   只有全開時清單可以捲；清單捲到最上面再往下拉＝拉抽屜。抽屜目前露出的高度每一格交給地圖留白（車隊留在看得到的那塊地圖中間）。 */
const sheet = $('#sheet'), body = sheet.querySelector('.sheet-body');
sheet.dataset.mt = 'l';
const STOPS = ['peek', 'mid', 'full'];
let stop = 'peek', off = 0, dragging = false;
const sheetH = () => sheet.offsetHeight;
const peekH = () => { const pk = sheet.querySelector('.peek'); return Math.round(pk.offsetTop + pk.offsetHeight + Math.max(10, parseFloat(getComputedStyle(sheet).paddingBottom) || 0)); };
// 每一段的位移（抽屜往下推多少）：全開＝0；半開＝露出畫面的 52%（至少比收起多 160px）；收起＝只露出進度條、數字、分頁鈕
const offOf = (st) => {
  const H = sheetH(), closed = Math.max(0, H - peekH());
  if (st === 'full') return 0;
  if (st === 'peek') return closed;
  return Math.max(0, Math.min(closed - 160, H - Math.round(innerHeight * 0.52)));
};
function setOff(px, animate) {
  off = px;
  sheet.classList.toggle('dragging', !animate);
  sheet.style.setProperty('--sheet-off', `${px}px`);
  // 全開而且沒在拖：地圖整個被蓋住，暫停重畫（拖曳中要露出地圖，不暫停）
  M.pauseRender(px <= 1 && animate);
  // 工具列：抽屜快全開時才往上滑走（半開時地圖還看得到，工具列留著）
  const t = 1 - px / Math.max(1, offOf('peek'));
  document.documentElement.style.setProperty('--sheet-t', Math.max(0, Math.min(1, (t - 0.6) / 0.4)).toFixed(3));
}
function setStop(st, animate = true) {
  stop = st;
  sheet.classList.toggle('small', st === 'peek');
  sheet.dataset.stop = st;
  body.classList.toggle('scroll', st === 'full');  // 只有全開時清單可以捲
  if (st !== 'full') body.scrollTop = 0;
  setOff(offOf(st), animate);
}
// 舊介面：true＝打開（收起時打開到半開）、false＝收起
const setSheet = (open) => setStop(open ? (stop === 'peek' ? 'mid' : stop) : 'peek');
{
  let y0 = null, off0 = 0, last = 0, lastT = 0, vel = 0, moved = false, pid = null, inBody = false;
  sheet.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('input, select, textarea')) return;
    inBody = !!e.target.closest('.sheet-body');
    if (inBody && stop === 'full' && body.scrollTop > 0) return;  // 全開、清單已經往下捲：交給清單捲
    y0 = e.clientY; off0 = off; last = y0; lastT = performance.now(); vel = 0; moved = false; pid = e.pointerId;
  });
  addEventListener('pointermove', (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    const dy = e.clientY - y0;
    if (!moved && Math.abs(dy) < 7) return;
    if (!moved && inBody && stop === 'full' && dy < 0) { y0 = null; return; }  // 全開時在清單裡往上滑＝捲清單
    if (!moved) { moved = true; dragging = true; try { sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    const t = performance.now(); vel = (e.clientY - last) / Math.max(1, t - lastT); last = e.clientY; lastT = t;
    const max = offOf('peek');
    let o = off0 + dy;
    if (o < 0) o /= 3;
    if (o > max) o = max + (o - max) / 3;
    setOff(o, false);
  });
  const end = (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    y0 = null; dragging = false;
    if (!moved) { sheet.classList.remove('dragging'); return; }
    sheet.endAt = performance.now();
    // 推算停點：位置＋速度 × 200ms，選最近的一段；甩得很快（> 0.6 px/ms）至少往甩的方向走一段
    const proj = off + vel * 200;
    let best = STOPS.reduce((a, b) => (Math.abs(offOf(b) - proj) < Math.abs(offOf(a) - proj) ? b : a));
    const i0 = STOPS.indexOf(stop);
    if (Math.abs(vel) > 0.6 && best === stop) best = STOPS[Math.max(0, Math.min(2, i0 + (vel < 0 ? 1 : -1)))];
    setStop(best);
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  // iOS：清單捲到頂再往下拉、或沒全開時拖清單，擋掉原生捲動（pointer 事件才不會被取消；iOS 不支援 touch-action: pan-down）
  sheet.addEventListener('touchmove', (e) => { if (y0 != null && (moved || stop !== 'full' || body.scrollTop <= 0)) e.preventDefault(); }, { passive: false });
  // 拖完瀏覽器補送的 click 不要觸發按鈕
  sheet.addEventListener('click', (e) => { if (performance.now() - (sheet.endAt || 0) < 400) { e.preventDefault(); e.stopPropagation(); } }, true);
}
// 點把手：收起 → 半開 → 全開 → 收起
sheet.querySelector('.handle').onclick = () => setStop(STOPS[(STOPS.indexOf(stop) + 1) % 3]);
addEventListener('resize', () => { if (!dragging) setStop(stop, false); });
if ('ResizeObserver' in window) new ResizeObserver(() => { if (!dragging) setStop(stop, false); }).observe(sheet.querySelector('.peek'));
requestAnimationFrame(() => setStop('peek', false));
// 分頁：收起時點分頁鈕＝打開抽屜並切過去（剖面切過去時 canvas 才有尺寸，要重畫）
$('#mt').onclick = (e) => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  sheet.dataset.mt = b.dataset.m;
  document.querySelectorAll('#mt button').forEach((x) => x.classList.toggle('on', x === b));
  if (stop === 'peek') setStop('mid');
  body.scrollTop = 0;
  renderPane();
  setTimeout(renderProgress, 30);
};
// 差距寫法：時間（+分:秒）或距離（+公里），記在這台
let gapMode = (() => { try { return localStorage.getItem(GAP_KEY) === 'km' ? 'km' : 'time'; } catch { return 'time'; } })();
const syncGm = () => document.querySelectorAll('#gm button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === gapMode)));
syncGm();
$('#gm').onclick = (e) => {
  const b = e.target.closest('[data-g]');
  if (!b) return;
  gapMode = b.dataset.g;
  try { localStorage.setItem(GAP_KEY, gapMode); } catch { /* 略過 */ }
  syncGm(); renderCards();
};
addEventListener('resize', () => { map.resize(); renderProgress(); });

const EXAG = 1.4; // mapbase 的地形誇張倍率
// 事件：顏色、類別名稱、圓圈裡的符號（照原型：彩色圓＋白色符號；符號和回放時間軸同一套）
const EV = {
  lost: '#ff453a', back: '#30d158', start: '#30d158', end: '#8e8e93', stop: '#8e8e93', join: '#64d2ff', kick: '#ffd60a',
  behind: '#ffd60a', ahead: '#ffd60a', regroup: '#30d158', waypoint: '#c2410c', create: '#8e8e93', arrive: '#30d158', allin: '#30d158', speedcam: '#ffd60a', roadevent: '#ff9f0a', weather: '#0a84ff', chat: '#0a84ff',
  msg: '#0a84ff', mark: '#ffd60a', sos: '#d70015', sos_off: '#30d158', route: '#c2410c', offroute: '#ffd60a', onroute: '#30d158', reroute: '#64d2ff', town: '#c2410c', stuck: '#ffd60a', moving: '#30d158',
};
const EV_NAME = {
  lost: '失聯', back: '恢復', start: '出發', end: '結束', stop: '停車', join: '加入', kick: '移出', behind: '落隊', ahead: '超前', regroup: '歸隊', waypoint: '停靠點', create: '建立', arrive: '抵達', allin: '到齊',
  speedcam: '測速', roadevent: '路況', weather: '降雨', msg: '訊息', chat: '聊天', mark: '標記', sos: 'SOS', sos_off: '解除 SOS', route: '路線', offroute: '偏離路線', onroute: '回到路線',
  reroute: '重新規劃', town: '鄉鎮', stuck: '停滯', moving: '出發', role: '身分',
};
const GLYPH = { start: '▶', moving: '▶', end: '■', stop: '‖', lost: '!', back: '✓', join: '+', kick: '✕', behind: '!', ahead: '»', regroup: '✓', waypoint: '⚑', create: '+', arrive: '★', allin: '★', speedcam: '◉', roadevent: '!', weather: '雨', msg: '✉', chat: '✉', mark: '⚑', sos: 'S', sos_off: '✓', route: '↺', offroute: '!', onroute: '✓', reroute: '↺', town: '◎', stuck: '!' };
const SRC = { web: '網頁', traccar: 'Traccar', sim: '模擬', 'sim-self': '模擬' };
// 身分：viewer＝只看（不畫、不列），car＝後援車（畫成方塊、不算名次）
const VIEWERS = new Map();
const isCar = (m) => m.u.role === 'car';

/* ---------- 標記與軌跡 ---------- */
function upsert(u, state = {}) {
  if (u.role === 'viewer') { VIEWERS.set(u.uid, u); dropMember(u.uid); return null; }
  VIEWERS.delete(u.uid);
  let m = S.members.get(u.uid);
  if (!m) {
    const el = document.createElement('div');
    el.className = 'rider';
    el.innerHTML = `<div class="arrow"></div><div class="dot">${esc(initialOf(u.nickname))}</div><div class="name">${esc(u.nickname)}</div>`;
    el.addEventListener('click', () => pick(m.u.uid));
    m = { u, state: {}, recent: [], el, marker: new maplibregl.Marker({ element: el, anchor: 'center', opacityWhenCovered: '1', subpixelPositioning: true }), trail: [], pos: null, from: null, to: null, t0: 0, onMap: false };
    S.members.set(u.uid, m);
  }
  m.u = { ...m.u, ...u };
  m.el.classList.toggle('car', isCar(m));
  m.el.querySelector('.dot').textContent = isCar(m) ? '🚐' : initialOf(m.u.nickname);
  m.el.style.setProperty('--c', m.u.color);
  m.el.style.setProperty('--ink', inkOn(m.u.color));
  m.state = { ...m.state, ...state };
  if (!m.pos && m.state.lat) m.pos = [+m.state.lon, +m.state.lat];
  return m;
}
function dropMember(uid) {
  const m = S.members.get(uid);
  if (!m) return;
  m.marker.remove();
  S.members.delete(uid);
}
const trailsGeo = () => ({ type: 'FeatureCollection', features: [...S.members.values()].filter((m) => m.trail.length > 1).map((m) => ({
  type: 'Feature', properties: { color: m.u.color }, geometry: { type: 'LineString', coordinates: m.pos ? [...m.trail, m.pos] : m.trail } })) });
const routeGeo = () => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: S.route?.coords || [] } });
M.onStyle(() => {
  if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: routeGeo() });
  if (!map.getLayer('route')) map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3d9bff', 'line-width': 6, 'line-opacity': 0.85 } });
  if (!map.getSource('trails')) map.addSource('trails', { type: 'geojson', data: trailsGeo() });
  if (!map.getLayer('trails')) map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4 } });
  bigLabels();
  S.styleReady = true;
});
// 大螢幕要一眼看出「他們在哪」（UX-29）：城市與鄉鎮名放大（中文地名由 mapbase 統一處理）
function bigLabels() {
  // 深色底圖（openfreemap dark）叫 place_*，淺色（Liberty）叫 label_*
  const big = [[['place_city_large', 'label_city_capital'], [5, 16, 9, 22, 13, 26]], [['place_city', 'label_city'], [5, 14, 9, 20, 13, 24]],
    [['place_town', 'label_town'], [8, 13, 12, 17, 15, 20]], [['place_village', 'label_village'], [10, 12, 14, 15]]];
  for (const [ids, size] of big) for (const id of ids) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'text-size', ['interpolate', ['linear'], ['zoom'], ...size]);
  }
}

/* ---------- 運鏡：手動操作後暫停跟隨 ---------- */
let lastT = performance.now(), lastTrail = 0;
let autoFollow = true;  // false＝暫離（使用者拖了地圖）
let awayAt = 0;
let lastFit = '';  // fitLast() 上次框的那組位置
let lastTarget = '';  // 上一格鏡頭在追什麼（換了就平滑接過去）
// 地圖鋪滿全螢幕：留白讓開上方標題列、右上工具列、抽屜「目前」露出的高度（拖曳中、動畫中每一格都跟著，
// 車隊一直在看得到的那塊地圖中間）；看得到的地圖至少留 140px，抽屜全開時就不再往上推
const padRaw = () => {
  const top = ($('.whd').getBoundingClientRect().bottom || 60) + 20;
  const shown = innerHeight - sheet.getBoundingClientRect().top;
  return { top, bottom: Math.max(24, Math.min(shown + 24, innerHeight - top - 140)), left: 30, right: 76 };
};
// 手勢規則（docs/地圖手勢規則.md）：拖曳＝暫離（按鈕／卡片變外框，10 秒沒動自動回去）；縮放、旋轉、傾斜繼續跟隨；
// 全隊模式下縮放也算暫離
function goAway() {
  awayAt = Date.now();
  if (!autoFollow) return;
  autoFollow = false;
  M.unfollow();
  syncFollowBtn();
  renderCards();
}
function resumeFollow() {
  autoFollow = true;
  lastFit = '';  // 回到全隊時，沒人在線也要重新框一次
  M.regroup();
  GEST.sync();
  syncFollowBtn();
  renderCards();
}
// 「全隊」鈕：實心＝自動框住全隊；外框＝暫離（點了回去）；跟著某人時放開
const syncFollowBtn = () => {
  press($('#centerTeam'), autoFollow && !S.focus);
  $('#centerTeam').classList.toggle('away', !autoFollow && !S.focus);
};
const GEST = cameraGestures(M, {
  centered: () => autoFollow && !!S.focus,
  onPan: goAway,
  onZoom: () => { if (!S.focus && autoFollow) goAway(); },
  onActivity: () => { if (!autoFollow) awayAt = Date.now(); },
});
$('#centerTeam').addEventListener('click', () => { S.focus = null; resumeFollow(); if (S.route && !S.profile) buildProfile(); });
// 點騎士卡／地圖頭像：鏡頭一直跟著他；再點一次回到全隊
function pick(uid) {
  S.focus = S.focus === uid && autoFollow ? null : uid;
  M.unfollow();
  resumeFollow();
}
// 留白直接用抽屜當下的位置（抽屜本身已經有動畫），不另外做平滑：平滑會落後抽屜，車隊會先跑掉再追回來
const pad = padRaw;
const gate = frameGate();
function frame(now) {
  if (!gate(now)) { requestAnimationFrame(frame); return; } // 省電模式約 30 fps
  const dt = Math.min(0.2, (now - lastT) / 1000);
  lastT = now;
  for (const m of S.members.values()) {
    if (m.to) {
      const k = Math.min(1, (now - m.t0) / (m.dur || 1000));
      m.pos = [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k];
      if (k >= 1) m.to = null;
    }
    if (m.pos) {
      m.marker.setLngLat(m.pos);
      if (!m.onMap) { m.marker.addTo(map); m.onMap = true; }
      const hd = m.state.heading != null && m.state.heading !== '' ? +m.state.heading : null;
      const ar = m.el.querySelector('.arrow');
      ar.style.visibility = hd == null ? 'hidden' : '';
      ar.style.transform = `rotate(${(hd ?? 0) - map.getBearing()}deg)`;
      m.el.classList.toggle('lost', m.state.status === 'lost');
      m.el.classList.toggle('rest', status(m)[0] === '停車');
      gapGlow(m.el, !!S.flags[m.u.uid] && m.state.status !== 'done', S.gaps[m.u.uid], S.lagKm || S.trip?.lag_km);
    }
  }
  // 等待開始時還沒有人 active：開始前正在回報（後端廣播的即時位置，10 分鐘內）的人都算
  const pre = S.trip?.status === 'planned';
  const live = [...S.members.values()].filter((m) => m.pos && m.state.status !== 'lost'
    && (pre ? !isOff(status(m)[0]) : m.u.active !== false));
  const pts = live.map((m) => m.pos);
  const back = resumeMs();
  if (!autoFollow && back > 0 && !M.busy && Date.now() - awayAt > back) resumeFollow();
  // 鏡頭目標的種類：跟某人／只有一人在線／全隊／沒人在線。種類一換就讓鏡頭從目前畫面滑過去（不跳）
  const fm = S.focus && S.members.get(S.focus);
  const target = !autoFollow || S.profiling ? '' : fm?.pos ? `f${S.focus}` : pts.length === 1 ? `o${live[0].u.uid}` : pts.length ? 'g' : 'last';
  if (target !== lastTarget) { if (target && lastTarget) M.retarget(); lastTarget = target; }
  if (S.styleReady && pts.length && !S.profiling && autoFollow) {
    if (!LOW_POWER && !reduceMotion() && !M.busy && M.is3d) map.setBearing((map.getBearing() + dt * 2) % 360); // 慢慢旋轉；省電或 2D 時不轉
    if (fm?.pos) M.follow(fm.pos, { padding: pad() });
    else if (pts.length === 1) M.follow(pts[0], { padding: pad() });
    else M.followGroup(pts, { padding: pad(), maxZoom: 14 });
  } else if (S.styleReady && !pts.length && !S.profiling && autoFollow && !M.busy) fitLast();
  if (now - lastTrail > 500 && !window.__qijiPerfFlags?.has('notrail')) { lastTrail = now; map.getSource('trails')?.setData(trailsGeo()); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 沒有人在線（全失聯、還沒出發、都結束了）：框住每個人最後的位置；連最後位置都沒有就框路線，再不行框台灣（UX-29）。
// 同一組位置只框一次，使用者動了地圖就交給使用者
function fitLast() {
  const last = [...S.members.values()].filter((m) => m.pos).map((m) => m.pos);
  const pts = last.length ? last : S.route?.coords?.length ? [S.route.coords[0], S.route.coords.at(-1)] : [];
  const key = pts.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(';') || 'tw';
  if (key === lastFit) return;
  lastFit = key;
  M.unfollow();
  if (!pts.length) { map.easeTo({ center: [120.95, 23.7], zoom: 6.6, padding: pad(), duration: 800 }); return; }
  if (pts.length === 1) { map.easeTo({ center: pts[0], zoom: 13.5, padding: pad(), duration: 800 }); return; }
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: pad(), maxZoom: 14, duration: 800 });
}

/* ---------- 騎士狀態與下一站 ETA ---------- */
// 距離寫法照原型：10 公里以上取整數、1 公里以上一位小數、不到 1 公里以 10 公尺為單位
const fmtKm = (km) => (km >= 10 ? `${Math.round(km)} 公里` : km >= 1 ? `${km.toFixed(1)} 公里` : `${Math.round(km * 100) * 10} 公尺`);
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const numeric = (v) => v != null && v !== '' && Number.isFinite(+v);
// 狀態詞分開寫（UX-29）：已經騎到終點、只是沒按結束的人不要叫「訊號弱」；很久沒回報寫「停止回報（N 分前）」
const seenAt = (s) => +s.seen || +s.ts || 0;
function arrived(m) {
  const p = S.prog[m.u.uid], total = S.route?.cum_km?.at(-1);
  return numeric(p?.km) && numeric(total) && +p.km >= total - 0.3;
}
function status(m) {
  const s = m.state;
  if (s.status === 'done') return ['已結束', 'muted'];
  if (!numeric(s.lat)) return [s.status === 'lost' ? '失聯' : '尚未回報', s.status === 'lost' ? 'crit' : 'muted'];
  const quiet = Date.now() - seenAt(s) > 30000;
  if (arrived(m) && (quiet || (+s.speed || 0) * 3.6 < 5)) return ['已抵達終點', 'ok'];
  if (s.status === 'lost') return [seenAt(s) ? `失聯（${ago(seenAt(s))}）` : '失聯', 'crit'];
  if (Date.now() - seenAt(s) > 10 * 60_000) return [`停止回報（${ago(seenAt(s))}）`, 'muted'];
  if (isWeak(s)) return ['訊號弱', 'warn'];
  return (+s.speed || 0) * 3.6 < 5 ? ['停車', ''] : ['騎乘中', 'ok'];
}
// 「不在線」：失聯、已結束、尚未回報、停止回報、已抵達（狀態詞後面可能帶時間，只比開頭）
const OFF = ['已結束', '失聯', '尚未回報', '停止回報', '已抵達'];
const isOff = (st) => OFF.some((w) => st.startsWith(w));
function routeKmOf(lon, lat) {
  if (!S.route?.coords?.length) return null;
  const coords = S.route.coords, cum = S.route.cum_km, kx = Math.cos(lat * Math.PI / 180);
  let best = Infinity, km = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1], dx = (b[0] - a[0]) * kx, dy = b[1] - a[1];
    const t = clamp((((lon - a[0]) * kx * dx) + (lat - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const dd = ((lon - a[0]) * kx - dx * t) ** 2 + (lat - a[1] - dy * t) ** 2;
    if (dd < best) { best = dd; km = cum[i] + (cum[i + 1] - cum[i]) * t; }
  }
  return km;
}
// 休息點、集合點換算成路線上的公里數（路線或停靠點變了才重算）
let stopsKey = '', stopsCache = [];
function stops() {
  const key = `${S.route?.coords?.length || 0}:${JSON.stringify(S.waypoints.map((w) => [w.id, w.lon, w.lat]))}`;
  if (key !== stopsKey) {
    stopsKey = key;
    stopsCache = S.waypoints.filter((w) => (w.kind === 'meet' || w.kind === 'rest') && numeric(w.lon) && numeric(w.lat))
      .map((w) => ({ ...w, km: routeKmOf(+w.lon, +w.lat) })).filter((w) => numeric(w.km)).sort((a, b) => a.km - b.km);
  }
  // 到齊狀態每次都用最新的
  const byId = new Map(S.waypoints.map((w) => [w.id, w]));
  return stopsCache.map((w) => ({ ...w, ...byId.get(w.id), km: w.km }));
}
function nextStop(km) {
  if (!numeric(km) || !S.route) return null;
  return stops().find((w) => w.km > +km + 0.15) || { name: '終點', km: S.route.cum_km.at(-1) };
}
function recentSpeed(m) {
  const fresh = m.recent.filter((x) => Date.now() - x.at < 10 * 60_000 && x.kmh >= 5);
  if (fresh.length >= 3) return fresh.reduce((a, x) => a + x.kmh, 0) / fresh.length;
  return +m.u.stats?.avg_kmh || null;
}
const kmOf = (m) => (numeric(S.prog[m.u.uid]?.km) ? +S.prog[m.u.uid].km : null);
// 在線、還在路上的人（KPI、帶頭距離用）
const riding = () => [...S.members.values()].filter((m) => !isCar(m) && kmOf(m) != null && m.u.active !== false && !isOff(status(m)[0]));
const routeKmh = () => Math.max(5, Math.min(150, +S.route?.summary?.km / (+S.route?.summary?.min / 60) || 25));
// 全隊的速度：在路上的人最近速度取中位數（沒有就用路線平均）。差距換成時間時大家用同一個速度，名次和差距才會一致
function teamKmh() {
  const v = riding().map(recentSpeed).filter((x) => x > 5).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : routeKmh();
}
// 差距（F1 式）：落後帶頭 d 公里；時間＝照全隊速度騎完這段要多久
function gapText(d) {
  if (gapMode === 'km') return d >= 1 ? `+${d.toFixed(1)} km` : `+${Math.round(d * 100) * 10} m`;
  const sec = Math.round(d / teamKmh() * 3600), mm = Math.floor(sec / 60);
  return mm >= 60 ? `+${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : `+${mm}:${String(sec % 60).padStart(2, '0')}`;
}

/* ---------- 標題列與 KPI ---------- */
function renderHead() {
  const t = S.trip;
  if (!t) return;
  const live = t.status === 'live';
  $('#live').classList.toggle('off', !live);
  $('#hT').textContent = live ? `騎乘中 ${t.started ? hms(Date.now() - +t.started) : ''}` : t.status === 'ended' ? '已結束' : '等待開始';
  const nv = VIEWERS.size;
  $('#watch').classList.toggle('hidden', !nv);
  $('#watch').textContent = `👀 ${nv} 人觀看`;
  const on = riding(), ks = on.map(kmOf);
  const lead = ks.length ? Math.max(...ks) : null, tail = ks.length ? Math.min(...ks) : null;
  let eta = '–';
  const total = S.route?.cum_km?.at(-1);
  if (live && tail != null && numeric(total)) {
    const last = on.find((m) => kmOf(m) === tail);
    eta = clock(Date.now() + Math.max(0, total - tail) / (recentSpeed(last) || routeKmh()) * 3600000);
  }
  const html = `<div><b>${lead == null ? '–' : fmtKm(lead)}</b>帶頭進度</div><div><b>${lead == null ? '–' : fmtKm(lead - tail)}</b>隊伍拉長</div><div><b>${eta}</b>全員預計抵達</div>`;
  if ($('#kpi').dataset.html !== html) { $('#kpi').dataset.html = html; $('#kpi').innerHTML = html; }
}

/* ---------- 全程進度條（抽屜收起時也看得到）---------- */
function renderStrip() {
  const box = $('#strip'), total = S.route?.cum_km?.at(-1);
  if (!(total > 0)) { box.innerHTML = '<div class="none">這趟沒有預定路線，無法畫全隊進度</div>'; return; }
  const pct = (km) => `${(clamp(km / total, 0, 1) * 100).toFixed(2)}%`;
  const ks = riding().map(kmOf), lead = ks.length ? Math.max(...ks) : 0;
  const wps = stops().map((w) => `<div class="wp" style="left:${pct(w.km)}">${esc(w.name)}</div>`).join('');
  const key = `${total}:${wps}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = `<div class="ln"></div><div class="dn"></div>${wps}<div class="wp end" style="left:100%">終點</div><div class="ps"></div>`;
    // 名字疊到前一個就只留刻度（終點一定留；從終點往回看，誰撞到右邊那個就藏誰）
    const labels = [...box.querySelectorAll('.wp')].reverse();
    let left = Infinity;
    for (const el of labels) {
      const r = el.getBoundingClientRect();
      if (r.right > left - 4) el.classList.add('nl'); else left = r.left;
    }
  }
  box.querySelector('.dn').style.width = pct(lead);
  // 每個人一個點：位置每秒更新（transition 平滑移動），後面的先畫、帶頭的疊在最上面
  const ps = box.querySelector('.ps');
  const list = [...S.members.values()].filter((m) => kmOf(m) != null && m.u.active !== false).sort((a, b) => kmOf(a) - kmOf(b));
  list.forEach((m, i) => {
    let d = ps.querySelector(`[data-uid="${CSS.escape(String(m.u.uid))}"]`);
    if (!d) { d = document.createElement('div'); d.dataset.uid = m.u.uid; ps.append(d); }
    d.className = `p${isCar(m) ? ' car' : ''}${S.focus === m.u.uid ? ' sel' : ''}`;
    d.style.cssText = `left:${pct(kmOf(m))};--c:${m.u.color};--ink:${inkOn(m.u.color)};z-index:${i + 1}`;
    const tx = isCar(m) ? '🚐' : initialOf(m.u.nickname);
    if (d.textContent !== tx) d.textContent = tx;
  });
  const keep = new Set(list.map((m) => String(m.u.uid)));
  [...ps.children].forEach((d) => { if (!keep.has(d.dataset.uid)) d.remove(); });
}

/* ---------- 騎士：照騎行順序，F1 式差距 ---------- */
function badgeOf(m) {
  const [st, stCls] = status(m), flag = S.flags[m.u.uid], off = isOff(st);
  if (S.sos.has(m.u.uid)) return ['SOS', 'crit'];
  if (flag === 'behind' && !off) return ['落隊', 'warn'];
  if (flag === 'ahead' && !off) return ['超前', 'warn'];
  if (numeric(m.state.batt) && +m.state.batt <= 15 && !off) return ['電量低', 'warn'];
  return st === '騎乘中' ? null : [st, stCls];
}
function renderCards() {
  // 在路上的照公里數排（後援車也排在它的位置、不給名次）；不在線（失聯、結束、還沒回報）排最後
  const all = [...S.members.values()];
  const onRoad = all.filter((m) => kmOf(m) != null && !isOff(status(m)[0])).sort((a, b) => kmOf(b) - kmOf(a));
  const rest = all.filter((m) => !onRoad.includes(m)).sort((a, b) => (kmOf(b) ?? -1) - (kmOf(a) ?? -1));
  const list = [...onRoad, ...rest];
  const riders = all.filter((m) => !isCar(m)), online = riders.filter((m) => !isOff(status(m)[0])).length;
  $('#teamT').textContent = `騎行順序（${online}/${riders.length} 在線）`;
  const ks = riding().map(kmOf), lead = ks.length ? Math.max(...ks) : null;
  const box = $('#cards');
  if (!list.length) { box.innerHTML = '<p class="empty">還沒有隊友</p>'; return; }
  box.querySelector('.empty')?.remove();
  let pos = 0;
  list.forEach((m, i) => {
    const s = m.state, car = isCar(m), off = isOff(status(m)[0]), km = kmOf(m);
    if (!car && !off) pos++;
    const bd = car ? null : badgeOf(m);
    const sub = [km != null ? fmtKm(km) : numeric(m.u.stats?.km) ? fmtKm(+m.u.stats.km) : '還沒有位置', !off && numeric(s.speed) ? `${Math.round(+s.speed * 3.6)} km/h` : '',
      numeric(s.batt) ? `電量 ${Math.round(+s.batt)}%` : '', SRC[s.src] || ''].filter(Boolean).join('・');
    const d = lead != null && km != null ? lead - km : null;
    // 只有名次第 1 的人寫「領先」；停在同一個地方的其他人寫 +0:00（F1 也是這樣）
    const gap = off ? `<span class="gap off">${esc(status(m)[0])}</span>` : d == null ? '<span class="gap off">–</span>'
      : !car && pos === 1 ? '<span class="gap lead">領先</span>' : `<span class="gap num">${gapText(Math.max(0, d))}</span>`;
    let b = box.querySelector(`[data-uid="${CSS.escape(String(m.u.uid))}"]`);
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'wr'; b.dataset.uid = m.u.uid; }
    if (box.children[i] !== b) box.insertBefore(b, box.children[i] || null);
    b.classList.toggle('sel', S.focus === m.u.uid && autoFollow);
    b.classList.toggle('away', S.focus === m.u.uid && !autoFollow);
    b.classList.toggle('sos', S.sos.has(m.u.uid));
    const html = `<span class="pos num">${car || off ? '–' : pos}</span>${car ? `<span class="avatar car">🚐</span>` : avatar(m.u)}`
      + `<span class="m"><b>${esc(m.u.nickname)}</b>${car ? '<span class="badge muted">後援車</span>' : ''}${bd ? `<span class="badge ${bd[1]}">${esc(bd[0])}</span>` : ''}`
      + `<div class="s num">${esc(sub)}</div></span>${gap}`;
    if (b.dataset.html !== html) { b.dataset.html = html; b.innerHTML = html; }
  });
  [...box.children].slice(list.length).forEach((x) => x.remove());
  markFocus([...S.members].map(([id, m]) => [id, m.el]), S.focus, !autoFollow);
}
$('#cards').addEventListener('click', (e) => { const b = e.target.closest('.wr'); if (b) pickFromList(b.dataset.uid); });
// 清單裡點人：鏡頭跟著他，抽屜收起來讓出地圖
function pickFromList(id) {
  pick(S.members.has(id) ? id : +id);
  setSheet(false);
}

/* ---------- 路線：直的路線圖（終點在上、起點在下） ---------- */
function renderLin() {
  const total = S.route?.cum_km?.at(-1);
  if (!(total > 0)) { $('#lin').innerHTML = '<p class="empty">這趟沒有預定路線。</p>'; return; }
  const ks = riding().map(kmOf), lead = ks.length ? Math.max(...ks) : 0;
  const items = [];
  const st = stops();
  const n = (w) => (w.arrived || []).length, N = (w) => w.total || S.members.size;
  const nextW = st.find((w) => w.km > lead + 0.15);
  st.forEach((w) => {
    const passed = w.km <= lead + 0.15;
    const note = w.all_in ? '全員到齊，已出發' : n(w) ? `等待中・${n(w)}/${N(w)} 到齊` : w === nextW ? `下一站・帶頭還有 ${fmtKm(Math.max(0, w.km - lead))}` : passed ? '已通過' : '';
    items.push({ km: w.km, html: `<div class="st wp"><em class="num">${fmtKm(w.km)}</em><b>⚑ ${esc(w.name)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div>` });
  });
  // 前方的路況、降雨（帶頭後面 2 公里以內也列，提醒後面的人）
  S.traffic.filter((x) => x.route_km >= lead - 2).forEach((x) => items.push({ km: +x.route_km,
    html: `<div class="st rd" style="--c:#ff9f0a"><em class="num">${fmtKm(+x.route_km)}</em><b style="color:#ff9f0a">⚠ ${esc(x.type)}</b><small>${esc(x.name)}</small></div>` }));
  S.weather.filter((x) => x.route_km >= lead - 2).forEach((x) => items.push({ km: +x.route_km,
    html: `<div class="st rd" style="--c:#64d2ff"><em class="num">${fmtKm(+x.route_km)}</em><b style="color:#64d2ff">☂ 降雨 ${x.pop}%</b><small>${esc(x.name)}・${esc(x.area)}</small></div>` }));
  const ppl = [...S.members.values()].filter((m) => kmOf(m) != null && m.u.active !== false).sort((a, b) => kmOf(b) - kmOf(a));
  let prev = null;
  ppl.forEach((m) => {
    const km = kmOf(m), car = isCar(m), bd = car ? null : badgeOf(m), s = m.state;
    let gapLine = '';
    if (prev && !car && km != null) {
      const d = kmOf(prev) - km, sec = d / teamKmh() * 3600;
      if (sec >= 120) gapLine = `<div class="gapln">⋯ 差 ${Math.round(sec / 60)} 分鐘（${fmtKm(d)}）</div>`;
    }
    if (!car) prev = m;
    items.push({ km, who: true, html: `${gapLine}<button type="button" class="who" data-uid="${esc(m.u.uid)}">${car ? '<span class="avatar car">🚐</span>' : avatar(m.u)}`
      + `<span class="n"><b>${esc(m.u.nickname)}</b>${bd ? `<span class="badge ${bd[1]}">${esc(bd[0])}</span>` : ''}<small class="num">${esc([fmtKm(km), numeric(s.speed) ? `${Math.round(+s.speed * 3.6)} km/h` : '', numeric(s.batt) ? `電量 ${Math.round(+s.batt)}%` : ''].filter(Boolean).join('・'))}</small></span></button>` });
  });
  // 由終點往起點排；同一公里時人排在點的後面（人在那個點之前還沒到）
  items.sort((a, b) => b.km - a.km || (a.who ? 1 : 0) - (b.who ? 1 : 0));
  const html = `<div class="ax"><div class="done"></div>`
    + `<div class="st wp"><em class="num">${fmtKm(total)}</em><b>🏁 終點</b></div>${items.map((x) => x.html).join('')}`
    + `<div class="st"><em class="num">0 公里</em><b>起點</b>${S.trip?.started ? `<small>${clock(+S.trip.started)} 出發</small>` : ''}</div></div>`;
  if ($('#lin').dataset.html !== html) { $('#lin').dataset.html = html; $('#lin').innerHTML = html; }
  // 走過的那段（橘色）：從起點畫到帶頭那個人（圖上的間距不是照公里比例，所以照帶頭的位置量）
  const ax = $('#lin').querySelector('.ax'), first = ax?.querySelector('.who:not(:has(.car))');
  if (ax && first) ax.querySelector('.done').style.height = `${Math.max(0, ax.offsetHeight - first.offsetTop - 15)}px`;
}
$('#strip').addEventListener('click', (e) => { const d = e.target.closest('.p'); if (d) pickFromList(d.dataset.uid); });
$('#lin').addEventListener('click', (e) => { const b = e.target.closest('.who'); if (b) pickFromList(b.dataset.uid); });
// 只畫看得到的分頁（每秒更新時不浪費）
function renderPane() {
  const t = sheet.dataset.mt;
  if (t === 'l') renderCards();
  else if (t === 'w') { renderLin(); }
  else if (t === 'p') renderProgress();
}
/* 天氣與路況使用既有本機 API；氣象署請求只有縣市代碼，騎士座標不外送。 */
function renderConditions() {
  const ks = Object.values(S.prog).map((p) => +p.km).filter(Number.isFinite);
  const front = ks.length ? Math.min(...ks) : 0;
  const weather = S.weather.filter((x) => x.route_km >= front - 2).slice(0, 2);
  const traffic = S.traffic.filter((x) => x.route_km >= front - 2).slice(0, 2);
  const tiles = [];
  if (S.weatherError) tiles.push(`<div><b>天氣</b>${esc(S.weatherError)}</div>`);
  else if (!weather.length) tiles.push('<div><b>無預報</b>前方沒有可用預報</div>');
  else weather.forEach((x) => tiles.push(`<div><b class="rain">降雨 ${x.pop}%</b>${esc(x.name)}<br>${esc(x.area)}</div>`));
  if (S.trafficError) tiles.push(`<div><b>路況</b>${esc(S.trafficError)}</div>`);
  else if (!traffic.length) tiles.push('<div><b class="okk">順暢</b>前方沒有施工、事故或管制（TDX）</div>');
  else traffic.forEach((x) => tiles.push(`<div><b class="road">${esc(x.type)}</b>${esc(x.name)}・${x.route_km} km</div>`));
  $('#wx').innerHTML = tiles.join('');
}
async function loadConditions() {
  if (!S.route?.coords?.length) { $('#wx').innerHTML = '<p class="empty">這趟沒有預定路線，無法顯示沿途預報。</p>'; return; }
  const samples = [], c = S.route.coords, cum = S.route.cum_km;
  let next = 0;
  c.forEach((point, i) => { if (cum[i] >= next) { samples.push([point[0], point[1], cum[i]]); next += 4; } });
  const last = c.length - 1;
  if (samples.at(-1)?.[2] !== cum[last]) samples.push([c[last][0], c[last][1], cum[last]]);
  const kmh = Math.max(5, Math.min(150, +S.route.summary?.km / (+S.route.summary?.min / 60) || 40));
  const results = await Promise.allSettled(['weather', 'roadevent'].map((kind) => api('/api/poi/along', { method: 'POST', body: { kind, samples, radius_m: kind === 'weather' ? 800 : 500, kmh } })));
  S.weather = results[0].status === 'fulfilled' ? results[0].value : [];
  S.traffic = results[1].status === 'fulfilled' ? results[1].value : [];
  S.weatherError = results[0].status === 'rejected' ? results[0].reason.message : '';
  S.trafficError = results[1].status === 'rejected' ? results[1].reason.message : '';
  renderConditions();
}
async function loadWaypoints() {
  try { S.waypoints = await api(`/api/trips/${tid}/waypoints`); renderCards(); }
  catch { S.waypoints = []; }
}

/* ---------- 右欄：事件 ---------- */
const nameOf = (uid) => S.members.get(uid)?.u.nickname || '';
const chatEv = (m) => ({ ...m, kind: 'event', type: 'chat', text: m.text });
const FEED = eventFilter($('#feedF'), FEED_FILTER_KEY, () => renderFeed());
$('#feedF').classList.add('wchips');
let seenEv = '';
function renderFeed() {
  const events = S.events.filter(FEED.match).slice(-40).reverse();
  const top = events[0] ? `${events[0].id || ''}:${events[0].ts}` : '';
  const fresh = seenEv && top !== seenEv;
  seenEv = top;
  $('#feed').innerHTML = events.map((e, k) => {
    const who = e.uid ? nameOf(e.uid) : '';
    return `<div class="ev${e.type === 'sos' ? ' sos' : ''}${fresh && k === 0 ? ' new' : ''}"><span class="ico" style="--c:${EV[e.type] || '#8e8e93'}">${GLYPH[e.type] || '•'}</span>`
      + `<div><b>${esc(e.text)}</b><span class="num">${esc(EV_NAME[e.type] || '事件')}・${clock(+e.ts)}${who ? '・' + esc(who) : ''}</span></div></div>`;
  }).join('') || '<p class="empty">目前沒有這類事件</p>';
}
// SOS 橫幅：「已處理」只在這台收起（記住那一次 SOS 的時間），同一人再發新的會再出現
const dismissed = new Set();
const sosKey = (uid, e) => `${uid}:${e?.ts || e?.id || ''}`;
function renderSos() {
  const list = [...S.sos].filter(([uid, e]) => !dismissed.has(sosKey(uid, e)));
  const text = ([uid, e]) => `${nameOf(uid)} 發出 SOS${e?.text ? '：' + e.text : ''}${e?.ts ? '・' + ago(+e.ts) : ''}`;
  const box = $('#sosbar'), key = list.map(([uid, e]) => sosKey(uid, e)).join('|');
  // 同一批 SOS 只改文字（每秒更新「N 秒前」），不重建按鈕，點擊才不會被吃掉
  if (box.dataset.key === key) { list.forEach((x, i) => { const t = box.children[i]?.querySelector('.t'); if (t) t.textContent = text(x); }); return; }
  box.dataset.key = key;
  box.innerHTML = list.map((x) => `<div class="sosbar" data-uid="${esc(x[0])}"><span class="t">${esc(text(x))}</span>`
    + '<button type="button" data-a="go">定位</button><button type="button" data-a="ok">已處理</button></div>').join('');
}
$('#sosbar').addEventListener('click', (e) => {
  const b = e.target.closest('button'), bar = e.target.closest('.sosbar');
  if (!b || !bar) return;
  const uid = [...S.sos.keys()].find((k) => String(k) === bar.dataset.uid);
  if (b.dataset.a === 'go') { S.focus = uid; M.unfollow(); resumeFollow(); }
  else { dismissed.add(sosKey(uid, S.sos.get(uid))); renderSos(); }
});
const refreshSos = () => api(`/api/trips/${tid}/sos`).then((list) => { S.sos = new Map(list.map((e) => [e.uid, e])); renderSos(); renderCards(); }).catch(() => {});

/* ---------- 下方：進度＋海拔剖面 ---------- */
async function loadRoute() {
  let r = null;
  try { r = await api(`/api/trips/${tid}/route`); } catch { /* 沒路線或暫時讀不到 */ }
  // 同一條路線（WebSocket 重連時 snapshot 會再叫一次）不要重算海拔：重算要把鏡頭拉到整條路線再拉回來
  const sig = (x) => (x?.coords?.length ? `${x.id ?? ''}:${x.coords.length}:${x.coords[0]}:${x.coords.at(-1)}` : '');
  const same = sig(r) && sig(r) === sig(S.route);
  S.route = r?.coords ? r : null;
  if (!same) S.profile = null;
  map.getSource('route')?.setData(routeGeo());
  if (S.route && !S.profiling && S.profileSig !== sig(S.route)) { S.profileSig = sig(S.route); buildProfile(); }
  renderProgress(); renderCards(); loadConditions();
}
// 海拔：路線整條框進畫面、地形圖磚載入完後，沿路線取 160 個點查地形高度（除掉誇張倍率）
function buildProfile() {
  if (!autoFollow || !M.is3d) { renderProgress(); return; }
  const c = S.route.coords;
  if (!c.length) return;
  const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
  S.profiling = true;
  M.unfollow();
  const cam = map.cameraForBounds(b, { padding: pad(), bearing: 0, pitch: 0 });
  M.ease({ ...(cam || {}), bearing: 0, pitch: 0, duration: 700 });
  // 等地圖 idle（地形圖磚到齊）再取高度；地圖可能一直不 idle，最多等 4 秒，不然鏡頭永遠停在整條路線
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const total = S.route.cum_km.at(-1), out = [];
    let j = 0;
    for (let k = 0; k <= 160; k++) {
      const km = (total * k) / 160;
      while (j < S.route.cum_km.length - 1 && S.route.cum_km[j + 1] < km) j++;
      const e = map.queryTerrainElevation(c[j]);
      out.push([km, e == null ? null : e / EXAG]);
    }
    S.profile = out.filter((x) => x[1] != null).length > 20 ? out.filter((x) => x[1] != null) : null;
    if (autoFollow) M.ease({ pitch: 60, duration: 900 });
    S.profiling = false;
    renderProgress();
  };
  const settle = () => (map.isMoving() ? map.once('moveend', settle) : map.once('idle', finish));
  requestAnimationFrame(settle);
  setTimeout(finish, 4700);
}
// 某公里數的海拔（剖面上線性內插）
function elevAt(km) {
  const P = S.profile;
  if (!P?.length) return null;
  const i = P.findIndex((p) => p[0] >= km);
  if (i <= 0) return P[Math.max(0, i)][1] ?? P.at(-1)[1];
  const a = P[i - 1], b = P[i];
  return a[1] + (b[1] - a[1]) * clamp((km - a[0]) / (b[0] - a[0] || 1), 0, 1);
}
// 畫法照原型 profile()：底部留 16px 寫公里數，上面 18px 寫停靠點名稱；高度從 0 m 起算
function renderProgress() {
  const cv = $('#pc'), dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.body), muted = css.getPropertyValue('--muted').trim() || '#98989d';
  const font = css.getPropertyValue('--font').trim() || '-apple-system,sans-serif';
  g.font = `11px ${font}`;
  g.fillStyle = muted;
  const total = S.route?.cum_km?.at(-1);
  if (!(total > 0)) { g.textAlign = 'center'; g.fillText('這趟沒有預定路線，無法畫全隊進度', w / 2, h / 2); return; }
  const P = S.profile, hi = P ? Math.max(...P.map((p) => p[1])) : 0, top = Math.max(100, hi * 1.06);
  const y = (e) => h - 16 - (h - 34) * clamp(e ?? 0, 0, top) / top;
  const X = (km) => w * clamp(km / total, 0, 1);
  if (P) {
    g.beginPath(); g.moveTo(0, h - 16); P.forEach(([km, e]) => g.lineTo(X(km), y(e))); g.lineTo(w, h - 16); g.closePath();
    g.fillStyle = 'rgba(255,138,61,.16)'; g.fill();
    g.beginPath(); P.forEach(([km, e], k) => (k ? g.lineTo(X(km), y(e)) : g.moveTo(X(km), y(e)))); g.strokeStyle = '#ff8a3d'; g.lineWidth = 2; g.stroke();
  } else {
    g.beginPath(); g.moveTo(0, h - 16); g.lineTo(w, h - 16); g.strokeStyle = '#ff8a3d'; g.lineWidth = 2; g.stroke();
  }
  // 休息／集合點：細線＋名稱；名稱撞到前一個就換到第二排
  g.fillStyle = muted;
  let end1 = -Infinity, end2 = -Infinity;
  for (const wp of stops()) {
    const x = X(wp.km), tw = g.measureText(wp.name).width, tx = Math.min(w - tw - 2, x + 4);
    const row2 = tx < end1 + 6;
    if (row2 && tx < end2 + 6) { g.fillRect(x, 6, 1, h - 22); continue; }
    g.fillRect(x, row2 ? 20 : 6, 1, h - (row2 ? 36 : 22));
    g.fillText(wp.name, tx, row2 ? 28 : 14);
    if (row2) end2 = tx + tw; else end1 = tx + tw;
  }
  g.fillText('0 km', 0, h - 2);
  g.textAlign = 'right'; g.fillText(`${Math.round(total)} km`, w, h - 2);
  if (P) { g.textAlign = 'center'; g.fillText(`最高 ${Math.round(hi)} m`, w / 2, h - 2); }
  g.textAlign = 'center';
  // 每個人：彩色圓＋名字縮寫（後面的先畫，帶頭的疊在最上面）
  const list = [...S.members.values()].filter((m) => kmOf(m) != null && m.u.active !== false).sort((a, b) => kmOf(a) - kmOf(b));
  for (const m of list) {
    const km = clamp(kmOf(m), 0, total), x = X(km), yy = y(P ? elevAt(km) : 0);
    g.beginPath(); g.arc(x, yy, 8, 0, 7); g.fillStyle = m.u.color; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
    if (S.focus === m.u.uid) { g.beginPath(); g.arc(x, yy, 11.5, 0, 7); g.strokeStyle = '#ff8a3d'; g.lineWidth = 2; g.stroke(); }
    g.fillStyle = inkOn(m.u.color); g.font = `bold 10px ${font}`; g.fillText(initialOf(m.u.nickname), x, yy + 3.5);
  }
  g.textAlign = 'left';
}

/* ---------- 通知橫幅：重要事件一次跳一則，4 秒自己收；手指往上滑掉 ---------- */
// SOS 另有固定橫幅（renderSos），這裡不重複
const NOTIFY = new Set(['behind', 'lost', 'offroute', 'stuck', 'arrive', 'allin', 'roadevent', 'weather']);
const noteQ = [];
let noteOn = false, noteT = 0;
function notify(e) {
  if (!NOTIFY.has(e.type) || !e.text) return;
  noteQ.push(e);
  if (noteQ.length > 5) noteQ.shift();  // 一下子來很多：只留最新的幾則
  if (!noteOn) nextNote();
}
function nextNote() {
  const n = $('#note'), e = noteQ.shift();
  if (!e) { noteOn = false; return; }
  noteOn = true;
  const who = e.uid ? nameOf(e.uid) : '';
  n.innerHTML = `<span class="ico" style="--c:${EV[e.type] || '#8e8e93'}">${GLYPH[e.type] || '•'}</span><div><b>${esc(e.text)}</b><small class="num">${esc(EV_NAME[e.type] || '事件')}・${clock(+e.ts || Date.now())}${who ? '・' + esc(who) : ''}</small></div>`;
  n.dataset.uid = e.uid || '';
  n.style.removeProperty('--ny');
  n.classList.add('on');
  clearTimeout(noteT);
  noteT = setTimeout(hideNote, 4000);
}
function hideNote() {
  const n = $('#note');
  clearTimeout(noteT);
  n.classList.remove('on');
  setTimeout(nextNote, 380);  // 收起動畫跑完再出下一則
}
{
  const n = $('#note');
  let y0 = null, dy = 0, pid = null;
  n.addEventListener('pointerdown', (e) => { if (!n.classList.contains('on')) return; y0 = e.clientY; dy = 0; pid = e.pointerId; clearTimeout(noteT); n.classList.add('drag'); try { n.setPointerCapture(pid); } catch { /* ignore */ } });
  n.addEventListener('pointermove', (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    dy = e.clientY - y0;
    n.style.setProperty('--ny', `${dy < 0 ? dy : dy / 4}px`);  // 往下拉只會一點點（橡皮筋）
  });
  const end = (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    y0 = null; n.classList.remove('drag');
    if (dy < -24) { n.style.setProperty('--ny', '-160%'); hideNote(); return; }
    n.style.removeProperty('--ny');
    // 點一下（沒滑）：鏡頭跟著那個人
    if (Math.abs(dy) < 6 && n.dataset.uid) { const id = [...S.members.keys()].find((k) => String(k) === n.dataset.uid); if (id != null) pick(id); hideNote(); return; }
    noteT = setTimeout(hideNote, 2500);
  };
  n.addEventListener('pointerup', end);
  n.addEventListener('pointercancel', end);
}

/* ---------- WebSocket ---------- */
// 自動重連＋斷線橫幅在 livesock.js（和行程頁共用）
function connect() {
  liveSocket(`/ws/trips/${tid}${WATCH ? `?watch=${encodeURIComponent(WATCH)}` : ''}`, { onMessage: handle, onForbidden: () => { tripGate(tid, { fresh: true }); } });
}
function handle(msg) {
  switch (msg.kind) {
    case 'snapshot': {
      const t = msg.trip;
      S.trip = t;
      t.members.forEach((u) => { const m = upsert(u, { ...u.state }); if (!m) return; m.trail = (t.trails[u.uid] || []).slice(); if (u.state?.pre) m.lastRough = true; if (numeric(u.state?.route_km)) S.prog[u.uid] = { km: +u.state.route_km }; });
      S.events = t.events; S.gaps = t.gaps || {}; S.flags = t.flags || {};
      $('#name').textContent = `戰情室・${t.name}`;
      document.title = `戰情室 · ${t.name}`;
      refreshSos();
      loadRoute(); loadWaypoints(); renderCards(); renderFeed(); renderHead();
      // 最近的聊天併進事件流（聊天另存一條 Stream）
      api(`/api/trips/${tid}/chat?limit=20`).then((d) => {
        S.events = [...S.events, ...d.items.map(chatEv)].sort((a, b) => +a.ts - +b.ts).slice(-200);
        renderFeed();
      }).catch(() => {});
      break;
    }
    case 'pos': {
      const m = S.members.get(msg.uid);
      if (!m) break;
      m.state = { ...m.state, ...msg, status: 'ok', seen: Date.now() };
      if (numeric(msg.speed)) { m.recent.push({ at: Date.now(), kmh: +msg.speed * 3.6 }); m.recent = m.recent.filter((x) => Date.now() - x.at < 10 * 60_000).slice(-180); }
      // 動畫長度＝跟上一點的間隔（和行程頁一樣），跟隨時鏡頭才不會一頓一頓
      const tnow = performance.now(), gap = m.lastAt ? tnow - m.lastAt : 1000;
      m.lastAt = tnow;
      if (!msg.pre && parkedJitter(m, +msg.lon, +msg.lat)) break; // 停著時原地飄移：圖釘和鏡頭都不跟著跳
      m.from = m.pos || [msg.lon, msg.lat]; m.to = [msg.lon, msg.lat]; m.t0 = tnow; m.dur = Math.min(3000, Math.max(250, gap * 1.1));
      if (m.pos && !m.lastRough) m.trail.push(m.pos);
      m.lastRough = !!msg.rough || !!msg.pre;  // 精度太差的點、行程開始前的即時位置只移動圖釘，不接進軌跡線
      if (m.trail.length > 3000) m.trail.splice(0, 500);
      break;
    }
    case 'status': { const m = S.members.get(msg.uid); if (m) { m.state.status = msg.status; if (msg.status === 'done') m.u.active = false; } break; }
    case 'stats': { const m = S.members.get(msg.uid); if (m) m.u.stats = msg; break; }
    case 'gap': S.gaps = msg.gaps; S.flags = msg.flags; S.lagKm = msg.lag_km; break;
    case 'progress': S.prog[msg.uid] = { km: msg.km, off: msg.off_m }; break;
    case 'route': loadRoute(); break;
    case 'waypoints': S.waypoints = msg.items || []; renderCards(); break;
    case 'member': upsert(msg.user, {}); break;
    case 'trip': if (S.trip) S.trip.status = msg.status; renderHead(); break;
    case 'kicked': if (msg.uid === S.trip?.me) tripGate(tid, { fresh: true }); else { dropMember(msg.uid); VIEWERS.delete(msg.uid); } break;
    case 'event':
      S.events.push(msg);
      if (S.events.length > 200) S.events.shift();
      if (msg.type === 'sos') S.sos.set(msg.uid, msg);
      if (msg.type === 'sos_off') S.sos.delete(msg.uid);
      if (msg.type === 'allin' || msg.type === 'arrive' || msg.type === 'regroup') loadWaypoints();  // 到齊人數
      notify(msg);
      renderFeed(); renderSos();
      break;
    case 'chat':  // 聊天另存在 trip:{id}:chat，大螢幕也顯示在事件裡
      S.events.push(chatEv(msg));
      if (S.events.length > 200) S.events.shift();
      renderFeed();
      break;
    case 'sos_refresh':  // 後台清掉測試 SOS
      refreshSos();
      break;
  }
}
// 每秒更新：計時、KPI、進度條、看得到的分頁（原型也是每秒一次）
setInterval(() => {
  renderHead();
  renderStrip();
  renderPane();
  renderSos();
}, 1000);
setInterval(() => { if (S.route) renderConditions(); }, 5000);
setInterval(() => { if (S.route) loadConditions(); loadWaypoints(); }, 5 * 60_000);
connect();

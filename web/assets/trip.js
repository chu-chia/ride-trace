import { api, tripGate, armConfirm, $, $$, esc, avatar, initialOf, inkOn, press, clock, dur, ago, toast, teamTable, initPanel, setLabel, smoothPad, frameGate, LOW_POWER, gapGlow, markFocus, isWeak, eventFilter } from '/assets/common.js';
import { createMap, declutter, addCompass } from '/assets/mapbase.js';
import { cameraGestures, resumeMs } from '/assets/gestures.js';
import { liveSocket } from '/assets/livesock.js';
import { gpsQueue } from '/assets/gpsqueue.js';

const tid = new URLSearchParams(location.search).get('id');
// 打錯 id、不是成員、被移出、沒登入：先擋下來顯示錯誤畫面（或導去登入），不會卡在「載入中」一直重連（UX-02）
await tripGate(tid);

const STATUS = {
  ride: ['騎乘中', 'ok'], rest: ['停車中', 'info'], weak: ['訊號弱', 'warn'],
  lost: ['失聯', 'crit'], done: ['已結束紀錄', ''], none: ['尚未回報', ''],
};
const TRIP_ST = { planned: ['等待開始', 'info'], live: ['進行中', 'ok'], ended: ['已結束', ''] };
const EV = {
  lost: ['失聯', 'var(--crit)', '!', '#ff3b30'], back: ['恢復', 'var(--ok)', '回', '#30a46c'],
  start: ['開始', 'var(--accent)', '騎', '#d9500f'], end: ['結束', 'var(--muted)', '終', '#8e8e93'],
  join: ['加入', 'var(--accent)', '入', '#2aabee'], stop: ['結束紀錄', 'var(--muted)', '停', '#8e8e93'],
  kick: ['移出', 'var(--warn)', '出', '#ffcc00'], create: ['建立', 'var(--muted)', '建', '#8e8e93'],
  behind: ['落隊', 'var(--warn)', '!', '#ffcc00'], ahead: ['超前', 'var(--warn)', '前', '#ffcc00'],
  regroup: ['跟上', 'var(--ok)', '合', '#30a46c'],
  waypoint: ['集合點', 'var(--muted)', '集', '#8e8e93'], arrive: ['抵達', 'var(--ok)', '到', '#30a46c'],
  allin: ['全員到齊', 'var(--ok)', '齊', '#30a46c'],
  roadevent: ['路況', 'var(--warn)', '路', '#ff9f0a'],
  weather: ['降雨', 'var(--accent)', '雨', '#0a84ff'],
  msg: ['訊息', 'var(--accent)', '訊', '#0a84ff'], mark: ['標註', 'var(--warn)', '註', '#ff9f0a'],
  sos: ['SOS', 'var(--crit)', 'S', '#ff3b30'], sos_off: ['解除 SOS', 'var(--ok)', '安', '#30a46c'],
  route: ['路線', 'var(--accent)', '路', '#0a84ff'], offroute: ['偏離路線', 'var(--warn)', '偏', '#ff9f0a'],
  onroute: ['回到路線', 'var(--ok)', '回', '#30a46c'],
  stuck: ['異常久停', 'var(--warn)', '停', '#ff9f0a'], moving: ['恢復移動', 'var(--ok)', '動', '#30a46c'],
  town: ['點亮鄉鎮', 'var(--accent)', '亮', '#ff8a3d'],
};
const fmtKm = (km) => (Math.abs(km) < 1 ? Math.round(Math.abs(km) * 1000) + ' m' : Math.abs(km).toFixed(1) + ' km');

// 預設深色＋3D（山的地形＋城市建築）
const M = createMap($('#map'), { style: 'dark', zoom: 7, terrain: true });
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
const map = M.map;
map.setPitch(55);
window.qijiMap = map; // 方便在主控台除錯
window.qijiM = M; // trip-extra.js（M3 互動功能）用
const S = { trip: null, me: null, members: new Map(), events: [], follow: 'all', away: false, awayAt: 0, lastInteract: 0, nearby: {}, nearbyFail: 0, gps: null, wake: null, trailDirty: true };
window.qijiState = S; // 除錯用

/* ---------- 成員與標記 ---------- */
function statusOf(m) {
  const s = m.state || {};
  if (s.status === 'done') return 'done';
  if (s.status === 'lost') return 'lost';
  if (s.lat == null || s.lat === '') return 'none';
  if (isWeak(s)) return 'weak';
  return (+s.speed || 0) * 3.6 < 5 ? 'rest' : 'ride';
}

function upsertMember(u, state) {
  let m = S.members.get(u.uid);
  if (!m) {
    const el = document.createElement('div');
    el.className = 'rider' + (u.uid === S.me ? ' me' : '');
    el.style.setProperty('--c', u.color);
    el.style.setProperty('--ink', inkOn(u.color));
    el.innerHTML = `<div class="arrow"></div><div class="dot">${esc(initialOf(u.nickname))}</div><div class="name">${esc(u.nickname)}</div>`;
    el.onclick = () => pick(u.uid);
    m = { u, state: {}, el, marker: new maplibregl.Marker({ element: el, anchor: 'center', opacityWhenCovered: '1', subpixelPositioning: true }), trail: [], onMap: false, pos: null, anim: null, lastAt: 0, lastTarget: null };
    S.members.set(u.uid, m);
  }
  m.u = { ...m.u, ...u };
  if (state) m.state = { ...m.state, ...state };
  if (!m.pos && m.state.lat != null && m.state.lat !== '') {
    m.pos = [+m.state.lon, +m.state.lat];
    m.lastTarget = m.pos;
  }
  placeMarker(m);
  return m;
}

// 收到新位置時不直接跳過去，而是在「距離上一筆的時間」內慢慢滑到新位置
// rough：精度太差的點（後端標記），只移動圖釘，不接進軌跡線
function moveTo(m, lon, lat, rough = false) {
  const now = performance.now();
  const to = [lon, lat];
  const gap = m.lastAt ? now - m.lastAt : 1000;
  m.lastAt = now;
  if (m.lastTarget && !m.lastRough) {
    const last = m.trail[m.trail.length - 1];
    if (!last || last[0] !== m.lastTarget[0] || last[1] !== m.lastTarget[1]) m.trail.push(m.lastTarget);
  }
  m.lastTarget = to;
  m.lastRough = rough;
  const far = !m.pos || Math.abs(to[0] - m.pos[0]) + Math.abs(to[1] - m.pos[1]) > 0.05; // 超過約 5 km 就直接跳
  if (far) { m.pos = to; m.anim = null; }
  else m.anim = { from: m.pos.slice(), to, t0: now, dur: Math.min(3000, Math.max(250, gap * 1.1)) };
  if (m.trail.length > 4000) m.trail.splice(0, 1000);
}

function placeMarker(m) {
  if (!m.pos) return;
  m.marker.setLngLat(m.pos);
  if (!m.onMap) { m.marker.addTo(map); m.onMap = true; }
  const s = m.state, st = statusOf(m);
  m.el.classList.toggle('lost', st === 'lost');
  m.el.classList.toggle('rest', st === 'rest' || st === 'none');
  m.el.classList.toggle('done', st === 'done');
  gapGlow(m.el, !!S.trip?.flags?.[m.u.uid] && st !== 'done', S.trip?.gaps?.[m.u.uid], S.trip?.lag_km);
  const hd = s.heading != null && s.heading !== '' ? +s.heading : null;
  m.el.querySelector('.arrow').style.transform = `rotate(${(hd ?? 0) - map.getBearing()}deg)`;
  m.el.querySelector('.arrow').style.visibility = hd == null ? 'hidden' : '';
}
map.on('rotate', () => S.members.forEach(placeMarker));

/* ---------- 軌跡圖層 ---------- */
function trailsGeo() {
  return {
    type: 'FeatureCollection',
    features: [...S.members.values()].map((m) => ({
      type: 'Feature', properties: { color: m.u.color },
      geometry: { type: 'LineString', coordinates: m.pos ? [...m.trail, m.pos] : m.trail },
    })).filter((f) => f.geometry.coordinates.length > 1),
  };
}
M.onStyle(() => {
  if (!map.getSource('trails')) map.addSource('trails', { type: 'geojson', data: trailsGeo() });
  if (!map.getLayer('trails')) {
    map.addLayer({ id: 'trails-casing', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-opacity': 0.25, 'line-width': 6 } });
    map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.9 } });
  }
  setLabel($('#bStyle'), M.styleName);
  S.styleReady = true; // isStyleLoaded() 在圖磚載入中都是 false，不能拿來判斷
});

/* ---------- 鏡頭 ---------- */
// 手勢規則（docs/地圖手勢規則.md）：拖曳＝暫離（按鈕變外框，10 秒沒動自動回去）；縮放、旋轉、傾斜繼續跟隨；
// 全隊模式下縮放也算暫離（全隊會一直改 zoom，跟使用者搶）
function goAway() {
  S.lastInteract = Date.now();
  S.awayAt = Date.now();
  if (S.away) return;
  S.away = true; S.fly = null;
  M.unfollow();
  syncTools();
  if (S.trip) renderTeam();
}
S.goAway = goAway; // trip-extra.js：點地點、事件把鏡頭帶過去時也算暫離
const GEST = cameraGestures(M, {
  centered: () => !S.away && S.follow !== 'all',
  onPan: goAway,
  onZoom: () => { if (S.follow === 'all' && !S.away) goAway(); },
  onActivity: () => { S.lastInteract = Date.now(); if (S.away) S.awayAt = Date.now(); },
});
// 側欄收合（電腦收合鈕／手機拉把手）由 common.js initPanel 統一處理，這裡只更新地圖留白
function panelPad() {
  const narrow = innerWidth <= 760;
  if (!narrow) return { top: 70, bottom: 90, left: ($('#panel').offsetWidth || 380) + 50, right: 80 };
  // 用抽屜實際的高度；開合後 smoothPad 讓鏡頭慢慢滑到新的置中位置（拖曳中不更新，所以不會跟著手指晃）
  // 抽屜拉高時留白最多用到畫面高度的 60%，不然可視區只剩一條、cameraForBounds 也會算不出來（UX-11）
  // 放大 200%（195 px 寬）時固定 px 的留白會吃掉大半畫面，左右上方都跟著畫面縮（UX-15）
  const top = Math.min(80, innerHeight * 0.16), left = Math.min(30, innerWidth * 0.08), right = Math.min(64, innerWidth * 0.2);
  return { top, bottom: Math.min(innerHeight * 0.6, Math.max(Math.min(60, innerHeight * 0.12), innerHeight - $('#panel').getBoundingClientRect().top + 16)), left, right };
}
let PAD = null;
const refreshPad = () => setTimeout(() => PAD?.refresh(), innerWidth <= 760 ? 0 : 300); // 電腦側欄寬度有 0.25 秒轉場，等它停
S.refreshPad = refreshPad;
addEventListener('resize', refreshPad);
// 抽屜開合後，還沒有人在騎時重新框一次（不然台灣會被拉高的抽屜蓋住，UX-11）
const PANEL = initPanel($('#panel'), 'trip', { onChange: () => { refreshPad(); setTimeout(() => S.trip && fitFallback(), 500); } });
PAD = smoothPad(panelPad);
Object.defineProperty(S, 'pad', { get: () => PAD.get(), set() {}, configurable: true });
const setCollapsed = (v) => PANEL.set(v);
S.panel = PANEL; // trip-extra.js：在地圖上點選位置時先收起抽屜（UX-34）

// 「全隊」框哪些人：有位置、這趟有出發（active，或已騎完 done）、沒有失聯。
// 沒出發的成員（例如建立者自己在家）位置在別處，算進來鏡頭會先拉到全台灣
const inGroup = (m) => m.pos && (m.u.active !== false || m.state?.status === 'done') && m.state?.status !== 'lost';
// 要跟著誰：選了某個人就跟他；「全隊」但地圖上只有一個人時，也跟著那個人
function followTarget() {
  if (S.follow !== 'all') { const m = S.members.get(S.follow); return m?.pos ? m : null; }
  const shown = [...S.members.values()].filter(inGroup);
  return shown.length === 1 ? shown[0] : null;
}
function setFollow(who, { keepZoom = false } = {}) {
  S.follow = who;
  S.away = false;
  S.lastInteract = 0;
  S.followZoomed = false;
  S.keepZoom = keepZoom;
  S.fly = null;
  syncTools();
  GEST.sync();
  // 不用 easeTo：動畫迴圈每一格從目前畫面平滑接過去（跟人用 S.fly 內插、全隊用 followGroup），中間沒有交接的跳動
  if (who === 'all') M.regroup();
  if (!S.styleReady) camera(true);
  if (S.trip) renderTeam();  // 隊員表的選取狀態跟著換
}
// 點隊員（列表、標記、「跟我」）：正在跟他就回到全隊；暫離中或還沒跟就跟他
const pick = (uid) => setFollow(S.follow === uid && !S.away ? 'all' : uid);
const hav = (a, b, c, d) => { const R6 = 6371000, p1 = (a * Math.PI) / 180, p2 = (c * Math.PI) / 180, dl = ((d - b) * Math.PI) / 180; return 2 * R6 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2)); };
function camera(force) {
  if (!force && S.away) return;
  if (followTarget()) return; // 跟隨模式由動畫迴圈每一格把人放在正中間
  const pts = [...S.members.values()].filter(inGroup).map((m) => m.pos);
  if (!pts.length) { fitFallback(); return; }
  if (pts.length < 2) return;
  fitPoints(pts, 15, 900);
}
// 自己算 zoom（不考慮傾斜，再留一點邊）：傾斜 55° 加上手機抽屜的留白時，cameraForBounds 會算得太保守，
// 甚至算不出來（Console「Map cannot fit within canvas」，UX-11）
function fitPoints(pts, maxZoom, duration) {
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  const box = map.getContainer(), pad = S.pad;
  const W = Math.max(box.clientWidth * 0.25, box.clientWidth - pad.left - pad.right);
  const H = Math.max(box.clientHeight * 0.2, box.clientHeight - pad.top - pad.bottom);
  const sw = maplibregl.MercatorCoordinate.fromLngLat(b.getSouthWest()), ne = maplibregl.MercatorCoordinate.fromLngLat(b.getNorthEast());
  const z = Math.log2(Math.min(W / Math.max(1e-9, Math.abs(ne.x - sw.x) * 512), H / Math.max(1e-9, Math.abs(ne.y - sw.y) * 512))) - 0.35;
  if (!Number.isFinite(z)) return false;
  const cam = { center: b.getCenter(), zoom: Math.max(1, Math.min(maxZoom, z)), pitch: map.getPitch(), padding: pad };
  S.easeUntil = performance.now() + duration + 50;
  if (duration) map.easeTo({ ...cam, duration });
  else map.jumpTo(cam);
  return true;
}
// 還沒有人在騎（行程還沒開始、大家都還沒回報）：先框路線，沒有路線就框有位置的人，再不行就框台灣（UX-11）。
// 使用者 10 秒內動過地圖就不搶鏡頭
function fitFallback() {
  if (S.away || (S.lastInteract && Date.now() - S.lastInteract < 10000)) return;
  if ([...S.members.values()].some(inGroup)) return;
  const route = S.routeCoords, known = [...S.members.values()].filter((m) => m.pos).map((m) => m.pos);
  const pts = route?.length ? route : known.length ? known : [[119.9, 21.8], [122.1, 25.4]];
  if (!fitPoints(pts.length === 1 ? [pts[0], pts[0]] : pts, 14, S.styleReady ? 600 : 0)) map.jumpTo({ center: [120.97, 23.7], zoom: 6.6 });
}
S.fitFallback = fitFallback; // trip-extra.js：路線載入後再框一次
// 之後「全隊」由動畫迴圈每一格平滑追（M.followGroup），不再定時 easeTo

// 動畫迴圈：標記平滑移動、跟隨的人保持在畫面中間、軌跡線尾巴接著標記
let lastTrailDraw = 0, lastDeclutter = 0;
const gate = frameGate();
function tick(now) {
  if (!gate(now)) { requestAnimationFrame(tick); return; } // 省電模式約 30 fps
  for (const m of S.members.values()) {
    if (!m.anim) continue;
    const k = Math.min(1, (now - m.anim.t0) / m.anim.dur);
    m.pos = [m.anim.from[0] + (m.anim.to[0] - m.anim.from[0]) * k, m.anim.from[1] + (m.anim.to[1] - m.anim.from[1]) * k];
    if (k >= 1) m.anim = null;
    m.marker.setLngLat(m.pos);
  }
  const t = followTarget();
  // 暫離超過設定秒數（預設 10 秒）、手指也不在地圖上，就回到原本的模式（縮放維持使用者調的）
  const back = resumeMs();
  if (S.away && back > 0 && !M.busy && Date.now() - S.awayAt > back) setFollow(S.follow, { keepZoom: true });
  if (t && !S.away) {
    // 切換跟隨對象：每一格朝他「現在」的位置內插過去（人一直在動，easeTo 到按下時的位置，結束會再跳一次），
    // 飛完直接接上跟隨。
    if (!S.followZoomed && S.styleReady) {  // 跟隨中使用者自己拉遠不再強制拉近（手勢規則第 2 條）
      S.followZoomed = true;
      const c = map.getCenter(), km = hav(c.lat, c.lng, t.pos[1], t.pos[0]) / 1000;
      S.fly = { at: now, from: [c.lng, c.lat], z0: map.getZoom(), z1: S.keepZoom ? map.getZoom() : Math.max(map.getZoom(), 14.5),
                dur: Math.min(1800, 700 + km * 40), dip: Math.max(0, Math.min(5, Math.log2(Math.max(1, km / 2)))) };
    }
    if (now > (S.easeUntil || 0)) {
      let center = t.pos, extra = {};
      if (S.fly) {
        const f = S.fly, k = Math.min(1, (now - f.at) / f.dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        center = [f.from[0] + (t.pos[0] - f.from[0]) * e, f.from[1] + (t.pos[1] - f.from[1]) * e];
        // 距離遠時中途先拉遠一點再拉近，不會一路掃過一大堆圖磚
        extra = { zoom: f.z0 + (f.z1 - f.z0) * e - f.dip * Math.sin(Math.PI * e) };
        if (k >= 1) S.fly = null;
      }
      M.follow(center, { padding: S.pad, ...extra });
    }
  } else if (!t && S.follow === 'all' && S.styleReady && !S.away && now > (S.easeUntil || 0)) {
    const pts = [...S.members.values()].filter(inGroup).map((m) => m.pos);
    if (pts.length >= 2) M.followGroup(pts, { padding: S.pad, maxZoom: 15 });
  } else M.unfollow();
  if (now - lastDeclutter > 200) {
    lastDeclutter = now;
    const ft = followTarget();
    const list = [...S.members.values()].filter((m) => m.onMap && m.pos)
      .sort((a, b) => (b.u.uid === S.me) - (a.u.uid === S.me) || (b === ft) - (a === ft));
    declutter(map, list.map((m) => ({ el: m.el, pos: m.pos, name: m.u.nickname })));
  }
  if (now - lastTrailDraw > (LOW_POWER ? 1000 : 150) && map.getSource('trails')) {
    lastTrailDraw = now;
    map.getSource('trails').setData(trailsGeo());
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 實心＝正在跟、外框＝暫離（點了回去）
function syncTools() {
  press($('#bAll'), S.follow === 'all' && !S.away);
  press($('#bMe'), S.follow === S.me && !S.away);
  $('#bAll').classList.toggle('away', S.follow === 'all' && S.away);
  $('#bMe').classList.toggle('away', S.follow === S.me && S.away);
  markFocus([...S.members].map(([id, m]) => [id, m.el]), S.follow === 'all' ? null : S.follow, S.away);
}
$('#bAll').onclick = () => setFollow('all');
$('#bMe').onclick = () => pick(S.me);
$('#bStyle').onclick = () => setLabel($('#bStyle'), M.nextStyle());
$('#b3d').onclick = () => { M.set3d(!M.is3d); press($('#b3d'), M.is3d); };

/* ---------- 面板 ---------- */
const TAB_KEY = `qiji:tripTab:${tid}`;
function saveTab() {
  try { sessionStorage.setItem(TAB_KEY, JSON.stringify({ tab: $$('.panel-body[data-b]').find((x) => !x.hidden)?.dataset.b, more: $('#moreNav button.on')?.dataset.moreTab })); } catch { /* 私密模式 */ }
}
function selectTab(name, { open = true } = {}) {
  const primary = ['wp', 'events', 'mark'].includes(name) ? 'more' : name;
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.t === primary));
  $$('.panel-body[data-b]').forEach((x) => (x.hidden = x.dataset.b !== name));
  if (open) setCollapsed(false);
  saveTab();
  dispatchEvent(new CustomEvent('qiji:tab', { detail: { tab: name, more: $('#moreNav button.on')?.dataset.moreTab } }));
}
function selectMore(name, opts) {
  $$('#moreNav button').forEach((x) => x.classList.toggle('on', x.dataset.moreTab === name));
  $$('.moreSection').forEach((x) => (x.hidden = x.dataset.more !== name));
  selectTab('more', opts);
}
$('#tabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) selectTab(b.dataset.t); };
$('#moreNav').onclick = (e) => { const b = e.target.closest('[data-more-tab]'); if (b) selectMore(b.dataset.moreTab); };
$$('[data-open-tab]').forEach((b) => { b.onclick = () => selectTab(b.dataset.openTab); });
$$('[data-back-more]').forEach((b) => { b.onclick = () => selectTab('more'); });
addEventListener('qiji:open-tab', (e) => { if (e.detail.more) selectMore(e.detail.more); else selectTab(e.detail.tab); });
// 網址 #分頁 優先；否則回到重新整理前的分頁（UX-49）。重新整理不改抽屜開合（開合另外記在 initPanel）
const TABS = ['team', 'route', 'msg', 'more', 'wp', 'events', 'mark'];
function restoreTab() {
  const h = location.hash.slice(1);
  if (TABS.includes(h)) { selectTab(h); return; }
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(TAB_KEY) || 'null'); } catch { /* 略過 */ }
  if (!saved || !TABS.includes(saved.tab)) return;
  if (saved.more && $(`#moreNav [data-more-tab="${saved.more}"]`)) selectMore(saved.more, { open: false });
  if (saved.tab !== 'more' || !saved.more) selectTab(saved.tab, { open: false });
}

// 橫幅：每秒重畫，但內容沒變就不動 DOM（按鈕的「再按一次確定」倒數才不會被洗掉）
function setBanner(html, bind) {
  const b = $('#banner');
  b.hidden = !html;
  if (b.dataset.html === html) return;
  b.dataset.html = html;
  b.innerHTML = html;
  bind?.();
}
const inviteBtn = '<button class="btn" data-invite>＋ 邀請隊友</button>';
function renderHeader() {
  const t = S.trip;
  $('#tName').textContent = t.name;
  document.title = `${t.name} · 騎跡`;
  const [label, cls] = TRIP_ST[t.status] || ['', ''];
  $('#tStatus').className = 'chip ' + cls;
  $('#tStatus').textContent = label;
  $('#tTimer').textContent = t.status === 'live' && t.started ? '已騎 ' + dur(Date.now() - +t.started) : '';
  const meActive = S.members.get(S.me)?.u.active;
  if (t.status === 'planned') {
    setBanner(t.is_owner
      ? `<div>行程還沒開始。等大家到齊後按開始，所有人的位置才會開始記錄，也會通知全隊。</div><div class="bannerBtns">${inviteBtn}<button class="btn primary" id="startBtn">開始行程</button></div>`
      : `<div>等待建立者開始行程。可以先到「更多 → 裝置與通知」設定位置來源。</div><div class="bannerBtns">${inviteBtn}</div>`,
    () => $('#startBtn')?.addEventListener('click', (e) => {
      // 一按就會推播給全隊：先確認一次（UX-45）
      armConfirm(e.currentTarget, '再按一次開始（會通知全隊）', async () => {
        try { S.trip = { ...S.trip, ...(await api(`/api/trips/${tid}/start`, { method: 'POST' })) }; renderAll(); }
        catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
      });
    }));
  } else if (t.status === 'ended') {
    setBanner(`<div>行程已結束，可以整隊回放這一趟。</div><a class="btn primary" href="/replay?id=${tid}">看回放</a>`);
  } else if (t.status === 'live' && (meActive || t.is_owner)) {
    // 「我騎完了」放在面板上，不用到 更多 → 裝置與通知 找；建立者可以直接結束整趟（UX-10）
    setBanner(`<div class="bannerBtns">${meActive ? '<button class="btn" id="doneBtn">我騎完了</button>' : ''}${t.is_owner ? '<button class="btn danger" id="finishBtn">結束整趟行程</button>' : ''}</div>`, () => {
      $('#doneBtn')?.addEventListener('click', (e) => armConfirm(e.currentTarget, '再按一次結束我的紀錄', endMine));
      $('#finishBtn')?.addEventListener('click', (e) => armConfirm(e.currentTarget, '再按一次結束全隊', async () => {
        try { await api(`/api/trips/${tid}/finish`, { method: 'POST' }); }
        catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
      }));
    });
  } else setBanner('');
  $('#endBtn').hidden = !(t.status === 'live' && meActive);
  $('#teamInvite').hidden = t.status === 'ended';
}
// 邀請入口（等待卡片、隊友分頁）都打開 更多 → 邀請隊友（UX-24）
document.addEventListener('click', (e) => { if (e.target.closest('[data-invite], #teamInvite')) selectMore('invite'); });

function renderTeam() {
  // 固定順序：我在最上面，其他人依加入順序（uid），不會因為狀態變化跳來跳去（UX-60）
  const list = [...S.members.values()].sort((a, b) => (b.u.uid === S.me) - (a.u.uid === S.me) || (+a.u.uid - +b.u.uid));
  const online = list.filter((m) => ['ride', 'rest', 'weak'].includes(statusOf(m))).length;
  $('#sOnline').textContent = `${online}/${list.length}`;
  const me = S.members.get(S.me);
  // 失聯、訊號弱、還沒回報、已結束：最後的速度不是現在的速度，不要大字顯示（UX-46）
  const meLive = me && ['ride', 'rest'].includes(statusOf(me));
  $('#sSpeed').textContent = meLive && me.state.speed != null && me.state.speed !== '' ? Math.round(+me.state.speed * 3.6) : '–';
  $('#sAlt').textContent = me?.state.alt != null && me.state.alt !== '' ? Math.round(+me.state.alt) : '–';
  $('#sSpeed').title = meLive ? '' : '目前沒有即時位置';
  $('#cOnline').textContent = $('#sOnline').textContent;
  $('#cSpeed').textContent = $('#sSpeed').textContent;
  const lagging = list.filter((m) => S.trip.flags?.[m.u.uid] === 'behind' && statusOf(m) !== 'done').length;
  // 「進團」和「正在回報位置」分開寫：大家都開著網頁、但還沒人開始回報時，不會看起來像全員離線（UX-33）
  $('#quickTeam').textContent = `${list.length} 人進團・${online ? `${online} 人正在回報` : '還沒有人回報位置'}${lagging ? `・${lagging} 人落隊` : ''}`;
  $('#sOnline').title = `${list.length} 人進團，${online} 人正在回報位置`;
  // 和回放頁同一種隊員表：名字＋狀態、速度、海拔、已騎、距離我；點一下鏡頭跟著他
  teamTable($('#team'), list.map((m) => {
    const st = statusOf(m), [label, cls] = STATUS[st], s = m.state;
    const isMe = m.u.uid === S.me, km = S.nearby[m.u.uid];
    const gap = S.trip.gaps?.[m.u.uid], flag = S.trip.flags?.[m.u.uid];
    const moving = st === 'ride' || st === 'rest' || st === 'weak';
    const sub = [label, flag && st !== 'done' ? `${flag === 'behind' ? '落隊' : '超前'}${gap != null ? ' ' + fmtKm(gap) : ''}` : '',
                 !moving && (s.seen || s.ts) ? ago(+s.seen || +s.ts) : ''].filter(Boolean).join(' · ');
    return {
      uid: m.u.uid, name: isMe ? `${m.u.nickname}（我）` : m.u.nickname, color: m.u.color, on: S.follow === m.u.uid && !S.away, away: S.follow === m.u.uid && S.away,
      sub, subCls: flag && st !== 'done' ? 'warn' : cls,
      cols: [[moving ? Math.round((+s.speed || 0) * 3.6) : '–', 'km/h'], [s.alt != null && s.alt !== '' ? Math.round(+s.alt) : '–', 'm 海拔'],
             [m.u.stats?.km > 0 ? (+m.u.stats.km).toFixed(1) : '0.0', 'km 已騎'],
             [isMe ? '–' : km == null ? '–' : km < 1 ? Math.round(km * 1000) : km.toFixed(1), km != null && km < 1 && !isMe ? 'm 距離我' : 'km 距離我']],
    };
  }), pick);
  // 建立者：隊員管理（移出）收在表格下面，不和點選跟拍混在一起
  const admin = S.trip.is_owner ? list.filter((m) => m.u.uid !== S.me) : [];
  const open = $('#teamAdmin details')?.open;
  // 移出鈕的無障礙名字帶上是誰（UX-57）；內容沒變就不重畫，確認倒數條才不會每秒重來
  const html = admin.length ? `<details><summary>管理隊員</summary>${admin.map((m) => `<div class="row"><span>${esc(m.u.nickname)}</span><button class="kick" data-kick="${m.u.uid}" aria-label="移出 ${esc(m.u.nickname)}">移出</button></div>`).join('')}</details>` : '';
  if ($('#teamAdmin').dataset.html !== html) {
    $('#teamAdmin').dataset.html = html; $('#teamAdmin').innerHTML = html;
    if (open && $('#teamAdmin details')) $('#teamAdmin details').open = true;
  }
}
$('#teamAdmin').onclick = (e) => {
  const k = e.target.closest('[data-kick]');
  if (!k) return;
  const uid = k.dataset.kick, who = S.members.get(uid)?.u.nickname || '';
  armConfirm(k, `確定移出${who ? ' ' + who : ''}？`, async () => {
    try { await api(`/api/trips/${tid}/kick`, { method: 'POST', body: { uid } }); }
    catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
};

// 和戰情室同一個篩選元件、同一個預設（全部），選擇也共用（UX-29）
const EVF = eventFilter($('#evFilter'), 'qiji:war:feed-filter:v2', () => renderEvents());
function renderEvents() {
  const name = (uid) => S.members.get(uid)?.u.nickname || S.trip?.people?.[uid]?.nickname || '';  // people：已被移出的人（UX-54）
  // 不同來源（警示、聊天、加入…）的事件到達順序和發生時間不一定一樣：依事件時間排，新的在上（同時間保留到達順序）（UX-35）
  $('#events').innerHTML = S.events.filter(EVF.match).reverse().sort((a, b) => +b.ts - +a.ts).map((e) => {
    const [, color] = EV[e.type] || ['', 'var(--muted)'];
    return `<div class="ev"><time class="num">${clock(+e.ts)}</time><i style="--c:${color}"></i><span>${e.uid ? `<b>${esc(name(e.uid))}</b> ` : ''}${esc(e.text)}</span></div>`;
  }).join('') || `<div class="muted small">${S.events.length ? '目前沒有這類事件' : '還沒有事件'}</div>`;
}

function renderInvite() {
  const t = S.trip;
  $('#code').textContent = t.invite;
  $('#codeNote').textContent = t.invite_valid ? '朋友掃 QR 或在首頁輸入邀請碼加入（24 小時內有效）' : '邀請碼已過期';
  const link = `${location.origin}/?join=${t.invite}`;
  if (window.qrcode && !$('#qr').dataset.done) {
    const q = qrcode(0, 'M'); q.addData(link); q.make();
    $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('#qr').dataset.done = '1';
  }
  $('#shareLink').hidden = !navigator.share;
  $('#shareLink').onclick = async () => {
    try { await navigator.share({ title: `一起騎「${t.name}」`, text: `用騎跡加入「${t.name}」，邀請碼 ${t.invite}`, url: link }); }
    catch (e) { if (e.name !== 'AbortError') toast('沒辦法開啟分享，改用複製連結', { icon: '!', color: '#ff9f0a' }); }
  };
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('已複製邀請連結'); } catch { prompt('複製這個連結', link); }
  };
}

// 落隊門檻：建立者可以調整，其他人只看得到
function renderLag() {
  const t = S.trip, el = $('#lagSet');
  const opts = [1, 2, 3, 5, 10].concat(t.lag_km).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  el.innerHTML = t.is_owner
    ? `落隊警示：離全隊中心超過 <select id="lagKm">${opts.map((v) => `<option value="${v}"${v === t.lag_km ? ' selected' : ''}>${v} km</option>`).join('')}</select>`
    : `落隊警示：離全隊中心超過 ${t.lag_km} km`;
  $('#lagKm')?.addEventListener('change', async (e) => {
    try { await api(`/api/trips/${tid}/settings`, { method: 'PATCH', body: { lag_km: +e.target.value } }); toast(`落隊門檻改成 ${e.target.value} km`); }
    catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
}

function renderAll() { renderHeader(); renderTeam(); renderEvents(); renderInvite(); renderLag(); }
setInterval(() => { if (S.trip) { renderHeader(); renderTeam(); S.members.forEach(placeMarker); describeMap(); } }, 1000);
// 地圖給螢幕報讀器一段文字（UX-61）
function describeMap() {
  const list = [...S.members.values()], on = list.filter((m) => ['ride', 'rest', 'weak'].includes(statusOf(m)));
  const who = S.follow === 'all' ? '全隊' : S.members.get(S.follow)?.u.nickname || '';
  const txt = `地圖：${S.trip.name}，${list.length} 名隊友，${on.length} 人正在回報位置${who && !S.away ? `，鏡頭跟著${who}` : ''}`;
  if ($('#map').getAttribute('aria-label') !== txt) { $('#map').setAttribute('aria-label', txt); map.getCanvas().setAttribute('aria-label', txt); }
}

/* ---------- WebSocket ---------- */
// 自動重連＋斷線橫幅在 livesock.js（和戰情室共用）
function connect() {
  liveSocket(`/ws/trips/${tid}`, {
    onMessage: handle,
    // 連線途中失去權限（例如斷線期間被移出）：重新檢查一次，顯示對應的錯誤畫面或導去登入
    onForbidden: () => { tripGate(tid, { fresh: true }); },
  });
}

function handle(msg) {
  window.dispatchEvent(new CustomEvent('qiji:msg', { detail: msg })); // 給 trip-extra.js
  switch (msg.kind) {
    case 'snapshot': {
      const t = msg.trip;
      // 行程結束後只剩回放：直接換到回放頁（replace，按上一頁不會又回到這裡）
      if (t.status === 'ended') { location.replace(`/replay?id=${tid}`); return; }
      S.trip = t; S.me = t.me;
      ensureQueue();  // 上次沒補完的位置（例如在山上重新整理過）接著補
      t.members.forEach((u) => {
        const m = upsertMember(u, { ...u.state });
        m.trail = t.trails[u.uid] || [];
        if (m.pos) m.trail = m.trail.slice(0, -1); // 最後一點就是目前位置，由 m.pos 接上
      });
      S.events = t.events;
      renderAll();
      if (!S.tabRestored) { S.tabRestored = true; restoreTab(); }  // trip-extra.js 這時已經在聽 qiji:tab
      camera(true);
      break;
    }
    case 'pos': {
      const m = S.members.get(msg.uid);
      if (!m) break;
      m.state = { ...m.state, ...msg, status: 'ok', seen: Date.now() };
      moveTo(m, msg.lon, msg.lat, !!msg.rough);
      placeMarker(m);
      break;
    }
    case 'status': {
      const m = S.members.get(msg.uid);
      if (m) { m.state.status = msg.status; if (msg.status === 'done') m.u.active = false; placeMarker(m); renderTeam(); }
      break;
    }
    case 'gap': S.trip.gaps = msg.gaps; S.trip.flags = msg.flags; S.trip.lag_km = msg.lag_km; S.members.forEach(placeMarker); break;
    case 'settings': S.trip.lag_km = msg.lag_km; renderLag(); break;
    case 'stats': { const m = S.members.get(msg.uid); if (m) m.u.stats = msg; break; } // 每秒的 renderTeam 會畫出來
    case 'member': upsertMember(msg.user, {}); renderTeam(); break;
    case 'trip':
      S.trip.status = msg.status;
      if (msg.status === 'ended') { toast('行程結束了，3 秒後前往回放', { icon: '騎' }); setTimeout(() => location.replace(`/replay?id=${tid}`), 3000); }
      if (msg.status === 'live') { S.trip.started = Date.now(); S.members.forEach((m) => (m.u.active = true)); }
      renderHeader();
      break;
    case 'kicked':
      // 回首頁並顯示「你已被移出○○」（和被移出推播點進去的畫面一樣）
      if (msg.uid === S.me) location.replace(`/?kicked=${tid}&name=${encodeURIComponent(S.trip?.name || '')}`);
      else { const m = S.members.get(msg.uid); m?.marker.remove(); S.members.delete(msg.uid); S.trailDirty = true; renderTeam(); }
      break;
    case 'event': {
      S.events.push(msg);
      if (S.events.length > 200) S.events.shift();
      renderEvents();
      const meta = EV[msg.type];
      if (meta && msg.type !== 'create') {
        const who = S.members.get(msg.uid)?.u.nickname || S.trip?.people?.[msg.uid]?.nickname;
        toast(`${who ? who + ' ' : ''}${msg.text}`, { icon: meta[2], color: meta[3], sub: clock(+msg.ts) });
      }
      break;
    }
  }
}

/* ---------- 距離（GEOSEARCH） ---------- */
setInterval(async () => {
  const me = S.members.get(S.me);
  if (!me?.onMap || S.trip?.status !== 'live') return;
  try { const r = await api(`/api/trips/${tid}/nearby`); S.nearby = Object.fromEntries(r.items.map((x) => [x.uid, x.km])); S.nearbyFail = 0; }
  catch {
    // 5 秒後會再試；連續失敗 3 次（約 15 秒）才提示一次，不要每 5 秒跳一則（UX-38）
    if (++S.nearbyFail === 3) toast('隊友距離暫時算不出來，會自動重試', { icon: '!', color: '#ff9f0a' });
  }
}, 5000);

/* ---------- 回報：網頁定位 ---------- */
async function battery() {
  try { const b = await navigator.getBattery?.(); return b ? Math.round(b.level * 100) : null; } catch { return null; }
}
async function wakeLock() {
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch { /* 不支援就算了 */ }
}
document.addEventListener('visibilitychange', () => { if (S.gps && document.visibilityState === 'visible') wakeLock(); });

$('#gpsBtn').onclick = () => {
  if (S.gps) { stopGps('已停止'); return; }
  if (!navigator.geolocation) { toast('這個瀏覽器不支援定位', { icon: '!', color: '#ff3b30' }); return; }
  if (!isSecureContext) { $('#gpsInfo').textContent = '要用 HTTPS 網址（或 localhost）才能定位'; return; }
  S.gps = { last: 0, sent: 0 };
  S.gps.watch = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  wakeLock();
  $('#gpsBtn').textContent = '停止回報'; $('#gpsBtn').className = 'btn';
  $('#gpsInfo').textContent = '等待定位…';
};
function stopGps(info) {
  if (S.gps) navigator.geolocation.clearWatch(S.gps.watch);
  S.gps = null; S.wake?.release?.(); S.wake = null;
  $('#gpsBtn').textContent = '開始回報我的位置'; $('#gpsBtn').className = 'btn primary';
  $('#gpsInfo').textContent = info;
}
// 定位權限被拒：停止回報、按鈕改回去、面板上方顯示怎麼打開（UX-31）。逾時、暫時抓不到就繼續等
function onGpsError(err) {
  if (err.code === 1) { stopGps('定位權限被拒絕，沒有在回報位置'); showGpsBar(); return; }
  $('#gpsInfo').textContent = err.code === 3 ? '還在等 GPS 訊號（到空曠的地方會比較快）…' : '暫時抓不到位置，會繼續嘗試：' + err.message;
}
function showGpsBar() {
  const me = S.members.get(S.me), ts = +me?.state.ts || 0;
  $('#gpsBar').hidden = false;
  $('#gpsBar').innerHTML = `<b>沒有定位權限，騎跡拿不到你的位置</b>
    <div>${ts ? `地圖上的你是 ${ago(ts)}的最後位置，不是即時的。` : '隊友在地圖上看不到你。'}iPhone：設定 → 隱私權與安全性 → 定位服務 → Safari 網站（加到主畫面的話是「騎跡」）→ 使用 App 期間；Android、電腦：點網址列左邊的圖示 → 位置 → 允許，再重新整理。</div>
    <div class="bannerBtns"><button class="btn" id="gpsRetry">重新試一次</button><button class="btn" id="gpsTraccar">改用 Traccar</button><button class="btn" id="gpsHide">先不用</button></div>`;
  $('#gpsRetry').onclick = () => { $('#gpsBar').hidden = true; $('#gpsBtn').click(); };
  $('#gpsTraccar').onclick = () => { $('#gpsBar').hidden = true; selectMore('report'); };
  $('#gpsHide').onclick = () => { $('#gpsBar').hidden = true; };
}
// 送出佇列（gpsqueue.js）：斷網時點先存在手機，恢復後依序補傳
let gpsQ = null;
let gpsAcc = null;
function ensureQueue() {
  if (gpsQ || !S.me) return gpsQ;
  gpsQ = gpsQueue(S.me, { onChange: renderGpsInfo });
  return gpsQ;
}
function renderGpsInfo({ pending, sent, error, dup }) {
  const el = $('#gpsInfo');
  if (pending > 1 || (pending && error)) {
    el.textContent = `${error || '補傳中'} · 手機暫存 ${pending} 筆，恢復連線後自動補傳`;
    el.classList.add('warn');
    return;
  }
  el.classList.remove('warn');
  if (!S.gps) { if (sent) el.textContent = `暫存的位置已全部補傳（${sent} 筆）`; return; }
  // Traccar 也在送：後端以 Traccar 為準，網頁的點只當心跳；Traccar 停了（例如停車時休眠）網頁會自動接手
  if (dup) { el.textContent = `Traccar 正在回報，網頁暫停記錄（Traccar 停了會自動接手）· ${clock(Date.now())}`; return; }
  el.textContent = `已送出 ${sent} 筆${gpsAcc != null ? ` · 精度 ${Math.round(gpsAcc)} m` : ''} · ${clock(Date.now())}`;
}
async function onFix(p) {
  if (!S.gps) return;
  const c = p.coords, now = Date.now();
  const moving = c.speed == null || c.speed > 1.5;
  if (now - S.gps.last < (moving ? 2500 : 30000)) return;   // 騎乘中 2.5 秒一點，停車時 30 秒一點
  S.gps.last = now;
  gpsAcc = c.accuracy;
  const q = ensureQueue();
  if (!q) return;   // 行程資料還沒載入（不知道是誰），下一點再送
  q.push({ lat: c.latitude, lon: c.longitude, alt: c.altitude, speed: c.speed, heading: c.heading, acc: c.accuracy, batt: await battery(), ts: Math.round(p.timestamp), src: 'web' });
}

async function endMine() {
  try { await api(`/api/trips/${tid}/end`, { method: 'POST' }); if (S.gps) stopGps('已結束紀錄'); $('#endBtn').hidden = true; toast('已結束你的紀錄，其他人還在騎時行程會繼續', { icon: '停' }); }
  catch (e) { toast(e.message, { icon: '!', color: '#ff3b30' }); }
}
$('#endBtn').onclick = (e) => armConfirm(e.currentTarget, '再按一次確定結束', endMine);

$('#bReplay').href = `/replay?id=${tid}`;
$('#warLink').href = `/war?id=${tid}`;
$('#warFoot').href = `/war?id=${tid}`;
$('#trUrl').textContent = `${location.origin}/osmand`;
api('/api/me/device').then((d) => ($('#trId').textContent = d.device_id)).catch(() => {});
syncTools();
press($('#b3d'), M.is3d);
connect();
navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
  // 用 Traccar 回報的人不需要網頁定位，不提醒
  const check = () => { const me = S.members.get(S.me); if (p.state === 'denied' && S.trip?.status === 'live' && me?.u.active && me.state.src !== 'traccar') showGpsBar(); };
  setTimeout(check, 1500);  // 等 snapshot
  p.onchange = () => { if (p.state !== 'denied') $('#gpsBar').hidden = true; else check(); };
}).catch(() => {});
S.isLive = (uid) => { const m = S.members.get(uid); return !!m && ['ride', 'rest'].includes(statusOf(m)); }; // trip-extra.js：轉彎提示只在位置是即時的時候顯示

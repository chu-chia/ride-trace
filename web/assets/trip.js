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
  onroute: ['回到路線', 'var(--ok)', '回', '#30a46c'], reroute: ['重新規劃', 'var(--accent)', '算', '#0a84ff'],
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
const S = { trip: null, me: null, members: new Map(), viewers: new Map(), events: [], follow: 'all', away: false, awayAt: 0, lastInteract: 0, nearby: {}, nearbyFail: 0, gps: null, wake: null, trailDirty: true };
window.qijiState = S; // 除錯用

/* ---------- 成員與標記 ---------- */
const PRE_STALE_MS = 10 * 60_000;
function statusOf(m) {
  const s = m.state || {};
  if (s.status === 'done') return 'done';
  if (s.status === 'lost') return 'lost';
  if (s.lat == null || s.lat === '') return 'none';
  // 開始前的即時位置（後端 10 分鐘 TTL）：太久沒新點就不算正在回報
  if (S.trip?.status === 'planned' && s.seen && Date.now() - +s.seen > PRE_STALE_MS) return 'none';
  if (isWeak(s)) return 'weak';
  return (+s.speed || 0) * 3.6 < 5 ? 'rest' : 'ride';
}

// 身分：只看的人（role＝viewer）不畫在地圖、不列在隊伍裡，只在隊友分頁寫「觀看中」；自己是只看時照樣留著（畫面很多地方要用到我）
// 後援車（car）圖釘是方塊＋車子
function upsertMember(u, state) {
  if (u.role === 'viewer' && u.uid !== S.me) {
    S.viewers.set(u.uid, u);
    const old = S.members.get(u.uid);
    if (old) { old.marker.remove(); S.members.delete(u.uid); }
    return null;
  }
  S.viewers.delete(u.uid);
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
  m.el.classList.toggle('car', m.u.role === 'car');
  m.el.querySelector('.dot').textContent = m.u.role === 'car' ? '🚐' : initialOf(m.u.nickname);
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
// 沒出發的成員（例如建立者自己在家）位置在別處，算進來鏡頭會先拉到全台灣。
// 等待開始時還沒有人 active：開始前正在回報（後端廣播的即時位置）的人都算
const inGroup = (m) => m.pos && (S.trip?.status === 'planned' ? statusOf(m) !== 'none'
  : (m.u.active !== false || m.state?.status === 'done') && m.state?.status !== 'lost');
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
  if (S.navMode) { /* 導航模式（nav.js）自己管鏡頭 */ }
  else if (t && !S.away) {
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
  if (!S.navMode && now - lastDeclutter > 200) {  // 導航模式由 nav.js 自己合併頭像
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
  // 手機：下方中間「跟隨 X ✕」（照原型）
  const fm = S.follow !== 'all' && !S.away ? S.members.get(S.follow) : null, fp = $('#followPill');
  fp.classList.toggle('show', !!fm);
  const html = fm ? `${avatar(fm.u)}<span>跟隨 ${esc(fm.u.uid === S.me ? '我' : fm.u.nickname)}</span><button type="button" aria-label="取消跟隨，回到全隊">✕</button>` : '';
  if (fp.dataset.html !== html) { fp.dataset.html = html; fp.innerHTML = html; const x = fp.querySelector('button'); if (x) x.onclick = () => setFollow('all'); }
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

// 內容沒變就不動 DOM（每秒重畫；按鈕「再按一次確定」的倒數才不會被洗掉）
function setHTML(el, html, bind) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
  bind?.();
}
/* ---------- 階段（照改版原型）：準備 → 集合 → 騎乘 → 結束，收起時只看到這一塊和它的主按鈕 ---------- */
const STAGES = [['prep', '準備'], ['gather', '集合'], ['ride', '騎乘'], ['done', '結束']];
function stepperHtml(cur) {
  const ci = STAGES.findIndex(([k]) => k === cur);
  return `<div class="stepper" aria-label="行程階段：${STAGES[ci][1]}">${STAGES.map(([, n], i) =>
    `${i ? `<span class="ln ${i <= ci ? 'done' : ''}"></span>` : ''}<span class="s ${i < ci ? 'done' : i === ci ? 'cur' : ''}"><i>${i < ci ? '✓' : i + 1}</i>${n}</span>`).join('')}</div>`;
}
const sharing = () => [...S.members.values()].filter((m) => statusOf(m) !== 'none' && statusOf(m) !== 'done').length;
function stageOf() {
  const t = S.trip, me = S.members.get(S.me);
  if (t.status === 'ended') return 'done';
  if (t.status === 'live') return me && !me.u.active && me.u.role !== 'viewer' ? 'done' : 'ride';  // 只看的人本來就不在紀錄裡，照樣看騎乘畫面  // 自己結束紀錄了：自己這邊算結束
  // 集合：至少兩個人在分享位置，或有人已經到集合點（只有自己一直開著 Traccar 不算，不然每趟準備中的行程都會變集合）
  const meet = (S.wps || []).find((w) => w.kind === 'meet') || (S.wps || [])[0];
  const atMeet = meet && [...S.members.values()].some((m) => statusOf(m) !== 'none' && statusOf(m) !== 'done' && hav(meet.lat, meet.lon, +m.state.lat, +m.state.lon) <= (meet.radius_m || 150) + 50);
  return sharing() >= 2 || atMeet ? 'gather' : 'prep';
}
// 路線摘要（起終點、公里、分鐘）：路線換了才重抓
let routeSum = null, routeFor;
function loadRouteSum() {
  const rid = S.trip?.route || '';
  if (rid === routeFor) return;
  routeFor = rid;
  if (!rid) { routeSum = null; renderStage(); return; }
  api(`/api/trips/${tid}/route/summary`).then((r) => { routeSum = r?.summary ? r : null; renderStage(); }).catch(() => {});
}
const ci = (ok, title, sub, act, id) => `<button type="button" class="ci ${ok ? 'ok' : ''}" id="${id}"><span class="ck" aria-hidden="true">✓</span><span class="m"><b>${title}</b><span>${sub}</span></span><span class="go2">${act}</span></button>`;
const meSharing = () => { const me = S.members.get(S.me); return !!S.gps || (me && statusOf(me) !== 'none'); };
function gpsAction() { if (!S.gps && !meSharing()) $('#gpsBtn').click(); else selectMore('report'); }
function renderStage() {
  const t = S.trip, st = stageOf(), owner = t.is_owner;
  $('#stepper').innerHTML = stepperHtml(st);
  const pre = st === 'prep' || st === 'gather';
  $$('#peek [data-st]').forEach((x) => { x.hidden = x.dataset.st !== (pre ? 'pre' : st); });
  if (pre) {
    const list = [...S.members.values()], n = list.length, on = meSharing(), sh = sharing();
    const ownerName = S.members.get(t.owner)?.u.nickname || '建立者';
    const others = list.filter((m) => m.u.uid !== S.me).map((m) => m.u.nickname);
    const p = routeSum?.points || [], sum = routeSum?.summary;
    const routeTxt = sum ? `${esc(p[0]?.name || '起點')} → ${esc(p.at(-1)?.name || '終點')}・${sum.km >= 10 ? Math.round(sum.km) : (+sum.km).toFixed(1)} 公里・約 ${sum.min} 分` : '還沒有路線（不規劃也可以，當天就自由騎）';
    const meet = (S.wps || []).find((w) => w.kind === 'meet') || (S.wps || [])[0];
    const startBtn = owner ? '<button class="btn main green" id="startBtn">開始行程</button>' : '';
    const waitBtn = `<button class="btn main wait" disabled>等 ${esc(ownerName)} 按開始…</button>`;
    let html;
    if (st === 'prep') {
      // 準備：路線、隊友、集合點三件事；主按鈕永遠是「下一件該做的事」（照原型），都好了才是開始
      const invTxt = n > 1 ? `${n} 人已加入：${esc(others.slice(0, 4).join('、') + (others.length > 4 ? ` 等 ${others.length} 人` : ''))}` : '現在只有你一個人';
      const todo = owner ? (!sum ? ['cRoute', '規劃路線'] : n < 2 ? ['cInvite', '邀請隊友'] : !meet ? ['cMeet', '設定集合點'] : null) : null;
      html = `<p class="stage-h">出發前準備</p>
        <p class="stage-p">三件事打勾就準備好了；有人開始分享位置，就會進到「集合」。</p>
        <div class="check">
          ${ci(!!sum, '規劃路線', routeTxt, owner ? (sum ? '修改' : '規劃 ›') : '看', 'cRoute')}
          ${ci(n > 1, '邀請隊友', invTxt, n > 1 ? '再邀' : '邀請 ›', 'cInvite')}
          ${ci(!!meet, '集合點', meet ? esc(meet.name) : '還沒設定（在地圖上點一下就能加）', meet ? '看' : (owner ? '設定 ›' : '看'), 'cMeet')}
        </div>
        ${owner
          ? (todo ? `<button class="btn main primary" id="todoBtn" data-go="${todo[0]}">${todo[1]}</button><p class="why">也可以不等，<button type="button" class="linkBtn" id="startBtn">直接開始行程</button>（會通知全隊）</p>`
                  : `${startBtn}<p class="why">都準備好了。人到齊就按開始，全隊會收到通知、開始記錄軌跡。</p>`)
          : (!on ? '<button class="btn main primary" id="todoBtn" data-go="cGps">開啟位置回報</button><p class="why">先開好，集合時隊友就看得到你在哪。</p>'
                 : `${waitBtn}<p class="why">${esc(ownerName)}（建立者）按「開始」之後，全隊一起進入騎乘。</p>`)}`;
    } else {
      // 集合：開位置回報、到集合點幾個人、路線（照原型）
      const R = (w, m) => hav(w.lat, w.lon, +m.state.lat, +m.state.lon);
      const live = list.filter((m) => statusOf(m) !== 'none' && statusOf(m) !== 'done');
      const here = meet ? live.filter((m) => R(meet, m) <= (meet.radius_m || 150) + 50) : [];
      const away = meet ? live.filter((m) => !here.includes(m)).map((m) => `${esc(m.u.uid === S.me ? '你' : m.u.nickname)} 還有 ${fmtKm(R(meet, m) / 1000)}`) : [];
      const off = n - live.length;
      const hereTxt = meet
        ? [here.length ? `${here.map((m) => esc(m.u.uid === S.me ? '你' : m.u.nickname)).join('、')} 已到` : '還沒有人到', ...away.slice(0, 2), off ? `${off} 人還沒開位置` : ''].filter(Boolean).join('；')
        : `${live.map((m) => esc(m.u.uid === S.me ? '你' : m.u.nickname)).join('、')} 在分享位置${off ? `；${off} 人還沒開` : ''}`;
      html = `<p class="stage-h">${meet ? `集合中・${here.length}／${n} 人到「${esc(meet.name)}」` : `集合中・${sh}／${n} 人在分享位置`}</p>
        <p class="stage-p">${owner ? '人到齊就按開始，全隊會收到通知、開始記錄軌跡。' : `${esc(ownerName)}（建立者）按「開始」之後，全隊一起進入騎乘。`}</p>
        <div class="check">
          ${ci(on, '開啟我的位置回報', on ? (S.gps ? '網頁 GPS 回報中・隊友看得到你' : '位置回報中・隊友看得到你') : '還沒開，隊友看不到你在哪', on ? '設定' : '開啟 ›', 'cGps')}
          ${ci(meet ? here.length >= n : off === 0, meet ? `到集合點 ${here.length}／${n} 人` : `分享位置 ${sh}／${n} 人`, hereTxt, '看地圖', 'cHere')}
          ${ci(!!sum, '路線', routeTxt, owner ? (sum ? '修改' : '規劃 ›') : '看', 'cRoute')}
        </div>
        ${!on ? '<button class="btn main primary" id="todoBtn" data-go="cGps">開啟位置回報</button><p class="why">要先開，隊友和戰情室才看得到你。</p>'
          : owner ? `${startBtn}<p class="why">會通知全隊，大家的軌跡從這一刻開始記錄。還沒到的人也可以晚點跟上。</p>`
          : `${waitBtn}<p class="why">開始後會自動進入騎乘，你不用再按任何東西。</p>`}`;
    }
    const acts = {
      cGps: gpsAction,
      cInvite: () => selectMore('invite'),
      cRoute: () => { if (owner) location.href = `/plan?trip=${tid}`; else selectTab('route'); },
      cMeet: () => selectTab('wp'),
      cHere: () => { setFollow('all'); setCollapsed(true); },
    };
    setHTML($('#preBox'), html, () => {
      for (const [id, f] of Object.entries(acts)) { const el = $('#' + id); if (el) el.onclick = f; }
      const tb = $('#todoBtn'); if (tb) tb.onclick = () => acts[tb.dataset.go]?.();
      $('#startBtn')?.addEventListener('click', (e) => {
        // 一按就會推播給全隊：先確認一次（UX-45）
        armConfirm(e.currentTarget, '再按一次開始（會通知全隊）', async () => {
          try {
            S.trip = { ...S.trip, ...(await api(`/api/trips/${tid}/start`, { method: 'POST' })) }; renderAll();
            let auto = '1'; try { auto = localStorage.getItem('qiji:nav:auto') ?? '1'; } catch { /* 私密模式 */ }
            if (auto === '1' && window.qijiExtra?.route) dispatchEvent(new Event('qiji:nav-open'));
          }
          catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
        });
      });
    });
  } else if (st === 'done') {
    const me = S.members.get(S.me), k = me?.u.stats || {};
    const D = doneSum, my = D?.mine;
    // 有回放摘要就用它（含爬升）；還沒載到先用即時統計
    const km = my ? my.km : +k.km || 0, mv = my ? my.moving_ms / 1000 : +k.moving_s || 0;
    const avg = my ? my.avg_kmh : mv > 60 ? km / (mv / 3600) : 0;
    const climb = my ? my.climb_m : null;
    const lines = [];
    if (t.status === 'ended') {
      if (D?.dest) lines.push(`${ICO_OK}${D.arrived === D.total ? `全隊 ${D.total} 人都抵達` : `${D.arrived}／${D.total} 人抵達`} <b>${esc(D.dest)}</b>`);
      else if (t.ended_reason) lines.push(`${ICO_OK}${esc(String(t.ended_reason).split('，')[0])}`);
      if (D?.towns?.length) lines.push(`${ICO_STAR}新點亮 ${D.towns.length} 個鄉鎮：<b>${D.towns.slice(0, 3).map(esc).join('、')}${D.towns.length > 3 ? ` 等` : ''}</b>（已算進足跡）`);
    } else lines.push(`${ICO_OK}車隊還在騎，地圖會繼續顯示隊友的位置`);
    const html = `<p class="stage-h">${t.status === 'ended' ? '騎完了，辛苦了' : '你的紀錄已結束'}</p>
      <div class="kv4 num"><div><b>${km.toFixed(1)}</b><span>公里</span></div><div><b>${mv ? dur(mv * 1000) : '–'}</b><span>騎乘時間</span></div><div><b>${avg ? Math.round(avg) : '–'}</b><span>平均 km/h</span></div><div><b>${climb != null ? Math.round(climb).toLocaleString() : '–'}</b><span>爬升 m</span></div></div>
      ${lines.map((l) => { const m = l.match(/^(<svg[\s\S]*?<\/svg>)([\s\S]*)$/); return `<p class="done-l">${m ? `${m[1]}<span>${m[2]}</span>` : `<span>${l}</span>`}</p>`; }).join('')}
      <div class="acts2"><a class="btn main primary" href="/replay?id=${tid}">看回放</a></div>
      <div class="acts2"><a class="btn" href="/footprint">看足跡</a><a class="btn" href="/">回首頁</a></div>`;
    setHTML($('#doneBox'), html);
    loadDoneSum();
  }
  loadRouteSum();
}
/* 結束階段的摘要：我的里程／騎乘時間／平均／爬升（回放摘要）、全隊幾人抵達終點、這趟新點亮的鄉鎮 */
const ICO_OK = '<svg class="dl-ico ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICO_STAR = '<svg class="dl-ico star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.6.7-4.9 4.6 1.4 6.6L12 17.3l-5.9 3.3 1.4-6.6-4.9-4.6 6.6-.7z"/></svg>';
let doneSum = null, doneLoading = false;
async function loadDoneSum() {
  if (doneSum || doneLoading || S.trip?.status !== 'ended') return;
  doneLoading = true;
  try {
    const [rp, rt, towns] = await Promise.all([api(`/api/trips/${tid}/replay`), api(`/api/trips/${tid}/route/summary`).catch(() => null), api('/api/me/towns').catch(() => null)]);
    const end = rt?.points?.at(-1), riders = rp.members.filter((m) => m.track?.length > 1);
    const near = (m) => { const p = m.track.at(-1); return end && hav(p[1], p[2], end.lat, end.lon) < 500; };
    const t0 = +S.trip.started || rp.t0, t1 = +S.trip.ended_at || rp.t1;
    doneSum = {
      mine: rp.members.find((m) => String(m.uid) === String(S.me))?.summary || null,
      dest: end ? end.name || '終點' : '', total: riders.length, arrived: riders.filter(near).length,
      towns: (towns?.recent || []).filter((x) => x.ts >= t0 - 60000 && x.ts <= t1 + 600000).map((x) => `${x.county}${x.name}`),
    };
  } catch { doneSum = { mine: null, dest: '', total: 0, arrived: 0, towns: [] }; }
  renderStage();
}
function renderHeader() {
  const t = S.trip;
  $('#tName').textContent = t.name;
  $('#tAv').textContent = [...(t.name || '騎')][0];
  document.title = `${t.name} · 騎跡`;
  // 狀態列照原型：準備中／● 集合中／● 騎乘中 1:23:45・3/4 在線／已結束
  const stg = stageOf();
  const [label, cls] = { prep: ['準備中', ''], gather: ['● 集合中', 'info'], ride: ['● 騎乘中', 'ok'], done: [t.status === 'ended' ? '已結束' : '● 騎乘中（你已結束）', t.status === 'ended' ? '' : 'ok'] }[stg];
  $('#tStatus').className = 'chip ' + cls;
  $('#tStatus').textContent = label;
  $('#tTimer').textContent = t.status === 'live' && t.started ? dur(Date.now() - +t.started) : '';
  const meActive = S.members.get(S.me)?.u.active;
  renderStage();
  $('#endBtn').hidden = !(t.status === 'live' && meActive);
  $('#finishBtn').hidden = !(t.status === 'live' && t.is_owner);
  $('#teamInvite').hidden = t.status === 'ended';
  $('#bShare').hidden = t.status === 'ended';
  document.body.classList.toggle('trip-ended', t.status === 'ended');  // 結束後不需要 SOS 浮鈕
}
$('#finishBtn').onclick = (e) => armConfirm(e.currentTarget, '再按一次結束全隊', async () => {
  try { await api(`/api/trips/${tid}/finish`, { method: 'POST' }); }
  catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
});
// 邀請入口（等待卡片、隊友分頁）都打開 更多 → 邀請隊友（UX-24）
document.addEventListener('click', (e) => { if (e.target.closest('[data-invite], #teamInvite')) selectMore('invite'); });

function renderTeam() {
  // 固定順序：我在最上面，其他人依加入順序（uid），不會因為狀態變化跳來跳去（UX-60）
  // 自己是「只看」時不列在隊伍裡、不算人數（S.members 裡還留著我，畫面其他地方要用）
  const list = [...S.members.values()].filter((m) => m.u.role !== 'viewer').sort((a, b) => (b.u.uid === S.me) - (a.u.uid === S.me) || (+a.u.uid - +b.u.uid));
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
  $('#tOnline').textContent = S.trip.status === 'live' ? `・${online}/${list.length} 在線` : '';
  // 騎乘中的收合區塊：已騎、海拔、在線、落隊、回報狀態
  const myKm = +me?.u.stats?.km || 0, myAlt = $('#sAlt').textContent;
  $('#rideA').innerHTML = `已騎 <b class="num">${myKm.toFixed(1)} km</b>${myAlt !== '–' ? `・海拔 <b class="num">${myAlt} m</b>` : ''}`;
  $('#rideLag').textContent = lagging ? `・${lagging} 人落隊` : '';
  renderRideB();
  const rg = $('#rideGps'), on = meSharing();
  const viewer = me?.u.role === 'viewer';
  rg.textContent = viewer ? '👀 只看中（不回報位置）' : S.gps ? '● 網頁 GPS 回報中' : on ? '● 位置回報中' : '開始回報我的位置';
  rg.disabled = viewer;
  rg.classList.toggle('on', on && !viewer); rg.classList.toggle('primary', !on && !viewer);
  $('#gpsBtn').hidden = viewer;
  $('#goNav').hidden = viewer;  // 只看的人不導航
  if (S.trip.status === 'planned') renderStage();  // 有人開始分享位置：準備 → 集合
  renderRole();
  // 和回放頁同一種隊員表：名字＋狀態、速度、海拔、已騎、距離我；點一下鏡頭跟著他
  teamTable($('#team'), list.map((m) => {
    const st = statusOf(m), [label, cls] = STATUS[st], s = m.state;
    const isMe = m.u.uid === S.me, km = S.nearby[m.u.uid];
    const gap = S.trip.gaps?.[m.u.uid], flag = S.trip.flags?.[m.u.uid];
    const moving = st === 'ride' || st === 'rest' || st === 'weak';
    const sub = [m.u.role === 'car' ? '後援車' : m.u.role === 'viewer' ? '只看' : '', label, flag && st !== 'done' ? `${flag === 'behind' ? '落隊' : '超前'}${gap != null ? ' ' + fmtKm(gap) : ''}` : '',
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
// 我的身分：騎士／只看（後援、家人：不出現在地圖和名單上）／後援車（分享位置，但不算名次、落隊、到齊）
const ROLES = [['rider', '騎士'], ['viewer', '只看'], ['car', '後援車']];
function renderRole() {
  const me = S.members.get(S.me), role = me?.u.role || 'rider';
  const html = `<div class="small muted">我的身分</div><div class="seg" role="group" aria-label="我的身分">${ROLES.map(([k, n]) => `<button type="button" data-role="${k}" class="${k === role ? 'on' : ''}" aria-pressed="${k === role}">${n}</button>`).join('')}</div>`
    + `<div class="small muted">${role === 'viewer' ? '只看：你不會出現在地圖和名單上，也不會回報位置' : role === 'car' ? '後援車：分享位置，地圖上是車子圖示，不算名次、落隊、到齊' : '騎士：分享位置，算進名次、落隊和到齊'}</div>`
    + (S.viewers.size ? `<div class="small muted viewers">👀 ${S.viewers.size} 人只看：${[...S.viewers.values()].map((u) => esc(u.nickname)).join('、')}</div>` : '');
  if ($('#myRole').dataset.html !== html) { $('#myRole').dataset.html = html; $('#myRole').innerHTML = html; }
}
$('#myRole').onclick = async (e) => {
  const b = e.target.closest('[data-role]');
  if (!b || b.classList.contains('on')) return;
  try { await api(`/api/trips/${tid}/role`, { method: 'POST', body: { role: b.dataset.role } }); }
  catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
};
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
  renderWatch();
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

// 觀看連結（建立者）：不用登入、不用加入，知道連結就能看戰情室；只能看，不出現在名單上。
// 行程結束自動失效；可以換一條新的（舊的立刻失效）或停用
function renderWatch() {
  const t = S.trip, card = $('#watchCard');
  card.hidden = !t.is_owner || t.status === 'ended';
  if (card.hidden) return;
  const link = t.watch ? `${location.origin}/w/${t.watch}` : '';
  const html = `<div class="eyebrow">觀看連結（免登入）</div>
    <div class="small muted">家人、後援不用註冊也能看戰情室（只能看）。知道連結的人都看得到大家的即時位置，行程結束後自動失效。</div>
    ${link ? `<div class="wlink num">${esc(link)}</div><div class="r"><button class="btn primary" type="button" data-w="copy">複製連結</button><button class="btn" type="button" data-w="new">換新連結</button><button class="btn" type="button" data-w="off">停用</button></div>`
      : '<button class="btn primary" type="button" data-w="new">產生觀看連結</button>'}`;
  if (card.dataset.html !== html) { card.dataset.html = html; card.innerHTML = html; }
}
$('#watchCard').onclick = async (e) => {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  const link = () => `${location.origin}/w/${S.trip.watch}`;
  if (b.dataset.w === 'copy') {
    try { await navigator.clipboard.writeText(link()); toast('已複製觀看連結'); } catch { prompt('複製這個連結', link()); }
    return;
  }
  const go = async () => {
    try {
      const r = await api(`/api/trips/${tid}/watch`, { method: b.dataset.w === 'off' ? 'DELETE' : 'POST' });
      S.trip.watch = r.watch || null; renderWatch();
      toast(r.watch ? '觀看連結已產生' : '觀看連結已停用', { sub: r.watch && b.dataset.w === 'new' && b.textContent.includes('換') ? '舊的連結已經失效' : '' });
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  };
  if (b.dataset.w === 'new' && !S.trip.watch) go();
  else armConfirm(b, b.dataset.w === 'off' ? '再按一次停用' : '再按一次換新（舊的失效）', go);
};

// 落隊門檻：建立者可以調整，其他人只看得到
function renderLag() {
  const t = S.trip, el = $('#lagSet');
  const opts = [1, 2, 3, 5, 10].concat(t.lag_km).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  // 一張卡片：說明＋門檻（建立者可以改，其他人只能看）
  const html = `<div class="eyebrow">落隊警示</div>
    <div class="small muted">有人離全隊中心超過這個距離，全隊會收到「落隊」通知，隊友列表也會標出來。</div>
    ${t.is_owner ? `<div class="seg" id="lagKm" role="group" aria-label="落隊門檻">${opts.map((v) => `<button type="button" data-km="${v}" class="${v === t.lag_km ? 'on' : ''}" aria-pressed="${v === t.lag_km}">${v} km</button>`).join('')}</div>`
      : `<div><b class="num" style="font-size:20px">${t.lag_km} km</b><span class="small muted">　（建立者可以調整）</span></div>`}`;
  if (el.dataset.html === html) return;
  el.dataset.html = html; el.innerHTML = html;
  $('#lagKm')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-km]'); if (!b) return;
    try { await api(`/api/trips/${tid}/settings`, { method: 'PATCH', body: { lag_km: +b.dataset.km } }); S.trip.lag_km = +b.dataset.km; renderLag(); toast(`落隊門檻改成 ${b.dataset.km} km`); }
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
      // 行程結束：照改版原型先看這趟的摘要（結束階段），再選看回放／看足跡／回首頁
      S.trip = t; S.me = t.me;
      ensureQueue();  // 上次沒補完的位置（例如在山上重新整理過）接著補
      t.members.forEach((u) => {
        const m = upsertMember(u, { ...u.state });
        if (!m) return;  // 只看的人
        m.trail = t.trails[u.uid] || [];
        if (m.pos) m.trail = m.trail.slice(0, -1); // 最後一點就是目前位置，由 m.pos 接上
        if (u.state?.pre) m.lastRough = true;  // 開始前的即時位置不接進軌跡（開始後第一點從這裡另起）
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
      // pre：行程開始前廣播的即時位置，跟精度差的點一樣只移動圖釘、不畫軌跡
      moveTo(m, msg.lon, msg.lat, !!msg.rough || !!msg.pre);
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
    case 'member':
      upsertMember(msg.user, {});
      // 自己改成只看：停止網頁回報位置
      if (msg.user.uid === S.me && msg.user.role === 'viewer' && S.gps) stopGps('你改成「只看」，已停止回報位置');
      renderTeam(); break;
    case 'trip':
      S.trip.status = msg.status;
      if (msg.status === 'ended') { S.trip.ended_at = Date.now(); toast('行程結束了', { icon: '騎', sub: '下面是這趟的摘要，可以看回放' }); setCollapsed(false); }
      if (msg.status === 'live') { S.trip.started = Date.now(); S.members.forEach((m) => (m.u.active = m.u.role !== 'viewer')); }
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
  el.textContent = `已送出 ${sent} 筆${gpsAcc != null ? ` · 精度 ${Math.round(gpsAcc)} m` : ''} · ${clock(Date.now())}`
    + (S.trip?.status === 'planned' ? '（行程還沒開始：隊友和戰情室看得到你的位置，開始後才記進軌跡）' : '');
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
$('#warLink2').href = `/war?id=${tid}`;
// 騎乘中收合區塊第二行（照原型）：下一站＋距離；沒有路線時顯示在線人數
function renderRideB() {
  const ns = S.nextStop, lag = $('#rideLag').textContent;
  $('#rideB').innerHTML = ns ? `下一站 <b>${esc(ns.name)}</b>・${fmtKm(ns.km)}${lag}` : `<b class="num">${$('#sOnline').textContent}</b> 人在線${lag}${$('#rideRoute').textContent}`;
}
addEventListener('qiji:next', renderRideB);
addEventListener('qiji:wps', () => { if (S.trip?.status === 'planned') renderStage(); });
$('#rideGps').onclick = gpsAction;
// 開始導航（照原型）：有路線＝導航，沒有路線＝自由騎乘；導航模式在 nav.js
$('#goNav').onclick = () => dispatchEvent(new Event('qiji:nav-open'));
const syncGoNav = () => { $('#goNav').lastChild.textContent = window.qijiExtra?.route ? '開始導航' : '開始自由騎乘'; };
setInterval(syncGoNav, 2000); syncGoNav();
// 路線剩多少（trip-extra.js 寫在 #quickRoute）：抄到騎乘中的收合區塊
new MutationObserver(() => { const v = $('#quickRoute').textContent; $('#rideRoute').textContent = v ? `・${v}` : ''; }).observe($('#quickRoute'), { childList: true, characterData: true, subtree: true });
// 手機：SOS 浮鈕（照原型），打開同一個求救視窗；SOS 進行中時字跟著變「解除」
$('#sosFab').onclick = () => $('#sosOpen').click();
new MutationObserver(() => { $('#sosFab').textContent = $('#sosOpen').textContent; $('#sosFab').setAttribute('aria-label', $('#sosOpen').getAttribute('aria-label') || ''); }).observe($('#sosOpen'), { childList: true, characterData: true, subtree: true, attributes: true });
// 手機直向：頂列搬到畫面上方浮動（照原型：圓形返回鍵＋膠囊），電腦和橫向放回側欄
{
  const NARROW = matchMedia('(max-width: 760px)');
  const place = () => { if (NARROW.matches) $('#rtop').append($('#head')); else $('#panel').insertBefore($('#head'), $('#panel .panel-mini')); refreshPad(); };
  place(); NARROW.addEventListener('change', place);
}
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

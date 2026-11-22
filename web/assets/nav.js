// 行程頁的導航模式（照改版原型 ride-trace-redesign/nav.html，隊伍呈現選 A：地圖為主、只放頭像、畫面外的貼邊緣）。
// 不另開一頁：GPS 回報、WebSocket、偏離重算、SOS 都沿用行程頁（trip.js／trip-extra.js）。
// 資料：window.qijiState（成員、位置）、window.qijiExtra（全隊路線 route、個人路線 nav、進度 prog、SOS）。
// /nav?id=… 或「開始導航」進來；?preview=1＝從規劃頁預覽，沿路線模擬騎一遍（不回報位置）。
import { api, $, esc, initialOf, sheetDrag, clock, dur, swipeAway } from '/assets/common.js';

const Q = new URLSearchParams(location.search);
const tid = Q.get('id');
const PREVIEW = Q.has('preview');
const PRE = (() => { if (!PREVIEW) return null; try { const r = JSON.parse(sessionStorage.getItem(`qiji:navPreview:${tid}`) || 'null'); return r?.coords?.length > 1 ? r : null; } catch { return null; } })();

// 等行程頁把地圖、成員、路線準備好（trip.js、trip-extra.js 也是 module，有 top-level await）
await new Promise((ok) => { const t = setInterval(() => { if (window.qijiState?.trip && window.qijiExtra && window.qijiM) { clearInterval(t); ok(); } }, 100); });
const S = window.qijiState, X = window.qijiExtra, M = window.qijiM, map = M.map;

/* ───── 設定（設定頁「導航」那一組） ───── */
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const NAV_PITCH = +pref('qiji:nav:pitch', '60');  // 預設照原型 60°
const SHOW_LIMIT = pref('qiji:nav:limit', '1') === '1';

/* ───── 幾何 ───── */
const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
const hav = (a, b) => { const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2; return 6371000 * 2 * Math.asin(Math.sqrt(s)); };
const brg = (a, b) => { const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1])); const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0])); return (toDeg(Math.atan2(y, x)) + 360) % 360; };
// 折線工具：沿線位置、投影（跟後端 worker 同一種算法：先在上次的附近找）
const PATHS = new WeakMap();
function pathOf(r) {
  let p = PATHS.get(r); if (p) return p;
  const sh = r.coords, c = [0];
  for (let i = 1; i < sh.length; i++) c.push(c[i - 1] + hav(sh[i - 1], sh[i]));
  const total = c[c.length - 1];
  const sg = (x) => { let lo = 0, hi = c.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= x) lo = m; else hi = m; } return lo; };
  const at = (x) => { x = Math.max(0, Math.min(total, x)); const i = sg(x), j = Math.min(i + 1, sh.length - 1), L = c[j] - c[i] || 1, t = (x - c[i]) / L; return [sh[i][0] + (sh[j][0] - sh[i][0]) * t, sh[i][1] + (sh[j][1] - sh[i][1]) * t]; };
  const project = (pt, hint) => {
    const kx = 111320 * Math.cos(toRad(pt[1])), ky = 110540;
    const scan = (lo, hi) => { let b = [Infinity, 0, 0]; for (let i = Math.max(0, lo); i < Math.min(sh.length - 1, hi); i++) {
      const ax = (sh[i][0] - pt[0]) * kx, ay = (sh[i][1] - pt[1]) * ky, dx = (sh[i + 1][0] - pt[0]) * kx - ax, dy = (sh[i + 1][1] - pt[1]) * ky - ay;
      const L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, px = ax + t * dx, py = ay + t * dy, d = px * px + py * py;
      if (d < b[0]) b = [d, i, t]; } return b; };
    let b = hint != null ? scan(hint - 60, hint + 160) : [Infinity, 0, 0];
    if (b[0] > 300 * 300) b = scan(0, sh.length);
    return { s: c[b[1]] + (c[b[1] + 1] - c[b[1]]) * b[2], off: Math.sqrt(b[0]), i: b[1] };
  };
  // 後端的 km 是用完整形狀算的、這裡的座標有抽稀：用比例換算，轉彎位置才對得上
  const scale = r.cum_km?.length ? total / Math.max(1, r.cum_km.at(-1) * 1000) : 1;
  p = { route: r, shape: sh, cum: c, total, at, project, scale };
  PATHS.set(r, p);
  return p;
}

/* ───── 文字與圖示（照原型） ───── */
const VERB = { 1: '出發', 2: '出發', 3: '出發', 4: '抵達', 5: '抵達', 6: '抵達', 8: '直行', 9: '靠右', 10: '右轉', 11: '急右轉', 12: '迴轉', 13: '迴轉', 14: '急左轉', 15: '左轉', 16: '靠左', 17: '靠右', 18: '靠左', 19: '靠右', 20: '靠左', 23: '靠右', 24: '靠左', 26: '進入圓環', 27: '離開圓環' };
const A = (d, mirror) => `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"${mirror ? ' style="transform:scaleX(-1)"' : ''}>${d}</svg>`;
const D = { straight: '<path d="M12 21V4M6.5 9.5 12 4l5.5 5.5"/>', right: '<path d="M7 21v-7a5 5 0 0 1 5-5h7M15 5l4 4-4 4"/>', slight: '<path d="M9 21v-6.5c0-1.6.6-3 1.8-4.1L18 4M12 4h6v6"/>', uturn: '<path d="M8 21V9a4 4 0 0 1 8 0v6M12 11l4 4 4-4"/>' };
const ARRIVE = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
function iconFor(t) {
  if (t === 10 || t === 11) return A(D.right); if (t === 15 || t === 14) return A(D.right, true);
  if ([9, 17, 19, 23].includes(t)) return A(D.slight); if ([16, 18, 20, 24].includes(t)) return A(D.slight, true);
  if (t === 12 || t === 13) return A(D.uturn);
  if (t >= 4 && t <= 6) return ARRIVE;
  return A(D.straight);
}
const isArrive = (t) => t >= 4 && t <= 6;
function fmtDist(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} 公里`;
  if (m >= 100) return `${Math.round(m / 50) * 50} 公尺`;
  return `${Math.max(10, Math.round(m / 10) * 10)} 公尺`;
}
const fmtGap = (g) => { const a = Math.abs(g); const d = a >= 1000 ? `${(a / 1000).toFixed(1)} 公里` : `${Math.round(a / 10) * 10} 公尺`; return a < 30 ? '並行' : `${g > 0 ? '前' : '後'} ${d}`; };

/* ───── 畫面 ───── */
const ICO = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/></svg>',
  needle: '<svg viewBox="0 0 24 24" id="nvNeedle"><path d="M12 2l4 10h-8z" fill="#ea4335"/><path d="M12 22l-4-10h8z" fill="currentColor" opacity=".55"/></svg>',
  sound: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>',
  team: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 19c.6-3.4 3.3-5.3 6.5-5.3s5.9 1.9 6.5 5.3z"/><circle cx="17" cy="9" r="2.5" opacity=".7"/><path d="M16 13.8c2.9 0 4.9 1.6 5.5 4.6h-4.2c-.3-1.8-1.1-3.4-2.4-4.5z" opacity=".7"/></svg>',
  nav: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l7 19-7-4-7 4z"/></svg>',
};
document.body.insertAdjacentHTML('beforeend', `
<section class="nv nv-turn" id="nvTurn" aria-live="polite"><div class="nv-track" id="nvTrack"></div></section>
<div class="nv nv-free nv-hidden" id="nvFree"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5l4-7h5l4 7M9.5 9.5L8 6H5M14.5 9.5l1.5-3h3"/></svg><span>自由騎乘<br><small>這趟沒有規劃路線，只跟著你和隊友</small></span><a id="nvPlan" href="/plan?trip=${tid}">規劃路線</a></div>
<div class="nv nv-banner nv-hidden" id="nvBanner" role="status"></div>
<div class="nv-fabs" id="nvFabs">
  <button class="nv-fab" id="nvCompass" aria-label="切換車頭朝上／北方朝上">${ICO.needle}</button>
  <button class="nv-fab" id="nvMute" aria-label="語音"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="nvMuteIco"></svg></button>
  <button class="nv-fab team" id="nvTeam" aria-label="隊伍">${ICO.team}<span class="cnt" id="nvCnt">0</span></button>
  <button class="nv-fab sos" id="nvSos" aria-label="開啟緊急求救選單">SOS</button>
</div>
<div class="nv-speed" id="nvSpeed"><div class="nv-limit nv-hidden" id="nvLimit"></div><div class="nv-cur" id="nvCur"><b id="nvSpd">0</b><small>km/h</small></div></div>
<div class="nv nv-focus nv-hidden" id="nvFocus" role="status"></div>
<button class="nv-recenter nv-hidden" id="nvRecenter">${ICO.nav}返回目前位置</button>
<div class="nv nv-edges" id="nvEdges"></div>
<section class="nv-sheet small" id="nvSheet">
  <button class="handle" type="button" aria-label="展開更多"></button>
  <div class="nv-row">
    <button class="nv-round" id="nvExit" aria-label="結束導航">${ICO.x}</button>
    <div class="nv-eta"><div class="nv-eta-time"><span id="nvEtaMin">--</span> <small id="nvEtaUnit">分</small></div><div class="nv-eta-sub" id="nvEtaSub"></div></div>
    <button class="nv-round" id="nvOverview" aria-label="路線總覽">${ICO.overview}</button>
  </div>
  <div class="nv-more">
    <div class="nv-sec-t" id="nvMatesT">隊伍</div>
    <div id="nvMates"></div>
    <div class="nv-grid">
      <button class="nv-tile" id="nvFuel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16zM3 21h14M15 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M8 7h4v4H8z"/></svg>沿路加油</button>
      <button class="nv-tile" id="nvMeet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>設集合點</button>
      <button class="nv-tile" id="nvMark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg>回報路況</button>
      <button class="nv-tile" id="nvReroute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></svg>重新規劃</button>
    </div>
    <button class="nv-end" id="nvEnd">結束導航</button>
  </div>
</section>`);

/* ───── 狀態 ───── */
const st = {
  s: 0, off: 0, pos: null, heading: 0, v: 0, follow: true, northUp: false, muted: pref('qiji:nav:voice', '1') !== '1',
  peek: null, view: null, camZoom: 16.5, camBearing: 0, camPitch: NAV_PITCH, navPitch: NAV_PITCH, zoomOff: 0, tzBase: 17.6, focus: null, hint: null, routeObj: null, gradF: null, lastUi: 0, safeTop: 120, simS: 0,
};
const spoken = new Set();
/* ───── 地圖上的東西：我的箭頭、終點、轉彎箭頭、路線（進度漸層） ───── */
const puckEl = document.createElement('div');
puckEl.innerHTML = '<svg class="nv-puck" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#fff" opacity=".18"/><path d="M22 6 34 36 22 29 10 36z" fill="#1a73e8" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>';
puckEl.style.zIndex = '1000'; // 自己永遠畫在隊友頭像上面（隊友的標記 z-index 是 1、2）；被山擋住也不變透明（opacityWhenCovered）
const puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map', opacityWhenCovered: '1' });
const destEl = document.createElement('div');
destEl.innerHTML = '<svg class="nv-dest" viewBox="0 0 34 44"><path d="M17 1C8.2 1 1 8 1 16.6 1 28.3 17 43 17 43s16-14.7 16-26.4C33 8 25.8 1 17 1z" fill="#d93025" stroke="#fff" stroke-width="2"/><circle cx="17" cy="16.5" r="6" fill="#fff"/></svg>';
const dest = new maplibregl.Marker({ element: destEl, anchor: 'bottom', opacityWhenCovered: '1' });
const arrowEl = document.createElement('div');
arrowEl.innerHTML = '<svg width="34" height="34" viewBox="0 0 34 34"><path d="M17 3 30 28 17 22 4 28z" fill="#fff" stroke="#1d4fb8" stroke-width="2" stroke-linejoin="round"/></svg>';
const arrowHead = new maplibregl.Marker({ element: arrowEl, rotationAlignment: 'map', pitchAlignment: 'map', opacityWhenCovered: '1' });
const EMPTY = { type: 'FeatureCollection', features: [] };
const lineF = (c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } });
const grad = (f) => { f = Math.min(0.9999, Math.max(0.0001, f)); return ['step', ['line-progress'], '#8a8f98', f, document.body.dataset.nvtheme === 'light' ? '#1a73e8' : '#4c8dff']; };
const TRIP_LAYERS = ['qx-route-casing', 'qx-route', 'qx-nav-casing', 'qx-nav', 'trails-casing', 'trails'];
function addLayers() {
  if (!map.getSource('nv-route')) map.addSource('nv-route', { type: 'geojson', lineMetrics: true, data: EMPTY });
  if (!map.getSource('nv-team')) map.addSource('nv-team', { type: 'geojson', data: EMPTY });
  if (!map.getSource('nv-mnv')) map.addSource('nv-mnv', { type: 'geojson', data: EMPTY });
  const w = (a, b, c) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, a, 14, b, 18, c];
  const lay = { 'line-cap': 'round', 'line-join': 'round', visibility: S.navMode ? 'visible' : 'none' };
  if (!map.getLayer('nv-team')) map.addLayer({ id: 'nv-team', type: 'line', source: 'nv-team', layout: lay, paint: { 'line-color': '#9aa0a6', 'line-opacity': 0.8, 'line-dasharray': [1.2, 1.4], 'line-width': w(3, 5, 12) } });
  if (!map.getLayer('nv-casing')) map.addLayer({ id: 'nv-casing', type: 'line', source: 'nv-route', layout: lay, paint: { 'line-color': '#000', 'line-opacity': 0.35, 'line-width': w(7, 12, 34) } });
  if (!map.getLayer('nv-line')) map.addLayer({ id: 'nv-line', type: 'line', source: 'nv-route', layout: lay, paint: { 'line-width': w(5, 9, 26), 'line-gradient': grad(0) } });
  if (!map.getLayer('nv-mnv')) map.addLayer({ id: 'nv-mnv', type: 'line', source: 'nv-mnv', layout: { ...lay, 'line-cap': 'butt' }, paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 14, 5, 18, 16] } });
  st.routeObj = null; st.gradF = null;
}
M.onStyle(() => { addLayers(); setLayersVisible(S.navMode); document.body.dataset.nvtheme = document.documentElement.dataset.theme || 'dark'; });
function setLayersVisible(on) {
  for (const id of ['nv-team', 'nv-casing', 'nv-line', 'nv-mnv']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  for (const id of TRIP_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
}

const me = () => S.members.get(S.me);
// 我正在導航的路線：預覽＝規劃頁傳來的；偏離後重算的個人路線優先；沒有就是全隊路線
const active = () => (PRE || X.nav || X.route || null);

/* ───── 語音 ───── */
function say(text) {
  if (st.muted || !('speechSynthesis' in window)) return;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-TW'; u.rate = 1.05; speechSynthesis.speak(u); } catch { /* 不支援就算了 */ }
}
addEventListener('pointerdown', () => { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* iOS 要先點過畫面才會出聲 */ } }, { once: true });
const syncMute = () => { $('#nvMuteIco').innerHTML = st.muted ? ICO.mute : ICO.sound; $('#nvMute').setAttribute('aria-label', st.muted ? '開啟語音' : '關閉語音'); };
$('#nvMute').onclick = () => { st.muted = !st.muted; syncMute(); if (st.muted) try { speechSynthesis.cancel(); } catch { /* 略過 */ } };
syncMute();

/* ───── 橫幅：SOS 會一直留著，直到按「查看」；其他提醒不會蓋掉 SOS ───── */
let bannerT;
function showBanner(kind, html, act, ms, onAct) {
  const b = $('#nvBanner');
  if (kind !== 'sos' && b.classList.contains('sos') && !b.classList.contains('nv-hidden')) return;
  b.className = `nv nv-banner ${kind}`;
  b.innerHTML = `<span>${html}</span>${act ? `<button class="act" type="button">${esc(act)}</button>` : ''}`;
  const hide = () => { b.classList.add('nv-hidden'); layout(); };
  if (act) b.querySelector('.act').onclick = () => { hide(); onAct?.(); };
  layout(); clearTimeout(bannerT);
  if (ms !== 0) bannerT = setTimeout(hide, ms || 4000);
}

// 橫幅也可以往上滑掉（SOS 那種一直留著的也一樣，滑掉就是「知道了」）
swipeAway($('#nvBanner'), () => { clearTimeout(bannerT); $('#nvBanner').classList.add('nv-hidden'); layout(); });

/* ───── 轉彎卡輪播：左右滑看上一個／下一個路口（像 Google Maps） ───── */
const track = $('#nvTrack'), cards = [];
let manS = [];
const roadOf = (R, m) => {
  if (isArrive(m.type)) return R.target?.name || R.points?.at(-1)?.name || '目的地';
  const n = (m.street || '').split(' · ')[0];
  return n || '無名道路';
};
function buildCards(R) {
  track.innerHTML = ''; cards.length = 0;
  const P = pathOf(R);
  manS = R.maneuvers.map((m) => m.km * 1000 * P.scale);
  for (let i = 1; i < R.maneuvers.length; i++) {
    const m = R.maneuvers[i], n2 = R.maneuvers[i + 1];
    const c = document.createElement('div'); c.className = 'tcard';
    c.innerHTML = `<div class="turn-main"><div class="turn-ico">${iconFor(m.type)}<div class="turn-dist"></div></div>
      <div class="turn-txt"><div class="turn-verb"></div><div class="turn-road">${esc(roadOf(R, m))}</div></div></div>
      <div class="turn-then">接下來 ${n2 ? iconFor(n2.type) : ''}</div>`;
    track.append(c); cards.push(c);
  }
  st.view = null; st.peek = null; spoken.clear(); clearArrow();
}
const nextIdx = (s) => { for (let i = 1; i < manS.length; i++) if (manS[i] > s + 1) return i; return manS.length; };
const cardW = () => $('#nvTurn').getBoundingClientRect().width + 10;
function placeTrack(animate, dx = 0) {
  $('#nvTurn').classList.toggle('dragging', !animate);
  track.style.transform = `translateX(${-((st.view || 1) - 1) * cardW() + dx}px)`;
}
function setView(i) {
  const live = Math.min(nextIdx(st.s), manS.length - 1);
  st.view = Math.max(1, Math.min(manS.length - 1, i)); placeTrack(true);
  if (st.view === live) { if (st.peek != null) resume(); return; }
  st.peek = st.view; stopFollow(); showManeuver(st.view);
}
// 預覽某個路口：鏡頭飛過去（傾斜、順著進路口的方向），路線上畫白色轉彎箭頭
function showManeuver(i) {
  const P = pathOf(active()), at = manS[i];
  map.easeTo({ center: P.at(at), zoom: 17.4, pitch: 50, bearing: brg(P.at(at - 40), P.at(at)), padding: camPad(false), duration: 900 });
  const pts = []; for (let d = -35; d <= 22; d += 3) pts.push(P.at(at + d));
  map.getSource('nv-mnv')?.setData(lineF(pts));
  arrowHead.setLngLat(P.at(at + 22)).setRotation(brg(P.at(at + 14), P.at(at + 24))).addTo(map);
}
function clearArrow() { map.getSource('nv-mnv')?.setData(EMPTY); arrowHead.remove(); }
{
  const el = $('#nvTurn'); let x0 = null, y0 = 0, dx = 0, horiz = null, t0 = 0;
  el.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; horiz = null; t0 = performance.now(); try { el.setPointerCapture(e.pointerId); } catch { /* 略過 */ } });
  el.addEventListener('pointermove', (e) => {
    if (x0 == null || !manS.length) return; dx = e.clientX - x0;
    if (horiz == null && Math.hypot(dx, e.clientY - y0) > 8) horiz = Math.abs(dx) > Math.abs(e.clientY - y0);
    if (!horiz) return;
    const atEdge = (dx > 0 && st.view <= 1) || (dx < 0 && st.view >= manS.length - 1);
    placeTrack(false, atEdge ? dx / 3 : dx);
  });
  const end = () => {
    if (x0 == null) return; x0 = null;
    if (!horiz) { placeTrack(true); return; }
    const fast = Math.abs(dx) / Math.max(1, performance.now() - t0) > 0.5;
    const step = (Math.abs(dx) > cardW() * 0.25 || (fast && Math.abs(dx) > 20)) ? (dx < 0 ? 1 : -1) : 0;
    setView(st.view + step);
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
  addEventListener('resize', () => placeTrack(false));
}

/* ───── 鏡頭：車頭朝上、傾斜、自己在畫面下方約 1/3、依速度縮放，接近路口拉近 ───── */
const LANDQ = matchMedia('(orientation:landscape) and (max-height:520px)');
const isLand = () => LANDQ.matches;
const panelR = () => (isLand() ? $('#nvSheet').getBoundingClientRect().right + 8 : 0);
function camPad(follow = true) {
  if (isLand()) return { top: follow && !st.northUp ? innerHeight * 0.34 : 20, bottom: follow ? 0 : 20, left: panelR(), right: 60 };
  if (!follow) return { top: $('#nvTurn').getBoundingClientRect().bottom, bottom: innerHeight - $('#nvSheet').getBoundingClientRect().top, left: 0, right: 0 };
  return { top: st.northUp ? 0 : innerHeight * 0.42, bottom: st.northUp ? 120 : 0, left: 0, right: 0 };
}
const lerpAngle = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };
function stopFollow() { if (!st.follow) return; st.follow = false; M.unfollow(); $('#nvRecenter').classList.remove('nv-hidden'); layout(); }
// 拖曳、旋轉＝離開跟隨（像 Google 地圖）；傾斜、縮放不離開，放開後就固定用那個角度／縮放（傾斜會記住，設定頁也看得到）
['dragstart', 'rotatestart'].forEach((ev) => map.on(ev, (e) => { if (S.navMode && e.originalEvent) stopFollow(); }));
map.on('pitchend', (e) => {
  if (!S.navMode || !e.originalEvent || st.northUp) return;
  st.navPitch = st.camPitch = Math.round(map.getPitch());
  try { localStorage.setItem('qiji:nav:pitch', String(st.navPitch)); } catch { /* 私密模式 */ }
});
map.on('zoomend', (e) => {
  if (!S.navMode || !e.originalEvent) return;
  st.camZoom = map.getZoom(); st.zoomOff = Math.max(-4, Math.min(3, map.getZoom() - st.tzBase));
});
function resume() {
  setFocus(null);
  st.peek = null; clearArrow(); st.follow = true; $('#nvRecenter').classList.add('nv-hidden'); layout();
  st.view = Math.min(nextIdx(st.s), manS.length - 1); placeTrack(true);
}
$('#nvRecenter').onclick = resume;
$('#nvFocus').addEventListener('click', (e) => { if (e.target.closest('button')) resume(); });
$('#nvCompass').onclick = () => { st.northUp = !st.northUp; $('#nvCompass').classList.toggle('on', st.northUp); if (!st.follow) resume(); };
$('#nvOverview').onclick = () => {
  const R = active(); if (!R) return;
  stopFollow(); clearArrow();
  const P = pathOf(R), b = new maplibregl.LngLatBounds();
  b.extend(st.pos || P.at(st.s));
  for (let i = 0; i < P.shape.length; i++) if (P.cum[i] >= st.s) b.extend(P.shape[i]);
  // 先在「平面、北朝上」狀態下算鏡頭（傾斜時算出來會縮太小），再從原本畫面動畫過去
  const from = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), padding: map.getPadding() };
  map.jumpTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  const cam = map.cameraForBounds(b, { padding: isLand() ? { top: 30, bottom: 30, left: panelR() + 20, right: 80 } : { top: $('#nvTurn').getBoundingClientRect().bottom + 30, bottom: innerHeight - $('#nvSheet').getBoundingClientRect().top + 100, left: 40, right: 80 } });
  map.jumpTo(from);
  if (cam) map.easeTo({ ...cam, bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 1000 });
};

/* ───── 隊友 ───── */
const sosSet = () => new Set((X.sos || []).map((x) => String(x.uid)));
const mateState = (m, sos) => (sos.has(String(m.u.uid)) ? 'sos' : m.state?.status === 'lost' ? 'lost' : m.state?.status === 'done' ? 'done' : 'ok');
// 沿全隊路線的前後距離（公尺）：兩個人都有進度才算；沒有路線就用直線距離（不分前後）
function gapOf(m) {
  const a = X.prog[m.u.uid], b = X.prog[S.me];
  if (a && b) return (a.km - b.km) * 1000;
  return null;
}
const others = () => [...S.members.values()].filter((m) => m.u.uid !== S.me && m.pos && m.u.active !== false);
// 點隊友（隊伍列表、地圖上的頭像、畫面邊緣的頭像）：鏡頭一直跟著他，「返回目前位置」回到自己
function focusMate(uid) {
  const m = S.members.get(String(uid)); if (!m?.pos || String(uid) === String(S.me)) return;
  setSheet(false); clearArrow(); st.peek = null;
  setFocus(String(uid)); st.follow = true;
}
function setFocus(uid) {
  st.focus = uid;
  const m = uid && S.members.get(uid), pill = $('#nvFocus');
  pill.classList.toggle('nv-hidden', !m);
  if (m) pill.innerHTML = `${avHtml(m)}<span>跟隨 ${esc(m.u.nickname)}</span><button type="button" aria-label="回到自己">✕</button>`;
  $('#nvRecenter').classList.toggle('nv-hidden', !uid && st.follow);
  for (const x of S.members.values()) x.el?.classList.toggle('nv-target', x.u.uid === uid);
  layout();
}
const avHtml = (m, cls = '') => `<div class="nv-av ${cls}" style="background:${esc(m.u.color)}">${esc(initialOf(m.u.nickname))}</div>`;
function renderMates() {
  const sos = sosSet(), list = [...S.members.values()].filter((m) => m.pos || m.u.uid === S.me);
  const items = list.map((m) => ({ m, gap: m.u.uid === S.me ? 0 : gapOf(m) })).sort((a, b) => (b.gap ?? -1e9) - (a.gap ?? -1e9));
  $('#nvMatesT').textContent = `隊伍（${list.length} 人${X.prog[S.me] ? '，由前到後' : ''}）`;
  const html = items.map(({ m, gap }) => {
    if (m.u.uid === S.me) return `<div class="nv-mate"><div class="nv-av" style="background:#1a73e8">我</div><div><div class="nm">你</div><div class="st">${Math.round(st.v)} km/h</div></div><div class="gap">—</div></div>`;
    const s = mateState(m, sos), v = Math.round((+m.state.speed || 0) * 3.6);
    const sub = s === 'sos' ? 'SOS 求救中' : s === 'lost' ? '失聯' : s === 'done' ? '已結束紀錄' : `${v} km/h${m.state.batt ? `・電量 ${Math.round(+m.state.batt)}%` : ''}`;
    const g = gap == null ? (m.pos && st.pos ? `相距 ${fmtDist(hav(st.pos, m.pos))}` : '—') : fmtGap(gap);
    return `<button type="button" class="nv-mate" data-uid="${esc(m.u.uid)}">${avHtml(m, s === 'sos' ? 'av-sos' : s === 'lost' ? 'av-lost' : '')}
      <div><div class="nm">${esc(m.u.nickname)}</div><div class="st">${sub}</div></div>
      <div class="gap">${g}${gap != null ? `<small>約 ${Math.max(1, Math.round(Math.abs(gap) / 600))} 分鐘</small>` : ''}</div></button>`;
  }).join('');
  if ($('#nvMates').dataset.h !== html) { $('#nvMates').dataset.h = html; $('#nvMates').innerHTML = html; }
  const worst = others().some((m) => mateState(m, sos) === 'sos') ? 'sos' : others().some((m) => mateState(m, sos) === 'lost' || (gapOf(m) ?? 0) < -2000) ? 'warn' : 'ok';
  $('#nvCnt').textContent = others().length;
  $('#nvCnt').style.background = { sos: '#d70015', warn: '#e37400', ok: '#1a73e8' }[worst];
}
$('#nvMates').onclick = (e) => { const b = e.target.closest('[data-uid]'); if (b) focusMate(b.dataset.uid); };

/* 地圖上的隊友頭像：跟我疊在一起的縮小變淡（不擋住自己的箭頭），彼此靠太近的合併成一顆＋數字 */
function cluster() {
  const meP = st.pos ? map.project(st.pos) : null, kept = [];
  const list = others().filter((m) => m.el).sort((a, b) => (gapOf(b) ?? 0) - (gapOf(a) ?? 0));
  for (const m of list) {
    const p = map.project(m.pos), el = m.el;
    const nearMe = meP && Math.hypot(p.x - meP.x, p.y - meP.y) < 30;
    const lead = false;  // 隊友之間疊到就直接疊上去（不合併）
    el.classList.toggle('nv-nearme', !!nearMe);
    el.classList.toggle('nv-merged', !!lead);
    if (lead) lead.n += 1; else if (!nearMe) kept.push({ m, p, n: 0 });
    el.style.zIndex = nearMe ? '0' : '2';
  }
  for (const k of kept) { const d = k.m.el.querySelector('.dot'); const v = k.n ? `+${k.n}` : ''; if (d.dataset.more !== v) d.dataset.more = v; }
  for (const m of list) if (m.el.classList.contains('nv-merged') || m.el.classList.contains('nv-nearme')) { const d = m.el.querySelector('.dot'); if (d.dataset.more) d.dataset.more = ''; }
}
// 點地圖上的隊友頭像：跟隨他（導航時不走行程頁的跟隨）
document.addEventListener('click', (e) => {
  if (!S.navMode) return;
  const r = e.target.closest('.rider'); if (!r) return;
  const m = [...S.members.values()].find((x) => x.el === r); if (!m) return;
  e.stopPropagation(); e.preventDefault(); focusMate(m.u.uid);
}, true);

/* A｜畫面外的隊友：貼在畫面邊緣，小箭頭指向他的方向 */
const edgeEls = new Map();
function edges() {
  const land = isLand(), XL = land ? panelR() : 8, XR = innerWidth - (land ? 62 : 8);
  const top = land ? 8 : st.safeTop, bot = land ? innerHeight - 8 : $('#nvSheet').getBoundingClientRect().top - 12;
  const fm = st.focus && S.members.get(st.focus), mePos = fm?.pos || st.pos; if (!mePos) return;
  const mp = map.project(mePos), camB = map.getBearing(), placed = [], sos = sosSet(), seen = new Set();
  const blocks = ['#nvSpeed', '#nvFabs', '#nvRecenter', '.tools'].map((q) => document.querySelector(q)).filter((el) => el && !el.classList.contains('nv-hidden') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).opacity !== '0').map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
  for (const m of others()) {
    const uid = m.u.uid;
    if (uid === st.focus) continue;  // 正在跟隨的人就在畫面中間
    seen.add(uid);
    const p = map.project(m.pos), rel = ((brg(mePos, m.pos) - camB + 540) % 360) - 180;
    const close = hav(mePos, m.pos) < 120;
    const inside = p.x > XL + 12 && p.x < XR - 12 && p.y > top + 40 && p.y < bot && (Math.abs(rel) < 100 || close || map.getPitch() < 20); // 平面（總覽）時沒有「背後看不到」的問題
    let el = edgeEls.get(uid);
    if (inside) { if (el) el.style.display = 'none'; continue; }
    if (!el) {
      el = document.createElement('button'); el.type = 'button'; el.className = 'nv-edge';
      el.innerHTML = `${avHtml(m)}<svg viewBox="0 0 16 16"><path d="M8 1l6 13-6-3.5L2 14z" fill="currentColor"/></svg>`;
      el.setAttribute('aria-label', `${m.u.nickname}，在畫面外，點一下看他在哪`);
      el.onclick = () => focusMate(uid);
      $('#nvEdges').append(el); edgeEls.set(uid, el);
    }
    el.style.display = '';
    const s = mateState(m, sos);
    el.classList.toggle('sos', s === 'sos');
    el.querySelector('.nv-av').className = `nv-av ${s === 'sos' ? 'av-sos' : s === 'lost' ? 'av-lost' : ''}`;
    const w = 46, h = 46, dx = Math.sin(toRad(rel)), dy = -Math.cos(toRad(rel));
    const x0 = Math.max(XL + w / 2, Math.min(XR - w / 2, mp.x)), y0 = Math.max(top + h / 2, Math.min(bot - h / 2, mp.y));
    const tx = dx > 1e-3 ? (XR - w / 2 - x0) / dx : dx < -1e-3 ? (XL + w / 2 - x0) / dx : Infinity;
    const ty = dy > 1e-3 ? (bot - h / 2 - y0) / dy : dy < -1e-3 ? (top + h / 2 - y0) / dy : Infinity;
    const t = Math.max(0, Math.min(tx, ty));
    let x = x0 + dx * t, y = y0 + dy * t;
    // 避開畫面上的按鈕（速度圈、右側浮鈕、返回目前位置、右上工具列）：疊到就往上推到它上面（工具列就推到下面）
    for (let k = 0; k < 4; k++) {
      const hit = blocks.find((r) => x + w / 2 > r.left - 4 && x - w / 2 < r.right + 4 && y + h / 2 > r.top - 4 && y - h / 2 < r.bottom + 4);
      if (!hit) break;
      y = hit.top < (top + bot) / 2 && hit.bottom < innerHeight / 2 ? hit.bottom + h / 2 + 6 : hit.top - h / 2 - 6;
    }
    // 跟別的邊緣頭像疊到就直接疊上去（不排開、不合併）
    placed.push({ x, y, w });
    el.style.transform = `translate(${Math.round(x - 17)}px,${Math.round(y - 17)}px)`;
    el.querySelector('svg').style.transform = `rotate(${Math.round(rel)}deg) translateY(-22px)`;
  }
  for (const [uid, el] of edgeEls) if (!seen.has(uid)) { el.remove(); edgeEls.delete(uid); }
}

/* ───── 主迴圈 ───── */
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!S.navMode) { last = now; return; }
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const R = active(), P = R ? pathOf(R) : null;
  if (R !== st.routeObj) {
    st.routeObj = R; st.hint = null; st.gradF = null;
    if (R) { buildCards(R); map.getSource('nv-route')?.setData(lineF(R.coords)); dest.setLngLat(R.coords.at(-1)).addTo(map); }
    else { track.innerHTML = ''; cards.length = 0; manS = []; map.getSource('nv-route')?.setData(EMPTY); dest.remove(); }
    // 走個人路線時，全隊路線畫成灰色虛線，知道車隊在哪條路上
    map.getSource('nv-team')?.setData(R && R !== X.route && X.route ? lineF(X.route.coords) : EMPTY);
    $('#nvFree').classList.toggle('nv-hidden', !!R); $('#nvTurn').classList.toggle('nv-hidden', !R);
    layout();
  }
  const mm = me(), state = mm?.state || {};
  if (PRE && P) {
    // 預覽：照原型的速度模擬（一般 40、接近路口減到 18），4 倍速
    const toTurn = (manS[nextIdx(st.simS)] ?? Infinity) - st.simS;
    const target = st.simS >= P.total - 1 ? 0 : toTurn < 90 ? 18 : 40;
    st.v += (target - st.v) * Math.min(1, dt * 1.2);
    st.simS = Math.min(P.total, st.simS + (st.v / 3.6) * dt * 4);
    st.s = st.simS; st.off = 0; st.pos = P.at(st.s); st.heading = brg(P.at(st.s - 5), P.at(st.s + 25));
  } else {
    const raw = mm?.pos;
    if (raw) {
      if (P) { const pr = P.project(raw, st.hint); st.hint = pr.i; st.s = pr.s; st.off = pr.off; }
      const onRoute = P && st.off < 40;
      st.pos = onRoute ? P.at(st.s) : raw;
      const hd = state.heading != null && state.heading !== '' ? +state.heading : null;
      st.heading = onRoute ? brg(P.at(st.s - 5), P.at(st.s + 25)) : hd ?? st.heading;
    }
    const fresh = state.ts && Date.now() - +state.ts < 30000;
    st.v = fresh && state.speed != null && state.speed !== '' ? +state.speed * 3.6 : 0;
  }
  if (st.pos) { puck.setLngLat(st.pos).setRotation(st.heading); if (!puck._map) puck.addTo(map); }
  // 鏡頭
  const ni = nextIdx(st.s), toTurn = ni < manS.length ? manS[ni] - st.s : Infinity;
  let tz = 17.6 - (Math.max(0, st.v - 20) / 30) * 1.1;
  if (toTurn < 160 && !st.focus) tz += 0.5;
  st.tzBase = tz; tz += st.zoomOff;  // 使用者自己捏過縮放：之後都照那個差距
  st.camZoom += (tz - st.camZoom) * Math.min(1, dt * 1.5);
  // 跟隨的對象：自己，或點過的隊友（車頭方向用他回報的 heading）
  const fm = st.focus && S.members.get(st.focus);
  if (st.focus && (!fm || !fm.pos)) setFocus(null);
  const tPos = fm?.pos || st.pos, fhd = fm && fm.state?.heading != null && fm.state.heading !== '' ? +fm.state.heading : null;
  const tHead = fm ? (fhd ?? st.camBearing) : st.heading;
  st.camBearing = lerpAngle(st.camBearing, st.northUp ? 0 : tHead, Math.min(1, dt * 3));
  st.camPitch += ((st.northUp ? 0 : st.navPitch) - st.camPitch) * Math.min(1, dt * 3);
  // 地形高度用自己腳下的（平滑），不用周圍平均：山路上平均常比路面低，鏡頭會對到路面下方、自己跑到畫面上半部
  if (tPos && map.getTerrain()) {
    const e = map.queryTerrainElevation(tPos);
    if (e != null) st.elev = st.elev == null ? e : st.elev + (e - st.elev) * Math.min(1, dt * 2);
  } else st.elev = null;
  if (st.follow && tPos) M.follow(tPos, { padding: camPad(true), zoom: st.camZoom, bearing: st.camBearing, pitch: st.camPitch, ...(st.elev != null ? { elevation: st.elev } : {}) });
  // 路線進度：走過的灰色、前面的藍色
  if (P && map.getLayer('nv-line') && now - (st.lastGrad || 0) > 500) {
    st.lastGrad = now;
    const f = Math.round((st.s / P.total) * 2000) / 2000;
    if (f !== st.gradF) { map.setPaintProperty('nv-line', 'line-gradient', grad(f)); st.gradF = f; }
  }
  edges();
  if (now - (st.lastCl || 0) > 150) { st.lastCl = now; cluster(); }
  if (now - st.lastUi > 200) { st.lastUi = now; ui(R, P, ni, toTurn); }
}
requestAnimationFrame(frame);

/* ───── 畫面更新 ───── */
const setText = (el, t) => { if (el._t !== t) { el._t = t; el.textContent = t; } };
const setHTML = (el, h) => { if (el._h !== h) { el._h = h; el.innerHTML = h; } };
function ui(R, P, ni, toTurn) {
  $('#nvNeedle').style.transform = `rotate(${-map.getBearing()}deg)`;
  setText($('#nvSpd'), String(Math.round(st.v)));
  if (!R) {
    // 自由騎乘：已騎公里、出發多久
    const km = +me()?.u.stats?.km || 0;
    setText($('#nvEtaMin'), km.toFixed(1)); setText($('#nvEtaUnit'), '公里');
    setText($('#nvEtaSub'), S.trip?.started ? `自由騎乘・已騎 ${dur(Date.now() - +S.trip.started)}` : '自由騎乘');
    $('#nvLimit').classList.add('nv-hidden'); $('#nvCur').classList.remove('over');
    renderMates(); return;
  }
  const done = st.s >= P.total - 15;
  const live = Math.min(ni, manS.length - 1);
  cards.forEach((c, k) => {
    const i = k + 1, m = R.maneuvers[i], d = manS[i] - st.s, isLive = i === live;
    c.classList.toggle('live', isLive && !done);
    c.classList.toggle('arrived', isLive && done);
    c.classList.toggle('near', isLive && d < 100);
    c.classList.remove('off');
    setHTML(c.querySelector('.turn-dist'), done && isLive ? '' : d > 0 ? fmtDist(d).replace(/ (公里|公尺)/, '<small>$1</small>') : '已經過');
    setText(c.querySelector('.turn-verb'), done && isLive ? '已抵達' : isArrive(m.type) ? (m.act === '抵達停靠點' ? '停靠點在前方' : '目的地在前方') : `${VERB[m.type] || m.act || '繼續'}進入`);
    setText(c.querySelector('.turn-road'), roadOf(R, m));
    const n2 = R.maneuvers[i + 1];
    c.classList.toggle('has-then', !!(isLive && !done && n2 && manS[i + 1] - manS[i] < 600));
  });
  // 偏離中（後端也用 150 公尺）：目前這張轉彎卡改成灰色「偏離路線」，轉彎語音先停；重算由 trip-extra.js 處理
  const lc = cards[live - 1], offNow = !PRE && st.off > 150;
  if (lc && offNow) {
    lc.classList.add('off'); setHTML(lc.querySelector('.turn-dist'), '');
    setText(lc.querySelector('.turn-verb'), `偏離路線 ${fmtDist(st.off)}`);
    setText(lc.querySelector('.turn-road'), X.rerouting ? '重新規劃中…' : '再偏離一下就幫你重新規劃');
  }
  if (st.view == null || (st.peek == null && st.view !== live)) { st.view = live; placeTrack(true); }
  // 速限（路線裡有 OSM 速限的路段才顯示）
  const lim = SHOW_LIMIT ? (R.limits || []).find(([a, b]) => st.s >= a * 1000 * P.scale && st.s < b * 1000 * P.scale)?.[2] : null;
  $('#nvLimit').classList.toggle('nv-hidden', !lim);
  if (lim) setText($('#nvLimit'), String(lim));
  $('#nvCur').classList.toggle('over', !!lim && st.v > lim + 2);
  // 抵達時間：剩下的距離 ÷ 這條路線的平均速度（有「依你的速度」就用它）
  const rem = Math.max(0, P.total - st.s), kmh = R.summary.km / Math.max(1, R.summary.min_personal || R.summary.min) * 60;
  const sec = (rem / 1000 / Math.max(5, kmh)) * 3600;
  setText($('#nvEtaUnit'), '分');
  setText($('#nvEtaMin'), String(done ? 0 : Math.max(1, Math.round(sec / 60))));
  setText($('#nvEtaSub'), `${(rem / 1000).toFixed(1)} 公里 · ${clock(Date.now() + sec * 1000)} 抵達${R.target ? `「${R.target.name}」` : ''}`);
  // 語音：路口前 400 公尺、80 公尺各講一次
  if (!done && !offNow && ni < manS.length) for (const th of [400, 80]) {
    const key = `${manS.length}-${ni}-${th}`;
    if (toTurn < th && toTurn > th - 120 && !spoken.has(key)) {
      spoken.add(key); const m = R.maneuvers[ni];
      say(isArrive(m.type) ? `${th === 80 ? '' : fmtDist(toTurn) + '後'}抵達${roadOf(R, m)}` : `${th === 80 ? '' : fmtDist(toTurn) + '後'}${VERB[m.type] || m.act || '繼續'}，進入${roadOf(R, m)}`);
    }
  }
  if (done && !st.arrivedSaid) { st.arrivedSaid = true; say(`已抵達${roadOf(R, R.maneuvers.at(-1))}`); }
  if (!done) st.arrivedSaid = false;
  renderMates();
}

/* ───── 事件 → 橫幅與語音 ───── */
const nameOf = (uid) => S.members.get(String(uid))?.u.nickname || '隊友';
addEventListener('qiji:msg', (e) => {
  const msg = e.detail;
  if (!S.navMode || msg.kind !== 'event' || PRE) return;
  const uid = String(msg.uid || ''), mine = uid === String(S.me), who = nameOf(uid);
  const g = () => { const m = S.members.get(uid), gp = m && gapOf(m); return gp != null ? ` · ${fmtGap(gp)}` : ''; };
  switch (msg.type) {
    case 'sos': if (!mine) { showBanner('sos', `${esc(who)} 發出 SOS${g()}`, '查看', 0, () => focusMate(uid)); say(`${who}發出求救`); } break;
    case 'sos_off': if (!mine) showBanner('info', `${esc(who)} 解除了 SOS`, null, 5000); break;
    case 'lost': if (!mine) { showBanner('warn', `${esc(who)} 失聯${g()}`, '查看', 6000, () => focusMate(uid)); say(`${who}失聯`); } break;
    case 'stuck': if (!mine) { showBanner('info', `${esc(who)} 停車很久了${g()}`, '查看', 5000, () => focusMate(uid)); say(`${who}停車了`); } break;
    case 'behind': if (!mine) { showBanner('info', esc(msg.text || `${who} 落後了`), '設集合點', 8000, setMeet); say(`${who}落後了`); } break;
    case 'offroute': if (mine) { showBanner('warn', '已偏離路線<br><small>再偏離 10 秒就幫你從目前位置重新規劃</small>', null, 4000); say('已偏離路線'); } break;
    case 'reroute': if (mine) { showBanner('info', `${esc(msg.text || '已重新規劃')}<br><small>虛線是車隊的路線，到了就接回</small>`, null, 8000); say('已重新規劃'); } break;
    case 'route': if (!mine && /改了路線/.test(msg.text || '')) { showBanner('info', `${esc(who)} ${esc(msg.text)}`, null, 8000); say(`${who}改了路線`); } break;
    case 'onroute': if (mine) { showBanner('info', '已接回車隊路線', null, 5000); say('已接回車隊路線'); } break;
    case 'allin': case 'arrive': case 'regroup': showBanner('info', esc(msg.text || ''), null, 5000); break;
    default: break;
  }
});

/* ───── 抽屜（共用 sheetDrag：照原型的手感）。只有導航模式時才算數，不會蓋掉行程頁抽屜的 --sheet-h ───── */
const sheet = $('#nvSheet');
const NAVQ = { get matches() { return !!S.navMode; }, addEventListener() {} };
const setSheet = (open) => sheet.classList.toggle('small', !open);
sheetDrag(sheet, { isOpen: () => !sheet.classList.contains('small'), setOpen: setSheet, scroll: '.nv-more', peek: '.handle, .nv-row', mq: NAVQ });
sheet.querySelector('.handle').onclick = () => setSheet(sheet.classList.contains('small'));
new MutationObserver(() => { document.body.classList.toggle('nv-open', !sheet.classList.contains('small')); setTimeout(layout, 300); }).observe(sheet, { attributes: true, attributeFilter: ['class'] });
$('#nvTeam').onclick = () => setSheet(true);
$('#nvSos').onclick = () => $('#sosOpen').click();
new MutationObserver(() => { $('#nvSos').textContent = $('#sosOpen').textContent; }).observe($('#sosOpen'), { childList: true, characterData: true, subtree: true });

/* ───── 版面：依抽屜高度擺浮鈕 ───── */
function layout() {
  if (!S.navMode) return;
  const sh = $('#nvSheet').getBoundingClientRect(), above = innerHeight - sh.top, land = isLand(), rc = !$('#nvRecenter').classList.contains('nv-hidden');
  if (land) {
    const L = panelR() + 2;
    $('#nvFabs').style.bottom = '12px';
    $('#nvSpeed').style.left = `${L}px`; $('#nvSpeed').style.bottom = '12px';
    $('#nvRecenter').style.left = `${L + 110}px`; $('#nvRecenter').style.bottom = '12px';
  } else {
    $('#nvFabs').style.bottom = `${above + 16}px`;
    $('#nvSpeed').style.left = ''; $('#nvRecenter').style.left = '';
    $('#nvSpeed').style.bottom = `${above + 16 + (rc ? 64 : 0)}px`;
    $('#nvRecenter').style.bottom = `${above + 16}px`;
  }
  const head = $('#nvTurn').classList.contains('nv-hidden') ? $('#nvFree') : $('#nvTurn');
  const tb = head.getBoundingClientRect().bottom;
  if (land) $('#nvSheet').style.maxHeight = `${Math.max(120, innerHeight - tb - 18)}px`;
  $('#nvBanner').style.top = `${tb + 8}px`;
  $('#nvFocus').style.top = `${tb + 8 + ($('#nvBanner').classList.contains('nv-hidden') ? 0 : $('#nvBanner').offsetHeight + 8)}px`;
  const bh = $('#nvBanner').classList.contains('nv-hidden') ? 0 : $('#nvBanner').offsetHeight + 8;
  st.safeTop = tb + 8 + bh;
  document.body.style.setProperty('--nv-top', `${tb + 8 + bh}px`);
  document.body.style.setProperty('--nv-turn-b', `${tb}px`);
}
addEventListener('resize', layout);

/* ───── 抽屜裡的格子 ───── */
// 設集合點：在全隊路線上、我前面 1.5 公里（沒有路線就是我現在的位置），全隊都會收到
async function setMeet() {
  setSheet(false);
  const P = X.route ? pathOf(X.route) : null, myKm = X.prog[S.me]?.km;
  const pt = P && myKm != null ? P.at(Math.min(P.total - 50, myKm * 1000 * P.scale + 1500)) : st.pos;
  if (!pt) { showBanner('info', '還沒有你的位置，不能設集合點', null, 4000); return; }
  try {
    await api(`/api/trips/${tid}/waypoints`, { method: 'POST', body: { name: `集合點 ${clock(Date.now())}`, lat: pt[1], lon: pt[0], kind: 'meet', radius_m: 150 } });
    showBanner('info', `已${P && myKm != null ? '在前方 1.5 公里' : '在你的位置'}設集合點，全隊都會收到`, null, 4000);
    say(P && myKm != null ? '已設定集合點，在前方一點五公里' : '已設定集合點');
  } catch (err) { showBanner('warn', `設集合點失敗：${esc(err.message)}`, null, 4000); }
}
$('#nvMeet').onclick = () => (PRE ? showBanner('info', '預覽時不能設集合點', null, 3000) : setMeet());
// 沿路加油：路線上我前面 60 公里內最近的加油站
$('#nvFuel').onclick = async () => {
  setSheet(false);
  const R = active(); if (!R) { showBanner('info', '沒有路線，找不到「沿路」的加油站', null, 3500); return; }
  const P = pathOf(R), samples = [];
  for (let s = st.s; s <= Math.min(P.total, st.s + 60000); s += 2000) { const p = P.at(s); samples.push([p[0], p[1], +(s / 1000).toFixed(2)]); }
  try {
    const items = await api('/api/poi/along', { method: 'POST', body: { kind: 'fuel', samples, radius_m: 800, kmh: 40 } });
    const x = items.filter((i) => i.route_km * 1000 >= st.s - 50).sort((a, b) => a.route_km - b.route_km)[0];
    if (!x) { showBanner('info', '前方 60 公里內路線附近沒有加油站', null, 5000); return; }
    const d = x.route_km * 1000 - st.s;
    showBanner('info', `前方加油站 ${fmtDist(Math.max(0, d))}：${esc(x.name)}${x.off_m > 150 ? `<br><small>離路線 ${x.off_m} 公尺</small>` : ''}`, '看位置', 10000, () => { stopFollow(); map.easeTo({ center: [x.lon, x.lat], zoom: 16, padding: { top: 0, bottom: 0, left: isLand() ? panelR() : 0, right: 0 }, duration: 900 }); });
    say(`前方${fmtDist(Math.max(0, d))}有加油站`);
  } catch (err) { showBanner('warn', `查不到加油站：${esc(err.message)}`, null, 4000); }
};
// 回報路況：回到行程頁的「標註」
$('#nvMark').onclick = () => { exitNav(); dispatchEvent(new CustomEvent('qiji:open-tab', { detail: { tab: 'mark' } })); };
// 重新規劃：從我現在的位置（含車頭方向）算到下一個停靠點；trip-extra.js 收到 navroute 會換上個人路線
$('#nvReroute').onclick = async () => {
  setSheet(false);
  if (PRE) { showBanner('info', '預覽時不能重新規劃', null, 3000); return; }
  const stt = me()?.state || {};
  if (!X.route || stt.lat == null || stt.lat === '') { showBanner('info', '要有路線和你的位置才能重新規劃', null, 4000); return; }
  showBanner('info', '重新規劃中…', null, 3000);
  try {
    const hd = +stt.speed > 1 && stt.heading !== '' && stt.heading != null ? +stt.heading : null;
    const r = await api(`/api/trips/${tid}/reroute`, { method: 'POST', body: { lat: +stt.lat, lon: +stt.lon, heading: hd } });
    if (r?.coords) { X.nav = r; showBanner('info', `已重新規劃：到「${esc(r.target?.name || '下一個停靠點')}」<br><small>虛線是車隊的路線，到了就接回</small>`, null, 8000); say('已重新規劃'); }
  } catch (err) { showBanner('warn', `重新規劃失敗：${esc(err.message)}`, null, 5000); }
};

/* ───── 右上工具列（照原型：全隊／3D／深色／指北）：導航時由這裡接手 ───── */
function fitTeam() {
  const pts = [st.pos, ...others().map((m) => m.pos)].filter(Boolean);
  if (pts.length < 2) return;
  stopFollow();
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  const from = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), padding: map.getPadding() };
  map.jumpTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  const cam = map.cameraForBounds(b, { padding: isLand() ? { top: 40, bottom: 40, left: panelR() + 30, right: 90 } : { top: st.safeTop + 30, bottom: innerHeight - $('#nvSheet').getBoundingClientRect().top + 60, left: 50, right: 90 }, maxZoom: 16 });
  map.jumpTo(from);
  if (cam) map.easeTo({ ...cam, bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 900 });
}
document.addEventListener('click', (e) => {
  if (!S.navMode) return;
  const b = e.target.closest('.tools .tool'); if (!b) return;
  if (b.id === 'bAll') { e.stopImmediatePropagation(); e.preventDefault(); fitTeam(); }
  else if (b.classList.contains('compass')) { e.stopImmediatePropagation(); e.preventDefault(); $('#nvCompass').click(); }
}, true);

/* ───── 進出導航模式 ───── */
function enterNav() {
  if (S.navMode) return;
  S.navMode = true;
  document.body.classList.add('nav');
  document.body.dataset.nvtheme = document.documentElement.dataset.theme || 'dark';
  // 樣式還沒載完就先不加圖層（載完時 M.onStyle 會加，並依 navMode 開關）
  try { addLayers(); } catch { /* Style is not done loading */ }
  setLayersVisible(true);
  st.follow = true; st.routeObj = undefined; st.camBearing = map.getBearing(); st.camPitch = map.getPitch(); st.camZoom = Math.max(map.getZoom(), 15);
  $('#nvRecenter').classList.add('nv-hidden');
  setSheet(false);
  history.replaceState(null, '', `/nav?id=${tid}${PREVIEW ? '&preview=1' : ''}`);
  dispatchEvent(new Event('resize')); // 抽屜量一次收起來的高度
  layout();
  if (PRE) showBanner('info', '預覽導航：沿路線模擬騎一遍（4 倍速）<br><small>不會回報位置；按左下 ✕ 回到規劃</small>', null, 6000);
}
function exitNav() {
  if (!S.navMode) return;
  S.navMode = false;
  document.body.classList.remove('nav', 'nv-open');
  setLayersVisible(false);
  puck.remove(); dest.remove(); clearArrow(); M.unfollow();
  for (const el of edgeEls.values()) el.remove(); edgeEls.clear();
  for (const m of S.members.values()) { m.el?.classList.remove('nv-nearme', 'nv-merged'); const d = m.el?.querySelector('.dot'); if (d) d.dataset.more = ''; }
  $('#nvBanner').classList.add('nv-hidden');
  try { speechSynthesis.cancel(); } catch { /* 略過 */ }
  if (PREVIEW) { location.href = `/plan?trip=${tid}`; return; }
  history.replaceState(null, '', `/trip?id=${tid}`);
  dispatchEvent(new Event('resize')); // 行程頁抽屜重新量高度
  S.fitFallback?.();
}
// 結束導航＝回到行程頁（不是結束這一趟；騎完要在行程頁按「我騎完了」）
$('#nvExit').onclick = exitNav;
$('#nvEnd').onclick = exitNav;
addEventListener('qiji:nav-open', enterNav);
// 直接開 /nav?id=…：等路線載入（最多 3 秒），沒有路線就是自由騎乘
if (location.pathname === '/nav' || Q.get('nav') === '1') {
  const t0 = Date.now();
  const go = () => { if (PRE || X.route || Date.now() - t0 > 3000) enterNav(); else setTimeout(go, 150); };
  go();
}
window.qijiNav = { st, enterNav, exitNav }; // 除錯用

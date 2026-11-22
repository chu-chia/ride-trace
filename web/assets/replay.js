// 回放：全隊同步、時間軸＋倍速、事件標記、跟拍鏡頭、依速度／海拔上色、海拔與速度曲線
import { api, tripGate, $, $$, esc, teamTable, initialOf, inkOn, press, clock, dur, initPanel, setLabel, smoothPad, frameGate, reduceMotion, markFocus, avatar } from '/assets/common.js';
import { createMap, declutter, addCompass, flatZoom, styleMenu } from '/assets/mapbase.js';
import { cameraGestures } from '/assets/gestures.js';

// 側欄收合（電腦收合鈕／手機拉把手）與其他地圖頁一致
let PADS = null;
// 版面照改版原型：手機直向＝上方浮動標題列＋抽屜裡的播放列／時間軸／鏡頭跟誰；
// 橫向與電腦＝標題列在左欄最上面，播放鍵、時間、時間軸、倍速搬到右下長條。搬 DOM，按鈕的事件跟著走
const NARROW = matchMedia('(max-width: 760px)');
function placeControls() {
  const head = $('#head'), panel = $('#panel');
  if (NARROW.matches) {
    $('#rtop').append(head);
    $('#player').append($('#play'), $('#clk'), $('#rate'));
    $('#peek').insertBefore($('#tl'), $('#fol'));
  } else {
    panel.insertBefore(head, $('#peek'));
    $('#pbar').append($('#play'), $('#clk'), $('#tl'), $('#rate'));
  }
  requestAnimationFrame(() => { drawScrub?.(); PADS?.refresh(); });
}
let drawScrub = null;
placeControls();
NARROW.addEventListener('change', placeControls);
const PANEL = initPanel($('#panel'), 'replay', { onChange: () => setTimeout(() => PADS?.refresh(), innerWidth <= 760 ? 0 : 300) });

const tid = new URLSearchParams(location.search).get('id');
await tripGate(tid);  // 錯誤 id／非成員／被移出：和行程頁、戰情室同一個錯誤畫面
// 返回：從哪裡進來就回哪裡（data-back，見 back.js）；直接開網址時備用回首頁
$('#back').href = '/';

const EV = { lost: 'var(--crit)', back: 'var(--ok)', start: 'var(--accent)', end: 'var(--muted)', stop: 'var(--muted)', join: 'var(--accent)', kick: 'var(--warn)', behind: 'var(--warn)', ahead: 'var(--warn)', regroup: 'var(--ok)', arrive: 'var(--ok)', allin: 'var(--ok)', speedcam: 'var(--warn)', roadevent: 'var(--warn)', weather: 'var(--accent)', msg: 'var(--accent)', chat: 'var(--accent)', mark: 'var(--warn)', sos: 'var(--crit)', sos_off: 'var(--ok)', route: 'var(--accent)', offroute: 'var(--warn)', onroute: 'var(--ok)', reroute: 'var(--accent)', stuck: 'var(--warn)', moving: 'var(--ok)', town: 'var(--accent)' };
// 時間軸事件點裡的小圖示（照原型：彩色小圓＋白色符號）
const GLYPH = { start: '▶', moving: '▶', end: '■', stop: '‖', lost: '!', back: '✓', join: '+', kick: '✕', behind: '!', ahead: '»', regroup: '⚑', arrive: '★', allin: '★', speedcam: '◉', roadevent: '!', weather: '雨', msg: '✉', chat: '✉', mark: '⚑', sos: 'S', sos_off: '✓', route: '↺', offroute: '!', onroute: '✓', reroute: '↺', stuck: '!' };
const SPEED_STOPS = [0, '#5e60ce', 20, '#4ea8de', 40, '#56cfe1', 60, '#ffd166', 90, '#ef476f'];
const ALT_STOPS = [0, '#2a9d8f', 800, '#8ab17d', 1600, '#e9c46a', 2400, '#f4a261', 3300, '#e76f51'];
const PLAY = '<svg viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 12 12"><rect x="2.5" y="1.5" width="2.6" height="9" fill="currentColor"/><rect x="7" y="1.5" width="2.6" height="9" fill="currentColor"/></svg>';

const M = createMap($('#map'), { style: 'dark', zoom: 7, terrain: true });
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
const map = M.map;
window.qijiMap = map;
// 地圖可能在等回放資料的時候就載完了：先記下來，最後才不會等一個已經發生過的 load
let mapLoaded = false;
map.once('load', () => { mapLoaded = true; });

let data;
try { data = await api(`/api/trips/${tid}/replay`); }
catch (err) {
  $('#tSub').innerHTML = `${esc(err.message)}・<a href="" style="color:inherit;text-decoration:underline">重新整理</a>`;
  await new Promise(() => {});  // 停在這裡等使用者重新整理（不丟出未處理的錯誤，UX-53）
}
const riders = data.members.filter((m) => m.track.length > 1);
const t0 = data.t0, t1 = data.t1;
const R = { t: t0, playing: false, rate: 60, follow: 'all', away: false, headingUp: true, followTarget: 'all', color: 'rider', sel: riders[0]?.uid, bearing: null, zoomed: false };

$('#tName').textContent = data.name;
document.title = `${data.name} · 回放`;
if (!riders.length) {
  $('#tSub').textContent = '這趟沒有任何軌跡紀錄';
  await new Promise(() => {});
}
// 結束原因（UX-62）：「全員結束紀錄」「管理者強制結束」…，取逗號前的短句
const endWhy = data.status === 'ended' && data.ended_reason ? ` · ${data.ended_reason.split('，')[0]}` : '';
$('#tSub').textContent = `${new Date(t0).toLocaleDateString('zh-TW')} ${clock(t0)}–${clock(t1)} · ${riders.length} 人${endWhy}`;
$('#tSub').title = data.ended_reason || '';

/* ---------- 每個人的軌跡：累積里程、內插 ---------- */
const hav = (a, b, c, d) => { const R6 = 6371000, p1 = (a * Math.PI) / 180, p2 = (c * Math.PI) / 180, dl = ((d - b) * Math.PI) / 180; return 2 * R6 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2)); };
for (const m of riders) {
  m.cum = [0];
  for (let i = 1; i < m.track.length; i++) {
    const a = m.track[i - 1], b = m.track[i];
    const d = hav(a[1], a[2], b[1], b[2]);
    const v = d / Math.max(0.001, (b[0] - a[0]) / 1000) * 3.6;
    m.cum.push(m.cum[i - 1] + (v > 250 ? 0 : d));
  }
}
function idxAt(m, t) {
  const tr = m.track;
  let lo = 0, hi = tr.length - 1;
  if (t <= tr[0][0]) return 0;
  if (t >= tr[hi][0]) return hi - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
  return lo;
}
function stateAt(m, t) {
  const tr = m.track, i = idxAt(m, t), a = tr[i], b = tr[Math.min(i + 1, tr.length - 1)];
  const f = b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
  const lerp = (x, y) => (x == null || y == null ? x ?? y : x + (y - x) * f);
  return {
    pos: [lerp(a[2], b[2]), lerp(a[1], b[1])],
    alt: lerp(a[3], b[3]), kmh: lerp(a[4], b[4]),
    km: (m.cum[i] + (m.cum[Math.min(i + 1, tr.length - 1)] - m.cum[i]) * f) / 1000,
    before: t < tr[0][0], after: t > tr[tr.length - 1][0],
  };
}
function bearingAt(m, t) {
  // 往前看 30 秒的方向，比單一線段穩定
  const a = stateAt(m, t).pos, b = stateAt(m, t + 30000).pos;
  if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-6) return null;
  const y = Math.sin((b[0] - a[0]) * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180);
  const x = Math.cos(a[1] * Math.PI / 180) * Math.sin(b[1] * Math.PI / 180) - Math.sin(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.cos((b[0] - a[0]) * Math.PI / 180);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/* ---------- 地圖圖層 ---------- */
function ghostGeo() {
  return { type: 'FeatureCollection', features: riders.map((m) => ({ type: 'Feature', properties: { color: m.color, uid: m.uid }, geometry: { type: 'LineString', coordinates: m.track.map((p) => [p[2], p[1]]) } })) };
}
function segGeo() {
  const features = [];
  for (const m of riders) {
    const tr = m.track, step = Math.max(1, Math.floor(tr.length / 4000));
    for (let i = 0; i + step < tr.length; i += step) {
      const a = tr[i], b = tr[i + step];
      features.push({ type: 'Feature', properties: { t: b[0], uid: m.uid, color: m.color, spd: b[4] ?? 0, alt: b[3] ?? 0 }, geometry: { type: 'LineString', coordinates: [[a[2], a[1]], [b[2], b[1]]] } });
    }
  }
  return { type: 'FeatureCollection', features };
}
const SEG = segGeo();
// 規劃路線：騎到一半改過路線的話有好幾條（後端 routes：from～to 這段時間走哪條）。
// 播放到哪個時間，那時候的路線是藍色，其他（原本的／之後換上的）是灰色虛線
const ROUTES = data.routes || [];
const routeAt = (t) => { let k = -1; ROUTES.forEach((x, i) => { if (x.from <= t) k = i; }); return Math.max(0, k); };
function routeGeo() {
  return { type: 'FeatureCollection', features: ROUTES.map((x, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'LineString', coordinates: x.coords } })) };
}
let curRoute = -1;
function styleRoutes(force) {
  const k = routeAt(R.t);
  if (!force && k === curRoute) return;
  curRoute = k;
  if (!map.getLayer('rp-route')) return;
  const on = ['==', ['get', 'i'], k];
  map.setPaintProperty('rp-route', 'line-color', ['case', on, '#3d9bff', '#9aa0a6']);
  map.setPaintProperty('rp-route', 'line-opacity', ['case', on, 0.55, ROUTES.length > 1 ? 0.7 : 0]);
  map.setPaintProperty('rp-route', 'line-width', ['case', on, 5, 3]);
  map.setPaintProperty('rp-route', 'line-dasharray', ROUTES.length > 1 ? [2, 1.5] : [1, 0]);
}
function colorExpr() {
  if (R.color === 'speed') return ['interpolate', ['linear'], ['get', 'spd'], ...SPEED_STOPS];
  if (R.color === 'alt') return ['interpolate', ['linear'], ['get', 'alt'], ...ALT_STOPS];
  return ['get', 'color'];
}
M.onStyle(() => {
  if (!map.getSource('rp-ghost')) map.addSource('rp-ghost', { type: 'geojson', data: ghostGeo() });
  if (!map.getSource('rp-seg')) map.addSource('rp-seg', { type: 'geojson', data: SEG });
  if (ROUTES.length && !map.getSource('rp-route')) map.addSource('rp-route', { type: 'geojson', data: routeGeo() });
  if (ROUTES.length && !map.getLayer('rp-route')) map.addLayer({ id: 'rp-route', type: 'line', source: 'rp-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3d9bff', 'line-width': 5, 'line-opacity': 0.55 } });
  if (!map.getLayer('rp-ghost')) map.addLayer({ id: 'rp-ghost', type: 'line', source: 'rp-ghost', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.22 } });
  if (!map.getLayer('rp-seg')) map.addLayer({ id: 'rp-seg', type: 'line', source: 'rp-seg', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': colorExpr(), 'line-width': 4, 'line-opacity': 0.95 } });
  applyLayerState();
  styleRoutes(true);
  setLabel($('#bStyle'), M.styleName);
  R.styleReady = true;
  $('#b3d').disabled = false;
});
function applyLayerState() {
  if (!map.getLayer('rp-seg')) return;
  map.setFilter('rp-seg', ['<=', ['get', 't'], R.t]);
  map.setPaintProperty('rp-seg', 'line-color', colorExpr());
  map.setPaintProperty('rp-seg', 'line-width', R.follow === 'all' ? 4 : ['case', ['==', ['get', 'uid'], R.follow], 5.5, 2.5]);
}

/* ---------- 標記 ---------- */
for (const m of riders) {
  const el = document.createElement('div');
  el.className = 'rider';
  el.style.setProperty('--c', m.color);
  el.style.setProperty('--ink', inkOn(m.color));
  el.innerHTML = `<div class="arrow" style="visibility:hidden"></div><div class="dot">${esc(initialOf(m.nickname))}</div><div class="name">${esc(m.nickname)}</div>`;
  el.onclick = () => pick(m.uid);
  m.el = el;
  m.marker = new maplibregl.Marker({ element: el, anchor: 'center', opacityWhenCovered: '1', subpixelPositioning: true }).setLngLat([m.track[0][2], m.track[0][1]]).addTo(map);
}

/* ---------- 鏡頭 ---------- */
// 手勢規則（docs/地圖手勢規則.md）：拖曳＝暫離（按鈕／列變外框，點了回去；回放不自動回去）；
// 縮放、傾斜繼續跟拍；旋轉繼續跟拍但不再車頭朝上（像 Apple 地圖「跟隨＋方向」被轉了就變「跟隨」）；全隊模式下縮放也算暫離
function goAway() {
  if (R.away) return;
  R.away = true; R.fly = null;
  M.unfollow();
  syncFollowUi();
}
const GEST = cameraGestures(M, {
  centered: () => !R.away && R.follow !== 'all',
  onPan: goAway,
  onZoom: () => { if (R.follow === 'all' && !R.away) goAway(); },
  onRotate: () => { R.headingUp = false; R.bearing = null; },
});
// 點隊員：正在跟他就回到全隊；暫離中點同一個人＝回去（保留縮放）；其他人＝改跟他
function pick(uid) {
  if (R.follow === uid && !R.away) setFollow('all');
  else setFollow(uid, { keepZoom: R.follow === uid });
}
// 地圖留白：避開左側欄、下方時間軸、右上工具列
const padRaw = () => (innerWidth <= 760
  ? { top: 80, bottom: innerHeight - $('#panel').getBoundingClientRect().top + 80, left: 30, right: 64 }
  : { top: 80, bottom: 100, left: $('#panel').offsetWidth + 50, right: 90 });
PADS = smoothPad(padRaw);
const pad = () => PADS.get(); // 抽屜／側欄開合後鏡頭慢慢滑到新位置
addEventListener('resize', () => PADS.refresh());
// 「全隊」＝框住現在這個時間點的所有騎士（跟行程頁、戰情室一樣），騎士在畫面中央。
// 以前框整條軌跡：剛打開時大家都在起點，起點又剛好在框的最邊邊，騎士就貼在畫面最左邊。
// 大家擠在一起時至少框約 3 km，看得到周圍的路
const MIN_SPAN = 0.015;
function fitAll(dur = 900) {
  const now = riders.map((m) => stateAt(m, R.t).pos);
  const lo = [Math.min(...now.map((p) => p[0])), Math.min(...now.map((p) => p[1]))], hi = [Math.max(...now.map((p) => p[0])), Math.max(...now.map((p) => p[1]))];
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, hx = Math.max(MIN_SPAN, (hi[0] - lo[0]) / 2), hy = Math.max(MIN_SPAN * 0.9, (hi[1] - lo[1]) / 2);
  const pts = [...now, [cx - hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy], [cx + hx, cy - hy]];
  const b = new maplibregl.LngLatBounds([cx - hx, cy - hy], [cx + hx, cy + hy]);
  // 縮放用平面換算、留白只交給 easeTo 一次：地圖已經記著跟拍用的 padding，cameraForBounds 會再疊一次，
  // 加上 3D 傾斜和手機直向的高畫面，算出來會拉到整個北台灣（UX：一進回放看不到軌跡）
  PADS.refresh();
  const padding = padRaw();
  R.easeUntil = performance.now() + dur + 50;
  map.easeTo({ ...fitCam(pts, b, padding), duration: dur });
}
// 平面換算在 3D 傾斜時會偏：近處（畫面下方）放大、遠處縮小，軌跡整體偏到一邊，起點的騎士常被擠到畫面最左邊。
// 先把鏡頭放到估算位置（不畫出來），量軌跡在畫面上的實際範圍，把它的中心移到可視區中央、照比例調縮放，做兩次就很準
function fitCam(pts, b, padding) {
  let cam = { center: b.getCenter(), zoom: flatZoom(b, padding, 15, map), padding, pitch: M.is3d ? 50 : 0, bearing: 0 };
  if (!cam.pitch) return cam;
  const saved = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: map.getPadding() };
  const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight;
  const L = padding.left, Rt = W - padding.right, T = padding.top, B = H - padding.bottom;
  const step = Math.max(1, Math.floor(pts.length / 300));
  for (let n = 0; n < 2; n++) {
    map.jumpTo(cam);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += step) {
      const q = map.project(pts[i]);
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    }
    const r = Math.max((x1 - x0) / Math.max(40, Rt - L), (y1 - y0) / Math.max(40, B - T));
    if (!Number.isFinite(r) || r <= 0) break;
    const c = map.unproject([(x0 + x1) / 2, (y0 + y1) / 2]);  // 鏡頭中心換成這一點，軌跡中心就會落在可視區中央
    cam = { ...cam, center: [c.lng, c.lat], zoom: Math.min(15, cam.zoom - Math.log2(r * 1.04)) };
  }
  map.jumpTo(saved);
  return cam;
}
function syncFollowUi() {
  press($('#bAll'), R.follow === 'all' && !R.away);
  $('#bAll').classList.toggle('away', R.follow === 'all' && R.away);
  renderRiders();
}
function setFollow(uid, { keepZoom = false } = {}) {
  R.followTarget = uid;
  R.follow = uid;
  R.away = false;
  R.headingUp = true;
  R.keepZoom = keepZoom;
  if (uid !== 'all') R.sel = uid;
  R.zoomed = false;
  R.fly = null;
  R.bearing = null;
  if (uid === 'all') M.unfollow();  // 換跟拍對象時不放開，鏡頭高度才能連續
  GEST.sync();
  press($('#bAll'), uid === 'all');
  $('#bAll').classList.toggle('away', false);
  if (uid === 'all') fitAll();
  applyLayerState();
  renderRiders();
  renderSummary();
  renderNow();
  drawCharts();
  drawScrub();
}
// 跟隨方式和行程頁一樣：右上「全隊」看全部人，點隊員（列表或地圖上的標記）就跟著他，再點一次回到全隊
$('#bAll').onclick = () => setFollow('all');

/* ---------- 面板 ---------- */
// 全隊狀態的每一列就是選人：點了鏡頭跟拍那個人，摘要／曲線也換成他
function renderRiders() {
  renderTeam();
  renderFol();
  markFocus(riders.map((m) => [m.uid, m.el]), R.follow === 'all' ? null : R.follow, R.away);
}

function renderSummary() {
  const m = riders.find((x) => x.uid === R.sel) || riders[0], s = m.summary;
  $('#sumTitle').textContent = `整趟摘要 · ${m.nickname}`;
  const cells = [
    [s.km.toFixed(1), 'km 總里程'], [dur(s.duration_ms), '總時間'], [dur(s.moving_ms), '騎乘時間'],
    [s.avg_kmh, 'km/h 平均（不含停車）'], [Math.round(s.max_kmh), 'km/h 最高'], [s.climb_m.toLocaleString(), 'm 累積爬升'],
    [s.max_alt ?? '–', 'm 最高點'], [s.stops, '次停車休息'], [riders.length, '人同行'],
  ];
  $('#sum').innerHTML = cells.map(([a, b]) => `<div><b class="num">${a}</b><span>${b}</span></div>`).join('');
}
function renderNow() {
  const m = riders.find((x) => x.uid === R.sel) || riders[0], st = stateAt(m, R.t);
  $('#nowTitle').textContent = `目前位置 · ${m.nickname} · ${clock(R.t)}`;
  $('#now').innerHTML = [[st.kmh == null ? '–' : Math.round(st.kmh), 'km/h'], [st.alt == null ? '–' : Math.round(st.alt), 'm 海拔'], [st.km.toFixed(1), 'km 已騎']]
    .map(([a, b]) => `<div><b class="num">${a}</b><span>${b}</span></div>`).join('');
}
function renderTeam() {
  const states = riders.map((m) => ({ m, st: stateAt(m, R.t) }));
  const active = states.filter(({ st }) => !st.before);
  const lead = active.length ? Math.max(...active.map(({ st }) => st.km)) : null;
  $('#teamBrief').textContent = `${riders.length} 人 · ${active.length} 人已出發`;
  // 選中＝正在跟隨的人（和行程頁、戰情室一樣）
  const focus = R.follow;
  teamTable($('#teamRows'), states.map(({ m, st }) => {
    const started = !st.before;
    return {
      uid: m.uid, name: m.nickname, color: m.color, on: m.uid === focus && !R.away, away: m.uid === focus && R.away,
      sub: st.before ? '還沒出發' : st.after ? '已抵達' : (st.kmh ?? 0) < 5 ? '停車' : '騎乘中',
      subCls: st.before || st.after ? 'info' : (st.kmh ?? 0) < 5 ? 'info' : 'ok',
      cols: [[started && st.kmh != null ? Math.round(st.kmh) : '–', 'km/h'], [started && st.alt != null ? Math.round(st.alt) : '–', 'm 海拔'],
             [started ? st.km.toFixed(1) : '–', 'km 已騎'], [started && lead != null ? Math.max(0, lead - st.km).toFixed(1) : '–', 'km 距領先']],
    };
  }), pick);
}

// people：事件裡出現、但已經被移出的人（後端補的暱稱和顏色，UX-54）
const nameOf = (uid) => data.members.find((m) => m.uid === uid)?.nickname || data.people?.[uid]?.nickname || '';
const riderColor = (uid) => data.members.find((m) => String(m.uid) === String(uid))?.color || data.people?.[uid]?.color || 'var(--muted)';
const tickEvents = data.events.filter((e) => e.ts >= t0 && e.ts <= t1 && !['create', 'town'].includes(e.type));
$('#events').innerHTML = tickEvents.map((e) => `<div class="ev" data-t="${e.ts}"><time class="num">${clock(e.ts)}</time><i style="--c:${e.uid ? esc(riderColor(e.uid)) : 'var(--muted)'}"></i><span>${e.uid ? `<b>${esc(nameOf(e.uid))}</b> ` : ''}${esc(e.text)}</span></div>`).join('') || '<div class="small muted">這趟沒有事件</div>';
$('#events').onclick = (e) => { const r = e.target.closest('[data-t]'); if (r) seek(+r.dataset.t - 5000); };
// 時間軸上的事件點（UX-55）：靠太近（< 26 px）的合併成一顆數字泡泡，點了展開清單；單一事件的點 12 px，可點範圍 ≥ 28 px
const evLabel = (e) => `${clock(e.ts)} ${e.uid ? nameOf(e.uid) + ' ' : ''}${e.text}`;
function drawTicks() {
  const box = $('#ticks'), W = box.clientWidth || 1, GAP = 26;
  // 固定寬度的格子：同一格的事件合併，點畫在格子中央，相鄰兩顆至少隔 GAP，不會疊在一起
  const bins = new Map();
  for (const e of tickEvents) {
    const k = Math.min(Math.max(0, Math.floor(W / GAP) - 1), Math.floor((((e.ts - t0) / (t1 - t0 || 1)) * W) / GAP));
    (bins.get(k) || bins.set(k, { k, items: [] }).get(k)).items.push(e);
  }
  const groups = [...bins.values()].sort((a, c) => a.k - c.k);
  box.innerHTML = groups.map((g, i) => {
    const x = (g.k + 0.5) * GAP, e = g.items[0];
    if (g.items.length === 1) return `<button type="button" class="tick" style="left:${x}px;--c:${EV[e.type] || 'var(--muted)'}" data-t="${e.ts}" title="${esc(evLabel(e))}" aria-label="${esc(evLabel(e))}"><span aria-hidden="true">${GLYPH[e.type] || '•'}\uFE0E</span></button>`;
    const sos = g.items.some((x2) => x2.type === 'sos');
    return `<button type="button" class="tick group${sos ? ' sos' : ''}" style="left:${x}px" data-g="${i}" aria-haspopup="true" aria-label="${clock(g.items[0].ts)}～${clock(g.items.at(-1).ts)} 共 ${g.items.length} 個事件，點一下展開">${g.items.length}</button>`;
  }).join('');
  box._groups = groups;
}
function closeTickPop() { $('#tickPop')?.remove(); }
function openTickPop(btn, items) {
  closeTickPop();
  const pop = document.createElement('div');
  pop.id = 'tickPop';
  pop.className = 'tickpop';  // 不用玻璃：清單文字多，底色不透明才讀得清楚
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `${items.length} 個事件`);
  pop.innerHTML = `<div class="tp-head"><b>${items.length} 個事件</b><button type="button" class="tp-x" aria-label="關閉">✕</button></div>
    <div class="tp-list">${items.map((e) => `<button type="button" class="ev" data-t="${e.ts}"><time class="num">${clock(e.ts)}</time><i style="--c:${EV[e.type] || 'var(--muted)'}"></i><span>${e.uid ? `<b>${esc(nameOf(e.uid))}</b> ` : ''}${esc(e.text)}</span></button>`).join('')}</div>`;
  document.body.append(pop);
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pw - 8, r.left + r.width / 2 - pw / 2))}px`;
  pop.style.bottom = `${innerHeight - r.top + 8}px`;
  pop.querySelector('.tp-x').onclick = closeTickPop;
  pop.querySelector('.tp-list').onclick = (e) => { const x = e.target.closest('[data-t]'); if (x) { seek(+x.dataset.t - 5000); closeTickPop(); } };
  pop.querySelector('.tp-list button')?.focus();
}
drawTicks();
// 時間軸寬度會跟著視窗、側欄收合改變：寬度變了才重排（重排時順便關掉展開的清單）
let ticksW = 0;
new ResizeObserver(() => { const w = $('#ticks').clientWidth; if (w !== ticksW) { ticksW = w; closeTickPop(); drawTicks(); drawScrub?.(); } }).observe($('#ticks'));
$('#ticks').onclick = (e) => {
  const b = e.target.closest('.tick');
  if (!b) return;
  e.stopPropagation();
  if (b.dataset.g != null) openTickPop(b, $('#ticks')._groups[+b.dataset.g].items);
  else seek(+b.dataset.t - 5000);
};
document.addEventListener('click', (e) => { if (!e.target.closest('#tickPop,.tick')) closeTickPop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTickPop(); });

/* ---------- 圖表（海拔用軌跡、速度用 TimeSeries 降採樣） ---------- */
let SPD = {};
api(`/api/trips/${tid}/series?kind=speed&points=400`).then((r) => { SPD = r.series; drawCharts(); }).catch(() => {});
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function prep(cv) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function chart(cv, seriesByUid, unit) {
  const { ctx, w, h } = prep(cv);
  if (!w) return;
  const pl = 38, pr = 8, pt = 8, pb = 18;
  const vals = Object.values(seriesByUid).flatMap((s) => s.map(([, v]) => v)).filter((v) => v != null).sort((a, b) => a - b);
  if (!vals.length) return;
  // 上限取 99 百分位，個別 GPS 尖峰不會把整張圖壓扁
  let lo = vals[0], hi = vals[Math.floor((vals.length - 1) * 0.99)];
  lo = unit === 'km/h' ? 0 : Math.floor(lo / 100) * 100;
  hi = Math.max(lo + 10, Math.ceil(hi / (unit === 'km/h' ? 10 : 100)) * (unit === 'km/h' ? 10 : 100));
  const X = (t) => pl + ((w - pl - pr) * (t - t0)) / Math.max(1, t1 - t0), Y = (v) => pt + (h - pt - pb) * (1 - (v - lo) / (hi - lo));
  ctx.font = '10.5px ' + css('--num'); ctx.fillStyle = css('--muted'); ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.textAlign = 'right';
  for (const v of [lo, (lo + hi) / 2, hi]) { ctx.beginPath(); ctx.moveTo(pl, Y(v)); ctx.lineTo(w - pr, Y(v)); ctx.stroke(); ctx.fillText(Math.round(v), pl - 5, Y(v) + 3.5); }
  ctx.textAlign = 'center';
  for (let k = 0; k <= 4; k++) { const t = t0 + ((t1 - t0) * k) / 4; ctx.fillText(clock(t), Math.min(w - pr - 14, Math.max(pl + 14, X(t))), h - 4); }
  for (const m of riders) {
    const s = seriesByUid[m.uid];
    if (!s?.length) continue;
    const hl = R.sel === m.uid;
    ctx.globalAlpha = hl ? 1 : 0.35; ctx.strokeStyle = m.color; ctx.lineWidth = hl ? 2 : 1.2;
    ctx.beginPath();
    let started = false;
    for (const [t, v] of s) { if (v == null) continue; const y = Y(Math.min(v, hi)); started ? ctx.lineTo(X(t), y) : ctx.moveTo(X(t), y); started = true; }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const x = X(R.t);
  ctx.strokeStyle = css('--fg'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, h - pb); ctx.stroke(); ctx.setLineDash([]);
  cv.onclick = (e) => { const r = cv.getBoundingClientRect(); seek(t0 + ((e.clientX - r.left - pl) / (w - pl - pr)) * (t1 - t0)); };
}
const ALT = Object.fromEntries(riders.map((m) => { const step = Math.max(1, Math.floor(m.track.length / 500)); return [m.uid, m.track.filter((_, i) => i % step === 0).map((p) => [p[0], p[3]])]; }));
function drawCharts() {
  if (tab === 'chart') { chart($('#altChart'), ALT, 'm'); chart($('#spdChart'), SPD, 'km/h'); }
  $('#lgSpd').innerHTML = riders.map((m) => `<span class="${R.sel === m.uid ? '' : 'dim'}"><i style="--c:${esc(m.color)}"></i>${esc(m.nickname)}</span>`).join('');
}

/* ---------- 時間軸（照原型：整條都能點、按住拖；背景畫鏡頭跟著的人的海拔） ---------- */
$('#legS').textContent = clock(t0);
$('#legE').textContent = clock(t1);
drawScrub = () => {
  const cv = $('#sc'), dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const top = 24, base = h - 3;
  g.fillStyle = 'rgba(128,128,140,.18)'; g.fillRect(0, base, w, 3);
  const m = riders.find((x) => x.uid === R.sel) || riders[0], s = ALT[m.uid] || [];
  const vals = s.map(([, v]) => v).filter((v) => v != null);
  if (!vals.length) return;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 50) hi = lo + 50;
  const X = (t) => (w * (t - t0)) / Math.max(1, t1 - t0), Y = (v) => base - (base - top) * ((v - lo) / (hi - lo));
  g.beginPath(); g.moveTo(X(s[0][0]), base);
  for (const [t, v] of s) if (v != null) g.lineTo(X(t), Y(v));
  g.lineTo(X(s.at(-1)[0]), base); g.closePath();
  g.fillStyle = 'rgba(255,138,61,.24)'; g.fill();
};
const knob = () => { $('#knob').style.left = `${((R.t - t0) / Math.max(1, t1 - t0)) * 100}%`; };
{
  // 拖曳：手指在時間軸上就鎖住（setPointerCapture），抽屜和地圖都不會搶；每一格最多更新一次
  const el = $('#scrub');
  let down = false, pendX = null;
  const tAt = (x) => { const r = el.getBoundingClientRect(); return t0 + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (t1 - t0); };
  const flush = () => { if (pendX != null) { const x = pendX; pendX = null; seek(tAt(x)); } };
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tick')) return;  // 事件點：交給下面的 click
    e.stopPropagation();
    down = true; R.scrubbing = true; closeTickPop();
    try { el.setPointerCapture(e.pointerId); } catch { /* 略過 */ }
    seek(tAt(e.clientX));
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    e.stopPropagation();
    if (pendX == null) requestAnimationFrame(flush);
    pendX = e.clientX;
  });
  // 拖曳中鏡頭先不動（每一格瞬間跳到新位置，圖磚來不及載入，地圖會整片變黑）；放開後再一次滑過去
  const end = () => {
    if (!down) return;
    down = false; R.scrubbing = false;
    flush();
    R.seekAt = performance.now() + 1500;  // 全隊鏡頭多追 1.5 秒（共 3 秒），拖了一大段也追得到
    if (R.follow !== 'all') { R.zoomed = false; R.keepZoom = true; }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
  // 抽屜的拖曳用 touch 事件：時間軸上的手指不能變成拉抽屜
  el.addEventListener('touchstart', (e) => { if (!e.target.closest('.tick')) e.stopPropagation(); }, { passive: true });
  el.addEventListener('touchmove', (e) => { e.stopPropagation(); }, { passive: true });
  el.addEventListener('keydown', (e) => {
    const step = (t1 - t0) / 100;
    const k = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10 }[e.key];
    if (k) { e.preventDefault(); seek(R.t + k); } else if (e.key === 'Home') { e.preventDefault(); seek(t0); } else if (e.key === 'End') { e.preventDefault(); seek(t1); }
  });
}
function seek(t) { R.seekAt = performance.now(); R.t = Math.max(t0, Math.min(t1, t)); if (R.follow !== 'all') { R.zoomed = false; R.keepZoom = true; } update(true); }  // 拖時間軸：鏡頭飛到那人在該時間的位置，縮放維持
// 手機橫向：倍速只露出目前那一顆（時間軸才夠長），點它就換下一個（10× → 60× → 300× → 10×）
const RATE_ONE = matchMedia('(min-width:761px) and (max-height:520px)');
$('#rate').onclick = (e) => {
  let b = e.target.closest('[data-x]'); if (!b) return;
  if (RATE_ONE.matches && b.classList.contains('on')) { const all = $$('#rate button'); b = all[(all.indexOf(b) + 1) % all.length]; }
  R.rate = +b.dataset.x;
  $$('#rate button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
};

/* ---------- 分頁：全隊／圖表／事件／摘要 ---------- */
let tab = 'team';
$('#tabs').onclick = (e) => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  tab = b.dataset.t;
  $$('#tabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  $$('.tabsec').forEach((x) => { x.hidden = x.dataset.tab !== tab; });
  $('#panel .panel-body').scrollTop = 0;
  if (PANEL.small) PANEL.set(false);  // 抽屜收著時點分頁＝打開
  requestAnimationFrame(drawCharts);
};
// 從事件分頁跳到某個時間：手機上順便把抽屜收起來，地圖才看得到
$('#events').addEventListener('click', () => { if (NARROW.matches) PANEL.set(true); });

/* ---------- 鏡頭跟誰（抽屜裡的一排；橫向和電腦用左欄的全隊狀態） ---------- */
const TEAM_ICO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 19c.6-3.4 3.3-5.3 6.5-5.3s5.9 1.9 6.5 5.3z"/><circle cx="17" cy="9" r="2.5" opacity=".7"/><path d="M16 13.8c2.9 0 4.9 1.6 5.5 4.6h-4.2c-.3-1.8-1.1-3.4-2.4-4.5z" opacity=".7"/></svg>';
$('#fol').innerHTML = `<button type="button" data-f="all">${TEAM_ICO}全隊</button>` + riders.map((m) => `<button type="button" data-f="${esc(m.uid)}">${avatar(m)}${esc(m.nickname)}</button>`).join('');
$('#fol').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; if (b.dataset.f === 'all') setFollow('all'); else pick(b.dataset.f); };
function renderFol() {
  $$('#fol [data-f]').forEach((b) => {
    const mine = b.dataset.f === R.follow;
    b.classList.toggle('on', mine && !R.away);
    b.classList.toggle('away', mine && R.away);
    b.setAttribute('aria-pressed', String(mine && !R.away));
  });
  const m = riders.find((x) => x.uid === R.follow);
  $('#legT').textContent = R.away ? '鏡頭：自由（點一下回去）' : m ? `鏡頭：${m.nickname}` : '鏡頭：全隊';
}
function syncPlay() { $('#play').innerHTML = R.playing ? PAUSE : PLAY; $('#play').setAttribute('aria-label', R.playing ? '暫停' : '播放'); }
$('#play').onclick = () => { if (R.t >= t1) R.t = t0; R.playing = !R.playing; syncPlay(); };
$('#colorBy').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  R.color = b.dataset.c;
  $$('#colorBy button').forEach((x) => x.classList.toggle('on', x === b));
  const stops = R.color === 'speed' ? SPEED_STOPS : R.color === 'alt' ? ALT_STOPS : null;
  $('#legend').hidden = !stops;
  if (stops) {
    const cols = stops.filter((_, i) => i % 2), vals = stops.filter((_, i) => !(i % 2));
    $('#legend').innerHTML = `${vals[0]}<i style="background:linear-gradient(90deg,${cols.join(',')})"></i>${vals[vals.length - 1]} ${R.color === 'speed' ? 'km/h' : 'm'}`;
  }
  applyLayerState();
};
styleMenu(M, $('#bStyle'), { before: () => { R.styleReady = false; $('#b3d').disabled = true; } });
$('#b3d').onclick = () => {
  M.unfollow();
  R.easeUntil = performance.now() + 850;
  M.set3d(!M.is3d);
  press($('#b3d'), M.is3d);
};
press($('#b3d'), M.is3d);

/* ---------- 主迴圈 ---------- */
let lastUi = 0, lastFilter = 0, lastT = performance.now();
function update(force) {
  for (const m of riders) {
    const st = stateAt(m, R.t);
    m.marker.setLngLat(st.pos);
    m.el.style.opacity = st.before ? 0.35 : 1;
  }
  const now = performance.now();
  if (force || now - lastFilter > 100) { lastFilter = now; if (map.getLayer('rp-seg')) map.setFilter('rp-seg', ['<=', ['get', 't'], R.t]); styleRoutes(); }
  if (force || now - lastUi > 250) {
    lastUi = now;
    knob();
    $('#scrub').setAttribute('aria-valuetext', `${clock(R.t)}，出發後 ${dur(R.t - t0)}`);
    $('#clock').textContent = clock(R.t);
    $('#elapsed').textContent = '+' + dur(R.t - t0);
    renderNow();
    renderTeam();
    drawCharts();
  }
}
const gate = frameGate();
function frame(now) {
  if (!gate(now)) { requestAnimationFrame(frame); return; } // 省電模式約 30 fps
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (R.playing) {
    R.t += dt * R.rate * 1000;
    if (R.t >= t1) { R.t = t1; R.playing = false; syncPlay(); }
    update(false);
  }
  // 跟拍：人在正中間、車頭朝上（方向平滑轉）、鏡頭高度平滑跟著地形
  if (R.follow !== 'all' && !R.away && R.styleReady && !R.scrubbing && now > (R.easeUntil || 0)) {
    const m = riders.find((x) => x.uid === R.follow);
    const st = stateAt(m, R.t);
    // 切換跟拍對象：不用 easeTo 飛到「按下那一刻」的位置（播放中人早就往前走了，動畫結束會再跳一次），
    // 而是每一格朝他「現在」的位置內插過去，飛完直接接上跟拍，中間沒有交接的跳動
    if (!R.zoomed) {
      R.zoomed = true;
      const c = map.getCenter();
      const km = hav(c.lat, c.lng, st.pos[1], st.pos[0]) / 1000;
      R.fly = { at: now, from: [c.lng, c.lat], z0: map.getZoom(), p0: map.getPitch(), z1: R.keepZoom ? map.getZoom() : Math.max(map.getZoom(), 15), p1: R.keepZoom ? map.getPitch() : M.is3d ? 62 : 0,
                dur: reduceMotion() ? 1 : Math.min(1800, 700 + km * 40), dip: reduceMotion() ? 0 : Math.max(0, Math.min(5, Math.log2(Math.max(1, km / 2)))) };
    }
    let center = st.pos, extra = {};
    if (R.fly) {
      const f = R.fly, k = Math.min(1, (now - f.at) / f.dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      center = [f.from[0] + (st.pos[0] - f.from[0]) * e, f.from[1] + (st.pos[1] - f.from[1]) * e];
      // 距離遠時中途先拉遠一點再拉近，畫面不會一路掃過一大堆圖磚
      extra = { zoom: f.z0 + (f.z1 - f.z0) * e - f.dip * Math.sin(Math.PI * e), pitch: f.p0 + (f.p1 - f.p0) * e };
      if (k >= 1) R.fly = null;
    }
    const target = bearingAt(m, R.t);
    if (target != null && R.headingUp) {
      if (R.bearing == null) R.bearing = map.getBearing();
      let d = ((target - R.bearing + 540) % 360) - 180;
      R.bearing += d * (1 - Math.exp(-dt / 1.2));
    }
    M.follow(center, { padding: pad(), ...extra, ...(R.bearing != null ? { bearing: R.bearing } : {}) });
  } else if (R.follow === 'all' && !R.away && R.styleReady && !R.scrubbing && (R.playing || now - (R.seekAt || 0) < 1500)
             && now > (R.easeUntil || 0)) {
    // 全隊：每一格平滑地框住所有人（暫停時不動，保留整趟總覽或使用者自己調的視角）
    M.followGroup(riders.map((m) => stateAt(m, R.t).pos), { padding: pad(), maxZoom: 14.5 });
  }
  if (now - lastDeclutter > 200) {
    lastDeclutter = now;
    const list = [...riders].sort((a, b) => (b.uid === R.follow) - (a.uid === R.follow));
    declutter(map, list.map((m) => ({ el: m.el, pos: stateAt(m, R.t).pos, name: m.nickname })));
  }
  requestAnimationFrame(frame);
}
let lastDeclutter = 0;


renderRiders();
renderSummary();
syncPlay();
{
  const first = () => { fitAll(0); update(true); };
  if (mapLoaded) first(); else map.once('load', first);
}
update(true);
requestAnimationFrame(frame);
addEventListener('resize', drawCharts);

// 戰情室（規格 4.7，電腦大螢幕）：3D 地圖自動運鏡（框住全隊＋慢慢旋轉）、隊員卡片牆、事件資訊流、
// 行程進度條＋海拔剖面。資料和行程頁一樣走 WebSocket（Pub/Sub）。
import { api, tripGate, $, esc, avatar, initialOf, inkOn, clock, dur, ago, teamTable, press, setLabel, liquidGlass, sheetDrag, smoothPad, frameGate, LOW_POWER, gapGlow, markFocus, isWeak, eventFilter } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';
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
const LAYOUT_KEY = `qiji:war:layout:v6:${tid}`;  // 改了預設版面就升版號，舊的自訂版面不會蓋掉新預設
const FEED_FILTER_KEY = 'qiji:war:feed-filter:v2';  // v2：預設改成「全部」（UX-29），舊的「重要」不沿用
const panels = [...document.querySelectorAll('.war-panel')];
const stage = $('#stage');
// 這個檔只在「電腦版排版」載入（war.html 依螢幕選版面）：電腦與手機橫向都用可編輯的浮動面板；手機直拿另用 war-m.js。
// 舊的手機抽屜、直式電腦版的程式還留著，但 mobile／deskPortrait 永遠是 false，不會啟用
const mobile = matchMedia('not all');
const deskPortrait = () => false;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (v) => Math.round(v / 12) * 12;
let editing = false, topLayer = 5;
// ---------- 收合靠邊 ----------
// 收合後變成只有標題的小膠囊：原本在左半就貼左、右半貼右；上半部往上疊在上一個面板下面，下半部往下貼底。
// 展開時回到原本的位置大小（收合前的 inline style 存在 data-ostyle）。
const dockable = () => !mobile.matches && !deskPortrait();
function openBox(el) {  // 展開時的位置大小
  const small = el.classList.contains('small'), cur = el.getAttribute('style') || '';
  if (small) { el.classList.remove('small'); el.setAttribute('style', el.dataset.ostyle ?? ''); }
  const r = el.getBoundingClientRect();
  if (small) { el.classList.add('small'); el.setAttribute('style', cur); }
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
function dock() {
  if (!dockable()) return;
  const g = Math.max(8, Math.round(innerWidth * 0.008));
  const items = panels.filter((el) => el.classList.contains('small')).map((el) => {
    const o = openBox(el);
    el.setAttribute('style', el.dataset.ostyle ?? '');
    el.style.removeProperty('width');
    return { el, o, w: el.offsetWidth, h: el.offsetHeight, up: o.y + o.h / 2 < innerHeight / 2 };
  });
  const placed = panels.filter((el) => !el.classList.contains('small')).map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const order = [...items.filter((i) => i.up).sort((a, b) => a.o.y - b.o.y), ...items.filter((i) => !i.up).sort((a, b) => (b.o.y + b.o.h) - (a.o.y + a.o.h))];
  for (const i of order) {
    const x = i.o.x + i.o.w / 2 > innerWidth / 2 ? i.o.x + i.o.w - i.w : i.o.x;
    const cross = (p) => p.x < x + i.w && x < p.x + p.w;
    const y = i.up
      ? Math.max(g, ...placed.filter((p) => cross(p) && p.y + p.h <= i.o.y + 1).map((p) => p.y + p.h + g))
      : Math.min(innerHeight - g - i.h, ...placed.filter((p) => cross(p) && p.y >= i.o.y + i.o.h - 1).map((p) => p.y - g - i.h));
    i.el.style.left = `${Math.round(x)}px`;
    i.el.style.top = `${Math.round(y)}px`;
    placed.push({ x, y, w: i.w, h: i.h });
  }
}
function saveLayout() {
  const layout = Object.fromEntries(panels.map((el) => {
    const r = openBox(el);
    return [el.dataset.panel, { x: r.x / innerWidth, y: r.y / innerHeight, w: r.w / innerWidth, h: (el.classList.contains('small') ? +(el.dataset.openHeight || r.h) : r.h) / innerHeight, small: el.classList.contains('small') }];
  }));
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 瀏覽器停用儲存時仍可操作 */ }
}
function restoreLayout() {
  if (deskPortrait()) { panels.forEach((el) => { el.style.cssText = ''; }); return; } // 直式電腦版用固定排法
  let layout;
  try { layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch { return; }
  if (!layout || typeof layout !== 'object') return;
  for (const el of panels) {
    const p = layout[el.dataset.panel];
    if (!p || ![p.x, p.y, p.w, p.h].every(Number.isFinite)) continue;
    const w = clamp(p.w * innerWidth, 180, innerWidth - 16);
    const h = clamp(p.h * innerHeight, 58, innerHeight - 16);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.dataset.openHeight = String(h);
    el.style.left = `${clamp(p.x * innerWidth, 0, innerWidth - w)}px`;
    el.style.top = `${clamp(p.y * innerHeight, 0, innerHeight - h)}px`;
    el.classList.toggle('small', !!p.small);
    el.querySelector('.panel-toggle')?.setAttribute('aria-expanded', String(!p.small));
    if (p.small) el.dataset.ostyle = el.getAttribute('style') || '';
  }
  // 騎士清單電腦版沒有標題列／收合鈕了，舊版面存成收合的話打開
  const cards = panels.find((e) => e.dataset.panel === 'cards');
  if (cards?.classList.contains('small')) { cards.classList.remove('small'); cards.setAttribute('style', cards.dataset.ostyle ?? ''); delete cards.dataset.ostyle; }
  dock();
}
function setEditing(on) {
  editing = on && !mobile.matches && !deskPortrait();
  stage.classList.toggle('editing', editing);
  $('#editLayout').setAttribute('aria-pressed', String(editing));
  $('#editLayout').textContent = editing ? '完成編輯' : '編輯版面';
}
function edge(v, max) { return v < 18 ? 12 : max - v < 18 ? max : snap(v); }
for (const el of panels) {
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++topLayer; });
  el.querySelector('.panel-toggle').addEventListener('click', () => {
    if (!el.classList.contains('small')) {
      el.dataset.openHeight = String(el.getBoundingClientRect().height);
      el.dataset.ostyle = el.getAttribute('style') || '';
      el.classList.add('small');
    } else {
      el.classList.remove('small');
      el.setAttribute('style', el.dataset.ostyle ?? '');
      delete el.dataset.ostyle;
    }
    el.querySelector('.panel-toggle').setAttribute('aria-expanded', String(!el.classList.contains('small')));
    dock();
    saveLayout();
  });
  for (const handle of el.querySelectorAll('.panel-grip,.panel-resize')) {
    handle.addEventListener('pointerdown', (e) => {
      if (!editing || mobile.matches || e.button !== 0 || e.target.closest('button,a') || el.classList.contains('small')) return;  // 收合中的膠囊不能拖，展開再排
      e.preventDefault(); e.stopPropagation();
      const r = el.getBoundingClientRect(), resize = handle.classList.contains('panel-resize');
      const x0 = e.clientX, y0 = e.clientY;
      el.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (resize) {
          el.style.width = `${clamp(edge(r.width + ev.clientX - x0, innerWidth - r.left), 180, innerWidth - r.left)}px`;
          if (!el.classList.contains('small')) el.style.height = `${clamp(edge(r.height + ev.clientY - y0, innerHeight - r.top), 58, innerHeight - r.top)}px`;
        } else {
          el.style.left = `${clamp(edge(r.left + ev.clientX - x0, innerWidth - r.width), 0, innerWidth - r.width)}px`;
          el.style.top = `${clamp(edge(r.top + ev.clientY - y0, innerHeight - r.height), 0, innerHeight - r.height)}px`;
        }
      };
      const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); el.classList.remove('dragging'); saveLayout(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }
}
$('#editLayout').onclick = () => setEditing(!editing);
$('#resetLayout').onclick = () => {
  for (const el of panels) { el.removeAttribute('style'); delete el.dataset.openHeight; delete el.dataset.ostyle; el.classList.remove('small'); el.querySelector('.panel-toggle').setAttribute('aria-expanded', 'true'); }
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* 儲存空間不可用 */ }
  setEditing(false);
};
restoreLayout();
window.addEventListener('resize', () => { if (!mobile.matches) restoreLayout(); else setEditing(false); map.resize(); });
$('#tripLink').href = `/trip?id=${encodeURIComponent(tid)}`;
$('#mapStyle').onclick = () => setLabel($('#mapStyle'), M.nextStyle());
panels.forEach((el) => liquidGlass(el));
// 工具列放在右上、右側面板的左邊；面板被拖動或縮放後重新計算
function placeTools() {
  if (mobile.matches) return document.documentElement.style.removeProperty('--tools-right');
  const right = panels.map((el) => el.getBoundingClientRect()).filter((r) => r.top < 160 && r.left > innerWidth / 2);
  const x = right.length ? Math.min(...right.map((r) => r.left)) : innerWidth;
  document.documentElement.style.setProperty('--tools-right', `${Math.round(innerWidth - x + 12)}px`);
}
placeTools();
addEventListener('resize', placeTools);
addEventListener('pointerup', () => setTimeout(placeTools, 0));

/* 手機抽屜沿用行程頁的收合概念，內容移入目前分頁避免複製資料。 */
const sheet = $('#mobileSheet');
let currentTab = 'cards';
function placeMobile() {
  if (!mobile.matches) {
    panels.forEach((el) => stage.append(el));
    return;
  }
  panels.forEach((el) => { if (el.dataset.panel === currentTab) $('#sheetContent').append(el); else stage.append(el); });
}
function setSheet(open) {
  sheet.classList.toggle('small', !open);
  $('#sheetHandle').setAttribute('aria-expanded', String(open));
  $('#sheetHandle').setAttribute('aria-label', open ? '收合戰情室資訊' : '展開戰情室資訊');
  map.resize();
  setTimeout(() => PADS.refresh(), 0); // PADS 在檔案後段才建立
}
$('#sheetHandle').onclick = () => setSheet(sheet.classList.contains('small'));
sheetDrag(sheet, { isOpen: () => !sheet.classList.contains('small'), setOpen: setSheet, scroll: '.sheet-content', peek: '.sheet-handle, .sheet-summary, .sheet-tabs', mq: mobile });
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
  currentTab = b.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  placeMobile(); setSheet(true);
});
mobile.addEventListener('change', placeMobile);
placeMobile();
const EXAG = 1.4; // mapbase 的地形誇張倍率
const EV = {
  lost: '#ff453a', back: '#30d158', start: '#ff8a3d', end: '#8e8e93', stop: '#8e8e93', join: '#64d2ff', kick: '#ffd60a',
  behind: '#ffd60a', ahead: '#ffd60a', regroup: '#30d158', arrive: '#30d158', allin: '#30d158', speedcam: '#ffd60a', roadevent: '#ff9f0a', weather: '#64d2ff', chat: '#64d2ff',
  msg: '#64d2ff', mark: '#ffd60a', sos: '#ff453a', sos_off: '#30d158', route: '#ff8a3d', offroute: '#ffd60a', onroute: '#30d158', reroute: '#64d2ff', town: '#ff8a3d', stuck: '#ffd60a', moving: '#30d158',
};

/* ---------- 標記與軌跡 ---------- */
function upsert(u, state = {}) {
  let m = S.members.get(u.uid);
  if (!m) {
    const el = document.createElement('div');
    el.className = 'rider';
    el.style.setProperty('--c', u.color);
    el.style.setProperty('--ink', inkOn(u.color));
    el.innerHTML = `<div class="arrow"></div><div class="dot">${esc(initialOf(u.nickname))}</div><div class="name">${esc(u.nickname)}</div>`;
    m = { u, state: {}, recent: [], el, marker: new maplibregl.Marker({ element: el, anchor: 'center', opacityWhenCovered: '1', subpixelPositioning: true }), trail: [], pos: null, from: null, to: null, t0: 0, onMap: false };
    S.members.set(u.uid, m);
  }
  m.u = { ...m.u, ...u };
  m.el.style.setProperty('--c', m.u.color);
  m.el.style.setProperty('--ink', inkOn(m.u.color));
  m.state = { ...m.state, ...state };
  if (!m.pos && m.state.lat) m.pos = [+m.state.lon, +m.state.lat];
  return m;
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
// 大螢幕要一眼看出「他們在哪」（UX-29）：地名只留中文、城市與鄉鎮名放大；衛星底圖沒有文字層就略過
function bigLabels() {
  const zh = ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name']];
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol' || !l.layout?.['text-field'] || !/^(label_|place)/.test(l.id)) continue;
    try { map.setLayoutProperty(l.id, 'text-field', zh); } catch { /* 該層不吃這個值 */ }
  }
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
const padRaw = () => mobile.matches ? { top: 85, bottom: sheet.classList.contains('small') ? 185 : Math.round(innerHeight * .77), left: 35, right: 35 } : deskPortrait() ? { top: 120, bottom: Math.round(innerHeight * .56), left: 60, right: 120 } : { top: 90, bottom: 160, left: 395, right: 365 };
// 手勢規則（docs/地圖手勢規則.md）：拖曳＝暫離（按鈕／列變外框，10 秒沒動自動回去）；縮放、旋轉、傾斜繼續跟隨；
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
const PADS = smoothPad(padRaw);
const pad = () => PADS.get(); // 抽屜開合後鏡頭慢慢滑到新位置
addEventListener('resize', () => PADS.refresh());
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
  // 鏡頭目標的種類：跟某人／只有一人在線／全隊／沒人在線。種類一換（有人失聯或恢復、點了隊員）就讓鏡頭
  // 從目前畫面滑過去：以前 2 人→1 人時中心一格跳到那個人（約 150 px），恢復時又跳回舊的全隊位置，看起來就是來回抖
  const fm = S.focus && S.members.get(S.focus);
  const target = !autoFollow || S.profiling ? '' : fm?.pos ? `f${S.focus}` : pts.length === 1 ? `o${live[0].u.uid}` : pts.length ? 'g' : 'last';
  if (target !== lastTarget) { if (target && lastTarget) M.retarget(); lastTarget = target; }
  if (S.styleReady && pts.length && !S.profiling && autoFollow) {
    if (!LOW_POWER && !M.busy) map.setBearing((map.getBearing() + dt * 2) % 360); // 慢慢旋轉；省電時不轉，鏡頭不動地圖就不必重畫
    if (fm?.pos) M.follow(fm.pos, { padding: pad() });  // 點了隊員表：鏡頭跟著他
    else if (pts.length === 1) M.follow(pts[0], { padding: pad() });
    else M.followGroup(pts, { padding: pad(), maxZoom: 14 });
  } else if (S.styleReady && !pts.length && !S.profiling && autoFollow && !M.busy) fitLast();
  if (now - lastTrail > 500) { lastTrail = now; map.getSource('trails')?.setData(trailsGeo()); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 沒有人在線（全失聯、還沒出發、都結束了）：框住每個人最後的位置；連最後位置都沒有就框路線，再不行框台灣（UX-29）。
// 同一組位置只框一次，使用者動了地圖就交給使用者（手勢規則 v2：鏡頭狀態不變，只是沒有東西可以跟）
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

/* ---------- 騎士資訊與下一站 ETA ---------- */
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
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
  return (+s.speed || 0) * 3.6 < 5 ? ['停車', 'info'] : ['騎乘中', 'ok'];
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
function nextStop(km) {
  if (!numeric(km) || !S.route) return null;
  const stops = S.waypoints.filter((w) => w.kind === 'meet' && numeric(w.lon) && numeric(w.lat)).map((w) => ({ name: w.name || '集合點', km: routeKmOf(+w.lon, +w.lat) })).filter((w) => numeric(w.km) && w.km > +km + 0.15).sort((a, b) => a.km - b.km);
  return stops[0] || { name: '終點', km: S.route.cum_km.at(-1) };
}
function recentSpeed(m) {
  const fresh = m.recent.filter((x) => Date.now() - x.at < 10 * 60_000 && x.kmh >= 5);
  if (fresh.length >= 3) return fresh.reduce((a, x) => a + x.kmh, 0) / fresh.length;
  return +m.u.stats?.avg_kmh || null;
}
function renderCards() {
  const list = [...S.members.values()].sort((a, b) => (+S.prog[b.u.uid]?.km || 0) - (+S.prog[a.u.uid]?.km || 0));
  const online = list.filter((m) => !isOff(status(m)[0])).length;
  $('#teamCount').textContent = `${list.length} 位`;
  $('#teamOnline').textContent = `${online}/${list.length} 在線`;
  $('#sheetBrief').textContent = `${online}/${list.length} 在線 · ${S.route ? '路線 ' + fmtKm(S.route.cum_km.at(-1)) : '尚無路線'}`;
  // 和回放頁同一種隊員表：點一下鏡頭跟著那個人，再點一次回到全隊
  teamTable($('#cards'), list.map((m) => {
    const s = m.state, [st, stClass] = status(m), p = S.prog[m.u.uid], flag = S.flags[m.u.uid];
    const alert = S.sos.has(m.u.uid) ? ['SOS 求救', 'crit'] : flag === 'behind' && !isOff(st) ? ['落隊', 'warn'] : flag === 'ahead' && !isOff(st) ? ['超前', 'warn'] : [st, stClass];
    const off = isOff(st);
    const stop = nextStop(p?.km), remaining = stop ? Math.max(0, stop.km - +p.km) : null;
    const avg = recentSpeed(m), eta = avg && remaining != null && Number.isFinite(remaining) ? clock(Date.now() + remaining / avg * 3600000) : null;
    const left = S.route && numeric(p?.km) ? Math.max(0, S.route.cum_km.at(-1) - +p.km) : null;
    return {
      uid: m.u.uid, name: m.u.nickname, color: m.u.color, on: S.focus === m.u.uid && autoFollow, away: S.focus === m.u.uid && !autoFollow,
      sub: [alert[0], eta && stop && !off ? `${stop.name === '終點' ? '' : stop.name + ' '}預計 ${eta}` : ''].filter(Boolean).join(' · '), subCls: alert[1],
      cols: [[off ? '–' : Math.round((+s.speed || 0) * 3.6), 'km/h'], [numeric(s.alt) ? Math.round(+s.alt) : '–', 'm 海拔'],
             [(+m.u.stats?.km || 0).toFixed(1), 'km 已騎'], [left == null ? '–' : left.toFixed(1), 'km 距終點']],
    };
  }), (uid) => { S.focus = S.focus === uid && autoFollow ? null : uid; M.unfollow(); resumeFollow(); });
  if (!list.length) $('#cards').innerHTML = '<p class="empty">還沒有隊友</p>';
  markFocus([...S.members].map(([id, m]) => [id, m.el]), S.focus, !autoFollow);
}

/* ---------- 事件流 ---------- */
const nameOf = (uid) => S.members.get(uid)?.u.nickname || '';
const chatEv = (m) => ({ ...m, kind: 'event', type: 'chat', text: `聊天：${m.text}` });
const FEED = eventFilter(document.querySelector('.feed-filters'), FEED_FILTER_KEY, () => renderFeed());
function renderFeed() {
  const events = S.events.filter(FEED.match);
  $('#feed').innerHTML = events.slice(-14).reverse().map((e) => `<div class="ev${e.type === 'sos' ? ' sos' : ''}"><time class="num">${clock(+e.ts)}</time>
    <i style="--c:${EV[e.type] || '#8e8e93'}"></i><span>${e.uid ? `<b>${esc(nameOf(e.uid))}</b> ` : ''}${esc(e.text)}</span></div>`).join('') || '<div class="empty">目前沒有這類事件</div>';
}
function renderSos() {
  $('#sosbar').innerHTML = [...S.sos.keys()].map((uid) => `<div>SOS：${esc(nameOf(uid))} 需要幫忙</div>`).join('');
}

/* 天氣與路況使用既有本機 API；氣象署請求只有縣市代碼，騎士座標不外送。 */
function renderConditions() {
  const progress = [...Object.values(S.prog)].map((p) => +p.km).filter(Number.isFinite);
  const front = progress.length ? Math.min(...progress) : 0;
  const weather = S.weather.filter((x) => x.route_km >= front - 2).slice(0, 3);
  const traffic = S.traffic.filter((x) => x.route_km >= front - 2).slice(0, 3);
  $('#conditions').innerHTML = `<div class="condition-group"><h3>沿途天氣 · 中央氣象署</h3>${S.weatherError ? `<p class="empty">${esc(S.weatherError)}</p>` : weather.length ? weather.map((x) => `<div class="condition-row"><span class="condition-mark">${x.pop}%</span><span><b>${esc(x.name)}</b><small>${esc(x.area)}</small></span></div>`).join('') : '<p class="empty">前方沒有可用預報</p>'}</div>
    <div class="condition-group"><h3>省道路況 · 交通部 TDX</h3>${S.trafficError ? `<p class="empty">${esc(S.trafficError)}</p>` : traffic.length ? traffic.map((x) => `<div class="condition-row"><span class="condition-mark">${esc(x.type)}</span><span><b>${esc(x.name)}</b><small>路線 ${x.route_km} km · ${esc(x.area)}</small></span></div>`).join('') : '<p class="empty">前方目前沒有施工、事故或管制</p>'}</div>`;
}
async function loadConditions() {
  if (!S.route?.coords?.length) { $('#conditions').innerHTML = '<p class="empty">這趟沒有預定路線，無法顯示沿途預報。</p>'; return; }
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

/* ---------- 進度條＋海拔剖面 ---------- */
async function loadRoute() {
  let r = null;
  try { r = await api(`/api/trips/${tid}/route`); } catch { /* 沒路線或暫時讀不到 */ }
  // 同一條路線（WebSocket 重連時 snapshot 會再叫一次）不要重算海拔：重算要把鏡頭拉到整條路線再拉回來，每次重連畫面就跳一次
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
  if (!autoFollow) { renderProgress(); return; }
  const c = S.route.coords;
  if (!c.length) return;
  const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
  S.profiling = true;
  // 用動畫滑到整條路線（以前 setPitch／setBearing／fitBounds 都是瞬間跳過去）
  M.unfollow();
  const cam = map.cameraForBounds(b, { padding: pad(), bearing: 0, pitch: 0 });
  M.ease({ ...(cam || {}), bearing: 0, pitch: 0, duration: 700 });
  // 等地圖 idle（地形圖磚到齊）再取高度；但軌跡每 0.5 秒更新、手機省電重畫時地圖可能一直不 idle，
  // 最多等 4 秒，不然 S.profiling 一直是 true，鏡頭永遠停在整條路線、不會框住全隊
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
    S.profile = out.filter((x) => x[1] != null).length > 20 ? out : null;
    // 傾斜慢慢回到 60°；動畫期間跟隨讓路，結束後從目前畫面平滑接回全隊／沒人在線的框
    if (autoFollow) M.ease({ pitch: 60, duration: 900 });
    S.profiling = false;
    renderProgress();
  };
  // 等滑到位（moveend）、地形圖磚到齊（idle）再取高度
  const settle = () => (map.isMoving() ? map.once('moveend', settle) : map.once('idle', finish));
  requestAnimationFrame(settle);
  setTimeout(finish, 4700);
}
function renderProgress() {
  const svg = $('#profile');
  const W = 1000, H = 100;
  if (!S.route) {
    $('#progTitle').textContent = '隊員海拔（沒有預定路線）';
    const ms = [...S.members.values()].filter((m) => m.state.alt);
    const max = Math.max(500, ...ms.map((m) => +m.state.alt));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = ms.map((m, i) => { const h = (+m.state.alt / max) * (H - 10), w = W / Math.max(ms.length, 1); return `<rect x="${i * w + w * 0.3}" y="${H - h}" width="${w * 0.4}" height="${h}" rx="4" fill="${m.u.color}" opacity=".85"/>`; }).join('');
    $('#pmeta').innerHTML = ms.map((m) => `<span>${esc(m.u.nickname)} ${Math.round(+m.state.alt)} m</span>`).join('');
    document.querySelectorAll('.pdot').forEach((d) => d.remove());
    return;
  }
  const total = S.route.cum_km.at(-1);
  if (!(total > 0)) return;
  $('#progTitle').textContent = `全隊進度 · ${fmtKm(total)}${S.profile ? ' · 海拔剖面' : ''}`;
  if (S.profile) {
    const ys = S.profile.filter((p) => p[1] != null).map((p) => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(50, hi - lo);
    const pts = S.profile.filter((p) => p[1] != null).map(([km, e]) => `${(km / total) * W},${H - 6 - ((e - lo) / span) * (H - 16)}`);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".55"/><stop offset="1" stop-color="#ff8a3d" stop-opacity=".05"/></linearGradient></defs>
      <polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="url(#g)"/><polyline points="${pts.join(' ')}" fill="none" stroke="#ff8a3d" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
    $('#pmeta').innerHTML = `<span>起點</span><span>最低 ${Math.round(lo)} m · 最高 ${Math.round(hi)} m</span><span>終點</span>`;
  } else {
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `<line x1="0" y1="${H - 6}" x2="${W}" y2="${H - 6}" stroke="#ff8a3d" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
    $('#pmeta').innerHTML = '<span>起點</span><span>終點</span>';
  }
  const wrap = $('#pwrap');
  for (const m of S.members.values()) {
    const p = S.prog[m.u.uid];
    let d = wrap.querySelector(`[data-u="${m.u.uid}"]`);
    if (!p || m.u.active === false) { d?.remove(); continue; }
    if (!d) { d = document.createElement('div'); d.className = 'pdot'; d.dataset.u = m.u.uid; d.style.setProperty('--c', m.u.color); d.style.setProperty('--ink', inkOn(m.u.color)); wrap.append(d); }
    d.innerHTML = `<span>${esc(m.u.nickname)}</span><b>${esc(m.el.querySelector('.dot').textContent)}</b>`;
    const km = clamp(+p.km || 0, 0, total);
    d.style.left = `${(km / total) * 100}%`;
    let y = H - 6;
    if (S.profile) {
      const known = S.profile.filter((item) => item[1] != null);
      const next = known.findIndex((item) => item[0] >= km);
      const a = known[Math.max(0, next - 1)] || known.at(-1);
      const b = known[next < 0 ? known.length - 1 : next];
      if (a && b) {
        const elevation = a[0] === b[0] ? a[1] : a[1] + (b[1] - a[1]) * clamp((km - a[0]) / (b[0] - a[0]), 0, 1);
        const heights = known.map((item) => item[1]);
        const lo = Math.min(...heights), span = Math.max(50, Math.max(...heights) - lo);
        y = H - 6 - ((elevation - lo) / span) * (H - 16);
      }
    }
    d.style.top = `${(y / H) * 100}%`;
  }
}

/* ---------- WebSocket ---------- */
// 自動重連＋斷線橫幅在 livesock.js（和行程頁共用）
function connect() {
  liveSocket(`/ws/trips/${tid}`, { onMessage: handle, onForbidden: () => { tripGate(tid, { fresh: true }); } });
}
function handle(msg) {
  switch (msg.kind) {
    case 'snapshot': {
      const t = msg.trip;
      S.trip = t;
      t.members.forEach((u) => { const m = upsert(u, { ...u.state }); m.trail = (t.trails[u.uid] || []).slice(); if (u.state?.pre) m.lastRough = true; if (numeric(u.state?.route_km)) S.prog[u.uid] = { km: +u.state.route_km }; });
      S.events = t.events; S.gaps = t.gaps || {}; S.flags = t.flags || {};
      $('#name').textContent = t.name;
      document.title = `戰情室 · ${t.name}`;
      api(`/api/trips/${tid}/sos`).then((list) => { S.sos = new Map(list.map((e) => [e.uid, e])); renderSos(); renderCards(); }).catch(() => {});
      loadRoute(); loadWaypoints(); renderCards(); renderFeed();
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
      // 動畫長度＝跟上一點的間隔（和行程頁一樣）：固定 1 秒的話，2 秒回報一次的人會「走一秒停一秒」，跟隨他時鏡頭一頓一頓
      const tnow = performance.now(), gap = m.lastAt ? tnow - m.lastAt : 1000;
      m.lastAt = tnow;
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
    case 'trip': if (S.trip) S.trip.status = msg.status; break;
    case 'kicked': if (msg.uid === S.trip?.me) tripGate(tid, { fresh: true }); else { S.members.get(msg.uid)?.marker?.remove(); S.members.delete(msg.uid); } break;
    case 'event':
      S.events.push(msg);
      if (S.events.length > 200) S.events.shift();
      if (msg.type === 'sos') S.sos.set(msg.uid, msg);
      if (msg.type === 'sos_off') S.sos.delete(msg.uid);
      renderFeed(); renderSos();
      break;
    case 'chat':  // 聊天另存在 trip:{id}:chat，大螢幕也顯示在事件流裡
      S.events.push(chatEv(msg));
      if (S.events.length > 200) S.events.shift();
      renderFeed();
      break;
    case 'sos_refresh':  // 後台清掉測試 SOS
      api(`/api/trips/${tid}/sos`).then((list) => { S.sos = new Map(list.map((e) => [e.uid, e])); renderSos(); renderCards(); }).catch(() => {});
      break;
  }
}
setInterval(() => {
  $('#clock').textContent = clock(Date.now());
  const t = S.trip;
  if (t) $('#sub').textContent = `${t.status === 'live' ? '進行中' : t.status === 'ended' ? '已結束' : '等待開始'}${t.started ? ' · 已騎 ' + dur(Date.now() - +t.started) : ''} · ${S.members.size} 人`;
  renderCards();
  if (S.route || S.members.size) renderProgress();
  if (S.route) renderConditions();
}, 5000);
setInterval(() => { if (S.route) loadConditions(); }, 5 * 60_000);
connect();

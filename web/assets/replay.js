// 回放：全隊同步、時間軸＋倍速、事件標記、跟拍鏡頭、依速度／海拔上色、海拔與速度曲線
import { api, $, $$, esc, teamTable, initialOf, inkOn, press, clock, dur, initPanel, setLabel, smoothPad, frameGate } from '/assets/common.js';
import { createMap, declutter, addCompass } from '/assets/mapbase.js';
import { cameraGestures } from '/assets/gestures.js';

// 側欄收合（電腦收合鈕／手機拉把手）與其他地圖頁一致
let PADS = null;
const PANEL = initPanel($('#panel'), 'replay', { onChange: () => setTimeout(() => PADS?.refresh(), innerWidth <= 760 ? 0 : 300) });

const tid = new URLSearchParams(location.search).get('id');
if (!tid) location.href = '/';
// 返回一律回首頁（行程結束後只剩回放，回行程頁沒有意義）
$('#back').href = '/';

const EV = { lost: 'var(--crit)', back: 'var(--ok)', start: 'var(--accent)', end: 'var(--muted)', stop: 'var(--muted)', join: 'var(--accent)', kick: 'var(--warn)', behind: 'var(--warn)', ahead: 'var(--warn)', regroup: 'var(--ok)', arrive: 'var(--ok)', allin: 'var(--ok)', speedcam: 'var(--warn)', roadevent: 'var(--warn)', weather: 'var(--accent)', msg: 'var(--accent)', chat: 'var(--accent)', mark: 'var(--warn)', sos: 'var(--crit)', sos_off: 'var(--ok)', route: 'var(--accent)', offroute: 'var(--warn)', onroute: 'var(--ok)', stuck: 'var(--warn)', moving: 'var(--ok)', town: 'var(--accent)' };
const SPEED_STOPS = [0, '#5e60ce', 20, '#4ea8de', 40, '#56cfe1', 60, '#ffd166', 90, '#ef476f'];
const ALT_STOPS = [0, '#2a9d8f', 800, '#8ab17d', 1600, '#e9c46a', 2400, '#f4a261', 3300, '#e76f51'];
const PLAY = '<svg width="16" height="16" viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg width="16" height="16" viewBox="0 0 12 12"><rect x="2.5" y="1.5" width="2.6" height="9" fill="currentColor"/><rect x="7" y="1.5" width="2.6" height="9" fill="currentColor"/></svg>';

const M = createMap($('#map'), { style: 'dark', zoom: 7, terrain: true });
addCompass(M, document.querySelector('.tools'));  // 指北針：點一下北方朝上
const map = M.map;
window.qijiMap = map;

let data;
try { data = await api(`/api/trips/${tid}/replay`); }
catch (err) {
  $('#tSub').innerHTML = `${esc(err.message)}・<a href="" style="color:inherit;text-decoration:underline">重新整理</a>`;
  throw err;
}
const riders = data.members.filter((m) => m.track.length > 1);
const t0 = data.t0, t1 = data.t1;
const R = { t: t0, playing: false, rate: 60, follow: 'all', away: false, headingUp: true, followTarget: 'all', color: 'rider', sel: riders[0]?.uid, bearing: null, zoomed: false };

$('#tName').textContent = data.name;
document.title = `${data.name} · 回放`;
if (!riders.length) {
  $('#tSub').textContent = '這趟沒有任何軌跡紀錄';
  throw new Error('沒有軌跡');
}
$('#tSub').textContent = `${new Date(t0).toLocaleDateString('zh-TW')} ${clock(t0)}–${clock(t1)} · ${riders.length} 人`;

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
function colorExpr() {
  if (R.color === 'speed') return ['interpolate', ['linear'], ['get', 'spd'], ...SPEED_STOPS];
  if (R.color === 'alt') return ['interpolate', ['linear'], ['get', 'alt'], ...ALT_STOPS];
  return ['get', 'color'];
}
M.onStyle(() => {
  if (!map.getSource('rp-ghost')) map.addSource('rp-ghost', { type: 'geojson', data: ghostGeo() });
  if (!map.getSource('rp-seg')) map.addSource('rp-seg', { type: 'geojson', data: SEG });
  if (!map.getLayer('rp-ghost')) map.addLayer({ id: 'rp-ghost', type: 'line', source: 'rp-ghost', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.22 } });
  if (!map.getLayer('rp-seg')) map.addLayer({ id: 'rp-seg', type: 'line', source: 'rp-seg', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': colorExpr(), 'line-width': 4, 'line-opacity': 0.95 } });
  applyLayerState();
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
  m.marker = new maplibregl.Marker({ element: el, anchor: 'center', opacityWhenCovered: '1' }).setLngLat([m.track[0][2], m.track[0][1]]).addTo(map);
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
function fitAll(dur = 900) {
  const pts = riders.flatMap((m) => m.track.filter((_, i) => i % 10 === 0).map((p) => [p[2], p[1]]));
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  const cam = map.cameraForBounds(b, { padding: pad(), maxZoom: 15 });
  if (cam) { R.easeUntil = performance.now() + dur + 50; map.easeTo({ ...cam, pitch: M.is3d ? 50 : 0, bearing: 0, duration: dur }); }
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
  drawCharts();
}
// 跟隨方式和行程頁一樣：右上「全隊」看全部人，點隊員（列表或地圖上的標記）就跟著他，再點一次回到全隊
$('#bAll').onclick = () => setFollow('all');

/* ---------- 面板 ---------- */
// 全隊狀態的每一列就是選人：點了鏡頭跟拍那個人，摘要／曲線也換成他
function renderRiders() { renderTeam(); }

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
  $('#miniTeam').textContent = `${riders.length} 人 · ${active.length} 人已出發`;
}

const nameOf = (uid) => data.members.find((m) => m.uid === uid)?.nickname || '';
const riderColor = (uid) => data.members.find((m) => String(m.uid) === String(uid))?.color || 'var(--muted)';
const tickEvents = data.events.filter((e) => e.ts >= t0 && e.ts <= t1 && !['create', 'town'].includes(e.type));
$('#events').innerHTML = tickEvents.map((e) => `<div class="ev" data-t="${e.ts}"><time class="num">${clock(e.ts)}</time><i style="--c:${e.uid ? esc(riderColor(e.uid)) : 'var(--muted)'}"></i><span>${e.uid ? `<b>${esc(nameOf(e.uid))}</b> ` : ''}${esc(e.text)}</span></div>`).join('') || '<div class="small muted">這趟沒有事件</div>';
$('#events').onclick = (e) => { const r = e.target.closest('[data-t]'); if (r) seek(+r.dataset.t - 5000); };
$('#ticks').innerHTML = tickEvents.map((e) => `<button class="tick" style="left:${((e.ts - t0) / (t1 - t0)) * 100}%;--c:${EV[e.type] || 'var(--muted)'}" data-t="${e.ts}" title="${clock(e.ts)} ${esc(nameOf(e.uid))} ${esc(e.text)}"></button>`).join('');
$('#ticks').onclick = (e) => { const b = e.target.closest('.tick'); if (b) seek(+b.dataset.t - 5000); };

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
function drawCharts() { chart($('#altChart'), ALT, 'm'); chart($('#spdChart'), SPD, 'km/h'); }

/* ---------- 時間軸 ---------- */
$('#range').min = t0; $('#range').max = t1; $('#range').step = 1000;
function seek(t) { R.seekAt = performance.now(); R.t = Math.max(t0, Math.min(t1, t)); if (R.follow !== 'all') { R.zoomed = false; R.keepZoom = true; } update(true); }  // 拖時間軸：鏡頭飛到那人在該時間的位置，縮放維持
$('#range').oninput = (e) => seek(+e.target.value);
$('#rate').onchange = (e) => { R.rate = +e.target.value; };
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
$('#bStyle').onclick = () => {
  R.styleReady = false;
  $('#b3d').disabled = true;
  setLabel($('#bStyle'), M.nextStyle());
};
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
  if (force || now - lastFilter > 100) { lastFilter = now; if (map.getLayer('rp-seg')) map.setFilter('rp-seg', ['<=', ['get', 't'], R.t]); }
  if (force || now - lastUi > 250) {
    lastUi = now;
    $('#range').value = R.t;
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
  if (R.follow !== 'all' && !R.away && R.styleReady && now > (R.easeUntil || 0)) {
    const m = riders.find((x) => x.uid === R.follow);
    const st = stateAt(m, R.t);
    // 切換跟拍對象：不用 easeTo 飛到「按下那一刻」的位置（播放中人早就往前走了，動畫結束會再跳一次），
    // 而是每一格朝他「現在」的位置內插過去，飛完直接接上跟拍，中間沒有交接的跳動
    if (!R.zoomed) {
      R.zoomed = true;
      const c = map.getCenter();
      const km = hav(c.lat, c.lng, st.pos[1], st.pos[0]) / 1000;
      R.fly = { at: now, from: [c.lng, c.lat], z0: map.getZoom(), p0: map.getPitch(), z1: R.keepZoom ? map.getZoom() : Math.max(map.getZoom(), 15), p1: R.keepZoom ? map.getPitch() : M.is3d ? 62 : 0,
                dur: Math.min(1800, 700 + km * 40), dip: Math.max(0, Math.min(5, Math.log2(Math.max(1, km / 2)))) };
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
  } else if (R.follow === 'all' && !R.away && R.styleReady && (R.playing || now - (R.seekAt || 0) < 1500)
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
map.once('load', () => { fitAll(0); update(true); });
update(true);
requestAnimationFrame(frame);
addEventListener('resize', drawCharts);

// 戰情室（規格 4.7，電腦大螢幕）：3D 地圖自動運鏡（框住全隊＋慢慢旋轉）、隊員卡片牆、事件資訊流、
// 行程進度條＋海拔剖面。資料和行程頁一樣走 WebSocket（Pub/Sub）。
import { api, $, esc, initialOf, inkOn, clock, dur } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const tid = new URLSearchParams(location.search).get('id');
if (!tid) location.href = '/';
const M = createMap($('#map'), { style: 'dark', zoom: 7, terrain: true });
const map = M.map;
window.qijiMap = map;
map.setPitch(60);
const S = { trip: null, members: new Map(), events: [], route: null, prog: {}, gaps: {}, flags: {}, sos: new Map(), profile: null, styleReady: false };
window.qijiWar = S;
const EXAG = 1.4; // mapbase 的地形誇張倍率
const EV = {
  lost: '#ff453a', back: '#30d158', start: '#ff8a3d', end: '#8e8e93', stop: '#8e8e93', join: '#64d2ff', kick: '#ffd60a',
  behind: '#ffd60a', ahead: '#ffd60a', regroup: '#30d158', arrive: '#30d158', allin: '#30d158', speedcam: '#ffd60a', roadevent: '#ff9f0a', weather: '#64d2ff',
  msg: '#64d2ff', mark: '#ffd60a', sos: '#ff453a', sos_off: '#30d158', route: '#ff8a3d', offroute: '#ffd60a', onroute: '#30d158', town: '#ff8a3d', stuck: '#ffd60a', moving: '#30d158',
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
    m = { u, state: {}, el, marker: new maplibregl.Marker({ element: el, anchor: 'center' }), trail: [], pos: null, from: null, to: null, t0: 0, onMap: false };
    S.members.set(u.uid, m);
  }
  m.u = { ...m.u, ...u };
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
  S.styleReady = true;
});

/* ---------- 運鏡：每格框住全隊（平滑）＋每秒轉 2 度 ---------- */
let lastT = performance.now(), lastTrail = 0;
const pad = () => ({ top: 110, bottom: 230, left: 40, right: 640 });
function frame(now) {
  const dt = Math.min(0.2, (now - lastT) / 1000);
  lastT = now;
  for (const m of S.members.values()) {
    if (m.to) {
      const k = Math.min(1, (now - m.t0) / 1000);
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
    }
  }
  const pts = [...S.members.values()].filter((m) => m.pos && m.u.active !== false).map((m) => m.pos);
  if (S.styleReady && pts.length && !S.profiling) {
    map.setBearing((map.getBearing() + dt * 2) % 360);
    if (pts.length === 1) M.follow(pts[0], { padding: pad() });
    else M.followGroup(pts, { padding: pad(), maxZoom: 14 });
  }
  if (now - lastTrail > 500) { lastTrail = now; map.getSource('trails')?.setData(trailsGeo()); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- 卡片牆 ---------- */
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
function status(m) {
  const s = m.state;
  if (s.status === 'done') return ['已結束', 'muted'];
  if (s.status === 'lost') return ['失聯', 'crit'];
  if (!s.lat) return ['尚未回報', 'muted'];
  if (Date.now() - (+s.seen || +s.ts) > 30000) return ['訊號弱', 'warn'];
  return (+s.speed || 0) * 3.6 < 5 ? ['停車', 'info'] : ['騎乘中', 'ok'];
}
function renderCards() {
  const total = S.route?.cum_km.at(-1);
  const list = [...S.members.values()].sort((a, b) => (S.prog[b.u.uid]?.km ?? -1) - (S.prog[a.u.uid]?.km ?? -1));
  $('#cards').innerHTML = list.map((m) => {
    const s = m.state, [st, cls] = status(m), p = S.prog[m.u.uid], g = S.gaps[m.u.uid], f = S.flags[m.u.uid];
    const speed = s.status === 'lost' || s.status === 'done' ? '–' : Math.round((+s.speed || 0) * 3.6);
    const avg = m.u.stats?.avg_kmh || 40;
    const eta = total && p ? clock(Date.now() + ((total - p.km) / Math.max(10, avg)) * 3600000) : '–';
    return `<div class="cd glass${S.sos.has(m.u.uid) ? ' sos' : ''}${s.status === 'lost' ? ' lost' : ''}">
      <div class="top"><div class="avatar" style="--c:${esc(m.u.color)}">${esc(initialOf(m.u.nickname))}</div><b>${esc(m.u.nickname)}</b>
        <span class="chip ${cls}">${st}</span>${f ? `<span class="chip warn">${f === 'behind' ? '落隊' : '超前'}</span>` : ''}${S.sos.has(m.u.uid) ? '<span class="chip crit">SOS</span>' : ''}</div>
      <div class="spd"><b class="num">${speed}</b><span>km/h</span></div>
      <div class="kv"><span>今日 <em class="num">${fmtKm(m.u.stats?.km || 0)}</em></span><span>電量 <em class="num">${s.batt ? Math.round(+s.batt) + '%' : '–'}</em></span>
        <span>海拔 <em class="num">${s.alt ? Math.round(+s.alt) + ' m' : '–'}</em></span><span>${g != null ? (g < 0 ? '落後' : '超前') + ' <em class="num">' + fmtKm(Math.abs(g)) + '</em>' : '極速 <em class="num">' + Math.round(m.u.stats?.max_kmh || 0) + '</em>'}</span>
        ${total ? `<span>進度 <em class="num">${p ? fmtKm(p.km) : '–'}</em></span><span>預估到 <em class="num">${eta}</em></span>` : ''}</div>
    </div>`;
  }).join('') || '<div class="empty">還沒有隊友</div>';
}

/* ---------- 事件流 ---------- */
const nameOf = (uid) => S.members.get(uid)?.u.nickname || '';
function renderFeed() {
  $('#feed').innerHTML = S.events.slice(-14).reverse().map((e) => `<div class="ev${e.type === 'sos' ? ' sos' : ''}"><time class="num">${clock(+e.ts)}</time>
    <i style="--c:${EV[e.type] || '#8e8e93'}"></i><span>${e.uid ? `<b>${esc(nameOf(e.uid))}</b> ` : ''}${esc(e.text)}</span></div>`).join('') || '<div class="empty">還沒有事件</div>';
}
function renderSos() {
  $('#sosbar').innerHTML = [...S.sos.keys()].map((uid) => `<div>SOS：${esc(nameOf(uid))} 需要幫忙</div>`).join('');
}

/* ---------- 進度條＋海拔剖面 ---------- */
async function loadRoute() {
  try { const r = await api(`/api/trips/${tid}/route`); S.route = r?.coords ? r : null; } catch { S.route = null; }
  map.getSource('route')?.setData(routeGeo());
  if (S.route) buildProfile();
  renderProgress();
}
// 海拔：路線整條框進畫面、地形圖磚載入完後，沿路線取 160 個點查地形高度（除掉誇張倍率）
function buildProfile() {
  const c = S.route.coords;
  const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
  S.profiling = true;
  map.setPitch(0); map.setBearing(0);
  map.fitBounds(b, { padding: pad(), duration: 0 });
  map.once('idle', () => {
    const total = S.route.cum_km.at(-1), out = [];
    let j = 0;
    for (let k = 0; k <= 160; k++) {
      const km = (total * k) / 160;
      while (j < S.route.cum_km.length - 1 && S.route.cum_km[j + 1] < km) j++;
      const e = map.queryTerrainElevation(c[j]);
      out.push([km, e == null ? null : e / EXAG]);
    }
    S.profile = out.filter((x) => x[1] != null).length > 20 ? out : null;
    map.setPitch(60);
    S.profiling = false;
    renderProgress();
  });
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
  $('#progTitle').textContent = `行程進度 · ${fmtKm(total)}${S.profile ? ' · 海拔剖面' : ''}`;
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
    if (!d) { d = document.createElement('div'); d.className = 'pdot'; d.dataset.u = m.u.uid; d.style.setProperty('--c', m.u.color); wrap.append(d); }
    d.innerHTML = `<span>${esc(m.u.nickname)}</span><b>${esc(initialOf(m.u.nickname))}</b>`;
    d.style.left = `${Math.min(100, (p.km / total) * 100)}%`;
  }
}

/* ---------- WebSocket ---------- */
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/trips/${tid}`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => { if (e.code === 4403) { $('#sub').textContent = '你不是這個行程的成員'; return; } setTimeout(connect, 2000); };
}
function handle(msg) {
  switch (msg.kind) {
    case 'snapshot': {
      const t = msg.trip;
      S.trip = t;
      t.members.forEach((u) => { const m = upsert(u, { ...u.state }); m.trail = (t.trails[u.uid] || []).slice(); if (u.state?.route_km) S.prog[u.uid] = { km: +u.state.route_km }; });
      S.events = t.events; S.gaps = t.gaps || {}; S.flags = t.flags || {};
      $('#name').textContent = t.name;
      document.title = `戰情室 · ${t.name}`;
      api(`/api/trips/${tid}/sos`).then((list) => { S.sos = new Map(list.map((e) => [e.uid, e])); renderSos(); renderCards(); }).catch(() => {});
      loadRoute(); renderCards(); renderFeed();
      break;
    }
    case 'pos': {
      const m = S.members.get(msg.uid);
      if (!m) break;
      m.state = { ...m.state, ...msg, status: 'ok', seen: Date.now() };
      m.from = m.pos || [msg.lon, msg.lat]; m.to = [msg.lon, msg.lat]; m.t0 = performance.now();
      if (m.pos) m.trail.push(m.pos);
      if (m.trail.length > 3000) m.trail.splice(0, 500);
      break;
    }
    case 'status': { const m = S.members.get(msg.uid); if (m) { m.state.status = msg.status; if (msg.status === 'done') m.u.active = false; } break; }
    case 'stats': { const m = S.members.get(msg.uid); if (m) m.u.stats = msg; break; }
    case 'gap': S.gaps = msg.gaps; S.flags = msg.flags; break;
    case 'progress': S.prog[msg.uid] = { km: msg.km, off: msg.off_m }; break;
    case 'route': loadRoute(); break;
    case 'member': upsert(msg.user, {}); break;
    case 'trip': if (S.trip) S.trip.status = msg.status; break;
    case 'event':
      S.events.push(msg);
      if (S.events.length > 200) S.events.shift();
      if (msg.type === 'sos') S.sos.set(msg.uid, msg);
      if (msg.type === 'sos_off') S.sos.delete(msg.uid);
      renderFeed(); renderSos();
      break;
  }
}
setInterval(() => {
  $('#clock').textContent = clock(Date.now());
  const t = S.trip;
  if (t) $('#sub').textContent = `${t.status === 'live' ? '進行中' : t.status === 'ended' ? '已結束' : '等待開始'}${t.started ? ' · 已騎 ' + dur(Date.now() - +t.started) : ''} · ${S.members.size} 人`;
  renderCards();
  if (S.route || S.members.size) renderProgress();
}, 1000);
connect();

import { api, $, $$, esc, avatar, initialOf, clock, dur, ago, toast } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const tid = new URLSearchParams(location.search).get('id');
if (!tid) location.href = '/';

const STATUS = {
  ride: ['騎乘中', 'ok'], rest: ['停車中', 'info'], weak: ['訊號弱', 'warn'],
  lost: ['失聯', 'crit'], done: ['已結束紀錄', ''], none: ['尚未回報', ''],
};
const TRIP_ST = { planned: ['等待開始', 'info'], live: ['進行中', 'ok'], ended: ['已結束', ''] };
const EV = {
  lost: ['失聯', 'var(--crit)', '!', '#ff3b30'], back: ['恢復', 'var(--ok)', '回', '#30a46c'],
  start: ['開始', 'var(--accent)', '騎', '#0a84ff'], end: ['結束', 'var(--muted)', '終', '#8e8e93'],
  join: ['加入', 'var(--accent)', '入', '#2aabee'], stop: ['結束紀錄', 'var(--muted)', '停', '#8e8e93'],
  kick: ['移出', 'var(--warn)', '出', '#ff9f0a'], create: ['建立', 'var(--muted)', '建', '#8e8e93'],
};

// 預設深色＋3D（山的地形＋城市建築）
const M = createMap($('#map'), { style: 'dark', zoom: 7, terrain: true });
const map = M.map;
map.setPitch(55);
window.qijiMap = map; // 方便在主控台除錯
const S = { trip: null, me: null, members: new Map(), events: [], follow: 'all', lastInteract: 0, nearby: {}, gps: null, wake: null, trailDirty: true };

/* ---------- 成員與標記 ---------- */
function statusOf(m) {
  const s = m.state || {};
  if (s.status === 'done') return 'done';
  if (s.status === 'lost') return 'lost';
  if (s.lat == null || s.lat === '') return 'none';
  if (Date.now() - (+s.seen || +s.ts) > 30000) return 'weak';
  return (+s.speed || 0) * 3.6 < 5 ? 'rest' : 'ride';
}

function upsertMember(u, state) {
  let m = S.members.get(u.uid);
  if (!m) {
    const el = document.createElement('div');
    el.className = 'rider' + (u.uid === S.me ? ' me' : '');
    el.style.setProperty('--c', u.color);
    el.innerHTML = `<div class="arrow"></div><div class="dot">${esc(initialOf(u.nickname))}</div><div class="name">${esc(u.nickname)}</div>`;
    el.onclick = () => { setFollow(u.uid); };
    m = { u, state: {}, el, marker: new maplibregl.Marker({ element: el, anchor: 'center' }), trail: [], onMap: false, pos: null, anim: null, lastAt: 0, lastTarget: null };
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
function moveTo(m, lon, lat) {
  const now = performance.now();
  const to = [lon, lat];
  const gap = m.lastAt ? now - m.lastAt : 1000;
  m.lastAt = now;
  if (m.lastTarget) {
    const last = m.trail[m.trail.length - 1];
    if (!last || last[0] !== m.lastTarget[0] || last[1] !== m.lastTarget[1]) m.trail.push(m.lastTarget);
  }
  m.lastTarget = to;
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
  $('#bStyle').textContent = M.styleName;
  S.styleReady = true; // isStyleLoaded() 在圖磚載入中都是 false，不能拿來判斷
});

/* ---------- 鏡頭 ---------- */
['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach((ev) => map.on(ev, (e) => { if (e.originalEvent) { S.lastInteract = Date.now(); M.unfollow(); } }));
function panelPad() {
  const narrow = innerWidth <= 760;
  return narrow ? { top: 90, bottom: $('#panel').offsetHeight + 30, left: 40, right: 70 } : { top: 90, bottom: 60, left: 60, right: 460 };
}
S.pad = panelPad();
const refreshPad = () => setTimeout(() => (S.pad = panelPad()), 350);
addEventListener('resize', refreshPad);

// 要跟著誰：選了某個人就跟他；「全隊」但地圖上只有一個人時，也跟著那個人
function followTarget() {
  if (S.follow !== 'all') { const m = S.members.get(S.follow); return m?.pos ? m : null; }
  const shown = [...S.members.values()].filter((m) => m.pos);
  return shown.length === 1 ? shown[0] : null;
}
function setFollow(who) {
  S.follow = who;
  S.lastInteract = 0;
  S.followZoomed = false;
  syncTools();
  camera(true);
}
function camera(force) {
  if (!force && Date.now() - S.lastInteract < 12000) return;
  if (followTarget()) return; // 跟隨模式由動畫迴圈每一格把人放在正中間
  const pts = [...S.members.values()].filter((m) => m.pos).map((m) => m.pos);
  if (pts.length < 2) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  const cam = map.cameraForBounds(b, { padding: S.pad, maxZoom: 15, bearing: map.getBearing() });
  if (cam) map.easeTo({ ...cam, pitch: map.getPitch(), padding: S.pad, duration: 900 });
}
setInterval(() => camera(false), 3000);

// 動畫迴圈：標記平滑移動、跟隨的人保持在畫面中間、軌跡線尾巴接著標記
let lastTrailDraw = 0;
function tick(now) {
  for (const m of S.members.values()) {
    if (!m.anim) continue;
    const k = Math.min(1, (now - m.anim.t0) / m.anim.dur);
    m.pos = [m.anim.from[0] + (m.anim.to[0] - m.anim.from[0]) * k, m.anim.from[1] + (m.anim.to[1] - m.anim.from[1]) * k];
    if (k >= 1) m.anim = null;
    m.marker.setLngLat(m.pos);
  }
  const t = followTarget();
  if (t && Date.now() - S.lastInteract > 12000) {
    // 拉近的動畫可能被地圖載入打斷；還太遠就再拉一次
    if ((!S.followZoomed || map.getZoom() < 12) && now > (S.easeUntil || 0) && S.styleReady) {
      S.followZoomed = true;
      S.easeUntil = now + 900;
      map.easeTo({ center: t.pos, zoom: Math.max(map.getZoom(), 14.5), padding: S.pad, duration: 850 });
    } else if (now > (S.easeUntil || 0)) {
      M.follow(t.pos, { padding: S.pad });
    }
  } else M.unfollow();
  if (now - lastTrailDraw > 150 && map.getSource('trails')) {
    lastTrailDraw = now;
    map.getSource('trails').setData(trailsGeo());
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function syncTools() {
  $('#bAll').classList.toggle('on', S.follow === 'all');
  $('#bMe').classList.toggle('on', S.follow === S.me);
}
$('#bAll').onclick = () => setFollow('all');
$('#bMe').onclick = () => setFollow(S.me);
$('#bStyle').onclick = () => { $('#bStyle').textContent = M.nextStyle(); };
$('#b3d').onclick = () => { M.set3d(!M.is3d); $('#b3d').classList.toggle('on', M.is3d); };

/* ---------- 面板 ---------- */
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('[data-b]').forEach((x) => (x.hidden = x.dataset.b !== b.dataset.t));
  $('#panel').classList.remove('small');
};
$('#handle').onclick = () => { $('#panel').classList.toggle('small'); refreshPad(); };

function renderHeader() {
  const t = S.trip;
  $('#tName').textContent = t.name;
  document.title = `${t.name} · 騎跡`;
  const [label, cls] = TRIP_ST[t.status] || ['', ''];
  $('#tStatus').className = 'chip ' + cls;
  $('#tStatus').textContent = label;
  $('#tTimer').textContent = t.status === 'live' && t.started ? '已騎 ' + dur(Date.now() - +t.started) : '';
  const b = $('#banner');
  if (t.status === 'planned') {
    b.hidden = false;
    b.innerHTML = t.is_owner
      ? '<div>行程還沒開始。等大家到齊後按開始，所有人的位置才會開始記錄。</div><button class="btn primary" id="startBtn">開始行程</button>'
      : '<div>等待建立者開始行程。可以先到「回報」分頁設定位置來源。</div>';
    $('#startBtn')?.addEventListener('click', async () => {
      try { S.trip = { ...S.trip, ...(await api(`/api/trips/${tid}/start`, { method: 'POST' })) }; renderAll(); }
      catch (e) { toast(e.message, { icon: '!', color: '#ff3b30' }); }
    });
  } else if (t.status === 'ended') {
    b.hidden = false;
    b.innerHTML = `<div>行程已結束，可以整隊回放這一趟。</div><a class="btn primary" href="/replay?id=${tid}">看回放</a>`;
  } else b.hidden = true;
  const meActive = S.members.get(S.me)?.u.active;
  $('#endBtn').hidden = !(t.status === 'live' && meActive);
}

function renderTeam() {
  const list = [...S.members.values()];
  const online = list.filter((m) => ['ride', 'rest', 'weak'].includes(statusOf(m))).length;
  $('#sOnline').textContent = `${online}/${list.length}`;
  const me = S.members.get(S.me);
  $('#sSpeed').textContent = me?.state.speed != null && me.state.speed !== '' ? Math.round(+me.state.speed * 3.6) : '–';
  $('#sAlt').textContent = me?.state.alt != null && me.state.alt !== '' ? Math.round(+me.state.alt) : '–';
  $('#team').innerHTML = list.map((m) => {
    const st = statusOf(m), [label, cls] = STATUS[st], s = m.state;
    const isMe = m.u.uid === S.me;
    const km = S.nearby[m.u.uid];
    const bits = [];
    if (isMe) bits.push('我');
    else if (km != null) bits.push(`距離我 ${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km'}`);
    const k = m.u.stats;
    if (k?.km > 0) bits.push(`騎了 ${k.km < 10 ? k.km.toFixed(1) : Math.round(k.km)} km`);
    if (k?.max_kmh > 0) bits.push(`極速 ${Math.round(k.max_kmh)}`);
    if (s.batt) bits.push(`電量 ${Math.round(+s.batt)}%`);
    if (s.seen || s.ts) bits.push(ago(+s.seen || +s.ts));
    const kick = S.trip.is_owner && !isMe ? `<button class="kick" data-kick="${m.u.uid}">移出</button>` : '';
    const right = st === 'ride' || st === 'rest' || st === 'weak' ? `<b class="num">${Math.round((+s.speed || 0) * 3.6)}</b> km/h` : '';
    return `<div class="li">${avatar(m.u)}<div class="grow"><div class="t1">${esc(m.u.nickname)} <span class="chip ${cls}">${label}</span></div><div class="t2">${esc(bits.join(' · ') || (m.u.active ? '' : '沒有在記錄'))}</div></div><div class="right">${right}${kick}</div></div>`;
  }).join('');
}
$('#team').onclick = async (e) => {
  const k = e.target.closest('[data-kick]');
  if (k) {
    if (k.dataset.confirm !== '1') { k.dataset.confirm = '1'; k.textContent = '確定移出？'; return; }
    try { await api(`/api/trips/${tid}/kick`, { method: 'POST', body: { uid: k.dataset.kick } }); }
    catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    return;
  }
  const li = e.target.closest('.li');
  if (li) { const idx = [...$('#team').children].indexOf(li); const m = [...S.members.values()][idx]; if (m?.onMap) { S.follow = m.u.uid; syncTools(); camera(true); } }
};

function renderEvents() {
  const name = (uid) => S.members.get(uid)?.u.nickname || '';
  $('#events').innerHTML = S.events.slice().reverse().map((e) => {
    const [, color] = EV[e.type] || ['', 'var(--muted)'];
    return `<div class="ev"><time class="num">${clock(+e.ts)}</time><i style="--c:${color}"></i><span>${e.uid ? `<b>${esc(name(e.uid))}</b> ` : ''}${esc(e.text)}</span></div>`;
  }).join('') || '<div class="muted small">還沒有事件</div>';
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
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('已複製邀請連結'); } catch { prompt('複製這個連結', link); }
  };
}

function renderAll() { renderHeader(); renderTeam(); renderEvents(); renderInvite(); }
setInterval(() => { if (S.trip) { renderHeader(); renderTeam(); S.members.forEach(placeMarker); } }, 1000);

/* ---------- WebSocket ---------- */
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/trips/${tid}`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (e.code === 4403) { toast('你不是這個行程的成員', { icon: '!', color: '#ff3b30' }); setTimeout(() => (location.href = '/'), 1500); return; }
    setTimeout(connect, 2000);
  };
}

function handle(msg) {
  switch (msg.kind) {
    case 'snapshot': {
      const t = msg.trip;
      S.trip = t; S.me = t.me;
      t.members.forEach((u) => {
        const m = upsertMember(u, { ...u.state });
        m.trail = t.trails[u.uid] || [];
        if (m.pos) m.trail = m.trail.slice(0, -1); // 最後一點就是目前位置，由 m.pos 接上
      });
      S.events = t.events;
            renderAll();
      camera(true);
      break;
    }
    case 'pos': {
      const m = S.members.get(msg.uid);
      if (!m) break;
      m.state = { ...m.state, ...msg, status: 'ok', seen: Date.now() };
      moveTo(m, msg.lon, msg.lat);
      placeMarker(m);
      break;
    }
    case 'status': {
      const m = S.members.get(msg.uid);
      if (m) { m.state.status = msg.status; if (msg.status === 'done') m.u.active = false; placeMarker(m); renderTeam(); }
      break;
    }
    case 'stats': { const m = S.members.get(msg.uid); if (m) m.u.stats = msg; break; } // 每秒的 renderTeam 會畫出來
    case 'member': upsertMember(msg.user, {}); renderTeam(); break;
    case 'trip':
      S.trip.status = msg.status;
      if (msg.status === 'live') { S.trip.started = Date.now(); S.members.forEach((m) => (m.u.active = true)); }
      renderHeader();
      break;
    case 'kicked':
      if (msg.uid === S.me) { toast('你已被移出這個行程', { icon: '!', color: '#ff3b30' }); setTimeout(() => (location.href = '/'), 1500); }
      else { const m = S.members.get(msg.uid); m?.marker.remove(); S.members.delete(msg.uid); S.trailDirty = true; renderTeam(); }
      break;
    case 'event': {
      S.events.push(msg);
      if (S.events.length > 200) S.events.shift();
      renderEvents();
      const meta = EV[msg.type];
      if (meta && msg.type !== 'create') {
        const who = S.members.get(msg.uid)?.u.nickname;
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
  try { const r = await api(`/api/trips/${tid}/nearby`); S.nearby = Object.fromEntries(r.items.map((x) => [x.uid, x.km])); } catch { /* 下次再試 */ }
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
  if (S.gps) {
    navigator.geolocation.clearWatch(S.gps.watch);
    S.gps = null; S.wake?.release?.(); S.wake = null;
    $('#gpsBtn').textContent = '開始回報我的位置'; $('#gpsBtn').className = 'btn primary';
    $('#gpsInfo').textContent = '已停止';
    return;
  }
  if (!navigator.geolocation) { toast('這個瀏覽器不支援定位', { icon: '!', color: '#ff3b30' }); return; }
  if (!isSecureContext) { $('#gpsInfo').textContent = '要用 HTTPS 網址（或 localhost）才能定位'; return; }
  S.gps = { last: 0, sent: 0 };
  S.gps.watch = navigator.geolocation.watchPosition(onFix, (err) => { $('#gpsInfo').textContent = '定位失敗：' + err.message; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  wakeLock();
  $('#gpsBtn').textContent = '停止回報'; $('#gpsBtn').className = 'btn';
  $('#gpsInfo').textContent = '等待定位…';
};
async function onFix(p) {
  if (!S.gps) return;
  const c = p.coords, now = Date.now();
  const moving = c.speed == null || c.speed > 1.5;
  if (now - S.gps.last < (moving ? 2500 : 30000)) return;   // 騎乘中 2.5 秒一點，停車時 30 秒一點
  S.gps.last = now;
  try {
    await api('/api/track', { method: 'POST', body: { lat: c.latitude, lon: c.longitude, alt: c.altitude, speed: c.speed, heading: c.heading, acc: c.accuracy, batt: await battery(), ts: Math.round(p.timestamp), src: 'web' } });
    S.gps.sent++;
    $('#gpsInfo').textContent = `已送出 ${S.gps.sent} 筆 · 精度 ${Math.round(c.accuracy)} m · ${clock(now)}`;
  } catch (e) { $('#gpsInfo').textContent = '送出失敗：' + e.message; }
}

$('#endBtn').onclick = async () => {
  const b = $('#endBtn');
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '再按一次確定結束'; return; }
  try { await api(`/api/trips/${tid}/end`, { method: 'POST' }); if (S.gps) $('#gpsBtn').click(); b.hidden = true; }
  catch (e) { toast(e.message, { icon: '!', color: '#ff3b30' }); }
};

$('#bReplay').href = `/replay?id=${tid}`;
$('#trUrl').textContent = `${location.origin}/osmand`;
api('/api/me/device').then((d) => ($('#trId').textContent = d.device_id)).catch(() => {});
syncTools();
$('#b3d').classList.toggle('on', M.is3d);
connect();

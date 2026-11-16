// 登入頁左側：在夜色 3D 地圖上，一條一條巡航台灣經典騎車路線。
// 目前那條會亮起來，四顆「大燈」（一隊人）沿著路線往前騎；其他路線淡淡留著。
// 路線是公開道路（tools/build_login_routes.py 用本機 Valhalla 產生），不是任何人的軌跡。
import { $ } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const SCENE_MS = 9000;          // 每條路線停留時間
const TEAM = ['#ff9a52', '#0a84ff', '#30d158', '#bf5af2']; // 領騎＋三位隊友
const GAP = 0.018;              // 隊友之間相隔路線長度的比例

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 沿線累積距離，之後可以用 0～1 的比例取位置
function measure(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
    const k = Math.cos(y1 * Math.PI / 180);
    cum.push(cum[i - 1] + Math.hypot((x2 - x1) * k, y2 - y1));
  }
  return cum;
}
function along(r, t) {
  const target = t * r.cum[r.cum.length - 1];
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < target) i++;
  const a = r.coords[i - 1], b = r.coords[i];
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const k = (target - r.cum[i - 1]) / seg;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
function bbox(coords) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [[w, s], [e, n]];
}

export async function start() {
  const routes = await (await fetch('/assets/login-routes.json')).json();
  routes.forEach((r) => { r.cum = measure(r.coords); });

  const M = createMap($('#map'), { style: 'dark', center: [121.0, 23.75], zoom: 6.6, terrain: !reduce, interactive: false, syncTheme: false });
  const map = M.map;
  let cur = -1, t0 = 0;

  const lines = { type: 'FeatureCollection', features: routes.map((r, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'LineString', coordinates: r.coords } })) };
  const team = () => ({
    type: 'FeatureCollection',
    features: cur < 0 ? [] : TEAM.map((c, j) => {
      const r = routes[cur];
      const p = Math.max(0, Math.min(1, (performance.now() - t0) / SCENE_MS * 0.9 + 0.05 - j * GAP));
      return { type: 'Feature', properties: { c, lead: j === 0 }, geometry: { type: 'Point', coordinates: along(r, p) } };
    }),
  });

  M.onStyle(() => {
    if (!map.getSource('lr')) map.addSource('lr', { type: 'geojson', data: lines });
    if (!map.getSource('lt')) map.addSource('lt', { type: 'geojson', data: team() });
    if (!map.getLayer('lr-dim')) {
      map.addLayer({ id: 'lr-dim', type: 'line', source: 'lr', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ff9a52', 'line-opacity': 0.35, 'line-width': 2 } });
      map.addLayer({ id: 'lr-glow', type: 'line', source: 'lr', filter: ['==', ['get', 'i'], cur], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ff7a1a', 'line-opacity': 0.55, 'line-width': 12, 'line-blur': 8 } });
      map.addLayer({ id: 'lr-hi', type: 'line', source: 'lr', filter: ['==', ['get', 'i'], cur], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffc08f', 'line-width': 3.5 } });
      map.addLayer({ id: 'lt-halo', type: 'circle', source: 'lt', paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['case', ['get', 'lead'], 16, 11], 'circle-opacity': 0.35, 'circle-blur': 1 } });
      map.addLayer({ id: 'lt-dot', type: 'circle', source: 'lt', paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['case', ['get', 'lead'], 6, 4.5], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    }
  });

  const steps = $('#steps');
  steps.innerHTML = routes.map(() => '<i></i>').join('');
  steps.style.setProperty('--dur', SCENE_MS + 'ms');

  const pad = () => (innerWidth <= 900
    ? { top: 110, bottom: 120, left: 30, right: 30 }
    : { top: 200, bottom: 200, left: 80, right: 80 });

  function show(i) {
    cur = i;
    const r = routes[i];
    ['lr-glow', 'lr-hi'].forEach((id) => map.getLayer(id) && map.setFilter(id, ['==', ['get', 'i'], i]));
    // 文字淡出→換字→淡入
    const box = $('#rcText');
    box.classList.add('out');
    setTimeout(() => {
      $('#rcRoad').textContent = r.road;
      $('#rcName').textContent = r.name;
      $('#rcMeta').innerHTML = `${r.from} → ${r.to} · 約 <span class="num">${r.km}</span> km`;
      box.classList.remove('out');
    }, reduce ? 0 : 350);
    [...steps.children].forEach((el, j) => { el.className = j < i ? 'done' : j === i ? 'on' : ''; });
    if (reduce) return;
    // 每條路換一個角度看：沿著路線大致方向轉，帶點仰角
    const [a, b] = [r.coords[0], r.coords[r.coords.length - 1]];
    const bearing = ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI) + 360) % 360 - 30;
    const cam = map.cameraForBounds(bbox(r.coords), { padding: pad(), bearing });
    if (cam) map.flyTo({ ...cam, zoom: Math.min(cam.zoom, 11.5), pitch: 58, duration: 2600, essential: false });
    t0 = performance.now() + 1800; // 鏡頭快到了才開始騎
  }

  map.once('load', () => {
    if (reduce) {
      // 減少動態效果：不飛、不動，顯示全部路線，每 9 秒換一條的文字
      map.fitBounds(bbox(routes.flatMap((r) => r.coords)), { padding: 40, duration: 0 });
      let i = 0; show(0);
      setInterval(() => show(i = (i + 1) % routes.length), SCENE_MS);
      return;
    }
    let i = 0;
    setTimeout(() => {
      show(0);
      setInterval(() => show(i = (i + 1) % routes.length), SCENE_MS);
    }, 1200);
    const tick = () => {
      if (map.getSource('lt') && cur >= 0 && performance.now() > t0) map.getSource('lt').setData(team());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 分頁在背景時不要一直算
  document.addEventListener('visibilitychange', () => { if (document.hidden) map.stop(); });
}

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

  // 深淺色由 <head> 先決定（記住的或跟系統），地圖跟著用深色／淺色底圖；syncTheme 讓換底圖時整頁一起換
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const M = createMap($('#map'), { style: isLight() ? 'light' : 'dark', center: [121.0, 23.75], zoom: 6.6, terrain: !reduce, forceTerrain: true, interactive: false, syncTheme: true });
  const map = M.map;
  // 只是背景裝飾，又鋪滿整個畫面：解析度最多 1.5 倍（Retina 原本 2 倍，像素少一半左右）
  if (devicePixelRatio > 1.5) map.setPixelRatio?.(1.5);
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
    // 淺色底圖（Liberty）的地名、圖示很搶眼，壓在標語底下不好讀：地名調淡、圖示拿掉，只當背景
    if (isLight()) for (const l of map.getStyle().layers) {
      if (l.type !== 'symbol') continue;
      map.setPaintProperty(l.id, 'text-opacity', 0.5);
      map.setPaintProperty(l.id, 'icon-opacity', 0);
    }
    if (!map.getSource('lr')) map.addSource('lr', { type: 'geojson', data: lines });
    if (!map.getSource('lt')) map.addSource('lt', { type: 'geojson', data: team() });
    if (!map.getLayer('lr-dim')) {
      map.addLayer({ id: 'lr-dim', type: 'line', source: 'lr', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ff9a52', 'line-opacity': 0.35, 'line-width': 2 } });
      map.addLayer({ id: 'lr-glow', type: 'line', source: 'lr', filter: ['==', ['get', 'i'], cur], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ff7a1a', 'line-opacity': 0.55, 'line-width': 12, 'line-blur': 8 } });
      map.addLayer({ id: 'lr-hi', type: 'line', source: 'lr', filter: ['==', ['get', 'i'], cur], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': isLight() ? '#d9500f' : '#ffc08f', 'line-width': 3.5 } });
      map.addLayer({ id: 'lt-halo', type: 'circle', source: 'lt', paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['case', ['get', 'lead'], 16, 11], 'circle-opacity': 0.35, 'circle-blur': 1 } });
      map.addLayer({ id: 'lt-dot', type: 'circle', source: 'lt', paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['case', ['get', 'lead'], 6, 4.5], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    }
  });

  // 右上角深淺切換：換底圖（自己的路線圖層會在 onStyle 加回來），並記住
  const btn = $('#themeBtn');
  const label = () => btn.setAttribute('aria-label', isLight() ? '切換成深色' : '切換成淺色');
  label();
  btn.onclick = () => {
    const next = isLight() ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;  // 地圖壞掉時 setStyle 是空的，頁面還是要換
    try { localStorage.setItem('qiji.loginTheme', next); } catch (e) {}
    M.setStyle(next);
    label();
  };

  const steps = $('#steps');
  steps.innerHTML = routes.map(() => '<i></i>').join('');
  steps.style.setProperty('--dur', SCENE_MS + 'ms');

  // 電腦版地圖鋪到表單底下，右邊留出表單寬度，路線才會落在左邊看得到的地方
  const formW = () => document.querySelector('.side')?.offsetWidth || 0;
  // 電腦版開場：台灣往左移半個表單寬，不要躲在表單後面（地圖還在載入時就先移，不等 load）
  if (innerWidth > 900) map.panBy([formW() / 2, 0], { duration: 0 });
  const pad = () => (innerWidth <= 900
    ? { top: 110, bottom: 168, left: 30, right: 30 }  // 手機：下面多 48px 是延伸到表單上方空白的那段（login.html --under）
    : { top: 200, bottom: 200, left: 80, right: formW() + 80 });

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
      map.fitBounds(bbox(routes.flatMap((r) => r.coords)), { padding: innerWidth <= 900 ? 40 : { top: 40, bottom: 40, left: 40, right: formW() + 40 }, duration: 0 });
      let i = 0; show(0);
      setInterval(() => show(i = (i + 1) % routes.length), SCENE_MS);
      return;
    }
    let i = 0;
    setTimeout(() => {
      show(0);
      setInterval(() => show(i = (i + 1) % routes.length), SCENE_MS);
    }, 1200);
    // 隊伍點每秒只更新 20 次：每次 setData 都會讓整張 3D 地圖重畫，跟著螢幕 60 次會讓 GPU 一直滿載。
    // 點走得很慢（9 秒走完一條路），20 次看起來一樣順
    let lastTick = 0;
    const tick = (now) => {
      if (now - lastTick >= 50 && map.getSource('lt') && cur >= 0 && performance.now() > t0) { lastTick = now; map.getSource('lt').setData(team()); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 分頁在背景時不要一直算
  document.addEventListener('visibilitychange', () => { if (document.hidden) map.stop(); });
}

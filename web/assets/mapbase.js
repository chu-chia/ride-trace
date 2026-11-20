// MapLibre 5 底圖：深色、衛星、淺色，足跡頁另有深藍。
// 3D 模式＝山的地形（AWS 高程）＋城市的立體建築（OpenFreeMap 向量資料）＋天空。
// 換風格後 style.load 會把地形、建築、天空和各頁自己的圖層全部加回來。
const SAT = {
  version: 8,
  sources: {
    sat: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}'],
      attribution: '© 內政部國土測繪中心',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#1c261d' } },
    { id: 'sat', type: 'raster', source: 'sat' },
  ],
};
export const STYLES = {
  dark: { name: '深色', url: 'https://tiles.openfreemap.org/styles/dark' },
  sat: { name: '衛星', url: SAT },
  light: { name: '淺色', url: 'https://tiles.openfreemap.org/styles/liberty' },
  // 足跡頁用：Liberty（有地名、路名、地標圖示）重新上成深藍色，黃色軌跡在上面最清楚
  navy: { name: '深藍', url: 'https://tiles.openfreemap.org/styles/liberty' },
};
const DEFAULT_ORDER = ['dark', 'sat', 'light'];

// 每種底圖的建築顏色（依高度由低到高）、山影、天空
const LOOK = {
  dark: {
    building: ['#3a4250', '#4b5568', '#606d84'], buildingOpacity: 0.95,
    hillshade: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#5b6b80', 'hillshade-accent-color': '#1a222c' },
    sky: { 'sky-color': '#0a1626', 'horizon-color': '#1d3352', 'fog-color': '#141c27', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0 },
  },
  sat: {
    building: null,
    hillshade: { 'hillshade-exaggeration': 0.25, 'hillshade-shadow-color': '#000000' },
    sky: { 'sky-color': '#6fa4dd', 'horizon-color': '#cfe0f0', 'fog-color': '#dfe9f3', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0 },
  },
  navy: {
    building: ['#2d4084', '#34498f', '#3c529b'], buildingOpacity: 0.9,
    hillshade: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0d1638', 'hillshade-highlight-color': '#3a4f95', 'hillshade-accent-color': '#1a2759' },
    sky: { 'sky-color': '#0b1433', 'horizon-color': '#24356f', 'fog-color': '#1a2759', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0 },
  },
  light: {
    building: ['#e4ddd2', '#c9bfb0', '#b3a794'], buildingOpacity: 0.85,
    hillshade: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#4b5563' },
    sky: { 'sky-color': '#7fb2ec', 'horizon-color': '#dbe8f5', 'fog-color': '#e6eef6', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4, 'atmosphere-blend': 0 },
  },
};
const BUILDING_ID = 'qiji-buildings-3d';
const BUILDING_FLAT_ID = 'qiji-buildings-2d';  // 2D 用的平面建築（不立體，從正上方看才不會歪斜）

// 深藍底圖：把 Liberty 的每一層依「是什麼」換色。只改顏色，不動資料與篩選。
const NAVY = {
  land: '#24356f', water: '#16245a', waterLine: '#1c2c66', green: '#22396c', landuse: '#283a78', building: '#2d4084',
  casing: '#1e2d63', major: '#4d62ad', secondary: '#42569d', minor: '#34478a', path: '#2f4180', rail: '#3a4c8c', boundary: '#7d8cc8',
  halo: '#17234f', city: '#f2f4ff', place: '#cdd4f5', poi: '#c3cbef', road: '#aab5e4', waterText: '#7f93d6', transit: '#9fc0ff',
};
function recolorNavy(map) {
  const set = (id, prop, v) => { try { map.setPaintProperty(id, prop, v); } catch { /* 該層沒有這個屬性 */ } };
  for (const l of map.getStyle().layers) {
    const id = l.id, sl = l['source-layer'] || '';
    if (l.type === 'background') set(id, 'background-color', NAVY.land);
    else if (l.type === 'raster' && id === 'natural_earth') map.setLayoutProperty(id, 'visibility', 'none');
    else if (l.type === 'fill') {
      if (sl === 'water') set(id, 'fill-color', NAVY.water);
      else if (id === 'park' || /wood|grass|wetland/.test(id)) { set(id, 'fill-color', NAVY.green); set(id, 'fill-outline-color', NAVY.green); }
      else if (sl === 'building') { set(id, 'fill-color', NAVY.building); set(id, 'fill-outline-color', NAVY.building); }
      else { set(id, 'fill-color', NAVY.landuse); set(id, 'fill-opacity', 0.55); }
    } else if (l.type === 'line') {
      if (sl === 'waterway') set(id, 'line-color', NAVY.waterLine);
      else if (sl === 'boundary') set(id, 'line-color', NAVY.boundary);
      else if (id === 'park_outline') set(id, 'line-opacity', 0);
      else if (sl === 'aeroway') set(id, 'line-color', NAVY.minor);
      else if (sl === 'transportation') {
        set(id, 'line-color', /casing/.test(id) ? NAVY.casing : /rail/.test(id) ? NAVY.rail : /path|pedestrian/.test(id) ? NAVY.path
          : /motorway|trunk|primary/.test(id) ? NAVY.major : /secondary|link/.test(id) ? NAVY.secondary : NAVY.minor);
      }
    } else if (l.type === 'symbol') {
      set(id, 'text-halo-color', NAVY.halo);
      set(id, 'text-halo-width', 1.4);
      if (/label_(city|country|state)/.test(id)) set(id, 'text-color', NAVY.city);
      else if (/label_/.test(id)) set(id, 'text-color', NAVY.place);
      else if (id === 'poi_transit') set(id, 'text-color', NAVY.transit);
      else if (/^poi|airport/.test(id)) set(id, 'text-color', NAVY.poi);
      else if (/water/.test(id)) set(id, 'text-color', NAVY.waterText);
      else if (/highway-name/.test(id)) set(id, 'text-color', NAVY.road);
    }
  }
  // 道路編號盾牌（白底小方塊，例如「1」「5」「XY-011」）和單行道箭頭在深藍上糊成白點，看不出是什麼，關掉
  for (const l of map.getStyle().layers) {
    if (/shield|one_way_arrow/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
  }
  // 地名、地標、路名只顯示中文（沒有中文名才用原名），不要英文疊在上面
  const zh = ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name']];
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && l.layout?.['text-field'] && /label_|poi|water_name|highway-name|airport/.test(l.id)) map.setLayoutProperty(l.id, 'text-field', zh);
  }
  // 城市名放大，像參考圖那樣一眼看到在哪
  for (const [id, size] of [['label_city', [5, 12, 9, 18, 13, 22]], ['label_city_capital', [5, 14, 9, 20, 13, 24]], ['label_town', [8, 11, 12, 15, 15, 18]]]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'text-size', ['interpolate', ['linear'], ['zoom'], ...size]);
  }
}
const DEM = {
  // maxzoom 12：更細的地形放大用就好，圖磚請求少很多（手機流量、電力，也是「地圖載入中」拖很久的主因，UX-12）
  type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 12,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  attribution: 'Terrain © Mapzen / AWS',
};

// ---------- 地圖掛掉時的保底 ----------
// MapLibre 腳本沒載到（CDN／網路問題）或 WebGL 開不起來時，換成一個「什麼都不做」的替身：
// 任何屬性、呼叫、new 都回傳自己，所以頁面其餘功能（SOS、隊友清單、訊息）照常運作，只是沒有地圖。
function inert() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(_, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then' || k === 'toJSON') return undefined;   // 不要被當成 Promise／JSON 物件
      return p;
    },
    apply() { return p; },
    construct() { return p; },
    set() { return true; },
  });
  return p;
}
if (!window.maplibregl) {
  window.maplibregl = inert();
  window.qijiMapDown = '地圖程式沒有載入';
}

function showMapError(container, msg) {
  const el = document.createElement('div');
  el.className = 'map-loading glass';
  el.setAttribute('role', 'alert');
  el.style.cssText = 'max-width:min(360px,calc(100% - 32px));text-align:center;line-height:1.5';
  el.textContent = `地圖載入失敗（${msg}）。隊友清單、訊息、SOS 仍然可以用。`;
  container.after(el);
}

// 不考慮傾斜，算出能把範圍放進留白內可視區的 zoom（cameraForBounds 算不出來時的備案）
function flatZoom(b, padding = {}, maxZoom = 15, map) {
  const box = map ? map.getContainer() : null;
  const BW = box?.clientWidth || innerWidth, BH = box?.clientHeight || innerHeight;
  // 留白比畫面還大時（手機抽屜拉到很高）W／H 會變成 0 或負的，算出來是 zoom 0（整個世界）：至少留畫面的 1/4
  const W = Math.max(BW * 0.25, BW - (padding.left || 0) - (padding.right || 0));
  const H = Math.max(BH * 0.25, BH - (padding.top || 0) - (padding.bottom || 0));
  const sw = maplibregl.MercatorCoordinate.fromLngLat(b.getSouthWest()), ne = maplibregl.MercatorCoordinate.fromLngLat(b.getNorthEast());
  const dx = Math.max(1e-9, Math.abs(ne.x - sw.x)), dy = Math.max(1e-9, Math.abs(ne.y - sw.y));
  return Math.min(maxZoom, Math.log2(Math.max(1, Math.min(W / (dx * 512), H / (dy * 512)))));
}

export function createMap(container, { style = 'dark', center = [121.0, 23.8], zoom = 7, terrain = false, interactive3d = true, interactive = true, syncTheme = true, styles = DEFAULT_ORDER } = {}) {
  const ORDER = styles;
  let cur = style;
  let is3d = terrain;
  // 浮在地圖上的面板跟著底圖深淺走（深色、衛星 → 深色面板；淺色 → 淺色面板），不跟系統
  // syncTheme:false 給只有半邊是地圖的頁面（登入頁），那邊的表單還是跟系統
  const theme = () => { if (syncTheme) document.documentElement.dataset.theme = cur === 'light' ? 'light' : 'dark'; };
  theme();
  const hooks = [];
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  let map;
  try {
    if (window.qijiMapDown) throw new Error(window.qijiMapDown);
    map = new maplibregl.Map({
      container, style: STYLES[cur].url, center, zoom, interactive,
      // 省電模式（common.js 在 <html> 加 .low-power）：手機 3 倍螢幕只畫 2 倍，像素少一半以上
      pixelRatio: document.documentElement.classList.contains('low-power') ? Math.min(devicePixelRatio, 2) : devicePixelRatio,
      fadeDuration: document.documentElement.classList.contains('low-power') ? 0 : 300, // 省電：文字不做淡入（淡入期間會一直重畫）
      maxPitch: 80, attributionControl: false,  // 來源標示統一放在「關於網頁」（設定頁最下面），地圖右下角不放 ⓘ
      dragRotate: interactive3d, pitchWithRotate: interactive3d, touchPitch: interactive3d,
    });
  } catch (e) {
    // 例如 WebGL 開不起來：一樣換成替身，不讓整頁壞掉
    console.error('地圖初始化失敗', e);
    showMapError(el, e.message?.includes('WebGL') ? '這台裝置不支援 WebGL' : e.message || '未知錯誤');
    map = inert();
    const base = { map, style: cur, styleName: STYLES[cur].name, is3d: false, down: true, nextStyle: () => STYLES[cur].name };
    return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}) });  // 其他方法（follow、set3d…）都是空的
  }
  if (!interactive3d && interactive) map.touchZoomRotate.disableRotation();
  // 省電：地圖自己的重畫最多 30 fps（圖磚載入、資料更新時 MapLibre 會連續重畫）；手指在地圖上時不限制，拖曳縮放才跟手
  if (document.documentElement.classList.contains('low-power')) {
    const repaint = map.triggerRepaint.bind(map);
    let last = 0, pending = 0, touching = false;
    const box = map.getCanvasContainer();
    box.addEventListener('touchstart', () => { touching = true; }, { passive: true });
    for (const ev of ['touchend', 'touchcancel']) box.addEventListener(ev, (e) => { if (!e.touches.length) touching = false; }, { passive: true });
    // 跟著螢幕更新排程（60Hz 螢幕就是隔一格畫一次），間隔平均；用 setTimeout 會忽快忽慢，畫面看起來在抖
    const tryPaint = () => {
      pending = 0;
      const now = performance.now();
      if (touching || now - last >= 25) { last = now; repaint(); } else pending = requestAnimationFrame(tryPaint);
    };
    map.triggerRepaint = () => { if (touching) { last = performance.now(); repaint(); } else if (!pending) tryPaint(); };
  }
  if (!terrain) map.setMaxPitch(0);
  // OpenFreeMap 的樣式引用了 sprite 裡沒有的圖示（circle-11、wood-pattern），每次載入都會警告：補一張透明圖（UX-53）
  map.on('styleimagemissing', (e) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  // 底圖、地形圖磚還沒出來前畫面是一片黑：先放「地圖載入中」，圖磚到齊就收掉
  const loadingEl = document.createElement('div');
  loadingEl.className = 'map-loading glass';
  loadingEl.setAttribute('role', 'status');
  loadingEl.innerHTML = '<span class="spin" aria-hidden="true"></span>地圖載入中…';
  el.after(loadingEl);
  // 底圖畫出來就收：底圖（向量／衛星）的圖磚第一次載入完成、或第一次 idle、或 load，哪個先到用哪個。
  // 不能只等 load：3D 地形圖磚鏡頭一動就被取消重抓，load 可能拖到 30 秒（UX-12）。最多蓋 5 秒
  let loaded = false;
  const doneLoading = () => {
    if (loaded) return;
    loaded = true;
    map.off('sourcedata', onBase);
    loadingEl.remove();
    // 精簡版來源標示預設是展開的，在手機上會蓋住一條地圖；收成 ⓘ，點了再展開
    map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
  };
  const onBase = (e) => { if ((e.sourceId === 'openmaptiles' || e.sourceId === 'sat') && e.isSourceLoaded && e.tile) doneLoading(); };
  map.on('sourcedata', onBase);
  map.once('load', doneLoading);
  map.once('idle', doneLoading);
  setTimeout(doneLoading, 5000); // 網路很慢時也不要一直蓋著

  const firstSymbol = () => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  function applyBuildings() {
    const look = LOOK[cur];
    // OpenFreeMap 的向量資料來源叫 openmaptiles；衛星底圖沒有，就不加建築
    if (!look.building || !map.getSource('openmaptiles')) return;
    const h = ['coalesce', ['get', 'render_height'], 8];
    const [lo, mid, hi] = look.building;
    // Liberty 內建 building-3d 圖層，關掉改用自己的，深淺色才一致
    if (map.getLayer('building-3d')) map.setLayoutProperty('building-3d', 'visibility', 'none');
    if (!map.getLayer(BUILDING_ID)) {
      map.addLayer({
        id: BUILDING_ID, type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], h, 0, lo, 60, mid, 150, hi],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, h],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': look.buildingOpacity,
        },
      }, firstSymbol());
    }
    if (!map.getLayer(BUILDING_FLAT_ID)) {
      map.addLayer({
        id: BUILDING_FLAT_ID, type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
        paint: { 'fill-color': lo, 'fill-opacity': look.buildingOpacity, 'fill-outline-color': mid },
      }, firstSymbol());
    }
    applyDim();
  }

  // 真的 2D：建築改平面、不能傾斜（鏡頭鎖 pitch 0）、沒有天空；3D：立體建築＋地形＋可傾斜
  function applyDim() {
    const vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
    vis(BUILDING_ID, is3d);
    vis(BUILDING_FLAT_ID, !is3d);
    map.setMaxPitch(is3d ? 80 : 0);
    if (interactive && interactive3d) {
      // 2D 仍可旋轉（右鍵／Ctrl 拖曳、雙指旋轉），只是不會傾斜
      if (is3d) { map.touchPitch.enable(); map.dragRotate.enable(); } else map.touchPitch.disable();
    }
  }


  function applyTerrain() {
    if (!map.getSource('dem')) {
      map.addSource('dem', { ...DEM });
    }
    if (!map.getLayer('hillshade')) {
      // 山影在 2D 也開著，平面地圖也看得出山的起伏
      // 山影用另一個來源，跟 3D 地形分開，畫質比較好
      if (!map.getSource('dem-hs')) map.addSource('dem-hs', { ...DEM });
      map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', paint: LOOK[cur].hillshade }, firstSymbol());
    }
    map.setTerrain(is3d ? { source: 'dem', exaggeration: 1.4 } : null);
    if (is3d) map.setSky(LOOK[cur].sky);
    applyDim();
  }

  // MapLibre 5 的鏡頭動畫被打斷時，地形高度可能停在 0（鏡頭會鑽進 3000 公尺的山裡）。
  // 每次停下來就把畫面中心的高度校正成地形高度。
  let following = false, smoothEl = null, lastT = 0, lastKey = '';
  // 手指／滑鼠按在地圖上時，跟隨先停手：jumpTo 會中止 MapLibre 正在辨識的拖曳、縮放手勢，跟隨中就怎麼拖都拖不動
  let held = 0, wheelUntil = 0;  // 滾輪縮放有約 0.2 秒的緩動，而且不一定帶 originalEvent，用時間判斷
  { const box = map.getCanvasContainer();
    box.addEventListener('touchstart', (e) => { held = e.touches.length; }, { passive: true });
    for (const ev of ['touchend', 'touchcancel']) box.addEventListener(ev, (e) => { held = e.touches.length; }, { passive: true });
    // 滑鼠只看真的滑鼠（手機點一下也會補送 mousedown／mouseup，不能拿來判斷）
    box.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') held = 1; });
    addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') held = 0; });
    box.addEventListener('wheel', () => { lastT = performance.now(); wheelUntil = lastT + 250; }, { passive: true }); }
  // 使用者自己的鏡頭動作（滾輪縮放慣性、雙指旋轉放開後的慣性）還在進行時，跟隨也讓路：jumpTo 會呼叫 map.stop() 把它中止
  let userMove = false;
  map.on('movestart', (e) => { if (e.originalEvent) userMove = true; });
  map.on('moveend', () => { userMove = false; });
  // 跟隨暫停（手勢中）或剛開始跟隨時，鏡頭從目前畫面滑到目標，不要一格跳過去
  let resume = null, wasBusy = false;
  const RESUME_MS = 450;
  let retargetMs = 0;  // retarget() 指定的滑動時間
  let busyUntil = 0;  // 鏡頭動畫（指北針、2D/3D）結束前，跟隨模式不要每格重設鏡頭把動畫打斷
  const animate = (opts) => { busyUntil = performance.now() + (opts.duration ?? 500) + 80; map.easeTo(opts); };
  let grp = null, grpT = 0; // 全隊鏡頭目前的（平滑後）中心與縮放
  function fixElevation() {
    if (following || !is3d || !map.getTerrain() || map.isMoving()) return;
    const e = map.queryTerrainElevation(map.getCenter());
    if (e != null && Math.abs(e - map.getCenterElevation()) > 20) map.setCenterElevation(e);
  }
  map.on('moveend', fixElevation);
  map.on('idle', fixElevation);

  let styleLoaded = false;
  map.on('style.load', () => {
    styleLoaded = true;
    if (cur === 'navy') recolorNavy(map);
    applyTerrain();
    applyBuildings();
    hooks.forEach((fn) => fn(cur));
  });

  return {
    map,
    get style() { return cur; },
    get styleName() { return STYLES[cur].name; },
    get is3d() { return is3d; },
    // 樣式已經載入過就立刻執行一次（isStyleLoaded() 在圖磚載入中會是 false，不能用）
    onStyle(fn) { hooks.push(fn); if (styleLoaded) fn(cur); },
    setStyle(name) { cur = name; theme(); map.setStyle(STYLES[name].url, { diff: false }); },
    nextStyle() { this.setStyle(ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]); return STYLES[cur].name; },
    // 跟隨模式：每一格把鏡頭中心移到 center。高度不直接貼地形（地形有細小起伏，鏡頭會上下彈），
    // 而是周圍取幾個點平均後再慢慢追，看起來就是平穩地沿著山坡移動。
    follow(center, extra = {}) {
      const now = performance.now();
      if (now < busyUntil || now < wheelUntil || held || userMove) { lastT = now; wasBusy = true; return; }  // 指北針、切 2D/3D 的動畫、手指按在地圖上、使用者縮放的慣性還沒停，跟隨先讓路
      const dt = Math.min(0.2, (now - (lastT || now)) / 1000);
      lastT = now;
      if (!following || wasBusy) { const c = map.getCenter(); resume = { at: now, from: [c.lng, c.lat], ms: retargetMs || RESUME_MS, io: !!retargetMs }; wasBusy = false; retargetMs = 0; }
      if (!following) { following = true; map.setCenterClampedToGround(false); smoothEl = is3d && map.getTerrain() ? map.getCenterElevation() : null; }  // 從目前鏡頭高度開始追，不會一接手就跳
      if (resume) {
        // 換對象用前後都慢的曲線（每格位移小、沒有一開始的猛衝）；手勢後接回用先快後慢
        const k = Math.min(1, (now - resume.at) / resume.ms), e = resume.io ? k * k * (3 - 2 * k) : 1 - (1 - k) ** 3;
        center = [resume.from[0] + (center[0] - resume.from[0]) * e, resume.from[1] + (center[1] - resume.from[1]) * e];
        if (k >= 1) resume = null;
      }
      let el = 0;
      if (is3d && map.getTerrain()) {
        const d = 0.0015, D = 0.003; // 約 150、300 公尺兩圈
        const samples = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d], [D, D], [-D, D], [D, -D], [-D, -D]]
          .map(([a, b]) => map.queryTerrainElevation([center[0] + a, center[1] + b]))
          .filter((v) => v != null);
        const target = samples.length ? samples.reduce((x, y) => x + y, 0) / samples.length : (smoothEl ?? 0);
        smoothEl = smoothEl == null ? target : smoothEl + (target - smoothEl) * (1 - Math.exp(-dt / 1.6));
        el = smoothEl;
      }
      // 鏡頭沒有變（人停著、全隊沒動）就不要 jumpTo，地圖才不會每一格白白重畫
      const key = `${center[0].toFixed(7)},${center[1].toFixed(7)},${el.toFixed(1)},${JSON.stringify(extra, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v))}`;
      if (key === lastKey) return;
      lastKey = key;
      map.jumpTo({ center, elevation: el, ...extra });
    },
    // 全隊鏡頭：每一格算「框住所有人」需要的中心和縮放，鏡頭往那裡平滑地追（不用 easeTo：
    // 每隔一段時間重新 easeTo 會一頓一頓的，動畫結束時地形高度校正還會讓畫面跳一下）。
    // 有人快跑出畫面時拉遠要快，拉近則慢慢來，避免縮放一直來回。
    followGroup(pts, { padding, maxZoom = 14.5 } = {}) {
      if (!pts.length || performance.now() < busyUntil || held) return;
      // 中心用全隊的重心（彎道上某人折返時，外框中心會左右甩，重心穩很多），範圍取以重心為中心、能包住所有人的對稱框
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const hx = Math.max(...pts.map((p) => Math.abs(p[0] - cx))), hy = Math.max(...pts.map((p) => Math.abs(p[1] - cy)));
      const b = new maplibregl.LngLatBounds([cx - hx, cy - hy], [cx + hx, cy + hy]);
      const cam = map.cameraForBounds(b, { padding, maxZoom, bearing: map.getBearing() });
      const c = { lng: cx, lat: cy };
      // 鏡頭傾斜很大、畫面又很高（例如手機直拿看戰情室電腦版）時 cameraForBounds 會算不出來，改用平面換算
      let tz = cam?.zoom ?? flatZoom(b, padding, maxZoom, map);
      const now = performance.now();
      const dt = Math.min(0.2, (now - (grpT || now)) / 1000);
      grpT = now;
      if (!grp || !following) { const mc = map.getCenter(); grp = { lon: mc.lng, lat: mc.lat, zoom: map.getZoom() }; }
      // zoom 遲滯：要拉遠（有人快出畫面）就跟；要拉近，差超過 0.4 級才慢慢拉近，小幅變化不理，畫面不會一直呼吸
      if (tz > grp.zoom && tz - grp.zoom < 0.4) tz = grp.zoom;
      else if (tz > grp.zoom) tz -= 0.2;
      const kc = 1 - Math.exp(-dt / 0.7);
      const kz = 1 - Math.exp(-dt / (tz < grp.zoom ? 0.5 : 2.2));
      grp.lon += (c.lng - grp.lon) * kc;
      grp.lat += (c.lat - grp.lat) * kc;
      grp.zoom += (tz - grp.zoom) * kz;
      this.follow([grp.lon, grp.lat], { zoom: grp.zoom, padding });
    },
    // 換回全隊時呼叫：全隊鏡頭從「目前畫面」重新開始追，不會跳回上次全隊時的舊位置
    regroup() { grp = null; grpT = 0; },
    // 跟隨的對象換了（全隊 ↔ 單人、有人失聯／恢復）：下一格從目前畫面用 0.45 秒滑過去，不要一格跳到新目標
    retarget(ms = 1000) { grp = null; grpT = 0; wasBusy = true; retargetMs = ms; },
    // 程式自己的鏡頭動畫（例如恢復傾斜）：動畫期間跟隨讓路，結束後平滑接回
    ease(opts) { animate(opts); },
    unfollow() {
      grp = null; grpT = 0;
      if (!following) return;
      following = false; lastT = 0; lastKey = '';
      map.setCenterClampedToGround(true);
      fixElevation();
    },
    // 使用者正在操作地圖（手指按著、滾輪慣性、鏡頭動畫中）：自動旋轉之類每格改鏡頭的動作要先停
    get busy() { const n = performance.now(); return !!held || userMove || n < busyUntil || n < wheelUntil; },
    // 以畫面中心縮放（跟隨中點兩下、雙指點一下用；MapLibre 內建的是以手指位置為中心）
    zoomBy(d) { animate({ zoom: map.getZoom() + d, duration: 300 }); },
    resetNorth() { animate({ bearing: 0, duration: 500 }); },
    set3d(on) {
      is3d = on;
      if (styleLoaded) {
        map.setTerrain(on ? { source: 'dem', exaggeration: 1.4 } : null);
        if (on) map.setSky(LOOK[cur].sky);
      }
      if (on) { applyDim(); animate({ pitch: 60, duration: 800 }); }
      // 先把鏡頭放平，再鎖住 pitch（直接鎖會瞬間跳平）
      else { animate({ pitch: 0, duration: 600 }); setTimeout(() => { if (!is3d) applyDim(); }, 650); }
      if (!styleLoaded) applyDim();
    },
  };
}

// 標記重疊時整理名字：靠太近的隊友只留第一個人的名字，後面加「+N」，其他人只顯示頭像。
// items：[{ el, pos:[lon,lat], name }]，越前面越優先（自己、正在跟的人放前面）。
export function declutter(map, items, gap = 40) {
  const kept = [];
  for (const it of items) {
    if (!it.pos) continue;
    const p = map.project(it.pos);
    const lead = kept.find((k) => Math.hypot(k.p.x - p.x, k.p.y - p.y) < gap);
    // 帶名字的那個疊在最上面，名字才不會被後面的頭像蓋住
    if (lead) { lead.n += 1; it.el.classList.add('stacked'); it.el.style.zIndex = '1'; }
    else { kept.push({ it, p, n: 0 }); it.el.classList.remove('stacked'); it.el.style.zIndex = '2'; }
  }
  for (const k of kept) {
    const label = k.it.el.querySelector('.name');
    const text = k.n ? `${k.it.name} +${k.n}` : k.it.name;
    if (label && label.textContent !== text) label.textContent = text;
  }
}

// 指北針：指針跟著地圖方向轉，點一下讓北方朝上（3D 保留傾斜角度）。放進各頁右上的 .tools 按鈕列。
export function addCompass(M, tools) {
  const map = M.map;
  if (M.down || !tools) return null;
  const b = document.createElement('button');
  b.className = 'tool glass compass';
  b.type = 'button';
  b.title = '指北針：點一下讓北方朝上';
  b.setAttribute('aria-label', '指北針，點一下讓北方朝上');
  b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g class="needle"><path d="M12 3 L15.5 12 L8.5 12 Z" fill="#ff453a"/><path d="M12 21 L8.5 12 L15.5 12 Z" fill="currentColor" opacity=".55"/></g></svg>';
  const needle = b.querySelector('.needle');
  const sync = () => {
    const bearing = map.getBearing();
    needle.setAttribute('transform', `rotate(${-bearing} 12 12)`);
    b.classList.toggle('off-north', Math.abs(bearing) > 0.5);
  };
  map.on('rotate', sync);
  sync();
  b.onclick = () => M.resetNorth();
  tools.append(b);
  return b;
}

// 自己的圖層要插在哪裡：所有底圖形狀（道路、橋、高架、建築）之後的第一個文字層之前。
// 不能直接用「第一個文字層」：Liberty 有些文字層（河流名、單行道箭頭）排在道路之前，插在那裡會被道路和高架蓋住。
export function labelLayerId(map) {
  const ls = map.getStyle().layers;
  const ours = (id) => /^(fp-|towns-|heat|qiji-|rp-|route|trails)/.test(id) || id === 'hillshade';
  const lastShape = ls.findLastIndex((l) => l.type !== 'symbol' && !ours(l.id));
  return ls.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;
}

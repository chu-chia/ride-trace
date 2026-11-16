// 首頁背景：夜色 3D 地圖，鏡頭以台北為中心、帶到周圍山區，
// 自己全部的軌跡用黃光畫上去，鏡頭非常慢地繞著轉。只是背景：不能操作、不跟著改整頁深淺色。
import { createMap } from '/assets/mapbase.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
// 台灣時間的日期字串（API 用 YYYY-MM-DD）
const tsDay = (ms) => {
  const d = new Date(ms + (new Date(ms).getTimezoneOffset() + 480) * 60000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function start(summary) {
  const narrow = innerWidth <= 640;
  const M = createMap(document.getElementById('bgmap'), {
    style: 'dark', terrain: true, interactive: false, syncTheme: false,
    // 以台北為中心：最常騎、軌跡最密，發光的路網會落在頁首與兩側
    center: [121.5, 25.0], zoom: narrow ? 9.2 : 9.6,
  });
  const map = M.map;
  map.jumpTo({ pitch: 45, bearing: -18 });

  M.onStyle(() => {
    // 背景用：地名、路名全部關掉，只留地形和軌跡，頁首的字才不會跟地圖的字打架
    for (const l of map.getStyle().layers) if (l.type === 'symbol') map.setLayoutProperty(l.id, 'visibility', 'none');
    if (!map.getSource('hm')) map.addSource('hm', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('hm-glow')) {
      map.addLayer({ id: 'hm-glow', type: 'line', source: 'hm', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffd84d', 'line-opacity': 0.28, 'line-width': 7, 'line-blur': 5 } });
      map.addLayer({ id: 'hm-line', type: 'line', source: 'hm', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffe14d', 'line-opacity': 0.9, 'line-width': 1.6 } });
    }
  });

  if (summary?.points) {
    const q = `from=${tsDay(summary.first_ts)}&to=${tsDay(summary.last_ts)}&buckets=dawn,day,dusk,night`;
    fetch('/api/footprint/lines?' + q, { credentials: 'same-origin' }).then((r) => r.json())
      .then((lines) => { const set = () => map.getSource('hm')?.setData(lines); map.loaded() ? set() : map.once('load', set); set(); })
      .catch(() => {});
  }

  if (reduce) return;
  // 每秒轉 1.2 度，大約 5 分鐘繞一圈；分頁在背景時暫停
  let last = performance.now();
  const spin = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!document.hidden) map.setBearing(map.getBearing() + dt * 1.2);
    requestAnimationFrame(spin);
  };
  map.once('load', () => requestAnimationFrame(spin));
}

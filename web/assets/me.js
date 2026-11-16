// 個人頁（規格 4.6）：點亮全台鄉鎮、熱力圖、累計統計。
import { api, $, $$, esc } from '/assets/common.js';
import { createMap } from '/assets/mapbase.js';

const M = createMap($('#map'), { style: 'navy', styles: ['navy', 'dark', 'sat', 'light'], center: [120.95, 23.7], zoom: 6.8, interactive3d: false });
const map = M.map;
window.qijiMap = map;
const D = { tab: 'towns', geo: null, towns: null, heat: null, stats: null };
const pad = () => (innerWidth <= 760 ? { top: 40, bottom: innerHeight * 0.55 + 20, left: 20, right: 20 } : { top: 40, bottom: 40, left: 60, right: 440 });

/* ---------- 地圖圖層 ---------- */
function townsData() {
  if (!D.geo) return { type: 'FeatureCollection', features: [] };
  const lit = new Set(D.towns?.ids || []);
  return { ...D.geo, features: D.geo.features.map((f) => ({ ...f, properties: { ...f.properties, lit: lit.has(f.properties.id) } })) };
}
const heatData = () => ({
  type: 'FeatureCollection',
  features: (D.heat?.cells || []).map(([lon, lat, n]) => ({ type: 'Feature', properties: { n }, geometry: { type: 'Point', coordinates: [lon, lat] } })),
});
M.onStyle(() => {
  const first = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  if (!map.getSource('towns')) map.addSource('towns', { type: 'geojson', data: townsData() });
  if (!map.getLayer('towns-fill')) map.addLayer({ id: 'towns-fill', type: 'fill', source: 'towns', paint: {
    'fill-color': ['case', ['get', 'lit'], '#ff8a3d', '#1b2433'], 'fill-opacity': ['case', ['get', 'lit'], 0.55, 0.35] } }, first);
  if (!map.getLayer('towns-line')) map.addLayer({ id: 'towns-line', type: 'line', source: 'towns', paint: {
    'line-color': ['case', ['get', 'lit'], '#ffb27a', '#3a4a63'], 'line-width': 0.7 } }, first);
  if (!map.getSource('heat')) map.addSource('heat', { type: 'geojson', data: heatData() });
  if (!map.getLayer('heat')) map.addLayer({ id: 'heat', type: 'heatmap', source: 'heat', paint: {
    'heatmap-weight': ['interpolate', ['linear'], ['ln', ['+', 1, ['get', 'n']]], 0, 0, 7, 1],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 2],
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 10, 8, 14, 20],
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(255,138,61,.35)', 0.4, '#ff8a3d', 0.7, '#ffd60a', 1, '#ffffff'],
    'heatmap-opacity': 0.9 } });
  applyTab();
  $('#bStyle').textContent = M.styleName;
});
$('#bStyle').onclick = () => { $('#bStyle').textContent = M.nextStyle(); };
map.on('click', 'towns-fill', (e) => {
  const p = e.features?.[0]?.properties;
  if (!p) return;
  new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat)
    .setHTML(`<b>${esc(p.county)}${esc(p.name)}</b><br>${p.lit ? '已點亮' : '還沒去過'}`).addTo(map);
});

function applyTab() {
  const show = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  show('towns-fill', D.tab === 'towns'); show('towns-line', D.tab === 'towns'); show('heat', D.tab === 'heat');
}
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  D.tab = b.dataset.t;
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.body').forEach((x) => (x.hidden = x.dataset.b !== D.tab));
  applyTab();
  if (D.tab === 'heat' && !D.heat) loadHeat();
  if (D.tab === 'stats' && !D.stats) loadStats();
};

/* ---------- 點亮鄉鎮 ---------- */
const date = (ms) => new Date(ms).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' });
async function loadTowns() {
  [D.geo, D.towns] = await Promise.all([api('/api/towns/geo'), api('/api/me/towns')]);
  map.getSource('towns')?.setData(townsData());
  const t = D.towns;
  $('#tLit').textContent = t.lit;
  $('#tOf').textContent = `/ ${t.total} 個鄉鎮市區（${Math.round((t.lit / t.total) * 100)}%）`;
  $('#tBar').style.width = `${(t.lit / t.total) * 100}%`;
  $('#sub').textContent = `已點亮 ${t.lit} 個鄉鎮`;
  $('#tRecent').innerHTML = t.recent.map((x) => `<div class="row2">${esc(x.county)}${esc(x.name)}<span>${date(x.ts)}</span></div>`).join('') || '<div class="note">還沒有</div>';
  $('#tCounties').innerHTML = t.counties.map((c) => `<div class="county" data-c="${esc(c.county)}"><span>${esc(c.county)}</span>
    <div class="bar"><i style="width:${(c.lit / c.total) * 100}%"></i></div><em class="num">${c.lit}/${c.total}</em></div>`).join('');
}
$('#tCounties').addEventListener('click', (e) => {
  const row = e.target.closest('[data-c]');
  if (!row || !D.geo) return;
  const fs = D.geo.features.filter((f) => f.properties.county === row.dataset.c);
  const b = new maplibregl.LngLatBounds();
  fs.forEach((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).forEach((poly) => poly[0].forEach((c) => b.extend(c))));
  if (!b.isEmpty()) map.fitBounds(b, { padding: pad(), duration: 800 });
});

/* ---------- 熱力圖 ---------- */
async function loadHeat() {
  D.heat = await api('/api/me/heat?limit=35000');
  map.getSource('heat')?.setData(heatData());
  const s = D.stats || (D.stats = await api('/api/me/stats'));
  $('#hPlaces').innerHTML = s.places.map((p, i) => `<div class="row2">${i + 1}. ${esc(p.county)}${esc(p.name)}<span>${p.points.toLocaleString()} 點</span></div>`).join('') || '<div class="note">還沒有資料</div>';
}

/* ---------- 統計 ---------- */
async function loadStats() {
  const s = D.stats || (D.stats = await api('/api/me/stats'));
  $('#sKm').textContent = Math.round(s.total_km).toLocaleString();
  $('#sDays').textContent = s.days;
  $('#sTrips').textContent = s.trips;
  const months = s.months.slice(-12), max = Math.max(1, ...months.map((m) => m.km));
  $('#sChart').innerHTML = months.map((m) => `<div title="${m.month.slice(0, 4)}/${m.month.slice(4)}：${Math.round(m.km)} km"><i style="height:${(m.km / max) * 100}%"></i><em>${+m.month.slice(4)}月</em></div>`).join('');
  const pace = await api('/api/me/pace');
  $('#sPace').innerHTML = pace.rows.length ? pace.rows.slice(0, 8).map((x) => `<div class="row2">${esc(x.name)}<span>${x.kmh} km/h · ${Math.round(x.km).toLocaleString()} km</span></div>`).join('')
    : '<div class="note">還沒算過（後端執行 tools.pace_profile）</div>';
}

loadTowns().then(() => {
  const b = new maplibregl.LngLatBounds([119.3, 21.85], [122.1, 25.35]);
  map.fitBounds(b, { padding: pad(), duration: 0 });
});

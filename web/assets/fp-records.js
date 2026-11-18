// 我的紀錄分頁：共用足跡頁的地圖，切換圖層時不重建地圖。
import { api, $, esc } from '/assets/common.js';
import { labelLayerId } from '/assets/mapbase.js';

export function initRecords(map, M, getTab, pad) {
  const D = { geo: null, towns: null, heat: null, stats: null, statsLoaded: false, heatLoaded: false };
  let heatTask = null, statsTask = null;
  const empty = { type: 'FeatureCollection', features: [] };
  const townsData = () => D.geo ? { ...D.geo, features: D.geo.features.map((f) => ({ ...f, properties: { ...f.properties, lit: new Set(D.towns?.ids || []).has(f.properties.id) } })) } : empty;
  const heatData = () => ({ type: 'FeatureCollection', features: (D.heat?.cells || []).map(([lon, lat, n]) => ({ type: 'Feature', properties: { n }, geometry: { type: 'Point', coordinates: [lon, lat] } })) });
  // 熱力圖細節：放大到 13 級以上時，用 GEOSEARCH BYBOX 取畫面內的原始足跡點（不是 160 m 的格子）
  let detail = [], detailBox = null, detailTimer = null, detailSeq = 0;
  const detailData = () => ({ type: 'FeatureCollection', features: detail.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })) });
  async function loadDetail() {
    if (getTab() !== 'heat' || map.getZoom() < 12.5) return;
    const b = map.getBounds();
    // 畫面還在上次抓的範圍內就不用再抓（上次多抓了一圈）
    if (detailBox && b.getWest() >= detailBox.w && b.getEast() <= detailBox.e && b.getSouth() >= detailBox.s && b.getNorth() <= detailBox.n) return;
    const dx = (b.getEast() - b.getWest()) * 0.5, dy = (b.getNorth() - b.getSouth()) * 0.5;
    const box = { w: b.getWest() - dx, e: b.getEast() + dx, s: b.getSouth() - dy, n: b.getNorth() + dy };
    const seq = ++detailSeq;
    try {
      const d = await api(`/api/me/heat/detail?west=${box.w}&south=${box.s}&east=${box.e}&north=${box.n}`);
      if (seq !== detailSeq || d.too_wide) return;
      detail = d.points; detailBox = d.capped ? null : box;
      map.getSource('heat-detail')?.setData(detailData());
    } catch { /* 下次移動再試 */ }
  }
  map.on('moveend', () => { clearTimeout(detailTimer); detailTimer = setTimeout(loadDetail, 250); });
  const show = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  function applyTab() {
    show('towns-fill', getTab() === 'towns'); show('towns-line', getTab() === 'towns'); show('heat', getTab() === 'heat'); show('heat-detail', getTab() === 'heat');
    if (getTab() === 'heat') loadDetail();
    if (getTab() === 'heat' && !D.heatLoaded && !heatTask) heatTask = loadHeat().catch(report).finally(() => { heatTask = null; });
    if (getTab() === 'stats' && !D.statsLoaded && !statsTask) statsTask = loadStats().catch(report).finally(() => { statsTask = null; });
  }
  function report(e) { $('#recordError').textContent = '讀取失敗：' + e.message; }
  M.onStyle(() => {
    const first = labelLayerId(map);  // 道路、高架、建築之上，地名之下
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
      // 放大到街道（13 級以上）改由 heat-detail 的原始點接手，格子版淡出
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0.9, 13.5, 0] } }, first);  // 熱力圖也放在地名、地標底下
    if (!map.getSource('heat-detail')) map.addSource('heat-detail', { type: 'geojson', data: detailData() });
    if (!map.getLayer('heat-detail')) map.addLayer({ id: 'heat-detail', type: 'heatmap', source: 'heat-detail', minzoom: 12.5, paint: {
      'heatmap-weight': 0.35,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 17, 1.6],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 13, 5, 15, 9, 18, 18],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(255,138,61,.35)', 0.4, '#ff8a3d', 0.7, '#ffd60a', 1, '#ffffff'],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, 0.9] } }, first);
    applyTab();
  });
  map.on('click', 'towns-fill', (e) => {
    if (getTab() !== 'towns') return;
    const p = e.features?.[0]?.properties;
    if (!p) return;
    new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat)
      .setHTML(`<b>${esc(p.county)}${esc(p.name)}</b><br>${p.lit ? '已點亮' : '還沒去過'}`).addTo(map);
  });
  const date = (ms) => new Date(ms).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' });
  async function loadTowns() {
    [D.geo, D.towns] = await Promise.all([api('/api/towns/geo'), api('/api/me/towns')]);
    map.getSource('towns')?.setData(townsData());
    const t = D.towns;
    $('#tLit').textContent = t.lit;
    $('#tOf').textContent = `/ ${t.total} 個鄉鎮市區（${Math.round((t.lit / t.total) * 100)}%）`;
    $('#tBar').style.width = `${(t.lit / t.total) * 100}%`;
    $('#tRecent').innerHTML = t.recent.map((x) => `<div class="row2">${esc(x.county)}${esc(x.name)}<span>${date(x.ts)}</span></div>`).join('') || '<div class="note">還沒有</div>';
    $('#tCounties').innerHTML = t.counties.map((c) => `<div class="county" data-c="${esc(c.county)}"><span>${esc(c.county)}</span><div class="bar"><i style="width:${(c.lit / c.total) * 100}%"></i></div><em class="num">${c.lit}/${c.total}</em></div>`).join('');
  }
  $('#tCounties').addEventListener('click', (e) => {
    const row = e.target.closest('[data-c]');
    if (!row || !D.geo) return;
    const fs = D.geo.features.filter((f) => f.properties.county === row.dataset.c);
    const b = new maplibregl.LngLatBounds();
    fs.forEach((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).forEach((poly) => poly[0].forEach((c) => b.extend(c))));
    if (!b.isEmpty()) map.fitBounds(b, { padding: pad(), duration: 800 });
  });
  async function statsData() { return D.stats || (D.stats = await api('/api/me/stats')); }
  async function loadHeat() {
    D.heat = await api('/api/me/heat?limit=35000');
    map.getSource('heat')?.setData(heatData());
    const s = await statsData();
    $('#hPlaces').innerHTML = s.places.map((p, i) => `<div class="row2">${i + 1}. ${esc(p.county)}${esc(p.name)}<span>${p.points.toLocaleString()} 點</span></div>`).join('') || '<div class="note">還沒有資料</div>';
    D.heatLoaded = true;
  }
  async function loadStats() {
    const s = await statsData();
    $('#sKm').textContent = Math.round(s.total_km).toLocaleString();
    $('#sDays').textContent = s.days;
    $('#sTrips').textContent = s.trips;
    const months = s.months.slice(-12), max = Math.max(1, ...months.map((m) => m.km));
    $('#sChart').innerHTML = months.map((m) => `<div title="${m.month.slice(0, 4)}/${m.month.slice(4)}：${Math.round(m.km)} km"><i style="height:${(m.km / max) * 100}%"></i><em>${+m.month.slice(4)}月</em></div>`).join('');
    const pace = await api('/api/me/pace');
    $('#sPace').innerHTML = pace.rows.length ? pace.rows.slice(0, 8).map((x) => `<div class="row2">${esc(x.name)}<span>${x.kmh} km/h · ${Math.round(x.km).toLocaleString()} km</span></div>`).join('') : '<div class="note">還沒算過（後端執行 tools.pace_profile）</div>';
    D.statsLoaded = true;
  }
  loadTowns().catch(report);
  applyTab();
  return { applyTab };
}

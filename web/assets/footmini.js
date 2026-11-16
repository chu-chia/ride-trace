// 足跡縮圖：把 /api/footprint/cells/all 的格子畫成一張發光的路線圖（首頁的招牌卡片用）
// cells 是攤平的 [緯度格, 經度格, …]，乘上 cellDeg 就是度數。

// 範圍：以中位數為中心，只取周圍 ±2.5° 緯度／±2° 經度內的格子（台灣本島＋離島）。
// 出國騎的格子（例如日本）不算進範圍，否則台灣會被縮成一個點。
function bounds(cells, cellDeg) {
  const la = [], lo = [];
  for (let i = 0; i < cells.length; i += 2) { la.push(cells[i] * cellDeg); lo.push(cells[i + 1] * cellDeg); }
  const med = (arr) => [...arr].sort((a, b) => a - b)[arr.length >> 1];
  const mLa = med(la), mLo = med(lo);
  const b = { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity };
  for (let i = 0; i < la.length; i++) {
    if (Math.abs(la[i] - mLa) > 2.5 || Math.abs(lo[i] - mLo) > 2) continue;
    b.s = Math.min(b.s, la[i]); b.n = Math.max(b.n, la[i]);
    b.w = Math.min(b.w, lo[i]); b.e = Math.max(b.e, lo[i]);
  }
  return b;
}

export function drawFootprint(canvas, cells, cellDeg, { color = '#ff9a52', pad = 18 } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H || !cells?.length) return;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const b = bounds(cells, cellDeg);
  const k = Math.cos(((b.n + b.s) / 2) * Math.PI / 180); // 經度在台灣緯度要乘 cos 才不會變胖
  const gw = (b.e - b.w) * k || 1, gh = (b.n - b.s) || 1;
  const scale = Math.min((W - pad * 2) / gw, (H - pad * 2) / gh);
  const ox = (W - gw * scale) / 2, oy = (H - gh * scale) / 2;
  const size = Math.max(1.3, cellDeg * scale * 1.6);

  // 疊加混色：常走的路會越疊越亮，像夜裡的大燈軌跡
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < cells.length; i += 2) {
    const lat = cells[i] * cellDeg, lon = cells[i + 1] * cellDeg;
    if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
    const x = ox + (lon - b.w) * k * scale, y = oy + (b.n - lat) * scale;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

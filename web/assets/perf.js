// 效能量測浮層：網址加 ?perf=1 開啟（同一個分頁換頁也會保留），?perf=0 關閉。
// 數字是在手機上自己算的，所以透過 iPhone 鏡像截圖，看到的就是手機真實的表現（鏡像串流卡不影響）。
// 顯示最近 5 秒：平均 fps、1% low（最慢 1% 的格換算成 fps）、最長一格、掉格比例、地圖每秒重畫次數，加一條每格間隔的折線圖。
// 點一下浮層換角落，長按 0.6 秒歸零重算。浮層本身每 250ms 才更新一次，盡量不干擾量測。

const WIN = 5000;          // 統計窗：最近 5 秒
const GRAPH_N = 240;       // 折線圖保留的格數
const frames = [];         // [時間, 間隔ms]
const mapHits = [];        // 地圖 render 事件的時間
let last = 0, worst = 0, t0 = performance.now(), hidden = false;

const LOW = document.documentElement.classList.contains('low-power');

// 每格 JS 花多久：包住 requestAnimationFrame，把同一格所有回呼（頁面迴圈＋MapLibre 畫圖）的執行時間加總。
// JS 很短、格卻很長 → 卡在 GPU（畫圖）；JS 很長 → 卡在主執行緒
const jsByFrame = new Map();   // 時間戳 → ms
const jsWin = [];              // [時間, ms]
const rawRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => rawRaf((ts) => {
  const a = performance.now();
  try { cb(ts); } finally { jsByFrame.set(ts, (jsByFrame.get(ts) || 0) + performance.now() - a); }
});
// 圖磚：每秒開始載入幾張（依來源）
const tileHits = [];           // [時間, 來源]

// ---------- A/B 開關（存在 localStorage，換頁、重開都保留） ----------
// nohs：關山影　nofollow：鏡頭不跟隨（地圖不動）　noel：跟隨時不取地形高度　notrail：戰情室不更新軌跡
// （11-22 也試過山影改用粗圖磚 z10／z9：fps 沒有改善，山影的負擔在逐像素計算，不在圖磚數量，所以拿掉了）
const FLAG_LIST = [['nohs', '關山影'], ['nofollow', '不跟隨'], ['noel', '不取高度'], ['notrail', '不更新軌跡']];
const flags = new Set();
try { for (const f of JSON.parse(localStorage.getItem('qiji:perf-flags') || '[]')) flags.add(f); } catch { /* 私密模式 */ }
window.__qijiPerfFlags = flags;
const maps = [];
function applyFlags() {
  for (const m of maps) {
    try {
      if (m.getLayer('hillshade')) m.setLayoutProperty('hillshade', 'visibility', flags.has('nohs') ? 'none' : 'visible');
    } catch { /* 樣式還沒好 */ }
  }
}
const RM = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- 浮層 ----------
const box = document.createElement('div');
box.id = 'qiji-perf';
box.innerHTML = '<pre></pre><canvas width="240" height="48"></canvas><div class="fl"></div>';
const css = document.createElement('style');
css.textContent = `#qiji-perf{position:fixed;z-index:2147483647;font:600 11px/1.35 ui-monospace,Menlo,monospace;color:#e8f0ff;background:rgba(8,12,20,.82);
border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:6px 8px;pointer-events:auto;user-select:none;-webkit-user-select:none;touch-action:manipulation}
#qiji-perf pre{margin:0 0 4px;font:inherit;white-space:pre;max-width:240px;overflow:hidden;text-overflow:ellipsis}
#qiji-perf canvas{display:block;width:240px;height:48px}
#qiji-perf .fl{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;max-width:240px}
#qiji-perf .fl button{font:600 11px/1 system-ui;color:#cfd8e6;background:#1e2633;border:1px solid #3a4558;border-radius:6px;padding:6px 7px}
#qiji-perf .fl button[aria-pressed="true"]{background:#b45309;border-color:#f59e0b;color:#fff}
#qiji-perf[data-pos="0"]{top:calc(env(safe-area-inset-top,0px) + 56px);left:calc(env(safe-area-inset-left,0px) + 8px)}
#qiji-perf[data-pos="1"]{top:calc(env(safe-area-inset-top,0px) + 56px);right:calc(env(safe-area-inset-right,0px) + 8px)}
#qiji-perf[data-pos="2"]{bottom:calc(env(safe-area-inset-bottom,0px) + 8px);right:calc(env(safe-area-inset-right,0px) + 8px)}
#qiji-perf[data-pos="3"]{bottom:calc(env(safe-area-inset-bottom,0px) + 8px);left:calc(env(safe-area-inset-left,0px) + 8px)}`;
let pos = 0;
try { pos = +sessionStorage.getItem('qiji:perf-pos') || 0; } catch { /* 私密模式 */ }
box.dataset.pos = pos;
const pre = box.querySelector('pre');
const cv = box.querySelector('canvas');
const g = cv.getContext('2d');
cv.width = 240 * devicePixelRatio; cv.height = 48 * devicePixelRatio;
g.scale(devicePixelRatio, devicePixelRatio);

function mount() { document.head.append(css); document.body.append(box); }
if (document.body) mount(); else addEventListener('DOMContentLoaded', mount, { once: true });

const fl = box.querySelector('.fl');
for (const [k, label] of FLAG_LIST) {
  const b = document.createElement('button');
  b.textContent = label; b.dataset.k = k; b.setAttribute('aria-pressed', String(flags.has(k)));
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('pointerup', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    flags.has(k) ? flags.delete(k) : flags.add(k);
    b.setAttribute('aria-pressed', String(flags.has(k)));
    try { localStorage.setItem('qiji:perf-flags', JSON.stringify([...flags])); } catch { /* 私密模式 */ }
    applyFlags(); reset();
  });
  fl.append(b);
}

// 點一下換角落；長按歸零
let pressT = 0, longFired = false;
box.addEventListener('pointerdown', (e) => {
  e.stopPropagation(); longFired = false;
  pressT = setTimeout(() => { longFired = true; reset(); }, 600);
});
box.addEventListener('pointerup', (e) => {
  e.stopPropagation(); clearTimeout(pressT);
  if (longFired) return;
  pos = (pos + 1) % 4; box.dataset.pos = pos;
  try { sessionStorage.setItem('qiji:perf-pos', pos); } catch { /* 私密模式 */ }
});
box.addEventListener('click', (e) => e.stopPropagation());

function reset() { frames.length = 0; mapHits.length = 0; tileHits.length = 0; jsWin.length = 0; worst = 0; t0 = performance.now(); last = 0; }

// 切到背景再回來的那一格會是好幾秒，不算
document.addEventListener('visibilitychange', () => { hidden = document.hidden; last = 0; });

// ---------- 量每一格 ----------
function loop(now) {
  if (last && !hidden) {
    const dt = now - last;
    frames.push([now, dt]);
    if (now - t0 > 1000 && dt > worst) worst = dt;   // 剛開頁第 1 秒在載入，不算進「史上最長」
  }
  last = now;
  while (frames.length && now - frames[0][0] > Math.max(WIN, 6000)) frames.shift();
  while (mapHits.length && now - mapHits[0] > WIN) mapHits.shift();
  while (tileHits.length && now - tileHits[0][0] > WIN) tileHits.shift();
  // 上一格以前的 JS 時間都已經結算
  for (const [ts, ms] of jsByFrame) { if (ts < now) { jsWin.push([ts, ms]); jsByFrame.delete(ts); } }
  while (jsWin.length && now - jsWin[0][0] > WIN) jsWin.shift();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 地圖每秒重畫幾次（rAF 是瀏覽器給的格數，地圖不一定每格都畫）
export function watchMap(map) {
  try {
    if (!map.on || maps.includes(map)) return;
    maps.push(map);
    map.on('render', () => mapHits.push(performance.now()));
    map.on('dataloading', (e) => { if (e.tile) tileHits.push([performance.now(), e.sourceId]); });
    map.on('styledata', applyFlags);
    applyFlags();
  } catch { /* 替身地圖 */ }
}
for (const m of window.__qijiMaps || []) watchMap(m);
window.__qijiPerfWatch = watchMap;

// ---------- 每 250ms 更新浮層 ----------
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
setInterval(() => {
  const now = performance.now();
  const win = frames.filter(([t]) => now - t <= WIN).map(([, d]) => d);
  if (win.length < 5) { pre.textContent = '量測中…'; return; }
  const sorted = [...win].sort((a, b) => a - b);
  const avg = win.reduce((s, d) => s + d, 0) / win.length;
  const med = pct(sorted, 0.5);
  const p99 = pct(sorted, 0.99);
  const jank = win.filter((d) => d > med * 1.5).length;       // 比平常慢一半以上的格 = 掉格
  const big = win.filter((d) => d > 50).length;               // 超過 50ms（肉眼明顯卡）
  const span = Math.min(WIN, now - t0) / 1000;
  const mapFps = mapHits.length / span;
  const hz = Math.round(1000 / med);
  const js = jsWin.map(([, d]) => d).sort((a, b) => a - b);
  const jsAvg = js.length ? js.reduce((a, b) => a + b, 0) / js.length : 0;
  const tiles = {};
  for (const [, src] of tileHits) tiles[src] = (tiles[src] || 0) + 1;
  const tileStr = Object.entries(tiles).map(([k, v]) => `${k.replace('openmaptiles', 'base')}${(v / span).toFixed(1)}`).join(' ') || '0';
  const clockStr = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  pre.textContent =
    `FPS ${(1000 / avg).toFixed(0).padStart(3)}  1%low ${(1000 / p99).toFixed(0).padStart(3)}  ${clockStr}\n` +
    `最長 ${p99.toFixed(0)}ms(5s) ${worst.toFixed(0)}ms(全)\n` +
    `掉格 ${(jank / win.length * 100).toFixed(1)}%  >50ms ${big}次\n` +
    `地圖重畫 ${mapFps.toFixed(0)}/s  螢幕≈${hz}Hz\n` +
    `JS ${jsAvg.toFixed(1)}ms/格 p95 ${js.length ? pct(js, 0.95).toFixed(0) : 0}ms\n` +
    `圖磚/s ${tileStr}\n` +
    `${LOW ? '省電' : '一般'} ${RM.matches ? '減少動態' : '動態正常'} dpr${maps[0]?.getPixelRatio?.() ?? devicePixelRatio}/${devicePixelRatio} ${innerWidth}×${innerHeight}`;
  draw();
}, 250);

// 折線圖：每格間隔，虛線是 16.7ms（60fps）和 33.3ms（30fps），超過 50ms 畫紅色
function draw() {
  const W = 240, H = 48, MAX = 66;
  const pts = frames.slice(-GRAPH_N);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.setLineDash([3, 3]); g.lineWidth = 1;
  for (const ms of [16.7, 33.3]) { const y = H - (ms / MAX) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.setLineDash([]);
  const step = W / GRAPH_N;
  pts.forEach(([, d], i) => {
    const h = Math.min(H, (d / MAX) * H);
    g.fillStyle = d > 50 ? '#ff4d4f' : d > 25 ? '#ffb020' : '#4ade80';
    g.fillRect(i * step, H - h, Math.max(1, step - 0.3), h);
  });
}

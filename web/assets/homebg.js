// 首頁背景（頭像選單「首頁背景」切換，記在這台瀏覽器）。全部畫在同一張 canvas 上，只是背景：
//   sky     天色：依台灣時間的天空（清晨、白天、傍晚、深夜＋星星），只在頁首
//   mosaic  日子馬賽克：整頁鋪滿很淡的方格，一格一天，越亮騎越遠
//   dash    儀表板夜光：頁首後面一個很大的半圓刻度環，琥珀色指針指本月里程
//   streaks 速度流線：幾道細細的琥珀光軌斜斜劃過，像夜騎時路燈拉出的光
//   route   路線剪影：自己最長的一段連續騎乘，放大成很淡的一條線
import { $ } from '/assets/common.js';

export const BGS = { sky: '天色', mosaic: '日子馬賽克', dash: '儀表板夜光', streaks: '速度流線', route: '路線剪影' };
const KEY = 'qiji.homeBg';
export function getBg() { try { const v = localStorage.getItem(KEY); return BGS[v] ? v : 'sky'; } catch { return 'sky'; } }
export function setBg(v) { try { localStorage.setItem(KEY, v); } catch { /* 存不了就只對這次有效 */ } }

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const pad2 = (n) => String(n).padStart(2, '0');
const tw = (ms = Date.now()) => new Date(ms + (new Date(ms).getTimezoneOffset() + 480) * 60000); // 台灣時間
const key = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
// 頁首型（只佔上面一截、往下淡出）與整頁型
const TOP = new Set(['sky', 'dash']);

let cur = null, stop = null, data = { summary: null };
export function setData(d) { data = { ...data, ...d }; if (cur && cur !== 'sky' && cur !== 'streaks') renderBg(cur); }

export function renderBg(kind) {
  stop?.(); stop = null;
  cur = kind;
  document.body.dataset.bg = kind;
  const box = $('#bg'), cv = $('#bgc');
  box.className = 'bg ' + (TOP.has(kind) ? 'top' : 'full') + ' bg-' + kind;
  $('#bgcap').textContent = '';
  const setup = () => {
    const dpr = Math.min(2, devicePixelRatio || 1), W = box.clientWidth, H = box.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    return { g, W, H, dark: darkMq.matches };
  };
  const draw = { sky, mosaic, dash, streaks, route }[kind];
  let inner = draw(setup);
  const redo = () => { clearTimeout(redo.t); redo.t = setTimeout(() => { inner?.(); inner = draw(setup); }, 150); };
  addEventListener('resize', redo);
  darkMq.addEventListener('change', redo);
  stop = () => { inner?.(); removeEventListener('resize', redo); darkMq.removeEventListener('change', redo); };
}

/* ---------- 共用：每天里程 ---------- */
function dayList() {
  const days = data.summary?.days || {};
  const out = [], today = tw();
  const first = data.summary?.first_ts ? tw(data.summary.first_ts) : new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  for (const d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d <= today; d.setDate(d.getDate() + 1)) out.push(days[key(d)] || 0);
  return out;
}

/* ---------- A. 天色 ---------- */
const PHASES = {
  dawn: { top: '#0b1a3f', mid: '#47407a', low: '#f2925a', glow: 'rgba(255,170,90,.55)', stars: 0.35 },
  day: { top: '#1f5fbf', mid: '#4c93e6', low: '#a9d3f7', glow: 'rgba(255,250,220,.45)', stars: 0 },
  dusk: { top: '#211a4d', mid: '#8a3f73', low: '#f08a55', glow: 'rgba(255,140,80,.55)', stars: 0.2 },
  night: { top: '#02050d', mid: '#08122d', low: '#16244d', glow: 'rgba(170,190,255,.18)', stars: 1 },
};
const phaseOf = (h) => (h >= 4 && h < 7 ? 'dawn' : h >= 7 && h < 16 ? 'day' : h >= 16 && h < 19 ? 'dusk' : 'night');
function sky(setup) {
  const { g, W, H } = setup();
  const p = PHASES[phaseOf(tw().getHours())];
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, p.top); bg.addColorStop(0.55, p.mid); bg.addColorStop(1, p.low);
  const glow = g.createRadialGradient(W * 0.78, H, 0, W * 0.78, H, Math.max(W, H) * 0.6);
  glow.addColorStop(0, p.glow); glow.addColorStop(1, 'rgba(0,0,0,0)');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const stars = Array.from({ length: Math.round((W * H) / 2600) }, () => ({ x: rnd() * W, y: rnd() * H * 0.75, r: 0.4 + rnd() * 1.1, ph: rnd() * 6.28, sp: 0.6 + rnd() * 1.6 }));
  let raf = 0;
  const frame = (t) => {
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    if (p.stars) {
      g.fillStyle = '#fff';
      for (const s of stars) {
        g.globalAlpha = p.stars * (reduce ? 0.8 : 0.55 + 0.45 * Math.sin((t / 1000) * s.sp + s.ph)) * (1 - s.y / (H * 0.9));
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.29); g.fill();
      }
      g.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(frame);
    }
  };
  raf = requestAnimationFrame(frame);
  const tick = setInterval(() => renderBg('sky'), 5 * 60 * 1000); // 開著不關也會跟著時段變
  return () => { cancelAnimationFrame(raf); clearInterval(tick); };
}

/* ---------- B. 日子馬賽克 ---------- */
function mosaic(setup) {
  const { g, W, H, dark } = setup();
  const list = dayList();
  const kms = list.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => kms[Math.floor((kms.length - 1) * p)] || 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const lvl = (km) => (!km ? 0 : km <= cuts[0] ? 1 : km <= cuts[1] ? 2 : km <= cuts[2] ? 3 : 4);
  const alpha = dark ? [0.025, 0.045, 0.07, 0.1, 0.15] : [0.03, 0.05, 0.075, 0.11, 0.16];
  const color = dark ? '255,138,61' : '194,65,12';
  const size = W < 500 ? 16 : 20, gap = 6;
  const cols = Math.ceil(W / (size + gap)), rows = Math.ceil(H / (size + gap));
  // 最新的一天在左上角，往右、往下越來越早；天數不夠鋪滿就重複
  const n = cols * rows;
  for (let i = 0; i < n; i++) {
    const km = list.length ? list[list.length - 1 - (i % list.length)] : 0;
    const x = (i % cols) * (size + gap), y = Math.floor(i / cols) * (size + gap);
    g.fillStyle = `rgba(${color},${alpha[lvl(km)]})`;
    g.beginPath(); g.roundRect(x, y, size, size, 4); g.fill();
  }
  if (list.length) $('#bgcap').textContent = `每一格是一天，越亮騎越遠 · 最近 ${list.length} 天`;
  return null;
}

/* ---------- C. 儀表板夜光 ---------- */
function dash(setup) {
  const days = data.summary?.days || {};
  const now = tw(), ym = `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;
  const byMonth = {};
  let monthKm = 0;
  for (const [k, km] of Object.entries(days)) { byMonth[k.slice(0, 6)] = (byMonth[k.slice(0, 6)] || 0) + km; if (k.startsWith(ym)) monthKm += km; }
  const best = Math.max(0, ...Object.values(byMonth));
  const step = best > 3000 ? 500 : best > 1200 ? 250 : 100;
  const max = Math.max(step * 5, Math.ceil((Math.max(best, monthKm) * 1.1) / step) * step);
  let raf = 0; const t0 = performance.now();
  const paint = (k) => {
    const { g, W, H } = setup();
    // 底：儀表板的深色＋中間一圈暖光
    const bg = g.createRadialGradient(W / 2, H * 1.15, 0, W / 2, H * 1.15, Math.max(W, H));
    bg.addColorStop(0, '#2a1a10'); bg.addColorStop(0.45, '#10141b'); bg.addColorStop(1, '#05070a');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // 很大的半圓：圓心在頁首下方，只露出上半截弧
    // 整個半圓都要在頁首裡：半徑受寬、高兩邊限制
    const cx = W / 2, cy = H * 1.02, R = Math.min(W * 0.46, H * 0.95);
    const ang = (v) => Math.PI + (Math.min(v, max) / max) * Math.PI; // 左（0）→右（max）
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 18;
    g.beginPath(); g.arc(cx, cy, R, Math.PI, 2 * Math.PI); g.stroke();
    // 已騎的弧：琥珀發光
    const a1 = Math.PI + (ang(monthKm) - Math.PI) * k;
    g.shadowColor = 'rgba(255,138,61,.9)'; g.shadowBlur = 24;
    g.strokeStyle = 'rgba(255,138,61,.75)'; g.lineWidth = 6;
    g.beginPath(); g.arc(cx, cy, R, Math.PI, a1); g.stroke();
    g.shadowBlur = 0;
    // 刻度與數字
    const minor = max / 50;
    g.font = '600 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif'; g.textAlign = 'center';
    for (let v = 0; v <= max + 0.1; v += minor) {
      const major = Math.round(v / minor) % 5 === 0, a = ang(v);
      const r1 = R - (major ? 34 : 24), r2 = R - 12;
      g.strokeStyle = v > best ? 'rgba(255,69,58,.45)' : major ? 'rgba(255,255,255,.32)' : 'rgba(255,255,255,.14)';
      g.lineWidth = major ? 2.2 : 1.2;
      g.beginPath(); g.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a)); g.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a)); g.stroke();
      if (major && Math.round(v / minor) % 10 === 0) {
        g.fillStyle = 'rgba(255,255,255,.28)';
        g.fillText(v >= 1000 ? `${v / 1000}k` : String(v), cx + (R - 56) * Math.cos(a), cy + (R - 56) * Math.sin(a) + 4);
      }
    }
    // 指針：一道光
    const an = a1, len = R - 40;
    const grad = g.createLinearGradient(cx, cy, cx + len * Math.cos(an), cy + len * Math.sin(an));
    grad.addColorStop(0, 'rgba(255,138,61,0)'); grad.addColorStop(0.6, 'rgba(255,138,61,.35)'); grad.addColorStop(1, 'rgba(255,190,140,.95)');
    g.strokeStyle = grad; g.lineWidth = 4; g.shadowColor = 'rgba(255,138,61,.9)'; g.shadowBlur = 16;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + len * Math.cos(an), cy + len * Math.sin(an)); g.stroke();
    g.shadowBlur = 0;
  };
  if (reduce || !data.summary) paint(1);
  else {
    const step2 = (t) => { const k = Math.min(1, (t - t0) / 1600); paint(1 - (1 - k) ** 3); if (k < 1) raf = requestAnimationFrame(step2); };
    raf = requestAnimationFrame(step2);
  }
  if (data.summary) $('#bgcap').textContent = `${now.getMonth() + 1} 月已騎 ${Math.round(monthKm).toLocaleString()} km · 紅色刻度是超過最佳月份`;
  return () => cancelAnimationFrame(raf);
}

/* ---------- D. 速度流線 ---------- */
function streaks(setup) {
  const { g, W, H, dark } = setup();
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ang = (-14 * Math.PI) / 180, dx = Math.cos(ang), dy = Math.sin(ang);
  const diag = Math.hypot(W, H);
  const narrow = W < 500;
  const lines = Array.from({ length: narrow ? 14 : 16 }, () => ({
    off: (rnd() - 0.5) * diag * (narrow ? 0.8 : 1.1), // 跟行進方向垂直的位移
    pos: rnd() * diag * 1.6,                    // 沿著方向的位置
    len: 160 + rnd() * 420, w: 0.8 + rnd() * 1.8, sp: 40 + rnd() * 110,
    a: (dark ? 0.25 : 0.18) + (narrow ? 0.12 : 0) + rnd() * (dark ? 0.35 : 0.22), warm: rnd() < 0.8,
  }));
  let raf = 0, last = performance.now();
  const frame = (t) => {
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    g.clearRect(0, 0, W, H);
    for (const l of lines) {
      if (!reduce && !document.hidden) { l.pos += l.sp * dt; if (l.pos > diag * 1.6) l.pos = -l.len; }
      // 從畫面左下角外面往右上走，垂直方向再偏移
      const ox = -diag * 0.3 + l.pos * dx - l.off * dy, oy = H * 0.85 + l.pos * dy + l.off * dx;
      const ex = ox + l.len * dx, ey = oy + l.len * dy;
      const c = l.warm ? (dark ? '255,154,82' : '194,65,12') : (dark ? '160,190,255' : '60,90,160');
      const gr = g.createLinearGradient(ox, oy, ex, ey);
      gr.addColorStop(0, `rgba(${c},0)`); gr.addColorStop(0.7, `rgba(${c},${l.a})`); gr.addColorStop(1, `rgba(${c},0)`);
      g.strokeStyle = gr; g.lineWidth = l.w; g.lineCap = 'round';
      g.beginPath(); g.moveTo(ox, oy); g.lineTo(ex, ey); g.stroke();
    }
    if (!reduce) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/* ---------- E. 路線剪影 ---------- */
let longest = null, longestReq = null;
function loadLongest() {
  if (longestReq || !data.summary?.points) return longestReq;
  const day = (ms) => { const d = tw(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  longestReq = fetch(`/api/footprint/lines?from=${day(data.summary.first_ts)}&to=${day(data.summary.last_ts)}&buckets=dawn,day,dusk,night`, { credentials: 'same-origin' })
    .then((r) => r.json()).then((f) => {
      // 一段 = 一次沒中斷的連續騎乘；挑最長的那段
      let best = null, bestKm = 0;
      for (const seg of f.geometry?.coordinates || []) {
        let km = 0;
        for (let i = 1; i < seg.length; i++) km += Math.hypot((seg[i][0] - seg[i - 1][0]) * Math.cos((seg[i][1] * Math.PI) / 180), seg[i][1] - seg[i - 1][1]) * 111.2;
        if (km > bestKm) { bestKm = km; best = seg; }
      }
      longest = best && { seg: best, km: bestKm };
      if (cur === 'route') renderBg('route');
    }).catch(() => {});
  return longestReq;
}
function route(setup) {
  const { g, W, H, dark } = setup();
  if (!longest) { loadLongest(); return null; }
  const { seg, km } = longest;
  let w = 180, e = -180, s = 90, n = -90;
  for (const [x, y] of seg) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const k = Math.cos((((n + s) / 2) * Math.PI) / 180);
  // 寬螢幕：畫在內容欄（640px）右邊的空白處，不要整條躲在卡片後面；窄螢幕就用整個畫面
  const side = W / 2 + 340, bx0 = W - side > 260 ? side : 0, bw = W - bx0;
  const pad = Math.min(bw, H) * 0.08;
  const sc = Math.min((bw - pad * 2) / ((e - w) * k || 1e-6), (H - pad * 2) / ((n - s) || 1e-6));
  const ox = bx0 + (bw - (e - w) * k * sc) / 2, oy = (H - (n - s) * sc) / 2;
  const P = ([x, y]) => [ox + (x - w) * k * sc, oy + (n - y) * sc];
  const path = () => { g.beginPath(); seg.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
  const c = dark ? '255,154,82' : '194,65,12';
  g.lineJoin = 'round'; g.lineCap = 'round';
  path(); g.strokeStyle = `rgba(${c},${dark ? 0.1 : 0.08})`; g.lineWidth = 14; g.stroke();   // 光暈
  path(); g.strokeStyle = `rgba(${c},${dark ? 0.32 : 0.26})`; g.lineWidth = 2.2; g.stroke(); // 線
  // 起點、終點
  for (const [p, r] of [[seg[0], 5], [seg[seg.length - 1], 7]]) {
    const [x, y] = P(p);
    g.fillStyle = `rgba(${c},${dark ? 0.45 : 0.35})`; g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
  }
  $('#bgcap').textContent = `你最長的一段連續騎乘 · 約 ${Math.round(km).toLocaleString()} km`;
  return null;
}

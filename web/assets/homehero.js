// 首頁頂部三種樣式（設定裡切換，記在這台瀏覽器）：
//   sky   天色：背景是依時段變化的天空（清晨、白天、傍晚、深夜＋星星）
//   year  年度紀錄：最近一年每天騎多少的格子圖
//   gauge 儀表：機車儀表板，指針指本月里程，下面一排里程表數字
// 資料都來自 /api/footprint/summary 的 days（{YYYYMMDD: km}）。
import { $, esc } from '/assets/common.js';

export const HEROES = { sky: '天色', year: '年度紀錄', gauge: '儀表' };
const KEY = 'qiji.homeHero';
export function getHero() {
  try { const v = localStorage.getItem(KEY); return HEROES[v] ? v : 'sky'; } catch { return 'sky'; }
}
export function setHero(v) { try { localStorage.setItem(KEY, v); } catch { /* 無痕模式存不了就算了 */ } }

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad2 = (n) => String(n).padStart(2, '0');
// 台灣時間
const tw = (ms = Date.now()) => new Date(ms + (new Date(ms).getTimezoneOffset() + 480) * 60000);
const key = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const fmt = (n) => Math.round(n).toLocaleString();

let stop = null; // 換樣式時把上一個的動畫停掉
export function renderHero(kind, summary) {
  stop?.(); stop = null;
  document.body.dataset.hero = kind;
  $('#sky').hidden = kind !== 'sky';
  const box = $('#hero');
  box.hidden = kind === 'sky';
  box.innerHTML = '';
  if (kind === 'sky') stop = sky();
  else if (kind === 'year') year(box, summary);
  else stop = gauge(box, summary);
}

/* ---------------- 1. 天色 ---------------- */
// 每個時段：天頂、中段、地平線三個顏色，以及太陽／月亮的光暈
const PHASES = {
  dawn: { top: '#0b1a3f', mid: '#47407a', low: '#f2925a', glow: 'rgba(255,170,90,.55)', stars: 0.35, label: '清晨' },
  day: { top: '#1f5fbf', mid: '#4c93e6', low: '#a9d3f7', glow: 'rgba(255,250,220,.45)', stars: 0, label: '白天' },
  dusk: { top: '#211a4d', mid: '#8a3f73', low: '#f08a55', glow: 'rgba(255,140,80,.55)', stars: 0.2, label: '傍晚' },
  night: { top: '#02050d', mid: '#08122d', low: '#16244d', glow: 'rgba(170,190,255,.18)', stars: 1, label: '深夜' },
};
const phaseOf = (h) => (h >= 4 && h < 7 ? 'dawn' : h >= 7 && h < 16 ? 'day' : h >= 16 && h < 19 ? 'dusk' : 'night');

function sky() {
  const el = $('#sky'), cv = $('#stars');
  let raf = 0;
  const paint = () => {
    const p = PHASES[phaseOf(tw().getHours())];
    el.style.setProperty('--sky-top', p.top);
    el.style.setProperty('--sky-mid', p.mid);
    el.style.setProperty('--sky-low', p.low);
    el.style.setProperty('--sky-glow', p.glow);
    el.dataset.phase = phaseOf(tw().getHours());
    // 星星：位置用固定亂數種子，每次打開都一樣；亮度慢慢閃
    const dpr = Math.min(2, devicePixelRatio || 1), W = el.clientWidth, H = el.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const stars = Array.from({ length: Math.round((W * H) / 2600) }, () => ({ x: rnd() * W, y: rnd() * H * 0.75, r: 0.4 + rnd() * 1.1, ph: rnd() * 6.28, sp: 0.6 + rnd() * 1.6 }));
    cancelAnimationFrame(raf);
    const frame = (t) => {
      g.clearRect(0, 0, W, H);
      if (p.stars) {
        for (const s of stars) {
          const tw2 = reduce ? 0.8 : 0.55 + 0.45 * Math.sin(t / 1000 * s.sp + s.ph);
          g.globalAlpha = p.stars * tw2 * (1 - s.y / (H * 0.9));
          g.fillStyle = '#fff';
          g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.29); g.fill();
        }
      }
      if (!reduce && p.stars) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };
  paint();
  const onResize = () => { clearTimeout(onResize.t); onResize.t = setTimeout(paint, 150); };
  addEventListener('resize', onResize);
  const tick = setInterval(paint, 5 * 60 * 1000); // 開著不關也會跟著天色變
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); clearInterval(tick); };
}

/* ---------------- 2. 年度紀錄 ---------------- */
function year(box, s) {
  const days = s?.days || {};
  const today = tw();
  const W = box.clientWidth || 600;
  const gap = 3;
  // 盡量放滿 53 週；太窄（手機）就格子最小 9px，週數減少
  let cell = Math.floor((W - 34 + gap) / 53) - gap, weeks = 53;
  if (cell < 9) { cell = 9; weeks = Math.floor((W - 34 + gap) / (cell + gap)); }
  // 最右一欄是本週；從 weeks 週前的星期日開始
  const start = new Date(today); start.setDate(start.getDate() - start.getDay() - (weeks - 1) * 7);
  const kms = Object.values(days).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => kms[Math.floor((kms.length - 1) * p)] || 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (km) => (!km ? 0 : km <= cuts[0] ? 1 : km <= cuts[1] ? 2 : km <= cuts[2] ? 3 : 4);

  let rects = '', months = '', lastM = -1, total = 0, rideDays = 0, best = 0, bestDay = '', streak = 0, maxStreak = 0;
  for (let w = 0; w < weeks; w++) {
    for (let dd = 0; dd < 7; dd++) {
      const d = new Date(start); d.setDate(start.getDate() + w * 7 + dd);
      if (d > today) continue;
      const km = days[key(d)] || 0;
      total += km;
      if (km > 0) { rideDays++; streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
      if (km > best) { best = km; bestDay = `${d.getMonth() + 1}/${d.getDate()}`; }
      const x = 34 + w * (cell + gap), y = 18 + dd * (cell + gap);
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" class="l${level(km)}"><title>${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} · ${km ? km.toFixed(1) + ' km' : '沒騎'}</title></rect>`;
      if (dd === 0 && d.getMonth() !== lastM && d.getDate() <= 7) { lastM = d.getMonth(); months += `<text x="${x}" y="11">${d.getMonth() + 1}月</text>`; }
    }
  }
  const h = 18 + 7 * (cell + gap);
  const wk = ['', '一', '', '三', '', '五', ''].map((t, i) => (t ? `<text x="0" y="${18 + i * (cell + gap) + cell - 1}">${t}</text>` : '')).join('');
  box.className = 'hero-year card';
  box.innerHTML = `
    <div class="hy-head"><div><div class="eyebrow">最近 ${weeks} 週</div><b>每天騎了多少</b></div>
      <div class="hy-legend" aria-hidden="true">少<i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>多</div></div>
    <svg viewBox="0 0 ${34 + weeks * (cell + gap)} ${h}" role="img" aria-label="最近 ${weeks} 週每日里程：騎了 ${rideDays} 天，共 ${fmt(total)} 公里">${months}${wk}${rects}</svg>
    <div class="hy-stats">
      <div><strong class="num">${rideDays}</strong><span>天有騎</span></div>
      <div><strong class="num">${fmt(total)}</strong><span>km</span></div>
      <div><strong class="num">${maxStreak}</strong><span>天最長連續</span></div>
      <div><strong class="num">${fmt(best)}</strong><span>km 最多一天${bestDay ? `（${esc(bestDay)}）` : ''}</span></div>
    </div>`;
}

/* ---------------- 5. 儀表 ---------------- */
function gauge(box, s) {
  const days = s?.days || {};
  const now = tw();
  const ym = `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pym = `${prev.getFullYear()}${pad2(prev.getMonth() + 1)}`;
  const byMonth = {};
  let monthKm = 0, prevKm = 0, monthDays = 0, monthBest = 0, total = 0;
  for (const [k, km] of Object.entries(days)) {
    const m = k.slice(0, 6);
    byMonth[m] = (byMonth[m] || 0) + km;
    total += km;
    if (m === ym) { monthKm += km; if (km > 0) monthDays++; monthBest = Math.max(monthBest, km); }
    if (m === pym) prevKm += km;
  }
  const bestMonth = Math.max(0, ...Object.values(byMonth));
  // 錶面上限：最佳月份再多一點，取整到好讀的刻度
  const step = bestMonth > 3000 ? 500 : bestMonth > 1200 ? 250 : 100;
  const max = Math.max(step * 5, Math.ceil((Math.max(bestMonth, monthKm) * 1.1) / step) * step);
  const ang = (v) => -120 + (Math.min(v, max) / max) * 240; // -120°～+120°
  const pt = (a, r) => [150 + r * Math.sin((a * Math.PI) / 180), 150 - r * Math.cos((a * Math.PI) / 180)];
  let ticks = '';
  const majors = max / step <= 10 ? step : step * 2;
  for (let v = 0; v <= max + 0.1; v += majors / 5) {
    const major = Math.abs(v / majors - Math.round(v / majors)) < 1e-6;
    const [x1, y1] = pt(ang(v), major ? 112 : 118), [x2, y2] = pt(ang(v), 126);
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${major ? 'mj' : 'mn'}"/>`;
    if (major) { const [tx, ty] = pt(ang(v), 98); ticks += `<text x="${tx}" y="${ty + 4}">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : v}</text>`; }
  }
  // 紅區：超過歷史最佳月份
  const arc = (a1, a2, r) => { const [x1, y1] = pt(a1, r), [x2, y2] = pt(a2, r); return `M${x1} ${y1} A${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2} ${y2}`; };
  const diff = prevKm ? Math.round(((monthKm - prevKm) / prevKm) * 100) : null;
  const odo = String(Math.round(total)).padStart(6, '0');
  box.className = 'hero-gauge';
  box.innerHTML = `
    <svg class="dial" viewBox="0 0 300 226" role="img" aria-label="本月里程 ${fmt(monthKm)} 公里，歷史最佳月份 ${fmt(bestMonth)} 公里">
      <path d="${arc(-120, 120, 126)}" class="track"/>
      <path d="${arc(-120, ang(monthKm), 126)}" class="fill" id="gFill"/>
      <path d="${arc(ang(bestMonth), 120, 126)}" class="red"/>
      ${ticks}
      <g id="needle" style="transform:rotate(-120deg)"><line x1="150" y1="150" x2="150" y2="44" class="needle"/><circle cx="150" cy="150" r="9" class="hub"/></g>
      <text x="150" y="196" class="unit">km／月</text>
    </svg>
    <div class="g-side">
      <div class="eyebrow">${now.getMonth() + 1} 月里程</div>
      <div class="g-big"><strong class="num" id="gRead">${fmt(monthKm)}</strong> km</div>
      <div class="g-rows">
        <div><span>騎乘天數</span><b class="num">${monthDays} 天</b></div>
        <div><span>本月最遠一天</span><b class="num">${fmt(monthBest)} km</b></div>
        <div><span>跟上個月比</span><b class="num">${diff == null ? '–' : (diff >= 0 ? '+' : '') + diff + '%'}</b></div>
        <div><span>最佳月份</span><b class="num">${fmt(bestMonth)} km</b></div>
      </div>
      <div class="odo" aria-label="總里程 ${fmt(total)} 公里"><span>ODO</span>${[...odo].map((c) => `<i>${c}</i>`).join('')}<span>km</span></div>
    </div>`;
  // 指針從 0 掃到本月里程（開機自檢的感覺）；減少動態效果時直接到位
  const target = ang(monthKm), needle = $('#needle'), read = $('#gRead');
  if (reduce) { needle.style.transform = `rotate(${target}deg)`; read.textContent = fmt(monthKm); return null; }
  let raf = 0; const t0 = performance.now();
  const step2 = (t) => {
    const k = Math.min(1, (t - t0) / 1400), e = 1 - (1 - k) ** 3;
    needle.style.transform = `rotate(${-120 + (target + 120) * e}deg)`;
    read.textContent = fmt(monthKm * e);
    if (k < 1) raf = requestAnimationFrame(step2);
  };
  raf = requestAnimationFrame(step2);
  return () => cancelAnimationFrame(raf);
}

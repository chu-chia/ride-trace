// 首頁背景：重機爆炸圖（琥珀發光線稿）。
// 一台通用街車拆成十幾個零件，每 16 秒一輪：組合 → 慢慢拆開（拉出虛線引線、標上自己的騎乘數字）
// → 拆開時各自運作（輪子、碟盤轉，活塞上下，鏈條跑，頭燈亮）→ 再組回去。
// 全部用 CSS 動畫（transform／opacity），只在分頁可見時跑；減少動態效果時停在拆開的樣子。
//
// 座標系：viewBox 1600×900，整台車組合時在正中間（後輪 520,600、前輪 1080,600）。
// 桌機內容欄寬 640px，約佔中間 x 444～1156，零件拆開後落在左右兩側空白。

const pad2 = (n) => String(n).padStart(2, '0');
const tw = (ms = Date.now()) => new Date(ms + (new Date(ms).getTimezoneOffset() + 480) * 60000); // 台灣時間
const fmt = (n) => Math.round(n).toLocaleString();

/* ---------- 零件線稿（都畫在組合位置） ---------- */
function wheel(cx, cy) {
  let spokes = '';
  for (let i = 0; i < 5; i++) {
    const a = (i * 72 * Math.PI) / 180;
    for (const d of [-0.1, 0.1]) {
      spokes += `<line x1="${cx + 16 * Math.cos(a)}" y1="${cy + 16 * Math.sin(a)}" x2="${cx + 96 * Math.cos(a + d)}" y2="${cy + 96 * Math.sin(a + d)}"/>`;
    }
  }
  return `<circle cx="${cx}" cy="${cy}" r="115" class="thick"/>
    <g class="spin">${spokes}<circle cx="${cx}" cy="${cy}" r="98"/><circle cx="${cx}" cy="${cy}" r="14"/>
      <line x1="${cx}" y1="${cy - 115}" x2="${cx}" y2="${cy - 104}" class="thick"/></g>`;
}
function disc(cx, cy) {
  let holes = '', bolts = '';
  for (let i = 0; i < 12; i++) { const a = (i * 30 * Math.PI) / 180; holes += `<circle cx="${cx + 46 * Math.cos(a)}" cy="${cy + 46 * Math.sin(a)}" r="3.5"/>`; }
  for (let i = 0; i < 5; i++) { const a = (i * 72 * Math.PI) / 180; bolts += `<circle cx="${cx + 22 * Math.cos(a)}" cy="${cy + 22 * Math.sin(a)}" r="2.5"/>`; }
  const arc = (r, a1, a2) => { const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)]; const [x1, y1] = p(a1), [x2, y2] = p(a2); return `M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`; };
  return `<g class="spin"><circle cx="${cx}" cy="${cy}" r="62"/><circle cx="${cx}" cy="${cy}" r="30"/>${holes}${bolts}</g>
    <path d="${arc(70, -70, -20)} ${arc(52, -20, -70).replace('M', 'L')} Z" class="thick"/>`;
}

// id、組合中心、拆開後的中心、拆開時的轉角、內容、標籤位置（相對組合中心）
const PARTS = [
  { id: 'frame', a: [800, 430], e: [800, 430], r: 0, s: 1, svg: `
      <path d="M1000 292 L1016 338"/><path d="M1008 312 L900 332 L770 352 L760 520 L880 456 L1012 330" />
      <path d="M900 332 L880 456 M840 342 L880 456 M840 342 L820 488 M770 352 L820 488"/>
      <path d="M770 352 L570 362 L600 432 L760 476"/><path d="M640 360 L620 418"/>
      <path d="M760 520 L520 600 M760 532 L528 612" class="thick"/>` },
  { id: 'rearW', a: [520, 600], e: [240, 560], r: -8, s: .8, label: ['後輪', 'days'], lb: 'hub', svg: wheel(520, 600) },
  { id: 'frontW', a: [1080, 600], e: [1330, 460], r: 8, s: .8, label: ['前輪', 'total'], lb: 'hub', svg: wheel(1080, 600) },
  { id: 'disc', a: [1080, 600], e: [1520, 760], r: 0, s: .8, label: ['碟盤', 'best'], lb: [1590, 850, 'end'], svg: disc(1080, 600) },
  { id: 'fork', a: [1040, 450], e: [1555, 470], r: -10, s: .8, svg: `
      <path d="M992 300 L1074 600 M1008 300 L1090 600" class="thick"/>
      <path d="M1040 470 L1074 600 M1056 470 L1090 600" class="fat"/>
      <path d="M972 300 L1034 300 M984 338 L1046 338"/><circle cx="1082" cy="600" r="9"/>` },
  { id: 'bar', a: [968, 262], e: [1330, 90], r: 10, s: 1, svg: `
      <path d="M1004 292 L962 274 L928 270" class="thick"/><path d="M928 264 L908 262 L908 276 L928 278" />
      <path d="M990 286 L978 226"/><ellipse cx="972" cy="216" rx="18" ry="10"/>` },
  { id: 'light', a: [1050, 330], e: [1480, 210], r: 0, s: 1, label: ['頭燈', 'points'], lb: [1190, 215, 'start'], svg: `
      <path d="M1022 296 C1062 288 1082 320 1074 352 C1066 372 1040 376 1028 362 Z"/>
      <ellipse cx="1060" cy="330" rx="10" ry="18" class="thick"/>
      <path d="M1072 316 L1180 286 M1074 330 L1190 330 M1072 344 L1180 374" class="beam"/>` },
  { id: 'tank', a: [890, 310], e: [250, 300], r: -5, s: .9, label: ['油箱', 'streak'], lb: [60, 375, 'start'], svg: `
      <path d="M800 334 C818 282 900 262 976 288 L988 328 C940 344 860 350 800 342 Z" class="thick"/>
      <circle cx="905" cy="282" r="8"/><path d="M830 320 C880 300 930 298 972 306"/>` },
  { id: 'seat', a: [690, 346], e: [250, 150], r: 0, s: 1, label: ['座墊', 'month'], lb: [60, 195, 'start'], svg: `
      <path d="M592 346 C640 330 720 330 792 336 L796 352 C720 354 640 358 592 362 Z" class="thick"/>
      <path d="M560 350 L594 346 L594 362 L560 360 Z"/><path d="M548 350 L560 350 L560 360 L548 358 Z" class="fat"/>` },
  { id: 'engine', a: [855, 470], e: [1330, 730], r: 0, s: .75, label: ['引擎', 'thismonth'], lb: [1190, 850, 'start'], svg: `
      <path d="M760 432 L920 422 L952 500 L904 562 L782 562 L746 500 Z" class="thick"/>
      <circle cx="820" cy="500" r="32"/><circle cx="820" cy="500" r="12"/><circle cx="900" cy="520" r="18"/>
      <path d="M858 426 L928 420 L966 346 L896 350 Z" class="thick"/>
      <path d="M866 410 L934 404 M874 392 L942 386 M882 374 L950 368"/>
      <g class="piston"><path d="M884 398 L924 395 L936 372 L896 374 Z" class="fat"/></g>
      <path d="M770 552 L790 572 L890 572 L904 562"/>` },
  { id: 'exhaust', a: [740, 560], e: [250, 60], r: 0, s: .8, svg: `
      <path d="M906 546 C906 600 880 610 820 606 L690 600" class="thick"/>
      <path d="M548 528 L690 560 L682 594 L540 562 Z" class="thick"/><path d="M548 545 L686 577"/>
      <circle cx="544" cy="545" r="6"/>` },
  { id: 'chain', a: [645, 562], e: [250, 800], r: 0, s: .8, label: ['鏈條', 'weekday'], lb: [60, 700, 'start'], svg: `
      <circle cx="768" cy="520" r="16"/><circle cx="768" cy="520" r="5"/>
      <g class="spin"><circle cx="520" cy="600" r="38"/><circle cx="520" cy="600" r="10"/></g>
      <path d="M768 504 L520 562 A38 38 0 0 0 520 638 L768 536 A16 16 0 0 0 768 504 Z" class="chainline"/>` },
];

/* ---------- 數字 ---------- */
function stats(s) {
  const days = s?.days || {};
  const now = tw(), ym = `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;
  const byMonth = {}, byWd = [0, 0, 0, 0, 0, 0, 0];
  let total = 0, best = 0, thisMonth = 0;
  for (const [k, km] of Object.entries(days)) {
    total += km;
    best = Math.max(best, km);
    byMonth[k.slice(0, 6)] = (byMonth[k.slice(0, 6)] || 0) + km;
    if (k.startsWith(ym)) thisMonth += km;
    byWd[new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)).getDay()] += km;
  }
  // 最長連續騎乘天數
  const keys = Object.keys(days).filter((k) => days[k] > 0).sort();
  let streak = 0, run = 0, prev = null;
  for (const k of keys) {
    const d = new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
    run = prev && (d - prev) / 86400000 === 1 ? run + 1 : 1;
    streak = Math.max(streak, run); prev = d;
  }
  const wd = byWd.indexOf(Math.max(...byWd));
  return {
    total: `總里程 ${fmt(total)} km`,
    days: `${keys.length} 天有騎`,
    best: `最多一天 ${fmt(best)} km`,
    points: `${(s?.points || 0).toLocaleString()} 個 GPS 點`,
    streak: `最長連續 ${streak} 天`,
    month: `最佳月份 ${fmt(Math.max(0, ...Object.values(byMonth)))} km`,
    thismonth: `${now.getMonth() + 1} 月 ${fmt(thisMonth)} km`,
    weekday: `最常騎 星期${'日一二三四五六'[wd]}`,
  };
}

/* ---------- 組起來 ---------- */
export function mountTeardown(el) {
  let labels = '';
  const parts = PARTS.map((p) => {
    const dx = p.e[0] - p.a[0], dy = p.e[1] - p.a[1];
    const lead = dx || dy ? `<line x1="${p.a[0]}" y1="${p.a[1]}" x2="${p.a[0] - dx}" y2="${p.a[1] - dy}" class="lead"/>` : '';
    if (p.label) {
      // 標籤放在固定位置（不跟著零件移動），拆開時才出現；輪子的數字直接寫在輪軸上
      if (p.lb === 'hub') {
        labels += `<g class="label hub"><text x="${p.e[0]}" y="${p.e[1] - 8}" class="cap">${p.label[0]}</text><text x="${p.e[0]}" y="${p.e[1] + 22}" class="val" data-k="${p.label[1]}">–</text></g>`;
      } else {
        const [lx, ly, an] = p.lb, tx = an === 'end' ? lx - 90 : lx + 60;
        labels += `<g class="label" text-anchor="${an}"><line x1="${p.e[0]}" y1="${p.e[1]}" x2="${tx}" y2="${ly - 20}" class="tick"/>
          <text x="${lx}" y="${ly}" class="cap">${p.label[0]}</text><text x="${lx}" y="${ly + 26}" class="val" data-k="${p.label[1]}">–</text></g>`;
      }
    }
    return `<g class="part" style="--dx:${dx}px;--dy:${dy}px">${lead}
      <g class="turn" style="--r:${p.r}deg;--s:${p.s}"><g class="glow">${p.svg}</g><g class="ink">${p.svg}</g></g></g>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet">${parts}${labels}</svg>`;
  // 窄螢幕沒有左右空白：改成 slice，整台車放大鋪在整頁後面
  const svg = el.querySelector('svg'), narrow = matchMedia('(max-width: 760px)');
  const fit = () => svg.setAttribute('preserveAspectRatio', narrow.matches ? 'xMidYMid slice' : 'xMidYMid meet');
  narrow.addEventListener('change', fit); fit();
  // 分頁在背景時暫停
  const vis = () => el.classList.toggle('paused', document.hidden);
  document.addEventListener('visibilitychange', vis);
  return {
    setData(summary) {
      const st = stats(summary);
      el.querySelectorAll('.val').forEach((t) => { t.textContent = st[t.dataset.k] || '–'; });
    },
  };
}

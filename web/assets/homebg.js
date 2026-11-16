// 首頁背景：幾道細細的琥珀光軌斜斜慢慢流過，像夜騎時路燈拉出的光。
// 分頁在背景時暫停；減少動態效果時停住不動。
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const darkMq = matchMedia('(prefers-color-scheme: dark)');

export function startBg(cv) {
  let W, H, lines, raf = 0, last = performance.now();
  const setup = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const diag = Math.hypot(W, H), dark = darkMq.matches;
    lines = Array.from({ length: W < 500 ? 12 : 16 }, () => ({
      off: (rnd() - 0.5) * diag * 0.9, pos: rnd() * diag * 1.6,
      len: 160 + rnd() * 420, w: 0.8 + rnd() * 1.6, sp: 40 + rnd() * 100,
      a: (dark ? 0.3 : 0.2) + rnd() * (dark ? 0.3 : 0.2), warm: rnd() < 0.8,
    }));
  };
  const frame = (t) => {
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    const g = cv.getContext('2d'), dark = darkMq.matches;
    const ang = (-14 * Math.PI) / 180, dx = Math.cos(ang), dy = Math.sin(ang), diag = Math.hypot(W, H);
    g.clearRect(0, 0, W, H);
    for (const l of lines) {
      if (!reduce && !document.hidden) { l.pos += l.sp * dt; if (l.pos > diag * 1.6) l.pos = -l.len; }
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
  const redo = () => { clearTimeout(redo.t); redo.t = setTimeout(() => { cancelAnimationFrame(raf); setup(); raf = requestAnimationFrame(frame); }, 150); };
  setup();
  raf = requestAnimationFrame(frame);
  addEventListener('resize', redo);
  darkMq.addEventListener('change', redo);
}

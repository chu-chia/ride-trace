// 共用：API、通知、小工具
export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine === false ? '沒有網路，請檢查手機訊號' : '連不到伺服器，請稍後再試');
  }
  // Tailscale serve／反向代理在後端重啟時回 502～504
  if (res.status >= 502 && res.status <= 504) throw new Error('伺服器暫時連不上（可能正在重新啟動），請稍後再試');
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('請先登入');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `錯誤 ${res.status}`);
  return data;
}

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const pad2 = (n) => String(n).padStart(2, '0');
export const clock = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
export const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 3600) + ':' + pad2(Math.floor(s / 60) % 60); };
export const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分前` : `${Math.floor(s / 3600)} 小時前`; };
// 頭像字：一般取暱稱最後一個字（阿偉 → 偉）；結尾是日期（武嶺 25/12/12）就取最後兩位數
export const initialOf = (name = '?') => (/\d$/.test(name) ? name.replace(/\D/g, '').slice(-2) : name.slice(-1));
// 代表色上的字色：白字對比到 3:1（粗體門檻）就用白字，否則改深字（黃、淺藍、綠、橘這類亮色）
const lum = (hex) => {
  const h = String(hex).replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return 0;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
};
export const inkOn = (hex) => (1.05 / (lum(hex) + 0.05) >= 3 ? '#fff' : '#1d1d1f');
export const avatar = (u) => `<div class="avatar" style="--c:${esc(u.color)};--ink:${inkOn(u.color)}">${esc(initialOf(u.nickname))}</div>`;
// 工具按鈕的開關狀態：外觀和 aria-pressed 一起切，不只靠顏色
export const press = (el, on) => { el.classList.toggle('on', !!on); el.setAttribute('aria-pressed', on ? 'true' : 'false'); };

// 寬螢幕時把 el 搬進 into 的最上面（例如標題列併進右側面板），窄螢幕放回原位
export function dock(el, into, query) {
  const home = el.parentNode, anchor = document.createComment('dock');
  home.insertBefore(anchor, el);
  const mq = matchMedia(query);
  const place = () => (mq.matches ? into.prepend(el) : anchor.after(el));
  mq.addEventListener('change', place);
  place();
}

function zone() {
  let z = $('.toasts');
  if (!z) { z = document.createElement('div'); z.className = 'toasts'; document.body.append(z); }
  return z;
}
export function toast(text, { icon = '騎', color = '#d9500f', sub = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="ic" style="--c:${color};--ink:${inkOn(color)}">${esc(icon)}</div><div style="min-width:0"><div class="tx">${esc(text)}</div>${sub ? `<div class="tt">${esc(sub)}</div>` : ''}</div>`;
  const z = zone();
  z.prepend(el);
  while (z.children.length > 3) z.lastChild.remove();
  setTimeout(() => el.remove(), 5000);
}

// 隊員狀態表（回放、行程頁、戰情室共用的樣式）：每列＝顏色點＋名字（下面一行狀態）＋四欄數字，點一下選那個人。
// 列只在人員或順序改變時重建，平常只更新文字：每秒重畫整個 innerHTML 的話，點下去的按鈕會被換掉而點不到。
// rows：[{ uid, name, color, sub, subCls, cols: [[值, 單位] ×4], on }]
export function teamTable(el, rows, onPick) {
  const key = rows.map((r) => r.uid).join(',');
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.classList.add('team-rows');
    el.innerHTML = rows.map((r) => `<button type="button" class="team-row" data-uid="${esc(r.uid)}"><span class="team-name"><i style="background:${esc(r.color)}"></i><span class="team-nm"><b>${esc(r.name)}</b><small class="team-sub"></small></span></span>${'<span class="num"></span>'.repeat(4)}</button>`).join('');
  }
  if (!el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('click', (e) => { const b = e.target.closest('.team-row'); if (b) el.__pick?.(b.dataset.uid); }); }
  el.__pick = onPick;
  for (const r of rows) {
    const row = [...el.children].find((x) => x.dataset.uid === String(r.uid));
    if (!row) continue;
    const sub = row.querySelector('.team-sub');
    sub.textContent = r.sub || '';
    sub.className = `team-sub ${r.subCls || ''}`;
    row.querySelectorAll('.num').forEach((n, i) => { const [v, u] = r.cols[i] || ['–', '']; n.innerHTML = `${esc(v)}<small>${esc(u)}</small>`; });
    row.classList.toggle('on', !!r.on);
    row.setAttribute('aria-pressed', String(!!r.on));
    row.setAttribute('aria-label', `${r.name}，${r.sub || ''}，點一下${r.on ? '取消跟隨' : '鏡頭跟著他'}`);
  }
}

/* ==========================================================================
   統一外框：圖示、側欄收合、液態玻璃（各地圖頁共用）
   ========================================================================== */
const SVG = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  back: SVG('<path d="M15 5l-7 7 7 7"/>'),
  collapse: SVG('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/><path class="fill" d="M5.5 8h1.5M5.5 11h1.5M5.5 14h1.5"/>'),
  team: SVG('<circle cx="12" cy="8" r="3"/><circle cx="5" cy="10" r="2.2"/><circle cx="19" cy="10" r="2.2"/><path d="M6.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M1.5 18c.3-2 1.6-3.3 3.5-3.6M22.5 18c-.3-2-1.6-3.3-3.5-3.6"/>'),
  me: SVG('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7"/>'),
  cube: SVG('<path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M4 7.2l8 4.4 8-4.4M12 11.6v9.6"/>'),
  layers: SVG('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  replay: SVG('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><path d="M11 9l4 3-4 3z" fill="currentColor"/>'),
  screen: SVG('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  home: SVG('<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>'),
  edit: SVG('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  reset: SVG('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
};
// 有 data-icon 的元素自動補上圖示；工具列按鈕的文字包成 <span>，之後用 setLabel() 改字不會洗掉圖示
export function decorate(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.decorated) return;
    el.dataset.decorated = '1';
    const text = el.textContent.trim();
    el.innerHTML = (ICONS[el.dataset.icon] || '') + (text ? `<span>${esc(text)}</span>` : '');
    if (!el.getAttribute('aria-label') && text) el.setAttribute('aria-label', text);
  });
}
export const setLabel = (el, text) => { const s = el.querySelector('span'); if (s) s.textContent = text; else el.textContent = text; };
decorate();

// 液態玻璃的邊緣折射：中間不位移，越靠近圓角邊框，背景越往內彎（移植自北商美食地圖 liquidGlass.ts）
function edgeMap(w, h, radius, bezel) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const hw = w / 2, hh = h / 2, r = Math.min(radius, hw, hh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw, py = y + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
      let nx = 0, ny = 0, d;
      if (qx > 0 && qy > 0) { const len = Math.hypot(qx, qy) || 1; nx = (Math.sign(px) * qx) / len; ny = (Math.sign(py) * qy) / len; d = r - len; }
      else if (qx >= qy) { nx = Math.sign(px); d = hw - Math.abs(px); }
      else { ny = Math.sign(py); d = hh - Math.abs(py); }
      let m = 0;
      if (d < bezel) { const t = Math.min(1, Math.max(0, 1 - d / bezel)); m = 1 - Math.sqrt(1 - t * t); }
      const i = (y * w + x) * 4;
      img.data[i] = 128 - nx * m * 127; img.data[i + 1] = 128 - ny * m * 127; img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
// 只有 Chromium 的 backdrop-filter 吃 SVG 濾鏡；其他瀏覽器、手機版維持一般毛玻璃
const LIQUID_OK = !!(navigator.userAgentData?.brands || []).find((b) => /Chromium/.test(b.brand))
  && !matchMedia('(prefers-reduced-transparency: reduce)').matches;
let liquidSeq = 0;
export function liquidGlass(el, { radius = 24, bezel = 20, scale = 90 } = {}) {
  if (!LIQUID_OK || !el || !('ResizeObserver' in window)) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'liquid-glass-filter'); svg.setAttribute('aria-hidden', 'true');
  document.body.append(svg);
  let key = '', frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (!w || !h || !matchMedia('(min-width: 761px)').matches) { el.style.removeProperty('--liquid-filter'); key = ''; return; }
      if (`${w}x${h}` === key) return;
      key = `${w}x${h}`;
      // 尺寸改變就換新的濾鏡 id，Chromium 才會重新讀位移圖
      const id = `liquid-${++liquidSeq}`;
      svg.innerHTML = `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="${edgeMap(w, h, radius, bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/><feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`;
      el.style.setProperty('--liquid-filter', `url(#${id})`);
    });
  });
  ro.observe(el);
}

// 手機底部抽屜拖曳（參考美食地圖 useSheetDrag）：
// 抽屜整塊都能拖（頂列、摘要、把手，按鈕上也行），抽屜跟著手指走；放開時看速度（快速一甩）或位置決定開合。
// 展開時在清單裡往下拉：清單已在最頂端就改成拖抽屜收合，否則照常捲動。
// 用 touch 事件是因為原生捲動會搶走 pointer 事件；接手拖曳後才 preventDefault。
const SHEET_MQ = matchMedia('(max-width: 760px)');
const NO_DRAG = 'input, select, textarea, [contenteditable], .no-drag';
const TAP_SLOP = 6, FLICK = 0.45; // px、px/ms
export function sheetDrag(sheet, { isOpen, setOpen, scroll }) {
  let st = 'idle', scroller = null, x0 = 0, y0 = 0, h0 = 0, minH = 0, maxH = 0, h = 0, trail = [], endAt = 0, timer = 0;
  const measure = () => {
    sheet.style.transition = 'none'; sheet.style.height = '';
    sheet.classList.add('small'); minH = sheet.offsetHeight;
    sheet.classList.remove('small'); maxH = sheet.offsetHeight;
  };
  sheet.addEventListener('touchstart', (e) => {
    st = 'idle';
    if (!SHEET_MQ.matches || e.touches.length !== 1 || e.target.closest(NO_DRAG)) return;
    scroller = isOpen() && scroll ? e.target.closest(scroll) : null;
    st = 'pending';
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; trail = [];
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (st === 'idle') return;
    const t = e.touches[0], dy = t.clientY - y0;
    if (st === 'pending') {
      // 清單裡：只有往下拉而且已在頂端才接手，其他交給原生捲動
      if (scroller && (dy < 0 || scroller.scrollTop > 0)) { st = 'idle'; return; }
      if (scroller) e.preventDefault();
      if (Math.abs(dy) < TAP_SLOP && Math.abs(t.clientX - x0) < TAP_SLOP) return;
      if (Math.abs(t.clientX - x0) > Math.abs(dy)) { st = 'idle'; return; } // 橫向滑動不搶
      clearTimeout(timer);
      const open = isOpen();
      measure();
      h0 = open ? maxH : minH;
      y0 = t.clientY; // 從接手的位置開始算，抽屜不會突然跳一段
      st = 'dragging';
    }
    e.preventDefault();
    const now = performance.now();
    trail.push([now, t.clientY]);
    while (trail.length > 2 && now - trail[0][0] > 100) trail.shift(); // 速度看最後 0.1 秒，避免單格抖動
    h = Math.min(maxH, Math.max(minH, h0 - (t.clientY - y0)));
    sheet.style.height = `${h}px`;
  }, { passive: false });
  const end = (e) => {
    if (st === 'pending' && e?.type === 'touchend' && !isOpen() && !e.target.closest('a, button, input, select, textarea, label')) {
      st = 'idle'; endAt = performance.now(); setOpen(true); return; // 收合時點摘要空白處也能展開
    }
    if (st !== 'dragging') { st = 'idle'; return; }
    st = 'idle'; endAt = performance.now();
    const [ta, ya] = trail[0] || [0, 0], [tb, yb] = trail.at(-1) || [1, 0];
    const speed = (yb - ya) / Math.max(1, tb - ta), moved = h - h0, need = Math.min(90, (maxH - minH) / 4);
    // 快速一甩看方向；慢慢拉則要拉超過一段距離（90px 或全程四分之一）才換狀態，否則彈回
    const open = speed < -FLICK ? true : speed > FLICK ? false : Math.abs(moved) > need ? moved > 0 : h0 === maxH;
    sheet.style.transition = '';
    sheet.style.height = `${open ? maxH : minH}px`;
    if (!open) sheet.classList.add('small'); // 收合時內容先藏，只動高度
    timer = setTimeout(() => { sheet.style.height = ''; setOpen(open); }, 280);
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
  // 拖曳或點摘要展開後，瀏覽器補送的 click 不要再觸發按鈕（例如把手又切回去）
  sheet.addEventListener('click', (e) => {
    if (performance.now() - endAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// 左側欄：收合鈕（電腦）與拉把手（手機）行為一致，每頁各自記住開合狀態
export function initPanel(panel, key, { onChange, defaultSmall = innerWidth <= 760 } = {}) {
  const storeKey = `qiji:panel:${key}`;
  let small = defaultSmall;
  try { const v = localStorage.getItem(storeKey); if (v !== null) small = v === '1'; } catch { /* 私密模式 */ }
  const btn = panel.querySelector('.panel-collapse'), handle = panel.querySelector('.handle');
  const set = (v, save = true) => {
    small = !!v;
    panel.classList.toggle('small', small);
    for (const el of [btn, handle]) if (el) { el.setAttribute('aria-expanded', String(!small)); el.setAttribute('aria-label', small ? '展開面板' : '收合面板'); }
    if (save) try { localStorage.setItem(storeKey, small ? '1' : '0'); } catch { /* 私密模式 */ }
    onChange?.(small);
  };
  if (btn) btn.onclick = () => set(!small);
  if (handle) handle.onclick = () => set(!small);
  sheetDrag(panel, { isOpen: () => !small, setOpen: (open) => set(!open), scroll: '.panel-body' });
  set(small, false);
  // 手機收合時抽屜高度不固定（摘要一行或兩行），持續量實際高度，讓時間軸、進度條、比例尺貼在它上方
  if ('ResizeObserver' in window) new ResizeObserver(() => {
    if (small) document.documentElement.style.setProperty('--panel-small-h', `${panel.offsetHeight + 8}px`);
  }).observe(panel);
  liquidGlass(panel);
  return { set, get small() { return small; } };
}

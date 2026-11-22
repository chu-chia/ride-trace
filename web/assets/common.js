// 共用：API、通知、小工具
export { canGoBack, goBackOr, wireBack } from '/assets/back.js';  // 返回鈕回到來的地方、擋掉 iOS 回到頁面時自動 focus 輸入框
// 觀看連結（/w/{tok} 轉到 /war?id=…&watch=tok）：免登入看戰情室，每個 API 都帶著它
export const WATCH = new URLSearchParams(location.search).get('watch') || '';
const watchHdr = () => (WATCH ? { 'x-qiji-watch': WATCH } : {});
export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...watchHdr() },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw netError(navigator.onLine === false ? '沒有網路，請檢查手機訊號' : '連不到伺服器，請稍後再試');
  }
  // Tailscale serve／反向代理在後端重啟時回 502～504
  if (res.status >= 502 && res.status <= 504) throw netError('伺服器暫時連不上（可能正在重新啟動），請稍後再試');
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    toLogin();
    // 已經在換頁：回一個永遠不完成的 Promise，呼叫端不會再收到一堆「請先登入」的未處理錯誤（UX-53）
    return new Promise(() => {});
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `錯誤 ${res.status}`);
  return data;
}

// 網路斷線、伺服器重啟這類「等一下再送就會好」的錯誤：err.net = true（訊息待送佇列用，UX-56）
function netError(msg) { const e = new Error(msg); e.net = true; return e; }

// 兩段式確認（移出、開始行程、結束、解除 SOS 共用）：第一次按換成確認文字＋倒數條，
// ms 內再按一次才執行；時間到恢復原狀。戴手套也來得及按第二下（UX-22、UX-45）
export function armConfirm(btn, label, onConfirm, ms = 6000) {
  if (btn.dataset.armed === '1') { disarm(btn); onConfirm(); return; }
  btn.__orig = { html: btn.innerHTML, aria: btn.getAttribute('aria-label') };
  btn.dataset.armed = '1';
  btn.textContent = label;
  if (btn.__orig.aria != null) btn.setAttribute('aria-label', label);
  btn.style.setProperty('--arm', ms + 'ms');
  btn.classList.add('arming');
  btn.__armT = setTimeout(() => disarm(btn), ms);
}
export function disarm(btn) {
  clearTimeout(btn.__armT);
  if (btn.dataset.armed !== '1') return;
  btn.dataset.armed = '';
  btn.classList.remove('arming');
  if (btn.__orig) { btn.innerHTML = btn.__orig.html; if (btn.__orig.aria != null) btn.setAttribute('aria-label', btn.__orig.aria); }
}

export function toLogin() {
  location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
}

/* ---------- 行程頁／戰情室的進場檢查（UX-02） ----------
   連 WebSocket 之前先問 GET /api/trips/{id}：401 → 登入頁；403（不是成員、被移出）／404（打錯 id）→ 整頁錯誤畫面。
   同一頁的多個模組（trip.js、trip-extra.js）共用同一次請求。失敗時回傳永遠不完成的 Promise，
   後面的程式（地圖、輪詢、WebSocket）都不會跑，也不會留下一串 403。 */
let gateTask = null;
export function tripGate(tid, { fresh = false } = {}) {
  if (!gateTask || fresh) gateTask = checkTrip(tid);
  return gateTask;
}
async function checkTrip(tid) {
  if (!tid || !/^\d+$/.test(tid)) return fatal(404, '找不到這個行程', '網址裡的行程編號不對，可能是連結複製不完整。');
  let res;
  try { res = await fetch(`/api/trips/${tid}`, { credentials: 'same-origin', headers: watchHdr() }); }
  catch { return fatal(0, '連不到伺服器', navigator.onLine === false ? '沒有網路，請檢查手機訊號後再試一次。' : '請稍後再試一次。', true); }
  if (res.ok) return res.json();
  if (WATCH && (res.status === 403 || res.status === 404)) return fatal(0, '觀看連結已失效', '行程可能已經結束，或建立者停用、換了新的連結。請向建立者要新的連結。');
  if (res.status === 401) { toLogin(); return new Promise(() => {}); }
  const detail = (await res.json().catch(() => ({}))).detail || '';
  if (res.status === 404) return fatal(404, '找不到這個行程', '行程可能已經被刪除，或網址打錯了。');
  if (res.status === 403) {
    const kicked = detail.includes('移出');
    return fatal(403, kicked ? '你已被移出這個行程' : '你不是這個行程的成員',
      kicked ? '建立者把你移出了這個行程。要再加入，請向建立者要新的邀請碼。' : '請向建立者要邀請碼，在首頁輸入後就能加入。');
  }
  return fatal(res.status, '暫時打不開這個行程', detail || '伺服器發生錯誤，請稍後再試一次。', true);
}
// 整頁錯誤畫面（樣式比照回放頁「你不是這個行程的成員」）：蓋住地圖與所有面板，只留回首頁／重新整理
export function fatal(code, title, msg, retry = false) {
  document.querySelector('.qx-fatal')?.remove();
  document.querySelector('.qx-conn')?.setAttribute('hidden', '');
  const el = document.createElement('div');
  el.className = 'qx-fatal';
  el.setAttribute('role', 'alert');
  el.innerHTML = `<section class="card">${code ? `<div class="code">${code}</div>` : ''}<h1>${esc(title)}</h1><p>${esc(msg)}</p>
    <div class="acts">${retry ? '<button type="button" class="btn" data-reload>重新整理</button>' : ''}${WATCH ? '' : '<a class="btn primary" href="/">回首頁</a>'}</div></section>`;
  el.querySelector('[data-reload]')?.addEventListener('click', () => location.reload());
  document.body.append(el);
  document.title = `${title}｜騎跡`;
  el.querySelector('.btn.primary')?.focus();  // 觀看連結失效時沒有按鈕
  return new Promise(() => {});
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
// 通知往上滑掉（照 iOS）：手指跟著往上走，放開時往上超過 30px 或甩得夠快就收起來，不然彈回去；左右滑不搶
export function swipeAway(el, onGone) {
  let y0 = null, x0 = 0, dy = 0, t0 = 0, pid = null, drag = false;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => { if (e.target.closest('button,a')) return; y0 = e.clientY; x0 = e.clientX; dy = 0; t0 = performance.now(); pid = e.pointerId; drag = false; });
  el.addEventListener('pointermove', (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    dy = Math.min(0, e.clientY - y0);
    if (!drag && Math.abs(e.clientY - y0) > 6 && Math.abs(e.clientY - y0) > Math.abs(e.clientX - x0)) { drag = true; try { el.setPointerCapture(pid); } catch { /* 略過 */ } }
    if (!drag) return;
    el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`; el.style.opacity = String(Math.max(0.2, 1 + dy / 120));
  });
  const end = () => {
    if (y0 == null) return; y0 = null;
    if (!drag) return;
    const fast = -dy / Math.max(1, performance.now() - t0) > 0.4;
    el.style.transition = 'transform .2s ease, opacity .2s ease';
    if (dy < -30 || fast) { el.style.transform = 'translateY(-140%)'; el.style.opacity = '0'; setTimeout(() => { el.style.transition = el.style.transform = el.style.opacity = ''; onGone?.(); }, 200); }
    else { el.style.transform = ''; el.style.opacity = ''; }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
// action：{ label, onClick } 在右邊放一顆按鈕（例如「改用傾斜」），按了就收掉；ms：幾毫秒後自動消失
export function toast(text, { icon = '騎', color = '#d9500f', sub = '', action = null, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="ic" style="--c:${color};--ink:${inkOn(color)}">${esc(icon)}</div><div style="min-width:0;flex:1"><div class="tx">${esc(text)}</div>${sub ? `<div class="tt">${esc(sub)}</div>` : ''}</div>`;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());  // 不要被滑掉手勢吃掉
    b.onclick = () => { el.remove(); action.onClick(); };
    el.append(b);
  }
  const z = zone();
  z.prepend(el);
  while (z.children.length > 3) z.lastChild.remove();
  setTimeout(() => el.remove(), ms);
  swipeAway(el, () => el.remove());
  return el;
}

// 訊號弱：移動中 30 秒沒新點；停著（< 5 km/h）3 分鐘（停著時手機本來就少送，甚至休眠不送；10 分鐘才算失聯）
export const isWeak = (s) => Date.now() - (+s.seen || +s.ts) > ((+s.speed || 0) * 3.6 < 5 ? 180000 : 30000);

// 騎士標記的落隊光暈：flagged＝有落隊／超前旗標；超過門檻越多越紅（剛超過黃、超過兩倍門檻就是紅）
export function gapGlow(el, flagged, gapKm, lagKm) {
  el.classList.toggle('gapflag', !!flagged);
  const lag = +lagKm || 1;
  const g = flagged && Number.isFinite(+gapKm) ? Math.max(0, Math.min(1, (Math.abs(+gapKm) - lag) / lag)) : 0;
  el.style.setProperty('--g', g.toFixed(2));
}
// 跟隨中的騎士標記：focus＝正在跟（away＝暫離中，虛線圈）
export function markFocus(markers, uid, away) {
  for (const [id, el] of markers) {
    const on = id != null && String(id) === String(uid);
    el.classList.toggle('focus', on);
    el.classList.toggle('away', on && !!away);
  }
}

// 隊員狀態表（回放、行程頁、戰情室共用的樣式）：每列＝顏色點＋名字（下面一行狀態）＋四欄數字，點一下選那個人。
// 列只在人員或順序改變時重建，平常只更新文字：每秒重畫整個 innerHTML 的話，點下去的按鈕會被換掉而點不到。
// rows：[{ uid, name, color, sub, subCls, cols: [[值, 單位] ×4], on, away }]
// 事件篩選（騎乘頁事件分頁、戰情室事件流共用，UX-29）：全部／重要／路況／訊息，預設「全部」，選擇存在 localStorage
export const EVENT_FILTERS = {
  all: ['全部', null],
  important: ['重要', new Set(['sos', 'sos_off', 'lost', 'behind', 'ahead', 'offroute', 'stuck'])],
  road: ['路況', new Set(['roadevent', 'weather', 'rain', 'speedcam'])],
  message: ['訊息', new Set(['msg', 'chat', 'mark'])],
};
export function eventFilter(el, storeKey, onChange) {
  let cur = 'all';
  try { const v = localStorage.getItem(storeKey); if (Object.hasOwn(EVENT_FILTERS, v)) cur = v; } catch { /* 私密模式 */ }
  el.classList.add('feed-filters');
  el.setAttribute('role', 'group');
  if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', '篩選事件');
  el.innerHTML = Object.entries(EVENT_FILTERS).map(([k, [n]]) => `<button type="button" data-feed-filter="${k}" aria-pressed="${k === cur}">${n}</button>`).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-feed-filter]');
    if (!b || b.dataset.feedFilter === cur) return;
    cur = b.dataset.feedFilter;
    try { localStorage.setItem(storeKey, cur); } catch { /* 私密模式 */ }
    el.querySelectorAll('[data-feed-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onChange(cur);
  });
  return { get value() { return cur; }, match: (e) => cur === 'all' || !!EVENT_FILTERS[cur][1]?.has(e.type) };
}

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
    row.classList.toggle('away', !!r.away);  // 暫離：拖了地圖，點一下回去跟他
    row.setAttribute('aria-pressed', String(!!r.on));
    row.setAttribute('aria-label', `${r.name}，${r.sub || ''}，點一下${r.on ? '取消跟隨' : r.away ? '回去跟著他' : '鏡頭跟著他'}`);
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
  share: SVG('<path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
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
  el.dataset.lgOwn = '1'; // 這個元件自己管折射，設定頁的「邊緣折射」不要再蓋掉
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

// ---------- 省電模式（手機預設開，設定頁可關） ----------
// 地圖頁每一格都在移動鏡頭，地圖就每一格重畫；手機上再乘上 3 倍解析度、3D 地形和玻璃模糊，很吃電。
// 省電時：鏡頭與標記 30 fps、地圖解析度最多 2 倍、面板不做背景模糊、戰情室不自動旋轉。
export const LOW_POWER = (() => {
  let v = null;
  try { v = localStorage.getItem('qiji:lowpower'); } catch { /* 私密模式 */ }
  return v ? v === '1' : matchMedia('(pointer: coarse)').matches;
})();
document.documentElement.classList.toggle('low-power', LOW_POWER);

// ---------- 玻璃效果（設定頁可關、可調；只影響這台裝置） ----------
// qiji:glass = '0' 關閉；qiji:glass-a = 小按鈕底色不透明度 0～100（%），大面板自動再濃 12%
// qiji:glass-x = 玻璃進階（測試用，JSON）：模糊、亮度、邊緣折射與強度、色散、漸層亮邊、轉彎卡玻璃、省電時抽屜也用玻璃、側邊面板／行程抽屜玻璃
export const GLASS_DEFAULT_A = 72;
export const GLASS_X_DEFAULT = { blur: 20, bri: 0, refr: false, refrS: 60, disp: false, rim: false, turn: false, sheetLP: false, panel: true };
export function glassPrefs() {
  let on = true, a = GLASS_DEFAULT_A, x = { ...GLASS_X_DEFAULT };
  try {
    on = localStorage.getItem('qiji:glass') !== '0';
    const s = localStorage.getItem('qiji:glass-a'), v = Number(s);
    if (s !== null && s !== '' && v >= 0 && v <= 100) a = v;
    const j = JSON.parse(localStorage.getItem('qiji:glass-x') || '{}');
    for (const k of Object.keys(GLASS_X_DEFAULT)) if (typeof j[k] === typeof GLASS_X_DEFAULT[k]) x[k] = j[k];
  } catch { /* 私密模式、JSON 壞掉 */ }
  x.blur = Math.min(30, Math.max(0, x.blur)); x.bri = Math.min(20, Math.max(0, x.bri)); x.refrS = Math.min(100, Math.max(0, x.refrS));
  return { on, a, ...x };
}
export function saveGlass(g) {
  try {
    localStorage.setItem('qiji:glass', g.on ? '1' : '0'); localStorage.setItem('qiji:glass-a', String(g.a));
    const x = {}; for (const k of Object.keys(GLASS_X_DEFAULT)) x[k] = g[k];
    localStorage.setItem('qiji:glass-x', JSON.stringify(x));
  } catch { /* 私密模式 */ }
}
export function applyGlass(g = glassPrefs()) {
  const root = document.documentElement;
  root.classList.toggle('no-glass', !g.on);
  root.classList.toggle('glass-rim', !!g.rim);
  root.classList.toggle('glass-turn', !!g.turn);
  root.classList.toggle('glass-sheet-lp', !!g.sheetLP);
  root.classList.toggle('glass-panel', !!g.panel);
  root.style.setProperty('--lg-a', String(g.a / 100));
  root.style.setProperty('--lg-blur', `${g.blur}px`);
  root.style.setProperty('--lg-bri', String(1 + g.bri / 100));
  edgeRefraction(g.on && g.refr ? { strength: g.refrS, disp: !!g.disp } : null);
}

// 邊緣折射（設定頁開）：替每個玻璃元件依尺寸產生位移圖，寫進 --liquid-filter。只有 Chromium 有效；
// 色散＝紅綠藍三個通道位移量不同，邊緣會出現彩色邊
const GLASS_SEL = '.rtop #back,.rtop #bFog,.rtop .pill,.rtop .panel-title,.followPill,.wnote,.pbar,.glass,.toast,.nv-fab:not(.sos),.nv-cur,.nv-recenter,.nv-focus,.nv-sheet,.wsheet,.psheet,.turn-main,.turn-then';
const ER = { opts: null, svg: null, ro: null, mo: null, mine: new Set(), size: new WeakMap(), seq: 0 };
function erFilter(el) {
  const o = ER.opts; if (!o || el.dataset.lgOwn) return;
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight); if (!w || !h) return;
  const key = `${w}x${h}|${o.strength}|${o.disp}`; if (ER.size.get(el) === key) return; ER.size.set(el, key);
  const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12, bezel = Math.max(4, Math.min(16, rad, h / 2));
  const sc = bezel * 4 * o.strength / 60, id = `lgx-${++ER.seq}`;
  const map = `<feImage href="${edgeMap(w, h, rad, bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>`;
  const dm = (k, res) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(sc * k).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"${res ? ` result="${res}"` : ''}/>`;
  const cm = (n, m) => `<feColorMatrix in="d${n}" values="${m}" result="c${n}"/>`;
  const body = !o.disp ? dm(1)
    : dm(1.1, 'dr') + cm('r', '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0') + dm(1, 'dg') + cm('g', '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0')
      + dm(.9, 'db') + cm('b', '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0') + '<feBlend in="cr" in2="cg" mode="screen" result="rg"/><feBlend in="rg" in2="cb" mode="screen"/>';
  const old = el.dataset.lgx && document.getElementById(el.dataset.lgx); if (old) old.remove();
  ER.svg.insertAdjacentHTML('beforeend', `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${map}${body}</filter>`);
  el.dataset.lgx = id; el.style.setProperty('--liquid-filter', `url(#${id})`); ER.mine.add(el);
}
function erScan() { for (const el of document.querySelectorAll(GLASS_SEL)) if (!el.dataset.lgOwn && !ER.mine.has(el)) { ER.ro.observe(el); erFilter(el); } }
function edgeRefraction(opts) {
  if (!LIQUID_OK || !('ResizeObserver' in window)) return;
  ER.opts = opts;
  if (!opts) {
    ER.ro?.disconnect(); ER.mo?.disconnect();
    for (const el of ER.mine) { el.style.removeProperty('--liquid-filter'); delete el.dataset.lgx; ER.size.delete(el); }
    ER.mine.clear(); if (ER.svg) ER.svg.innerHTML = '';
    return;
  }
  if (!ER.svg) {
    ER.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ER.svg.setAttribute('class', 'liquid-glass-filter'); ER.svg.setAttribute('aria-hidden', 'true'); document.body.append(ER.svg);
    ER.ro = new ResizeObserver((es) => requestAnimationFrame(() => es.forEach((e) => erFilter(e.target))));
    ER.mo = new MutationObserver(() => { cancelAnimationFrame(ER.raf); ER.raf = requestAnimationFrame(erScan); });
  }
  for (const el of ER.mine) ER.size.delete(el); // 強度、色散變了：全部重做
  ER.mine.forEach((el) => erFilter(el));
  ER.mo.observe(document.body, { childList: true, subtree: true });
  erScan();
}
applyGlass();

// ---------- 效能量測浮層（開發用）：網址加 ?perf=1 開、?perf=0 關，同一分頁換頁會保留 ----------
export const PERF = (() => {
  const q = new URLSearchParams(location.search).get('perf');
  try {
    if (q === '1') sessionStorage.setItem('qiji:perf', '1');
    if (q === '0') { sessionStorage.removeItem('qiji:perf'); localStorage.removeItem('qiji:perf'); }
    // 加到主畫面的 App 沒有網址列：設定頁的「效能量測浮層」開關存在 localStorage
    return sessionStorage.getItem('qiji:perf') === '1' || localStorage.getItem('qiji:perf') === '1';
  } catch { return q === '1'; }
})();
if (PERF) { window.__qijiMaps ||= []; import('/assets/perf.js'); }
// 動畫迴圈用：回傳 false 表示這一格跳過（省電時約 30 fps）
export function frameGate() {
  let last = 0;
  return (now) => {
    // 效能量測 A/B「3D 20fps」：地圖和頁面迴圈要一起降，不然標記和底圖會錯開一格、看起來在抖
    const ms = !LOW_POWER ? 0 : window.__qiji3d && window.__qijiPerfFlags?.has('fps20') ? 1000 / 20 - 2 : 1000 / 30 - 2;
    if (now - last < ms) return false; last = now; return true;
  };
}

// 地圖留白平滑過渡：抽屜或側欄開合後，鏡頭用 0.45 秒滑到新的置中位置，不會一下子閃過去
// 停車時的 GPS 飄移：手機停著時位置會在原地跳十幾到幾十公尺，速度也會跟著亂跳（有時算出 7 km/h）。
// 圖釘照著跳，跟隨／全隊鏡頭也會跟著來回追，3D 傾斜時看起來就是畫面上下抖。
// 最近 3 點速度的中位數低於 6 km/h、新位置又在目前圖釘 30 m 內，就當作停著沒動，圖釘不動。
const PARK_KMH = 6, PARK_M = 30;
export function parkedJitter(m, lon, lat) {
  const anchor = m.to || m.lastTarget || m.pos; // 戰情室用 to、行程頁用 lastTarget（圖釘正要滑去的位置）
  if (!anchor) return false;
  const v = (m.recent || []).slice(-3).map((x) => x.kmh).sort((a, b) => a - b);
  if (!v.length || v[Math.floor(v.length / 2)] >= PARK_KMH) return false;
  const kx = Math.cos((lat * Math.PI) / 180) * 111320;
  return Math.hypot((lon - anchor[0]) * kx, (lat - anchor[1]) * 110540) < PARK_M;
}

// 系統「減少動態效果」：鏡頭不做飛行、旋轉、慢慢追的動畫，直接到位（MapLibre 自己的 easeTo／flyTo 已經會略過動畫）
const RM_Q = matchMedia('(prefers-reduced-motion: reduce)');
export const reduceMotion = () => RM_Q.matches;

export function smoothPad(compute, ms = 450) {
  let from = compute(), to = from, t0 = 0;
  const get = () => {
    const k = RM_Q.matches ? 1 : Math.min(1, (performance.now() - t0) / ms);
    if (k >= 1) return to;
    const e = 1 - (1 - k) ** 3;
    return Object.fromEntries(Object.keys(to).map((key) => [key, (from[key] ?? to[key]) + (to[key] - (from[key] ?? to[key])) * e]));
  };
  return { get, refresh() { from = get(); to = compute(); t0 = performance.now(); } };
}

// iOS：鍵盤收起後整頁可能停在捲動過的位置，固定在畫面上的按鈕看起來在原處、實際點擊位置卻偏了。
// 地圖頁本來就不該捲動，鍵盤收起或視窗大小變了就捲回頂端。
const unscroll = () => setTimeout(() => {
  if (document.getElementById('map') && (scrollX || scrollY)) scrollTo(0, 0);
}, 80);
addEventListener('focusout', unscroll);
window.visualViewport?.addEventListener('resize', unscroll);
addEventListener('orientationchange', unscroll);

// 手機底部抽屜：直接照改版原型 ride-trace-redesign/proto.js 的 Sheet() 搬過來（使用者覺得原型的手感比較好）。
// 抽屜高度固定，用 transform 整塊上下推；pointer 事件＋CSS touch-action（抽屜 none、清單 pan-y）決定手勢歸誰。
// 拖曳：超過 7px 才開始、跟著手指走、拉過頭有 1/3 阻力；放開時速度 > 0.4 px/ms 看方向，不然看有沒有過一半。
// 展開時清單已經往下捲（scrollTop > 0）就不接手，讓清單自己捲。收合時點空白處（不是按鈕）就展開。
// 正式版另外補的：收合時露出 peek 元素（把手、頂列、摘要），keep 元素（行程頁的 SOS 那一排）一直貼在畫面最下面；
// 頁面自己切 .small（點把手、點分頁）時用 MutationObserver 跟著滑；抽屜露出的高度寫進 --sheet-h／--sheet-t（每一格最多一次）。
const SHEET_MQ = matchMedia('(max-width: 760px)');
const NO_DRAG = 'input, select, textarea, [contenteditable], .no-drag';
let safeProbe = null;
const safeBottom = () => {
  if (!safeProbe) { safeProbe = document.createElement('div'); safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-bottom,0px)'; document.body.append(safeProbe); }
  return safeProbe.offsetHeight;
};
export function sheetDrag(sheet, { isOpen, setOpen, scroll, peek = '.handle, .panel-head, .panel-mini, .peek', keep = '.keep', mq = SHEET_MQ }) {
  const root = document.documentElement.style;
  sheet.classList.add('sheetx');
  const mark = () => { for (const el of sheet.children) el.classList.toggle('sx-rest', !el.matches(peek) && !el.matches(keep)); sheet.classList.toggle('sx-on', mq.matches); };
  mark();
  // 收合時露出的高度：最後一個 peek 元素的下緣＋keep 元素的高度（沒有 keep 時留安全區）
  const peekH = () => {
    let b = 0, k = 0;
    for (const el of sheet.children) {
      if (el.offsetParent === null) continue;
      if (el.matches(keep)) k += el.offsetHeight;
      else if (el.matches(peek)) b = Math.max(b, el.offsetTop + el.offsetHeight);
    }
    return Math.round(b + (k || Math.max(10, safeBottom() + 6)));
  };
  const closedOff = () => Math.max(0, sheet.offsetHeight - peekH());
  let off = 0, max = 0, H = 0, open = isOpen(), raf = 0, until = 0, endAt = 0;
  const setOff = (px) => { off = px; sheet.style.setProperty('--sheet-off', px + 'px'); };
  // --sheet-h／--sheet-t：每一格最多寫一次（拖曳中、轉場中都跟著抽屜上緣走）
  const publish = () => {
    if (!mq.matches) return;
    const vis = Math.max(0, Math.min(H, innerHeight - sheet.getBoundingClientRect().top));
    const t = (max ? Math.min(1, Math.max(0, 1 - (H - vis) / max)) : (open ? 1 : 0)).toFixed(3);
    root.setProperty('--sheet-h', `${Math.round(vis)}px`);
    root.setProperty('--sheet-t', t);
    sheet.style.setProperty('--sx-t', t);
  };
  const tick = () => { raf = 0; publish(); if (performance.now() < until) raf = requestAnimationFrame(tick); };
  const publishFor = (ms) => { until = Math.max(until, performance.now() + ms); if (!raf) raf = requestAnimationFrame(tick); };
  const measure = () => { H = sheet.offsetHeight; max = closedOff(); sheet.dataset.minH = H - max; };
  const set = (o, { animate = true } = {}) => {
    open = o;
    if (o !== isOpen()) setOpen(o);  // 先切狀態（摘要列只在收合時顯示），再量收合高度
    if (!mq.matches) { sheet.style.removeProperty('--sheet-off'); return; }
    measure();
    if (!animate) sheet.classList.add('dragging');
    setOff(o ? 0 : max);
    if (!animate) { void sheet.offsetHeight; sheet.classList.remove('dragging'); }
    if (!o) { const b = scrollEl(); if (b) b.scrollTop = 0; }
    publishFor(animate ? 360 : 0);
  };
  const toggle = (o = !open) => set(o);
  // 捲動的地方：可以是抽屜裡的清單，也可以是整個抽屜（行程頁打開後整個抽屜一起捲）
  const scrollEl = () => (scroll ? (sheet.matches(scroll) ? sheet : sheet.querySelector(scroll)) : null);

  let y0 = null, off0 = 0, last = 0, lastT = 0, vel = 0, moved = false, pid = null, inBody = false;
  sheet.addEventListener('pointerdown', (e) => {
    if (!mq.matches || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // 把手一律可以拉；其他地方在清單（或整個抽屜）已經往下捲時，交給原生捲動
    const body = scroll && !e.target.closest('.handle') && e.target.closest(scroll);
    if (body && open && body.scrollTop > 0) return;
    if (e.target.closest(NO_DRAG)) return;
    measure();
    inBody = !!body;
    y0 = e.clientY; off0 = off; last = y0; lastT = performance.now(); vel = 0; moved = false; pid = e.pointerId;
  });
  // 移動、放開聽在 window：滑鼠一下子移出抽屜（還沒 setPointerCapture）也收得到
  addEventListener('pointermove', (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    const dy = e.clientY - y0;
    if (!moved && Math.abs(dy) < 7) return;
    if (!moved && inBody && open && dy < 0) { y0 = null; return; }  // 展開時在清單裡往上滑＝捲清單，抽屜放手
    if (!moved) { moved = true; sheet.classList.add('dragging'); try { sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    const t = performance.now(); vel = (e.clientY - last) / Math.max(1, t - lastT); last = e.clientY; lastT = t;
    let o = off0 + dy;
    if (o < 0) o /= 3;
    if (o > max) o = max + (o - max) / 3;
    setOff(o); publishFor(0);
  });
  const end = (e) => {
    if (y0 == null || e.pointerId !== pid) return;
    y0 = null; sheet.classList.remove('dragging');
    if (!moved) { if (e.type === 'pointerup' && !open && !e.target.closest('button,a,input,select,label')) { endAt = performance.now(); set(true); } return; }
    endAt = performance.now();
    set(Math.abs(vel) > 0.4 ? vel < 0 : off < max / 2);
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  // 清單捲到最上面再往下拉＝拉抽屜：擋掉原生的回彈捲動，pointer 事件才不會被取消（iOS 不支援 touch-action: pan-down）
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null || !mq.matches) return;
    const dy = e.touches[0].clientY - y0, el = scrollEl();
    if (moved || (dy > 0 && (!inBody || !el || el.scrollTop <= 0))) e.preventDefault();
  }, { passive: false });
  // 拖曳或點摘要展開後，瀏覽器補送的 click 不要再觸發按鈕（例如把手又切回去）
  sheet.addEventListener('click', (e) => {
    if (performance.now() - endAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // 轉場結束再量一次（保證 --sheet-h 停在最後的位置）
  sheet.addEventListener('transitionend', (e) => { if (e.target === sheet) publishFor(0); });
  // 頁面自己切開合（.small）：滑到對的位置
  new MutationObserver(() => { if (y0 == null && isOpen() !== open) set(isOpen()); })
    .observe(sheet, { attributes: true, attributeFilter: ['class'] });
  // 收合時露出的內容變高變矮（摘要換行、轉向）：跟著調整
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => { if (y0 == null && mq.matches) { const was = max; measure(); if (!open && Math.abs(max - was) > 1) { setOff(max); publishFor(360); } else publishFor(0); } });
    for (const el of sheet.children) ro.observe(el);  // 任何一塊出現、消失、變高（例如提示晚一點才出現）都要重量
    ro.observe(sheet);
  }
  mq.addEventListener('change', () => { mark(); set(isOpen(), { animate: false }); });
  addEventListener('resize', () => { if (y0 == null) set(open, { animate: false }); });
  requestAnimationFrame(() => set(isOpen(), { animate: false }));
  return { toggle };
}

// 地圖留白用：手機抽屜「收合時」的高度。展開或拖曳中都回傳同一個值，
// 地圖鏡頭不會因為抽屜拉上拉下而跟著跳；抽屜展開時本來就是在看面板。
export const sheetRestH = (el, fallback = 120) => Number(el?.dataset.minH) || fallback;

// 手機：不給頁面縮放（地圖自己的雙指縮放不受影響），從上一頁返回時也不要自動叫出鍵盤
document.addEventListener('gesturestart', (e) => e.preventDefault());
addEventListener('pageshow', (e) => { if (e.persisted) document.activeElement?.blur?.(); });

// 側欄收合／展開動畫（Apple 的作法：外框用彈簧縮放，裡面的內容先淡掉再換、或換好再淡入）
// 用 clip-path 從現在的大小裁到目標大小，不去動 width／height（不會每格重新排版，手機上也順）。
// 收合時先加 .small＋.closing：.closing 讓面板維持展開的版面直到動畫結束，但 body:has(.panel.small) 的元件（回放播放列、
// 全隊進度條、跟隨膠囊）已經開始往左滑，兩邊同時動。
let panelAnim = null;
function animatePanel(panel, toSmall) {
  panelAnim?.finish?.();
  const R = 20, ease = cssVar('--ease-spring'), dur = 520;
  const kids = () => [...panel.children].filter((el) => !el.matches('.panel-head,.panel-mini,.handle,.keep'));
  if (toSmall) {
    const full = panel.getBoundingClientRect();
    panel.classList.add('small');                      // 量目標大小
    const sm = panel.getBoundingClientRect();
    panel.classList.add('closing');                    // 版面先維持展開
    const cut = `inset(0px ${Math.max(0, full.width - sm.width)}px ${Math.max(0, full.height - sm.height)}px 0px round ${R}px)`;
    kids().forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' }));
    const a = panel.animate([{ clipPath: `inset(0px 0px 0px 0px round ${R}px)` }, { clipPath: cut }], { duration: dur, easing: ease });
    panelAnim = a;
    const done = () => { panel.classList.remove('closing'); kids().forEach((el) => el.getAnimations().forEach((x) => x.cancel())); if (panelAnim === a) panelAnim = null; };
    a.onfinish = done; a.oncancel = done;
  } else {
    const sm = panel.getBoundingClientRect();
    panel.classList.remove('small');
    const full = panel.getBoundingClientRect();
    const cut = `inset(0px ${Math.max(0, full.width - sm.width)}px ${Math.max(0, full.height - sm.height)}px 0px round ${R}px)`;
    const a = panel.animate([{ clipPath: cut }, { clipPath: `inset(0px 0px 0px 0px round ${R}px)` }], { duration: dur, easing: ease });
    panelAnim = a;
    // 內容晚一點出來、從上面一點點滑下來（像 iOS 展開卡片）
    kids().forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: 90 + Math.min(i, 4) * 25, easing: ease, fill: 'backwards' }));
    a.onfinish = a.oncancel = () => { if (panelAnim === a) panelAnim = null; };
  }
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease';

// 分段按鈕（.seg）換選項：底色從舊的位置滑到新的位置（iOS UISegmentedControl）。
// 各頁照舊只切 .on，這裡用 MutationObserver 看到「A 拿掉 on、B 加上 on」就放一塊同色的底（.seg-ghost）從 A 滑到 B，
// 滑的時候 B 自己的底色先隱藏（.seg-moving），到了再拿掉那塊。
const segRun = new WeakMap();
function segSlide(seg, from, to) {
  if (RM_Q.matches || !to.offsetWidth || !from.offsetWidth || !seg.animate) return;
  segRun.get(seg)?.finish();
  const cs = getComputedStyle(to);
  const g = document.createElement('i');
  g.className = 'seg-ghost';
  Object.assign(g.style, { background: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius, height: `${to.offsetHeight}px`, top: `${to.offsetTop}px` });
  seg.append(g);
  to.classList.add('seg-moving');
  const a = g.animate([
    { transform: `translateX(${from.offsetLeft}px)`, width: `${from.offsetWidth}px` },
    { transform: `translateX(${to.offsetLeft}px)`, width: `${to.offsetWidth}px` },
  ], { duration: 460, easing: cssVar('--ease-spring') });
  segRun.set(seg, a);
  a.onfinish = a.oncancel = () => { g.remove(); to.classList.remove('seg-moving'); if (segRun.get(seg) === a) segRun.delete(seg); };
}
const hasOn = (v) => /(^|\s)on(\s|$)/.test(v || '');
new MutationObserver((recs) => {
  const lost = new Map(), got = new Map();
  for (const r of recs) {
    const b = r.target, seg = b.parentElement;
    if (b.tagName !== 'BUTTON' || !seg?.classList.contains('seg')) continue;
    const was = hasOn(r.oldValue), now = b.classList.contains('on');
    if (was && !now) lost.set(seg, b);
    else if (!was && now) got.set(seg, b);
  }
  for (const [seg, to] of got) { const from = lost.get(seg); if (from) segSlide(seg, from, to); }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });

// 左側欄：收合鈕（電腦）與拉把手（手機）行為一致，每頁各自記住開合狀態
export function initPanel(panel, key, { onChange, defaultSmall = innerWidth <= 760 } = {}) {
  const storeKey = `qiji:panel:${key}`;
  let small = defaultSmall;
  try { const v = localStorage.getItem(storeKey); if (v !== null) small = v === '1'; } catch { /* 私密模式 */ }
  const btn = panel.querySelector('.panel-collapse'), handle = panel.querySelector('.handle');
  const set = (v, save = true) => {
    const next = !!v;
    // 電腦／手機橫向的側欄：收合、展開用彈簧動畫（見 animatePanel）；手機直向是抽屜，另外有拖曳動畫
    const anim = save && next !== small && innerWidth > 760 && !RM_Q.matches && !!panel.animate;
    small = next;
    if (anim) animatePanel(panel, small);
    else panel.classList.toggle('small', small);
    for (const el of [btn, handle]) if (el) { el.setAttribute('aria-expanded', String(!small)); el.setAttribute('aria-label', small ? '展開面板' : '收合面板'); }
    if (save) try { localStorage.setItem(storeKey, small ? '1' : '0'); } catch { /* 私密模式 */ }
    onChange?.(small);
  };
  if (btn) btn.onclick = () => set(!small);
  set(small, false);
  const drag = sheetDrag(panel, { isOpen: () => !small, setOpen: (open) => set(!open), scroll: '.panel' });
  if (handle) handle.onclick = () => drag.toggle();
  return { set, get small() { return small; } };
}

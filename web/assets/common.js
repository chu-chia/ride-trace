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

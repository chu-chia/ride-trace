// 共用：API、通知、小工具
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
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
export const avatar = (u) => `<div class="avatar" style="--c:${esc(u.color)}">${esc(initialOf(u.nickname))}</div>`;

function zone() {
  let z = $('.toasts');
  if (!z) { z = document.createElement('div'); z.className = 'toasts'; document.body.append(z); }
  return z;
}
export function toast(text, { icon = '騎', color = '#2aabee', sub = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="ic" style="--c:${color}">${esc(icon)}</div><div style="min-width:0"><div class="tx">${esc(text)}</div>${sub ? `<div class="tt">${esc(sub)}</div>` : ''}</div>`;
  const z = zone();
  z.prepend(el);
  while (z.children.length > 3) z.lastChild.remove();
  setTimeout(() => el.remove(), 5000);
}

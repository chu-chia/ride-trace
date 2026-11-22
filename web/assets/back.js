// 返回鈕：從哪裡點進來就回到哪裡（跟 iOS 左滑返回一樣），不是一律回首頁。
// 用法：<a data-back href="備用網址">——上一頁是本站、而且不是登入頁或同一頁時就 history.back()；
// 直接開網址、推播點進來、加到主畫面直接開這頁時沒有上一頁，才照 href 走。
// 另外處理 iOS 回到頁面時自己把焦點還給輸入框（鍵盤跳出來）的問題，見最下面。

export function canGoBack(want) {
  if (history.length < 2 || !document.referrer) return false;
  try {
    const r = new URL(document.referrer);
    if (r.origin !== location.origin) return false;
    if (/^\/(login|w\/)/.test(r.pathname)) return false;            // 登入頁、觀看連結轉址頁不回去
    if (r.pathname + r.search === location.pathname + location.search) return false;
    if (want && !want(r)) return false;
    return true;
  } catch { return false; }
}

// 做完一件事要回到上一層（例如規劃頁「改用這條路線」後回行程頁）：上一頁就是那裡就 back，否則用 replace，
// 不會在歷史紀錄裡多疊一層（不然在行程頁按返回又回到規劃頁）
export function goBackOr(url) {
  const u = new URL(url, location.origin);
  if (canGoBack((r) => r.pathname === u.pathname || (u.pathname === '/trip' && r.pathname === '/nav'))) history.back();
  else location.replace(u.pathname + u.search);
}

export function wireBack(root = document) {
  root.querySelectorAll('a[data-back]').forEach((a) => {
    if (a.dataset.backWired) return;
    a.dataset.backWired = '1';
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;  // 電腦按著 ⌘／Ctrl 點：照常開新分頁
      // data-back-to="/trip"：只有上一頁就是那一頁才 back（例如戰情室的「行程頁」鈕：從首頁進來時要往前開行程頁）
      const to = a.dataset.backTo;
      if (canGoBack(to ? (r) => r.pathname === to || (to === '/trip' && r.pathname === '/nav') : undefined)) { e.preventDefault(); history.back(); }
    });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => wireBack());
else wireBack();

// iOS：從背景切回來、或返回時從快取還原頁面，Safari 會把焦點還給上次的輸入框（首頁的邀請碼），鍵盤自己跳出來。
// 頁面剛顯示的 1.5 秒內、使用者沒有碰螢幕或按鍵就拿到焦點的輸入框，一律放掉焦點。
let lastUser = -Infinity, shownAt = performance.now();
for (const ev of ['pointerdown', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, () => { lastUser = performance.now(); }, { capture: true, passive: true });
addEventListener('pageshow', () => { shownAt = performance.now(); document.activeElement?.matches?.('input,textarea,select') && document.activeElement.blur(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { shownAt = performance.now(); document.activeElement?.matches?.('input,textarea,select') && performance.now() - lastUser > 800 && document.activeElement.blur(); } });
document.addEventListener('focusin', (e) => {
  const t = e.target, now = performance.now();
  if (!t.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=range]),textarea')) return;
  if (now - shownAt < 1500 && now - lastUser > 800) t.blur();
}, true);

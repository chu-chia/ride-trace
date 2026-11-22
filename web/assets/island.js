// 手機橫向時，iOS 左右兩邊都回報約 59pt 的安全區，但動態島（瀏海）只在其中一邊。
// 這裡算出 --sai-l／--sai-r：動態島那側照系統值閃避，另一側只留螢幕圓角需要的距離，把中間空間讓出來。
// CSS 一律寫 var(--sai-l, env(safe-area-inset-left,0px))；沒算出來（直向、電腦、沒有瀏海）就退回系統值。
const FAR = 20;  // 沒有動態島那側的距離：圓角半徑約 55pt，元件本身有 16px 以上圓角時 20px 就不會被切到
const root = document.documentElement;
const probe = document.createElement('div');
probe.setAttribute('aria-hidden', 'true');
probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
  + 'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';

// 動態島在哪一邊：iOS 的 window.orientation 90＝手機往左轉（頂端在左）、-90＝往右轉（頂端在右）
function islandSide() {
  const o = window.orientation;
  if (o === 90) return 'left';
  if (o === -90) return 'right';
  const t = screen.orientation?.type;
  if (t === 'landscape-primary') return 'left';
  if (t === 'landscape-secondary') return 'right';
  return null;
}

function update() {
  if (!probe.isConnected) (document.body || root).appendChild(probe);
  const cs = getComputedStyle(probe);
  const l = parseFloat(cs.paddingLeft) || 0, r = parseFloat(cs.paddingRight) || 0;
  const side = islandSide();
  // 戰情室在手機上會把 viewport 改成 width=1280（畫面縮小約 1.5 倍）；安全區若還是以螢幕點回報（< 70），要乘上縮放倍率才蓋得住
  const f = innerWidth / Math.max(screen.width, screen.height, 1);
  const k = f > 1.05 && l < 70 ? f : 1;
  // 只有「左右都有、而且一樣大」才是系統對稱補的（瀏海機橫向）；其他情況不動
  if (side && l > FAR && r > FAR && Math.abs(l - r) < 2) {
    root.style.setProperty('--sai-l', `${Math.round((side === 'left' ? l : FAR) * k)}px`);
    root.style.setProperty('--sai-r', `${Math.round((side === 'right' ? r : FAR) * k)}px`);
    root.dataset.island = side;
  } else {
    root.style.removeProperty('--sai-l');
    root.style.removeProperty('--sai-r');
    delete root.dataset.island;
  }
}

let t = 0;
const later = () => { clearTimeout(t); t = setTimeout(update, 120); };  // 轉向時安全區要等版面換完才更新
addEventListener('orientationchange', later);
addEventListener('resize', later);
screen.orientation?.addEventListener?.('change', later);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update, { once: true });
else update();

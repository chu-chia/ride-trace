// 地圖手勢規則（docs/地圖手勢規則.md v2）：行程頁、回放、戰情室共用。
// 業界做法（Google／Apple 地圖、MapLibre Native LocationComponent、Mapbox NavigationCamera）：
// 只有「移動位置」才離開跟隨；縮放、旋轉、傾斜不算，跟隨某人時縮放以那個人（畫面中心）為準。
//
// cameraGestures(M, {
//   centered: () => bool,   // 正在跟隨某一個人（縮放要以畫面中心為準）
//   onPan: () => void,      // 使用者拖曳超過門檻：頁面把鏡頭轉成「暫離」
//   onZoom: () => void,     // 使用者縮放（全隊模式下要轉暫離；跟隨某人時不用理）
//   onRotate: () => void,   // 使用者旋轉（回放「車頭朝上」要改成北不動）
//   onActivity: () => void, // 任何操作：暫離的自動回去要重新計時
// })
// 回傳 { sync }：跟隨模式改變後呼叫，讓縮放中心跟著換。
const PAN_PX = 10;        // 單指拖曳超過這個距離才算離開跟隨
const MULTI_PAN_PX = 60;  // 雙指（縮放／旋轉）時，兩指中點移動超過這個距離才算拖曳
const TAP_MS = 300, TAP_PX = 10, DOUBLE_TAP_PX = 40;

export function cameraGestures(M, { centered = () => false, onPan = () => {}, onZoom = () => {}, onRotate = () => {}, onActivity = () => {} } = {}) {
  const map = M.map;
  if (M.down) return { sync() {} };
  map.boxZoom.disable();  // Shift＋拖曳框選放大：很少人知道，又容易誤觸（第 17 條）
  const box = map.getCanvasContainer();
  let mode = null;
  function sync() {
    const c = !!centered();
    if (c === mode) return;
    mode = c;
    const opt = c ? { around: 'center' } : undefined;
    // scrollZoom.enable() 已啟用時不會改設定，要先關再開
    if (map.scrollZoom.isEnabled()) { map.scrollZoom.disable(); map.scrollZoom.enable(opt); }
    if (map.touchZoomRotate.isEnabled()) map.touchZoomRotate.enable(opt);
    // 點兩下／雙指點一下：MapLibre 內建以手指位置為中心，跟隨時改成自己處理（以畫面中心）
    if (c) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  }
  sync();
  // 延後一格：觸控結束時 MapLibre 自己的點兩下拖曳縮放（tapDragZoom）還會處理同一個 touchend，當下 easeTo 會被它停掉
  const zoom = (d) => { setTimeout(() => { M.zoomBy(d); onZoom(); onActivity(); }, 0); };

  /* ---------- 觸控 ---------- */
  const mid = (ts) => { let x = 0, y = 0; for (const t of ts) { x += t.clientX; y += t.clientY; } return [x / ts.length, y / ts.length]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let g = null, lastTap = null, lastTouchAt = 0;
  box.addEventListener('touchstart', (e) => {
    sync();
    onActivity();
    lastTouchAt = performance.now();
    const c = mid(e.touches);
    if (!g) {
      // 剛點過一下又按下去＝點兩下（或點兩下後拖曳縮放），不能當成拖曳
      const tapDrag = e.touches.length === 1 && lastTap && e.timeStamp - lastTap.at < TAP_MS && dist(c, lastTap.p) < DOUBLE_TAP_PX;
      g = { t0: e.timeStamp, max: 0, moved: 0, panned: false, tapDrag };
    }
    g.max = Math.max(g.max, e.touches.length);
    g.n = e.touches.length;
    g.start = c;
  }, { passive: true, capture: true });
  box.addEventListener('touchmove', (e) => {
    if (!g) return;
    const c = mid(e.touches);
    if (e.touches.length !== g.n) { g.n = e.touches.length; g.start = c; return; }  // 手指數變了，中點會跳，重新起算
    const d = dist(c, g.start);
    g.moved = Math.max(g.moved, d);
    if (!g.panned && !g.tapDrag && d > (g.max >= 2 ? MULTI_PAN_PX : PAN_PX)) { g.panned = true; onPan(); sync(); }  // sync：同一個手勢接下來雙指就能平移地圖
  }, { passive: true, capture: true });
  const touchEnd = (e) => {
    if (!g) return;
    lastTouchAt = performance.now();
    if (e.touches.length) { g.n = e.touches.length; g.start = mid(e.touches); return; }
    const quick = e.timeStamp - g.t0 < TAP_MS && g.moved < TAP_PX && e.type === 'touchend';
    const p = mid(e.changedTouches);
    if (quick && g.max === 1) {
      if (lastTap && e.timeStamp - lastTap.at < TAP_MS * 1.5 && dist(p, lastTap.p) < DOUBLE_TAP_PX) { lastTap = null; if (centered()) zoom(1); }
      else lastTap = { at: e.timeStamp, p };
    } else {
      lastTap = null;
      if (quick && g.max === 2 && centered()) zoom(-1);
    }
    g = null;
  };
  box.addEventListener('touchend', touchEnd, { passive: true, capture: true });
  box.addEventListener('touchcancel', touchEnd, { passive: true, capture: true });

  /* ---------- 滑鼠、觸控板、鍵盤 ---------- */
  let ms = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    sync();
    onActivity();
    // 右鍵或 Ctrl＋左鍵是旋轉／傾斜，不算拖曳
    ms = e.button === 0 && !e.ctrlKey ? { p: [e.clientX, e.clientY], panned: false } : null;
  }, { capture: true });
  addEventListener('pointermove', (e) => {
    if (!ms || ms.panned || e.pointerType !== 'mouse') return;
    if (dist([e.clientX, e.clientY], ms.p) > PAN_PX) { ms.panned = true; onPan(); }
  });
  addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') ms = null; });
  // 滾輪、觸控板雙指捏合（MapLibre 的滾輪縮放不一定帶 originalEvent，直接聽）
  box.addEventListener('wheel', () => { sync(); onActivity(); onZoom(); }, { passive: true, capture: true });
  map.on('dblclick', (e) => {
    if (!centered() || performance.now() - lastTouchAt < 1000) return;  // 觸控的點兩下上面處理過了
    zoom(e.originalEvent?.shiftKey ? -1 : 1);
  });
  map.getContainer().addEventListener('keydown', (e) => {
    sync();
    onActivity();
    if (e.shiftKey) return;  // Shift＋方向鍵是旋轉／傾斜
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) onPan();
  }, { capture: true });

  // 其他來源的縮放（鍵盤＋－、內建點兩下）、旋轉
  map.on('zoomstart', (e) => { if (e.originalEvent) onZoom(); });
  map.on('rotatestart', (e) => { if (e.originalEvent) { onActivity(); onRotate(); } });
  map.on('pitchstart', (e) => { if (e.originalEvent) onActivity(); });
  return { sync };
}

// 暫離後自動回去的秒數（設定頁可改；0＝永不）
export function resumeMs() {
  let v = null;
  try { v = localStorage.getItem('qiji:resume'); } catch { /* 私密模式 */ }
  return (v == null ? 10 : +v) * 1000;
}

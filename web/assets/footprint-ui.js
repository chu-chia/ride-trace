// 足跡頁的改版外觀（照 ride-trace-redesign/footprint.html）：手機上方的標題列＋迷霧鍵、地圖模式膠囊、抽屜收起時的四個數字。
// 只接 footprint.js 現有的元素和分頁，不改資料與地圖邏輯。
import { api, $, $$ } from '/assets/common.js';

const NARROW = matchMedia('(max-width: 760px)');
// 手機直向：標題列搬到畫面上方浮動（圓形返回鍵＋膠囊＋圓形迷霧鍵），電腦放回側欄
const place = () => { if (NARROW.matches) $('#rtop').append($('#head')); else $('#side').insertBefore($('#head'), $('#fpKv')); };
place(); NARROW.addEventListener('change', place);

// 迷霧鍵＝足跡分頁裡的「迷霧模式」勾選框
const fog = $('#optFog');
const syncFog = () => { $('#bFog').classList.toggle('on', fog.checked); $('#bFog').setAttribute('aria-pressed', String(fog.checked)); };
$('#bFog').onclick = () => { fog.checked = !fog.checked; fog.dispatchEvent(new Event('change')); syncFog(); };
fog.addEventListener('change', syncFog); syncFog();

// 地圖模式膠囊：就是原本的分頁（軌跡線＝足跡）。時間範圍：打開足跡分頁的時間範圍
const tabBtn = (t) => $(`#tabs [data-t="${t}"]`);
$('#fpMode').onclick = (e) => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  if (b.dataset.m === 'range') {
    tabBtn('footprint').click();
    if ($('#side').classList.contains('small')) $('#side .handle').click();
    setTimeout(() => $('#presets').scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
    return;
  }
  tabBtn(b.dataset.m).click();
};
const syncMode = () => {
  const cur = $('#tabs button.on')?.dataset.t;
  $$('#fpMode [data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === cur));
  $('#fpRange').textContent = `${$('#rangeTitle').textContent || '全部'} ▾`;
};
new MutationObserver(syncMode).observe($('#tabs'), { attributes: true, subtree: true, attributeFilter: ['class'] });
new MutationObserver(syncMode).observe($('#rangeTitle'), { childList: true, characterData: true, subtree: true });
syncMode();

// 收起時的四個數字：公里、探索面積、天數跟著足跡分頁目前的範圍；鄉鎮是全部
const mirror = (from, to) => { const f = () => { $(to).textContent = $(from).textContent; }; new MutationObserver(f).observe($(from), { childList: true, characterData: true, subtree: true }); f(); };
mirror('#stKm', '#kvKm'); mirror('#stArea', '#kvArea'); mirror('#stDays', '#kvDays');
api('/api/me/towns').then((t) => { $('#kvTowns').textContent = t.lit; $('#kvTownsOf').textContent = `鄉鎮 / ${t.total}`; }).catch(() => {});

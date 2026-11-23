// 足跡頁「統計」分頁的匯入卡片：上傳 GPX／KML／Google 時間軸 → 後端排進 Stream，由 worker 合併重建 → 這裡每秒查進度。
import { api, $, esc } from '/assets/common.js';

const pick = $('#impPick'), file = $('#impFile'), box = $('#impStatus');
const MAX = 100 * 1024 * 1024;
const PHASE = { queued: '排隊中', parsing: '讀取檔案', merging: '比對與計算', writing: '寫入足跡', done: '完成', error: '失敗' };
const fmtN = (n) => (n ?? 0).toLocaleString('zh-TW');
const fmtSize = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

function show(msg, pct, err = false) {
  box.hidden = false;
  box.classList.toggle('err', err);
  $('#impMsg').textContent = msg;
  $('#impPct').textContent = pct == null ? '' : `${pct}%`;
  $('#impBar').style.width = `${pct ?? 0}%`;
}

function summary(j) {
  if (j.status === 'error') return j.msg || '匯入失敗';
  if (j.status !== 'done') return PHASE[j.status] || j.msg || '處理中';
  if (!j.added) return `沒有新的點（${fmtN(j.dup)} 個點已經在足跡裡）`;
  const extra = [j.dup ? `重複 ${fmtN(j.dup)}` : '', j.skipped ? `略過跳點 ${fmtN(j.skipped)}` : ''].filter(Boolean).join('、');
  return `新增 ${fmtN(j.added)} 個點${extra ? `（${extra}）` : ''}`;
}

async function renderList() {
  try {
    const { imports } = await api('/api/footprint/imports');
    $('#impList').innerHTML = imports.slice(0, 5).map((j) => `<div class="imp-row"><b>${esc(j.name || '檔案')}</b><span>${esc(summary(j))}<br>${esc(j.format || '')}${j.created ? ` · ${new Date(j.created).toLocaleDateString('zh-TW')}` : ''}</span></div>`).join('');
    return imports;
  } catch { return []; }
}

async function follow(job) {
  pick.classList.add('busy');
  for (;;) {
    let j;
    try { j = await api(`/api/footprint/imports/${job}`); } catch (e) { show(e.message, null, true); break; }
    if (j.status === 'done') {
      show(summary(j), 100);
      await renderList();
      if (j.added) {
        $('#impMsg').textContent = `${summary(j)}，重新整理中…`;
        setTimeout(() => location.reload(), 1500);  // 足跡、鄉鎮、熱力圖都換了，直接重載最單純
      }
      break;
    }
    if (j.status === 'error') { show(j.msg || '匯入失敗', null, true); await renderList(); break; }
    const total = j.total ? `（${fmtN(j.total)} 個點）` : '';
    show(`${j.msg || PHASE[j.status] || '處理中'}${total}`, j.pct ?? 0);
    await new Promise((res) => setTimeout(res, 1000));
  }
  pick.classList.remove('busy');
}

file.onchange = async () => {
  const f = file.files[0];
  file.value = '';
  if (!f) return;
  if (f.size > MAX) { show('檔案超過 100 MB，可以先壓成 ZIP 再上傳', null, true); return; }
  pick.classList.add('busy');
  show(`上傳 ${f.name}（${fmtSize(f.size)}）`, 0);
  try {
    const res = await fetch('/api/footprint/import', { method: 'POST', credentials: 'same-origin', body: f, headers: { 'x-filename': encodeURIComponent(f.name) } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.detail || `上傳失敗（${res.status}）`);
    await follow(d.job);
  } catch (e) {
    show(e.message, null, true);
    pick.classList.remove('busy');
  }
};

// 沒有足跡時分頁列是藏起來的：把匯入卡片直接搬到空狀態卡片下面
$('#impGo')?.addEventListener('click', () => {
  const card = $('#impCard');
  card.classList.add('inline');
  $('#fpEmpty').after(card);
  $('#impGo').hidden = true;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

// 重新整理頁面時，如果還有進行中的匯入，接著顯示進度
renderList().then((list) => {
  const running = list.find((j) => !['done', 'error'].includes(j.status));
  if (running) follow(running.job);
});

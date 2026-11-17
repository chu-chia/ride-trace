// 管理後台的「測試工具」：推播、行程事件、外部資料。後端在 backend/app/admin_test.py。
import { api, $, esc } from '/assets/common.js';

let I = null;  // /api/admin/test/info
const now = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });

function log(html, bad = false) {
  const box = $('#tLog');
  if (box.dataset.started !== '1') { box.innerHTML = ''; box.dataset.started = '1'; }
  const row = document.createElement('div');
  row.innerHTML = `<time>${now()}</time><span class="${bad ? 'bad' : ''}">${html}</span>`;
  box.prepend(row);
}
async function run(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { log(esc(e.message), true); } finally { btn.disabled = false; }
}

async function load() {
  I = await api('/api/admin/test/info');
  // 推播對象：有開通知的人＋我自己
  const users = [...I.push_users];
  if (!users.some((u) => u.uid === I.me)) users.unshift({ uid: I.me, name: '我', devices: 0 });
  $('#tPushTo').innerHTML = users.map((u) => `<option value="${u.uid}">${esc(u.uid === I.me ? `我（${u.name}）` : u.name)}（${u.devices} 台）</option>`).join('');
  $('#tPushHint').textContent = !I.push_enabled ? '伺服器沒有推播金鑰（.env 的 VAPID_*）'
    : I.push_users.length ? '手機要先在行程頁「回報」分頁開啟通知，才會出現在這裡。' : '還沒有人開通知：到行程頁「回報」分頁開啟。';
  // 行程
  const ST = { live: '進行中', planned: '未開始', ended: '已結束' };
  $('#tTrip').innerHTML = I.trips.map((t) => `<option value="${t.id}">${t.mine ? '★ ' : ''}#${t.id} ${esc(t.name)}（${ST[t.status] || t.status}）</option>`).join('');
  $('#tEvents').innerHTML = Object.entries(I.events).map(([k, e]) => `<button class="btn" data-ev="${k}" data-who="${e.who ? 1 : 0}">${esc(e.name)}</button>`).join('');
  fillWho();
  // 外部資料
  $('#tTdx').innerHTML = I.tdx.enabled ? `TDX 省道事件 ${I.tdx.count} 筆 · 快取還剩 ${I.tdx.fresh_s} 秒 · 本月呼叫 ${I.tdx.calls} 次（每月 4,500 次）` : 'TDX 沒有設定金鑰';
  $('#tCounty').innerHTML = '<option value="">選縣市…</option>' + I.cwa.counties.map((c) => `<option>${c}</option>`).join('');
}
function trip() { return I.trips.find((t) => t.id === $('#tTrip').value); }
function fillWho() {
  const t = trip();
  if (!t) return;
  // 預設選「不是我」的人，這樣推播才會推到我的手機
  const other = t.members.find((m) => m.uid !== I.me);
  $('#tWho').innerHTML = t.members.map((m) => `<option value="${m.uid}" ${other && m.uid === other.uid ? 'selected' : ''}>${esc(m.uid === I.me ? `我（${m.name}）` : m.name)}</option>`).join('');
  $('#tOpen').href = `/trip?id=${t.id}`;
}
$('#tTrip').addEventListener('change', fillWho);

$('#tPush').onclick = (e) => run(e.target, async () => {
  const r = await api('/api/admin/test/push', { method: 'POST', body: { to: $('#tPushTo').value } });
  log(r.sent ? `推播已送出給 <b>${esc(r.name)}</b>：${r.sent}/${r.devices} 台裝置的推播服務收下了，手機幾秒內會跳出來`
    : `<b>${esc(r.name)}</b> 沒有送出去：${r.devices ? '推播服務拒絕（訂閱可能過期，請在手機重新開啟通知）' : '這個人還沒有開通知的裝置'}`, !r.sent);
});

$('#tEvents').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ev]');
  if (!b) return;
  run(b, async () => {
    const r = await api('/api/admin/test/event', { method: 'POST', body: { trip: $('#tTrip').value, type: b.dataset.ev, who: $('#tWho').value } });
    const withDev = r.recipients.filter((x) => x.devices);
    const to = r.recipients.length
      ? `會推給 ${r.recipients.map((x) => `${esc(x.name)}${x.devices ? `（${x.devices} 台）` : ''}`).join('、')}` : '這個事件沒有推播對象';
    log(`<b>${esc(r.name)}</b>${r.who ? `（${esc(r.who)}）` : ''}：${esc(r.text)}<br><span class="muted">${to}${r.recipients.length && !withDev.length ? '，但都沒有開通知' : ''}</span>`);
  });
});

$('#tClean').onclick = (e) => run(e.target, async () => {
  const r = await api('/api/admin/test/cleanup', { method: 'POST', body: { trip: $('#tTrip').value } });
  log(`已清掉 #${esc($('#tTrip').value)} 的 ${r.deleted} 筆測試事件（行程頁重新整理後就不見了）`);
});

$('#tTdxBtn').onclick = (e) => run(e.target, async () => {
  const r = await api('/api/admin/test/tdx-refresh', { method: 'POST' });
  log(`TDX 路況已更新：${r.count} 筆，本月呼叫 ${r.calls} 次`);
  await load();
});

$('#tCounty').addEventListener('change', async (e) => {
  const c = e.target.value;
  if (!c) { $('#tWx').innerHTML = ''; return; }
  try {
    const r = await api(`/api/admin/test/weather?county=${encodeURIComponent(c)}`);
    $('#tWx').innerHTML = r.towns.map((t) => `<tr><td>${esc(t.town)}</td><td class="r num"><b>${t.now ?? '—'}%</b></td><td class="muted">${esc(t.slot)}</td><td class="r muted num">之後 ${t.next.map((x) => x + '%').join(' / ')}</td></tr>`).join('');
    log(`${esc(c)} 降雨機率：快取還剩 ${Math.max(0, r.cache_ttl)} 秒，本月呼叫氣象署 ${r.calls} 次`);
  } catch (err) { log(esc(err.message), true); }
});

// 等後台主畫面確認是管理者（#app 顯示）再載入
const wait = setInterval(() => { if (!$('#app').hidden) { clearInterval(wait); load().catch((e) => log(esc(e.message), true)); } }, 300);

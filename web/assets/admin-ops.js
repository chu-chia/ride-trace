// 管理後台維運工具；危險操作使用頁面內對話框確認。
import { api, $, esc } from '/assets/common.js';

const base = '/api/admin/ops';
const status = { planned: '未開始', live: '進行中', ended: '已結束' };
const fmt = (value) => value ? new Date(Number(value)).toLocaleString('zh-TW', { hour12: false }) : '—';
let map;
let marker;

function message(text, error = false) {
  const el = $('#opsMessage');
  el.textContent = text;
  el.style.color = error ? 'var(--crit-ink)' : '';
}

async function run(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
}

function confirmAction(text) {
  return new Promise((resolve) => {
    const dialog = $('#opsDialog');
    $('#opsDialogText').textContent = text;
    const finish = (yes) => { dialog.close(); resolve(yes); };
    $('#opsCancel').onclick = () => finish(false);
    $('#opsConfirm').onclick = () => finish(true);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

async function loadTrips() {
  const data = await api(`${base}/trips`);
  $('#opsTrips').innerHTML = data.trips.map((trip) => `<tr data-id="${esc(trip.id)}"><td>#${esc(trip.id)}</td><td>${esc(trip.name)}</td><td>${esc(status[trip.status] || trip.status)}</td><td>${esc(trip.owner)}（#${esc(trip.owner_uid)}）</td><td>${trip.members}／${trip.active}</td><td>${fmt(trip.started)}<br>${fmt(trip.ended_at)}</td><td><div class="ops-actions">
    ${trip.status === 'live' ? '<button class="btn danger" data-action="end">強制結束</button>' : ''}
    ${trip.status === 'ended' ? '<button class="btn" data-action="restart">重新開始</button>' : ''}
    <button class="btn danger" data-action="delete">刪除行程</button>
    <a class="btn" target="_blank" rel="noopener" href="/trip?id=${trip.id}">行程頁</a>
    <a class="btn" target="_blank" rel="noopener" href="/war?id=${trip.id}">戰情室</a>
    <a class="btn" target="_blank" rel="noopener" href="/replay?id=${trip.id}">回放</a>
  </div></td></tr>`).join('') || '<tr><td colspan="7">沒有行程</td></tr>';
}

$('#opsTripsReload').onclick = (event) => run(event.currentTarget, loadTrips);
$('#opsTrips').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  run(button, async () => {
    const tid = button.closest('tr').dataset.id;
    const action = button.dataset.action;
    const names = { end: '強制結束', restart: '重新開始', delete: '永久刪除' };
    const extra = action === 'delete' ? '軌跡、時序、事件、成員關聯也會刪除，無法復原。' : '';
    if (!await confirmAction(`確定要${names[action]}行程 #${tid}？${extra}`)) return;
    if (action === 'delete' && !await confirmAction(`再次確認：永久刪除行程 #${tid} 及其相關資料？`)) return;
    await api(`${base}/trips/${tid}${action === 'delete' ? '' : `/${action}`}`, { method: action === 'delete' ? 'DELETE' : 'POST' });
    message(`行程 #${tid} 已${names[action]}`);
    await loadTrips();
  });
});

function uid() { return $('#opsUser').value; }
async function loadUsers() {
  const previous = uid();
  const data = await api(`${base}/users`);
  $('#opsUser').innerHTML = data.users.map((user) => `<option value="${user.uid}">#${user.uid} ${esc(user.nickname)}（${esc(user.username)}）</option>`).join('');
  if (data.users.some((user) => user.uid === previous)) $('#opsUser').value = previous;
  await loadUser();
}
async function loadUser() {
  if (!uid()) { $('#opsUserInfo').textContent = '沒有使用者'; return; }
  const data = await api(`${base}/users/${uid()}`);
  $('#opsUserInfo').textContent = `最後位置：${JSON.stringify(data.last, null, 2)}\nactive_trip：${data.active_trip || '無'}\n裝置 ID：${data.device_id || '無'}`;
  $('#opsNickname').value = data.nickname;
}
$('#opsUser').onchange = loadUser;
for (const [selector, path, name] of [
  ['#opsClearLast', 'last', '最後位置'],
  ['#opsClearActive', 'active-trip', 'active_trip'],
]) {
  $(selector).onclick = (event) => run(event.currentTarget, async () => {
    if (!await confirmAction(`確定清除使用者 #${uid()} 的${name}？`)) return;
    await api(`${base}/users/${uid()}/${path}`, { method: 'DELETE' });
    message(`已清除${name}`); await loadUser();
  });
}
$('#opsSaveNickname').onclick = (event) => run(event.currentTarget, async () => {
  const nickname = $('#opsNickname').value.trim();
  if (!nickname) throw new Error('請輸入暱稱');
  await api(`${base}/users/${uid()}/nickname`, { method: 'PATCH', body: { nickname } });
  message('暱稱已更新'); await loadUsers();
});
$('#opsResetPassword').onclick = (event) => run(event.currentTarget, async () => {
  const password = $('#opsPassword').value;
  if (password.length < 6) throw new Error('密碼至少 6 個字');
  if (!await confirmAction(`確定重設使用者 #${uid()} 的密碼？`)) return;
  await api(`${base}/users/${uid()}/password`, { method: 'POST', body: { password } });
  $('#opsPassword').value = '';
  message('密碼已重設');
});

function initMap() {
  if (typeof maplibregl === 'undefined') { $('#opsMap').textContent = '地圖無法載入，仍可手動輸入經緯度。'; return; }
  map = new maplibregl.Map({ container: 'opsMap', style: 'https://tiles.openfreemap.org/styles/liberty', center: [121, 23.8], zoom: 6.5 });
  map.on('click', ({ lngLat }) => {
    $('#opsLat').value = lngLat.lat.toFixed(6);
    $('#opsLon').value = lngLat.lng.toFixed(6);
    if (marker) marker.remove();
    marker = new maplibregl.Marker().setLngLat(lngLat).addTo(map);
  });
}
$('#opsInject').onclick = (event) => run(event.currentTarget, async () => {
  const lat = Number($('#opsLat').value), lon = Number($('#opsLon').value);
  if (!$('#opsLat').value || !$('#opsLon').value || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('請輸入有效經緯度');
  if (!await confirmAction(`確定為使用者 #${uid()} 注入位置 ${lat}, ${lon}？這會寫入足跡及進行中的行程。`)) return;
  const data = await api(`${base}/inject`, { method: 'POST', body: { uid: uid(), lat, lon } });
  $('#opsInjectResult').textContent = JSON.stringify(data, null, 2);
  message(data.stale ? '位置已送出，但被判定為舊點' : '位置已送出');
  await loadUser();
});

$('#opsRedisSearch').onclick = (event) => run(event.currentTarget, async () => {
  const key = $('#opsRedisKey').value.trim(), pattern = $('#opsRedisPattern').value.trim();
  if (Boolean(key) === Boolean(pattern)) throw new Error('請只輸入完整 key 或 pattern');
  const data = await api(`${base}/redis?${key ? `key=${encodeURIComponent(key)}` : `pattern=${encodeURIComponent(pattern)}`}`);
  const box = $('#opsRedisResult');
  box.replaceChildren();
  for (const item of data.items) {
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${item.key} · ${item.type} · TTL ${item.ttl}`;
    const pre = document.createElement('pre');
    pre.className = 'ops-pre';
    pre.textContent = JSON.stringify(item.value, null, 2);
    detail.append(summary, pre);
    box.append(detail);
  }
  if (!data.items.length) box.textContent = '找不到資料';
});
async function loadSystem() {
  const data = await api(`${base}/system`);
  $('#opsSystem').textContent = `模擬中的行程：${data.simulating_trips}\nDBSIZE：${data.dbsize}\n記憶體：${data.used_memory_human}（${data.used_memory} bytes）\n` + data.streams.map((stream) => `${stream.name}：${stream.length} 筆\n${stream.groups.map((group) => `  ${group.name}：lag ${group.lag ?? '—'}，pending ${group.pending}`).join('\n')}`).join('\n');
}
$('#opsSystemReload').onclick = (event) => run(event.currentTarget, loadSystem);

// 與既有後台相同：主畫面確認管理權限後才載入工具。
const wait = setInterval(() => {
  if ($('#app').hidden) return;
  clearInterval(wait);
  initMap();
  Promise.all([loadTrips(), loadUsers(), loadSystem()]).catch((error) => message(error.message, true));
}, 300);

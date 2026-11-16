// 管理後台：每 5 秒更新一次；key 分布 60 秒更新（後端也快取 60 秒）。
import { api, $, esc } from '/assets/common.js';

const fmtB = (b) => (b > 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const fmtT = (ms) => (ms ? new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const TYPE_NAME = { hash: 'Hash', string: 'String', zset: 'Sorted Set / GEO', set: 'Set', stream: 'Stream', 'TSDB-TYPE': 'TimeSeries', 'ReJSON-RL': 'JSON', list: 'List', trietype0: '自動完成字典（FT.SUGADD）' };

function chart(svg, pts) {
  const W = 600, H = 140;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!pts.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="currentColor" opacity=".5" text-anchor="middle" font-size="13">最近 10 分鐘沒有資料</text>`; return; }
  const t0 = Date.now() - 600000, max = Math.max(1, ...pts.map((p) => p[1]));
  const xy = pts.map(([t, v]) => `${((t - t0) / 600000) * W},${H - 18 - (v / max) * (H - 30)}`);
  svg.innerHTML = `<polyline points="${xy.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${pts.map(([t, v]) => `<circle cx="${((t - t0) / 600000) * W}" cy="${H - 18 - (v / max) * (H - 30)}" r="2.5" fill="var(--accent)"/>`).join('')}
    <text x="4" y="12" fill="currentColor" opacity=".6" font-size="11">最高 ${max.toFixed(1)}/秒</text>
    <text x="4" y="${H - 4}" fill="currentColor" opacity=".5" font-size="11">10 分鐘前</text><text x="${W - 4}" y="${H - 4}" fill="currentColor" opacity=".5" font-size="11" text-anchor="end">現在</text>`;
}

async function tick() {
  let d;
  try { d = await api('/api/admin/overview'); } catch (e) { $('#denied').hidden = false; $('#denied').textContent = e.message; $('#upd').textContent = ''; return false; }
  $('#app').hidden = false;
  const rd = d.redis;
  $('#kMem').textContent = rd.used_memory_human;
  $('#kKeys').textContent = rd.keys.toLocaleString();
  $('#kOps').textContent = rd.ops_per_sec;
  $('#kOnline').textContent = d.online.reporting_2min;
  $('#kWs').textContent = d.online.ws_connections;
  $('#kLive').textContent = d.trips.live.length;
  chart($('#cWrites'), d.series.writes);
  chart($('#cPub'), d.series.pubsub);
  $('#groupsT').innerHTML = d.groups.map((g) => `<tr><td>${esc(g.name)}</td><td class="r num">${g.consumers}</td><td class="r num">${g.pending}</td><td class="r num">${g.lag ?? '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">沒有</td></tr>';
  $('#data').innerHTML = Object.entries(d.data).map(([n, m]) => `<tr><td>${esc(n)}</td><td class="muted">${esc(m.source || '—')}</td><td class="r num">${m.count ? m.count.toLocaleString() : '—'}</td><td class="r">${fmtT(m.updated)}</td></tr>`).join('')
    + `<tr><td>路網（Valhalla）</td><td class="muted">${d.valhalla.ok ? '本機 ' + esc(d.valhalla.version || '') : '沒有回應'}</td><td class="r">—</td><td class="r">${d.valhalla.tileset ? fmtT(d.valhalla.tileset * 1000) : '—'}</td></tr>`;
  $('#live').innerHTML = d.trips.live.map((t) => `<tr><td>${esc(t.name)}</td><td class="r num">${t.riders}</td><td class="r"><a href="/war?id=${t.id}" target="_blank">戰情室</a></td></tr>`).join('') || '<tr><td colspan="3" class="muted">目前沒有</td></tr>';
  const hit = rd.hits + rd.misses ? Math.round((rd.hits / (rd.hits + rd.misses)) * 100) : 0;
  $('#redis').innerHTML = [['版本', rd.version], ['已執行', `${Math.floor(rd.uptime_s / 3600)} 小時`], ['峰值記憶體 / RSS', `${rd.peak_human} / ${rd.rss_human}`],
    ['用戶端連線', rd.clients], ['Pub/Sub 頻道 / pattern', `${rd.pubsub_channels} / ${rd.pubsub_patterns}`], ['快取命中率', `${hit}%`],
    ['AOF', rd.aof ? '開啟' : '關閉'], ['上次 RDB 存檔', fmtT(rd.last_save * 1000)], ['帳號數', d.online.users], ['今天有回報的人', d.online.reporting_today]]
    .map(([k, v]) => `<tr><td class="muted">${k}</td><td class="r">${esc(String(v))}</td></tr>`).join('');
  $('#upd').textContent = `更新於 ${new Date(d.now).toLocaleTimeString('zh-TW', { hour12: false })}`;
  return true;
}

async function keys() {
  const k = await api('/api/admin/keys');
  const total = Object.values(k.types).reduce((a, b) => a + b, 0);
  $('#types').innerHTML = Object.entries(k.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<div class="br"><span>${esc(TYPE_NAME[t] || t)}</span>
    <div class="t"><i style="width:${(n / total) * 100}%"></i></div><em class="num">${n.toLocaleString()}</em></div>`).join('');
  const max = Math.max(1, ...k.groups.map((g) => g.est_bytes));
  $('#groups').innerHTML = k.groups.map((g) => `<div class="br"><span>${esc(g.prefix)}:*</span>
    <div class="t"><i style="width:${(g.est_bytes / max) * 100}%"></i></div><em class="num">${fmtB(g.est_bytes)} · ${g.keys.toLocaleString()}</em></div>`).join('');
  $('#kAt').textContent = `共 ${total.toLocaleString()} 個 · ${new Date(k.at).toLocaleTimeString('zh-TW', { hour12: false })}`;
}

(async () => {
  if (!(await tick())) return;
  keys();
  setInterval(tick, 5000);
  setInterval(keys, 60000);
})();

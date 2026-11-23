// 騎跡展示模式：只在 GitHub Pages 的展示版載入（scripts/pages/build.py 注入到每一頁 <head> 的最前面）。
// 把 fetch('/api/…') 和 WebSocket('/ws/…') 換成 report/demo-data/ 裡錄好的資料，頁面本身的程式完全不改。
// 錄製方式見 scripts/pages/record_demo.py。
(() => {
  const BASE = '__BASE__';            // build.py 換成 /ride-trace/app/
  const DATA = BASE + 'demo-data/';
  const file = location.pathname.split('/').pop() || 'index.html';
  const page = file.replace(/\.html$/, '') || 'index';
  const q = new URLSearchParams(location.search);
  const id = q.get('id') || q.get('trip') || '';
  const realFetch = window.fetch.bind(window);
  const RealWS = window.WebSocket;
  const loadedAt = Date.now();

  // ---------- 深淺色：跟報告網頁同步（同一個網域，共用 localStorage） ----------
  let theme = q.get('theme');
  try { theme = theme || localStorage.getItem('rt-report-theme'); } catch { /* 私密模式 */ }
  if (theme === 'light') {
    window.__demoStyle = 'light';
    document.documentElement.dataset.theme = 'light';
    try { localStorage.setItem('qiji.loginTheme', 'light'); } catch { /* */ }
  } else {
    window.__demoStyle = null;
    document.documentElement.dataset.theme = 'dark';
    try { localStorage.setItem('qiji.loginTheme', 'dark'); } catch { /* */ }
  }
  addEventListener('message', (e) => { if (e.data && e.data.rtTheme) location.reload(); });

  // 報告封面：只要登入頁的地圖，把標誌、路線卡、表單都藏起來
  if (page === 'login' && q.has('cover')) {
    const st = document.createElement('style');
    st.textContent = '.hero-brand,.routecard,.theme-btn,.side{display:none!important}.stage{position:fixed!important;inset:0!important;width:auto!important}';
    document.documentElement.append(st);
  }
  // 焦點在嵌入的頁面裡時，簡報用的按鍵還是交給報告（S 切換、Esc 離開、PageUp/PageDown 是簡報器的翻頁鍵）
  if (window.parent !== window) {
    addEventListener('keydown', (e) => {
      if (!['s', 'S', 'Escape', 'PageUp', 'PageDown'].includes(e.key) || e.target.closest?.('input,textarea')) return;
      try { window.parent.postMessage({ rtKey: e.key }, location.origin); e.preventDefault(); } catch { /* */ }
    }, true);
  }

  // ---------- 不要真的去定位、註冊推播 ----------
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('展示模式')); } catch { /* */ }
  try {
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition = () => 0;
      navigator.geolocation.getCurrentPosition = () => {};
      navigator.geolocation.clearWatch = () => {};
    }
  } catch { /* */ }

  // ---------- 讀錄好的資料 ----------
  const load = (n) => realFetch(DATA + n + '.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const live = page === 'trip' || page === 'war';
  // 足跡資料（格子、鄉鎮、熱力圖）約 3 MB，只有首頁和足跡頁要
  const wantFp = page === 'index' || page === 'footprint';
  const ready = Promise.all([wantFp ? load('footprint') : null, page === 'footprint' ? null : load(id ? `${page}-${id}` : page), live && id ? load(`trip-${id}`) : null])
    .then(([fp, own, liveData]) => {
      if (page === 'index' && fp) delete fp.http['GET /api/me'];  // 首頁：身分用展示帳號（進行中的行程），足跡卡片用 wei 的
      const sets = [own, page === 'war' ? liveData : null, fp].filter(Boolean);
      return { sets, ws: liveData?.ws || own?.ws || null, wsT0: liveData?.t0 || own?.t0 || loadedAt };
    });

  // 錄影當下的時間 → 現在：只平移「錄影前 12 小時到之後 2 天」的毫秒時間戳（舊行程、舊足跡不動）
  function shifter(t0) {
    const d = loadedAt - t0, lo = t0 - 12 * 3600e3, hi = t0 + 48 * 3600e3;
    const fix = (v) => {
      if (typeof v === 'number') return v > lo && v < hi ? v + d : v;
      if (typeof v === 'string' && /^\d{13}$/.test(v)) { const n = +v; return n > lo && n < hi ? String(n + d) : v; }
      if (Array.isArray(v)) return v.map(fix);
      if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = fix(v[k]); return o; }
      return v;
    };
    return fix;
  }

  function lookup(sets, method, u, kind) {
    const exact = kind ? `${method} ${u.pathname}#${kind}` : `${method} ${u.pathname}${u.search}`, bare = `${method} ${u.pathname}`;
    for (const s of sets) {
      const H = s.http || {};
      if (H[exact]) return [H[exact], s.t0];
      if (H[bare]) return [H[bare], s.t0];
      const pre = Object.keys(H).find((k) => k.startsWith(bare + '?'));
      if (pre) return [H[pre], s.t0];
    }
    return null;
  }

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  // ---------- 匯入足跡：假裝跑一遍進度 ----------
  let importAt = 0;
  function importJob() {
    const s = (Date.now() - importAt) / 1000;
    const steps = [[0, 'queued', '排隊中', 2], [1, 'parsing', '讀取檔案', 8], [2.5, 'merging', '比對與計算', 30], [4.5, 'writing', '寫入足跡', 70], [7, 'done', '完成', 100]];
    const [, status, msg, pct] = steps.filter((x) => s >= x[0]).pop();
    return { job: 'demo', name: '靈感足跡匯出.gpx', status, msg: status === 'done' ? '完成（展示模式不會真的寫入）' : msg, pct, format: 'GPX',
      total: 48213, ...(status === 'done' ? { added: 0, dup: 48213, skipped: 0 } : {}), created: importAt };
  }

  let toasted = false;
  function demoToast() {
    if (toasted) return; toasted = true;
    const el = document.createElement('div');
    el.textContent = '展示模式：操作不會真的送出';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:999px;background:rgba(20,22,26,.92);color:#fff;font:600 13px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    document.body.appendChild(el);
    setTimeout(() => { el.remove(); toasted = false; }, 2600);
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url, location.href);
    if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const fx = await ready;
    if (u.pathname === '/api/footprint/import' && method === 'POST') { importAt = Date.now(); return json({ job: 'demo' }); }
    if (u.pathname === '/api/footprint/imports/demo') return json(importJob());
    if (u.pathname === '/api/footprint/imports') return json({ imports: importAt ? [importJob()] : [] });
    if (method === 'POST' && (u.pathname === '/api/poi/along' || u.pathname === '/api/routes/preview')) {
      let kind = '';
      try { kind = JSON.parse(init.body || '{}').kind || ''; } catch { /* */ }
      const hit = lookup(fx.sets, 'POST', new URL(u.pathname + (kind ? '#' + kind : ''), location.href), kind);
      if (hit) return json(shifter(hit[1])(hit[0].body), hit[0].status || 200);
    }
    if (method !== 'GET') { demoToast(); return json({ ok: true, demo: true }); }
    const hit = lookup(fx.sets, method, u);
    if (!hit) return json({ detail: '展示模式沒有這筆資料' }, 404);
    const [rec, t0] = hit;
    return json(shifter(t0)(rec.body), rec.status || 200);
  };

  // ---------- WebSocket：照錄影的時間重播，播完重新整理再來一次 ----------
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob';
      this._l = {}; this._i = 0; this._path = new URL(url, location.href).pathname;
      setTimeout(() => this._open(), 60);
    }
    addEventListener(t, f) { (this._l[t] ||= []).push(f); }
    removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((x) => x !== f); }
    _emit(t, e) { this['on' + t]?.(e); (this._l[t] || []).forEach((f) => f(e)); }
    send() {}
    close(code = 1000) {
      if (this.readyState >= 2) return;
      this.readyState = 3; clearInterval(this._tick);
      this._emit('close', { code, reason: '', wasClean: true });
    }
    async _open() {
      this.readyState = 1; this._emit('open', {});
      const fx = await ready;
      const frames = fx.ws?.[this._path];
      if (!frames || !frames.length) return;
      const fix = shifter(fx.wsT0);
      const fixed = (raw) => { try { return JSON.stringify(fix(JSON.parse(raw))); } catch { return raw; } };
      const elapsed = () => Date.now() - loadedAt;
      // 中途重連：先送第一則（snapshot），再從現在的位置接著播
      this._emit('message', { data: fixed(frames[0][1]) });
      this._i = 1;
      while (this._i < frames.length && frames[this._i][0] <= elapsed()) this._i++;
      const end = frames[frames.length - 1][0];
      this._tick = setInterval(() => {
        if (this.readyState !== 1) return;
        const t = elapsed();
        while (this._i < frames.length && frames[this._i][0] <= t) this._emit('message', { data: fixed(frames[this._i++][1]) });
        if (t > end + 4000) location.reload();
      }, 200);
    }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = function (url, p) {
    return new URL(url, location.href).pathname.startsWith('/ws/') ? new FakeWS(url) : new RealWS(url, p);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();

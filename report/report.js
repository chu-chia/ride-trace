// 騎跡報告網頁：目錄、右側操作展示（展示資料／正式機）、簡報模式、互動元件。純原生，沒有函式庫。
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LIVE = 'https://node.tail866fc3.ts.net:8443';
  const sections = $$('main > .ch');
  let TID = '';

  // ---------- 深淺色 ----------
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const syncThemeBtn = () => { $('#themeLbl').textContent = isLight() ? '切成深色' : '切成淺色'; };
  $('#bTheme').onclick = () => {
    const next = isLight() ? 'dark' : 'light';
    if (next === 'light') document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('rt-report-theme', next); } catch { /* 私密模式 */ }
    syncThemeBtn();
    $$('iframe').forEach((f) => { try { f.contentWindow?.postMessage({ rtTheme: next }, '*'); } catch { /* */ } });
  };
  syncThemeBtn();

  // ---------- 目錄 ----------
  const toc = $('#tocList');
  sections.forEach((s, i) => {
    if (s.dataset.group) { const g = document.createElement('li'); g.className = 'grp'; g.textContent = s.dataset.group; toc.append(g); }
    const li = document.createElement('li');
    const num = ($('.kicker', s)?.textContent.match(/^\d+/) || ['00'])[0];
    li.innerHTML = `<a href="#${s.id}"><b>${num}</b><span>${s.dataset.title}${s.dataset.demo ? ' ▶' : ''}</span></a>`;
    toc.append(li);
  });

  // ---------- 操作展示 ----------
  const DEMO = {
    login: { path: () => 'app/login.html', live: '/login' },
    home: { path: () => 'app/index.html', live: '/login' },
    trip: { path: () => `app/trip.html?id=${TID}&demoTab=team`, live: '/demo' },
    plan: { path: () => `app/plan.html?trip=${TID}`, live: '/login' },
    replay: { path: () => 'app/replay.html?id=48', live: '/login' },
    footprint: { path: () => 'app/footprint.html', live: '/login' },
    towns: { path: () => 'app/footprint.html?tab=towns', live: '/login' },
    heat: { path: () => 'app/footprint.html?tab=heat', live: '/login' },
    import: { path: () => 'app/footprint.html?tab=stats', live: '/login' },
    war: { path: () => `app/war.html?id=${TID}`, live: '/demo', desk: true },
    warPhone: { path: () => `app/war.html?id=${TID}`, live: '/demo' },
    tripRoute: { path: () => `app/trip.html?id=${TID}&demoTab=route`, live: '/demo' },
    tripMore: { path: () => `app/trip.html?id=${TID}&demoTab=more`, live: '/demo' },
    replayChart: { path: () => 'app/replay.html?id=48&demoTab=chart', live: '/login' },
    replayEv: { path: () => 'app/replay.html?id=48&demoTab=ev', live: '/login' },
    replaySum: { path: () => 'app/replay.html?id=48&demoTab=sum', live: '/login' },
    replay55: { path: () => 'app/replay.html?id=55', live: '/login' },
    replay55Ev: { path: () => 'app/replay.html?id=55&demoTab=ev', live: '/login' },
    replay55Chart: { path: () => 'app/replay.html?id=55&demoTab=chart', live: '/login' },
    about: { path: () => 'app/about.html', live: '/about' },
    settings: { path: () => 'app/settings.html', live: '/login' },
  };
  let src = 'demo', curKey = null, curUrl = '';
  const frame = $('#demoFrame'), device = $('#device'), stage = $('#stage');

  function urlFor(key) {
    const d = DEMO[key];
    if (!d) return '';
    return src === 'live' ? LIVE + d.live : d.path();
  }
  // 裝置外框：先放到容器正中央，再依容器大小縮放（不超過原尺寸）
  function fit(dev = device, box = stage) {
    const desk = dev.classList.contains('desk');
    const w = desk ? 1460 : 414, h = desk ? 880 : 868;
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    const sc = Math.min(bw / w, bh / h, 1);
    // 置中用負邊距（不用 translate），這樣旋轉動畫的 rotate 才會繞著中心轉
    const centered = getComputedStyle(dev).position === 'absolute';
    dev.style.margin = centered ? `${-h / 2}px 0 0 ${-w / 2}px` : '';
    // 右欄的手機貼齊上緣；戰情室（橫的）和簡報裡的外框垂直置中
    dev.style.top = centered ? (desk || box !== stage ? '50%' : `${(h * sc) / 2}px`) : '';
    dev.style.transform = `scale(${sc})`;
  }
  let lastCap = '';
  function show(key, cap) {
    curKey = key; lastCap = cap || '';
    if (document.body.classList.contains('demo-off') && !document.body.classList.contains('slides')) return;
    const has = !!DEMO[key];
    device.hidden = !has; $('#demoEmpty').hidden = has;
    $('#demoCap').innerHTML = has ? (cap || '') + (src === 'live' ? ' <span class="ln">｜正式機：Demo 車隊即時跑（其他頁要登入），連不到請切回展示資料。</span>' : '') : '';
    if (!has) return;
    const u = urlFor(key);
    $('#demoOpen').href = u;
    setDesk(!!DEMO[key].desk, () => { if (u !== curUrl) { curUrl = u; frame.src = u; } });
  }

  // 手機 ⇄ 桌機（戰情室）：手機轉成橫的再變成螢幕；回來時先橫著再轉正。用獨立的 rotate 屬性，跟 fit() 的 transform 疊加
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
  // 先換頁，新頁面載入完（或最多 2.5 秒）才做下一步
  let navSeq = 0;
  function afterNavigate(swap, then) {
    const my = ++navSeq;
    let done = false;
    const go = () => { if (done || my !== navSeq) return; done = true; then(); };
    frame.addEventListener('load', go, { once: true });
    turning = setTimeout(go, 2500);
    swap();
  }
  let turning = null;
  function setDesk(desk, swap) {
    const was = device.classList.contains('desk');
    clearTimeout(turning);
    if (was === desk || REDUCE.matches || device.hidden) {
      // 包含「轉到一半又捲回來」：把動畫的角度、縮放、透明度都還原
      Object.assign(device.style, { transition: 'none', rotate: '0deg', scale: '1', opacity: '1' });
      if (was && !desk) { afterNavigate(swap, () => { device.classList.remove('desk'); fit(); }); return; }
      device.classList.toggle('desk', desk); fit(); swap(); return;
    }
    // 直的手機轉成橫的之後，寬度變成原本的高度：另外用 scale 縮到放得進右欄
    const sideFit = () => {
      const bw = stage.clientWidth, bh = stage.clientHeight;
      const upright = Math.min(bw / 414, bh / 868, 1), sideways = Math.min(bw / 868, bh / 414, 1);
      return String(sideways / upright);
    };
    device.style.transition = 'rotate .42s cubic-bezier(.3,.7,.2,1), scale .42s cubic-bezier(.3,.7,.2,1), opacity .42s';
    if (desk) {
      device.style.rotate = '-90deg'; device.style.scale = sideFit(); device.style.opacity = '.55';     // 手機轉成橫的
      turning = setTimeout(() => {
        device.style.transition = 'none';
        device.classList.add('desk'); device.style.rotate = '0deg'; device.style.scale = '1'; fit(); swap();
        device.getBoundingClientRect();
        device.style.transition = 'opacity .35s'; device.style.opacity = '1';
      }, 430);
    } else {
      // 戰情室寬度一變就會 location.reload()：要先換成新頁面、等它載入完才把外框變窄，不然新頁面會被戰情室的重新整理蓋掉
      device.style.transition = 'opacity .2s'; device.style.opacity = '.55';
      afterNavigate(swap, () => {
        device.style.transition = 'none';
        device.classList.remove('desk'); fit(); device.style.rotate = '-90deg'; device.style.scale = sideFit();  // 先橫著
        device.getBoundingClientRect();
        device.style.transition = 'rotate .5s cubic-bezier(.3,.7,.2,1), scale .5s cubic-bezier(.3,.7,.2,1), opacity .5s';
        device.style.rotate = '0deg'; device.style.scale = '1'; device.style.opacity = '1';     // 轉正
      });
    }
  }
  $$('.demo-bar .seg button').forEach((b) => b.onclick = () => {
    src = b.dataset.src;
    $$('.demo-bar .seg button').forEach((x) => x.classList.toggle('on', x === b));
    curUrl = ''; show(curKey, lastCap);
  });
  // 收起／展開右側（收起時卸載嵌入的頁面，不佔 GPU；記在這台瀏覽器）
  const setDemoOff = (off) => {
    document.body.classList.toggle('demo-off', off);
    try { localStorage.setItem('rt-report-demo-off', off ? '1' : '0'); } catch { /* */ }
    if (off) { frame.src = 'about:blank'; curUrl = ''; } else { show(curKey, lastCap); }
  };
  $('#demoHide').onclick = () => setDemoOff(true);
  $('#demoShow').onclick = () => setDemoOff(false);
  try { if (localStorage.getItem('rt-report-demo-off') === '1') document.body.classList.add('demo-off'); } catch { /* */ }
  addEventListener('resize', () => { fit(); if (document.body.classList.contains('slides')) placeSlide(); });

  // 沒有專屬操作的章節（長捲動時）也放一個相關的頁面，右邊不會空著；簡報模式這些頁維持全寬
  const FALLBACK = {
    c01: ['warPhone', '<b>戰情室（手機版）</b>：全隊每個人的速度、海拔、離終點多遠，一眼看到誰落後、誰到了。'],
    c02: ['heat', '<b>熱力圖</b>：一年 16.5 萬個 GPS 點——寫入多、要地理查詢，正是這種資料。'],
    c03: ['about', '<b>關於頁</b>：App 裡也寫了每個功能用到哪個 Redis 特性。'],
    c04: ['replay55', '<b>回放（北宜）</b>：成員、即時狀態、軌跡點三個實體一起動起來的樣子。'],
    c04b: ['tripMore', '<b>行程頁 → 更多</b>：邀請碼就是 <code>SET invite:{code} {tid} NX EX</code>，24 小時後自己消失。'],
    c06: ['tripRoute', '<b>行程頁 → 路線</b>：按左邊「播放」，走到 PUBLISH 那一步，地圖上的隊友點會閃一下。'],
    c14: ['replay55Ev', '<b>回放（北宜）→ 事件</b>：抵達、落隊、全員到齊各只通知一次，靠 Lua 的原子性。'],
    c15: ['footprint', '<b>足跡頁</b>：一年的紀錄都在記憶體裡，靠 AOF＋RDB 保證關機不會掉。'],
    c16: ['replaySum', '<b>回放 → 摘要</b>：這種彙總在 Redis 要寫入時就算好（反正規化）；SQL 一個 GROUP BY 就好。'],
    c18: ['settings', '<b>設定頁</b>：導航視角、語音提示、省電模式……8 天裡一項一項加上去的細節。'],
    c18b: ['replay55Chart', '<b>回放 → 圖表</b>：每次改動都用無頭瀏覽器截這些畫面，確認圖表、地圖都正常。'],
    c19: ['home', '<b>首頁</b>：一年 358 天、32,764 km、點亮 298 個鄉鎮。'],
    c20: ['login', '<b>登入頁</b>：掃左邊的 QR code 打開正式機，可以自己註冊一個帳號試試。'],
  };
  const demoOf = (s) => s.dataset.demo ? [s.dataset.demo, s.dataset.cap] : FALLBACK[s.id] || null;
  // 捲到哪一章就切到哪一頁
  let curSec = null;
  const spy = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting || document.body.classList.contains('slides')) continue;
      const s = e.target;
      if (curSec === s) continue;
      curSec = s;
      $$('.toc li a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + s.id));
      const d = demoOf(s);
      if (d) show(d[0], d[1]);
    }
  }, { rootMargin: '-35% 0px -60% 0px' });
  sections.forEach((s) => spy.observe(s));

  // 窄螢幕：每一章放一顆「操作展示」按鈕，點了用全螢幕看
  sections.filter((s) => s.dataset.demo).forEach((s) => {
    const box = document.createElement('div');
    box.className = 'inline-demo';
    box.innerHTML = '<button class="tbtn primary" type="button">▶ 操作展示</button><button class="tbtn" type="button" data-live>正式機即時</button>';
    const lead = $('.lead', s) || $('h2', s);
    lead.after(box);
    box.querySelectorAll('button').forEach((b) => b.onclick = () => openSheet(s.dataset.demo, !!b.dataset.live));
  });
  function openSheet(key, live) {
    const d = DEMO[key];
    const u = live ? LIVE + d.live : d.path();
    const sh = document.createElement('div');
    sh.className = 'sheet';
    sh.innerHTML = `<button class="tbtn sheet-close" type="button">關閉</button><div class="device${d.desk ? ' desk' : ''}"><iframe src="${u}" title="騎跡操作展示"></iframe></div>`;
    document.body.append(sh);
    const dev = $('.device', sh);
    const f = () => fit(dev, sh);
    f(); addEventListener('resize', f);
    $('.sheet-close', sh).onclick = () => { removeEventListener('resize', f); sh.remove(); };
  }

  // 封面：登入頁的地圖當背景（等頁面其他東西先載完）
  // 捲離封面（或簡報翻到別頁）就把封面地圖卸掉，畫面上同時只跑一張會動的 3D 地圖，GPU 不會一直被佔著
  const cover = $('#coverFrame');
  let pageLoaded = false, coverOn = true;
  const syncCover = () => {
    const want = pageLoaded && coverOn;
    if (want && !cover.src.includes('login')) cover.src = cover.dataset.src;
    else if (!want && cover.src.includes('login')) cover.src = 'about:blank';
  };
  addEventListener('load', () => { pageLoaded = true; syncCover(); });
  new IntersectionObserver(([e]) => { coverOn = e.isIntersecting && (!document.body.classList.contains('slides') || sections[si] === sections[0]); syncCover(); }).observe($('#c00'));
  const coverForSlide = () => { coverOn = sections[si] === sections[0]; syncCover(); };

  // 表格裡的短欄位（標籤、指令）不換行，長的說明欄才換行；手機上表格變寬就左右滑
  $$('main td, main th').forEach((c) => { if (c.textContent.trim().length <= 12) c.style.whiteSpace = 'nowrap'; });

  // ---------- Redis／SQL 切換 ----------
  $$('[data-cmp]').forEach((c) => {
    c.querySelectorAll('.cmp-tabs button').forEach((b) => b.onclick = () => {
      c.querySelectorAll('.cmp-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      c.querySelectorAll('pre[data-v]').forEach((p) => { p.hidden = p.dataset.v !== b.dataset.v; });
    });
  });

  // ---------- 術語 ----------
  const GL = {
    pipeline: ['Pipeline', '把很多個指令一次送給 Redis、一次收回結果，只有一次網路來回。不保證原子性，只是省時間。'],
    pubsub: ['Pub/Sub', '發布／訂閱：PUBLISH 到一個頻道，所有 SUBSCRIBE 這個頻道的連線立刻收到。不保存，沒人聽就丟掉。'],
    stream: ['Stream', '只能往後加的紀錄（像日誌），每筆有遞增的 ID（預設是毫秒時間戳），可以依 ID 範圍讀，也可以當可靠的工作佇列。'],
    cg: ['Consumer Group', 'Stream 的消費者群組：同一組裡的多個 Worker 分攤訊息；處理完要 XACK，沒確認的會留在待處理清單，可以被別人接手。'],
    ttl: ['TTL', 'Time To Live：key 的存活時間，時間到 Redis 自動刪掉。'],
    keyspace: ['Keyspace Notification', 'Redis 在 key 發生事件（例如過期）時，發一則 Pub/Sub 訊息。設定 notify-keyspace-events Ex 就會通知過期事件。'],
    watch: ['WATCH（樂觀鎖）', '先 WATCH 一些 key，再 MULTI/EXEC；如果 EXEC 之前被別人改過，整個交易不執行、回傳 nil，程式重試。不用把資料鎖住。'],
    lua: ['Lua script', '在 Redis 裡執行的一小段程式，整段是原子的：執行期間不會有其他指令插進來。'],
    geo: ['GEO', '地理位置集合：GEOADD 放經緯度，GEOSEARCH 找半徑或方框內的成員。底層是用 geohash 當分數的 Sorted Set。'],
    ts: ['TimeSeries', 'Redis 的時間序列模組：TS.ADD 加資料點，TS.MRANGE 依標籤一次取多條序列，可以降採樣、分組聚合。'],
    idem: ['冪等', '同一個操作做一次和做很多次，結果一樣。訊息可能重送時，處理邏輯必須冪等。'],
    denorm: ['反正規化', '為了讀得快，把計算結果另外存一份（例如里程），寫入時就更新，讀的時候不用重算。'],
  };
  const tip = $('#tip');
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.t'); if (!t) return;
    const g = GL[t.dataset.t]; if (!g) return;
    tip.innerHTML = `<b>${g[0]}</b>${g[1]}`; tip.hidden = false;
    const r = t.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - 316, Math.max(8, r.left)) + 'px';
    tip.style.top = (r.bottom + 8 + 120 > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8) + 'px';
  });
  document.addEventListener('mouseout', (e) => { if (e.target.closest('.t')) tip.hidden = true; });
  $$('.t').forEach((t) => { t.tabIndex = 0; t.addEventListener('focus', () => t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))); t.addEventListener('blur', () => { tip.hidden = true; }); });

  // ---------- 一筆 GPS 回報 ----------
  const CMDS = [
    ['XADD', 'footprint:24 1795…-* lat lon ele', '全年足跡'],
    ['GEOADD', 'footprint:24:geo 121.28 24.18 ts', '熱力圖放大用'],
    ['INCR', 'fp:ver:24', '足跡快取失效'],
    ['SADD', 'fog:24:20260314:day 16125:80855 …', '迷霧格子'],
    ['HINCRBYFLOAT', 'footprint:24:daykm 20260314 0.03', '每日里程'],
    ['XADD', 'track:57:24 * lat lon speed …', '行程軌跡'],
    ['GEOADD', 'trip:57:geo 121.28 24.18 24', '即時位置'],
    ['TS.ADD', 'ts:57:24:speed ts 40.3', '速度曲線'],
    ['TS.ADD', 'ts:57:24:alt ts 2275', '海拔曲線'],
    ['PUBLISH', 'trip:57:live {"kind":"pos",…}', '推給全隊'],
    ['HSET', 'trip:57:state:24 lat lon status ok seen …', '隊員狀態'],
    ['SET', 'hb:57:24 … EX 90', '心跳'],
    ['ZADD', 'online:report now 24', '線上人數'],
    ['XADD', 'stream:ingest MAXLEN ~ 100000 * …', '交給 Worker'],
    ['TS.INCRBY', 'ts:sys:writes 1', '後台指標'],
  ];
  const pipe = $('#pipe');
  pipe.innerHTML = CMDS.map(([c, a, w]) => `<div${c === 'PUBLISH' ? ' data-pub="1"' : ''}><b>${c}</b> ${a}<span>${w}</span></div>`).join('');
  let playing = false;
  // 右邊手機裡的隊友標記閃一下：表示「PUBLISH 的這一刻，全隊畫面收到新位置」
  const pulsePhone = () => { try { frame.contentWindow?.postMessage({ rtPulse: true }, location.origin); } catch { /* */ } };
  $('#flowPlay').onclick = async () => {
    if (playing) return; playing = true;
    const btn = $('#flowPlay'), step = $('#flowStep'), msg = $('#flowMsg');
    const node = (n) => $(`.node[data-n="${n}"]`);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const say = (h) => { step.innerHTML = h; };
    btn.disabled = true;
    $$('.node, .pipe div').forEach((x) => x.classList.remove('lit', 'done')); msg.classList.remove('lit');
    say('<b>① 手機</b>每 2～3 秒送出一筆位置'); msg.textContent = `POST /api/track  { lat: 24.1838, lon: 121.2826, speed: 11.2, ts: ${Date.now()} }`;
    msg.classList.add('lit'); node('phone').classList.add('lit'); await wait(1400);
    say('<b>② API 用 Pipeline</b>把 15 個指令一次送給 Redis（只有一次網路來回）');
    const rows = $$('.pipe div');
    for (const r of rows) {
      r.classList.add('lit');
      if (r.dataset.pub) { say('<b>③ PUBLISH</b>：訂閱這個行程的瀏覽器立刻收到 → 看右邊手機，隊友的點更新了'); node('pub').classList.add('lit'); pulsePhone(); await wait(1600); }
      else await wait(260);
      r.classList.replace('lit', 'done');
    }
    say('<b>④ XADD stream:ingest</b>：交給 Worker，兩個 Consumer Group 各自處理（統計、警示）');
    node('stats').classList.add('lit'); node('alerts').classList.add('lit'); await wait(1800);
    say('完成：<b>一次網路來回、15 個指令</b>。真實系統裡每位騎士每 2～3 秒就跑一次這整條路徑');
    btn.disabled = false; btn.textContent = '↻ 再播一次';
    playing = false;
  };

  // ---------- 互動 ER 圖 ----------
  const ENT = {
    user: { x: 20, y: 30, t: '使用者 USER', k: 'uid PK・username UK', keys: [
      ['user:{uid}', 'Hash', 'HGETALL user:1\n→ username wei  nickname 嘉瑋  color #5ac8fa  pw scrypt$…'],
      ['username:{name}', 'String', 'SET username:wei 1 NX   ← UNIQUE 約束'],
      ['seq:user', 'String', 'INCR seq:user   ← AUTO_INCREMENT'],
      ['session:{tok}', 'String＋TTL', 'SET session:… 1 EX 2592000'] ] },
    trip: { x: 270, y: 30, t: '行程 TRIP', k: 'tid PK・owner FK', keys: [
      ['trip:{tid}', 'Hash', 'HGETALL trip:57\n→ name 中部橫貫公路…  owner 1  status live  route 33  started 1795…'],
      ['invite:{code}', 'String＋TTL', 'SET invite:QF963Z 57 NX EX 86400'],
      ['trip:{tid}:events', 'Stream', 'XRANGE trip:57:events - + COUNT 2\n→ 1795423845037-0 type start text Demo 第 1 圈開始\n→ 1795423845054-0 type town uid 24 text 點亮新鄉鎮：南投縣埔里鎮'] ] },
    mem: { x: 270, y: 160, t: '成員 MEMBERSHIP', k: 'tid FK・uid FK・role', keys: [
      ['trip:{tid}:members', 'Set', 'SMEMBERS trip:57:members → 1 24 25 26 27'],
      ['user:{uid}:trips', 'Sorted Set', 'ZRANGE user:1:trips 0 -1 → 48 55 56 57 …   ← 多對多的另一個方向'],
      ['trip:{tid}:role', 'Hash', 'HGET trip:57:role {uid} → viewer（只看）／car（後援車）；沒有＝騎士'] ] },
    state: { x: 520, y: 160, t: '即時狀態 RIDER_STATE', k: 'tid・uid・lat・lon・seen', keys: [
      ['trip:{tid}:geo', 'GEO', 'GEOPOS trip:57:geo 24 → 121.2826 24.1838'],
      ['trip:{tid}:state:{uid}', 'Hash', 'HGETALL trip:57:state:24\n→ lat 23.965019 lon 120.967162 alt 452.5 speed 0.0 batt 85\n  status ok seen 1795423853133 hbs 600 route_km 0.0'],
      ['hb:{tid}:{uid}', 'String＋TTL', 'SET hb:57:24 … EX 90；TTL hb:57:24 → 剩幾秒'] ] },
    track: { x: 520, y: 290, t: '軌跡點 TRACK_POINT', k: 'tid・uid・ts・lat・lon', keys: [
      ['track:{tid}:{uid}', 'Stream', 'XRANGE track:57:24 - + COUNT 1\n→ 1795423845047-0 lat 23.965019 lon 120.967162 alt 452.5\n  speed 0.0 acc 6.0 batt 85.0 src sim'],
      ['ts:{tid}:{uid}:speed', 'TimeSeries', 'TS.RANGE ts:57:24:speed - + AGGREGATION avg 60000'],
      ['trip:{tid}:stats:{uid}', 'Hash（反正規化）', 'HGETALL trip:57:stats:24 → km  max_kmh  moving_s  points\n  lts（最後處理的時間戳：Lua 用它去重）'] ] },
    route: { x: 20, y: 160, t: '路線 ROUTE', k: 'rid PK・coords・steps', keys: [
      ['route:{rid}', 'JSON', 'JSON.GET route:33 $.summary\n→ [{"km":139.21,"min":170,"points":3875}]'],
      ['trip:{tid}:waypoints', 'GEO', 'GEOSEARCH trip:57:waypoints FROMLONLAT … BYRADIUS 300 m'],
      ['trip:{tid}:arrived:{wid}', 'Set', 'SDIFF trip:57:active trip:57:arrived:2 → 還沒到的人'] ] },
    fp: { x: 20, y: 290, t: '足跡 FOOTPRINT', k: 'uid・ts・lat・lon', keys: [
      ['footprint:{uid}', 'Stream', 'XLEN footprint:1 → 165751'],
      ['fog:{uid}:{日}:{時段}', 'Set', 'SUNION fog:1:20260301:day fog:1:20260302:day …'],
      ['heat:{uid}', 'Sorted Set', 'ZREVRANGE heat:1 0 2 WITHSCORES\n→ 16687:81040 1830  16695:81016 1252  16694:81016 991'] ] },
    town: { x: 270, y: 290, t: '鄉鎮 TOWN', k: 'code PK・shape', keys: [
      ['townpart:{code}:{n}', 'Hash＋GEOSHAPE 索引', 'FT.SEARCH idx:townshape "@shape:[CONTAINS $pt]"'],
      ['user:{uid}:towns', 'Set', 'SCARD user:1:towns → 298'],
      ['celltown', 'Hash（快取）', 'HGET celltown 16687:80867 → 1296139'] ] },
  };
  const REL = [['user', 'mem', '參加'], ['trip', 'mem', '有'], ['mem', 'state', '1:1'], ['mem', 'track', '1:N'], ['trip', 'route', '使用'], ['user', 'fp', '1:N'], ['fp', 'town', '點亮 N:M']];
  const svg = $('#erSvg'), W = 180, H = 62;
  const ctr = (e) => [ENT[e].x + W / 2, ENT[e].y + H / 2];
  svg.innerHTML = REL.map(([a, b, l]) => { const [x1, y1] = ctr(a), [x2, y2] = ctr(b); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><text class="rl" x="${(x1 + x2) / 2 + 4}" y="${(y1 + y2) / 2 - 4}">${l}</text>`; }).join('')
    + Object.entries(ENT).map(([id, e]) => `<g class="ent" data-e="${id}" tabindex="0" role="button" aria-label="${e.t}"><rect x="${e.x}" y="${e.y}" width="${W}" height="${H}" rx="10"/><text x="${e.x + 12}" y="${e.y + 26}">${e.t}</text><text class="s" x="${e.x + 12}" y="${e.y + 46}">${e.k}</text></g>`).join('');
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function pick(id) {
    const e = ENT[id];
    $$('.ent', svg).forEach((g) => g.classList.toggle('on', g.dataset.e === id));
    $('#erPanel').innerHTML = `<h4>${e.t}</h4><div class="muted" style="font-size:13px">在 Redis 裡拆成 ${e.keys.length} 種 key，依查詢方式選型別：</div><div class="keys">${e.keys.map(([k, ty, ex]) => `<div class="key"><code>${esc(k)}</code><span class="ty">${ty}</span><pre>${esc(ex)}</pre></div>`).join('')}</div>`;
  }
  svg.addEventListener('click', (ev) => { const g = ev.target.closest('.ent'); if (g) pick(g.dataset.e); });
  svg.addEventListener('keydown', (ev) => { const g = ev.target.closest('.ent'); if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); pick(g.dataset.e); } });
  pick('trip');

  // ---------- QR code ----------
  if (window.qrcode) $$('[data-qr]').forEach((f) => {
    const q = window.qrcode(0, 'M'); q.addData(f.dataset.qr); q.make();
    f.querySelector('div').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  });

  // ---------- 簡報模式 ----------
  let si = 0;
  const slot = (s) => {
    let el = $('.slot', s);
    if (!el) { el = document.createElement('div'); el.className = 'slot'; s.append(el); }
    return el;
  };
  function placeSlide() {
    const s = sections[si];
    sections.forEach((x) => x.classList.toggle('cur', x === s));
    // 填滿視窗：以 1600×900 為基準縮放，視窗比 16:9 寬就把頁面加寬、比較窄就加高
    const sc = Math.min(innerWidth / 1600, innerHeight / 900);
    s.style.width = `${innerWidth / sc}px`; s.style.height = `${innerHeight / sc}px`;
    s.style.transform = `scale(${sc})`;
    $('#sNum').textContent = `${si + 1} / ${sections.length}`;
    const dm = s.id === 'c00' ? null : demoOf(s);   // 每一頁都配一個頁面（封面除外）
    s.classList.toggle('has-slot', !!dm);
    const sl = dm ? slot(s) : null;
    if (sl) {
      const d = DEMO[dm[0]];
      sl.classList.toggle('desk', !!d.desk);
      if (!d.desk) sl.style.height = `${innerHeight / sc - 104}px`;   // 頁面高度扣掉上下邊距
      else sl.style.height = '';
      if (device.parentElement !== sl) sl.append(device);
      Object.assign(device.style, { transition: 'none', rotate: '0deg', scale: '1', opacity: '1' });
      device.hidden = false;
      const u = urlFor(dm[0]);
      const nav = () => { if (u !== curUrl) { curUrl = u; frame.src = u; } };
      if (device.classList.contains('desk') && !d.desk) {
        afterNavigate(nav, () => { device.classList.remove('desk'); fit(device, sl); });   // 從戰情室切走：先換頁再變窄
      } else {
        device.classList.toggle('desk', !!d.desk); nav(); fit(device, sl);
      }
    }
    history.replaceState(null, '', '#' + s.id);
    coverForSlide();
  }
  function enterSlides(at) {
    document.body.classList.add('slides');
    si = Math.max(0, at ?? sections.indexOf(curSec || sections[0]));
    placeSlide();
  }
  function exitSlides() {
    document.body.classList.remove('slides');
    sections.forEach((x) => { x.classList.remove('cur', 'has-slot'); x.style.transform = x.style.width = x.style.height = ''; });
    stage.prepend(device);
    if (document.body.classList.contains('demo-off')) { frame.src = 'about:blank'; curUrl = ''; }
    const s = sections[si];
    curSec = null; s.scrollIntoView({ behavior: 'instant', block: 'start' });
    const d = demoOf(s);
    if (d) show(d[0], d[1]); else fit();
  }
  const go = (d) => { si = Math.max(0, Math.min(sections.length - 1, si + d)); placeSlide(); };
  $('#bSlides').onclick = () => enterSlides();
  $$('[data-act="slides"]').forEach((b) => b.onclick = () => enterSlides(0));
  $('#sPrev').onclick = () => go(-1); $('#sNext').onclick = () => go(1); $('#sExit').onclick = exitSlides;
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const on = document.body.classList.contains('slides');
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); on ? exitSlides() : enterSlides(); return; }
    if (!on) return;
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { si = 0; placeSlide(); }
    else if (e.key === 'End') { si = sections.length - 1; placeSlide(); }
    else if (e.key === 'Escape') exitSlides();
    else if (e.key === 'f' || e.key === 'F') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  });
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data?.rtKey) return;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: e.data.rtKey }));
  });
  // 點 iframe 以外的地方翻頁時，焦點可能在 iframe 裡：滑鼠移出 iframe 就把焦點拉回來，方向鍵才有用
  frame.addEventListener('mouseleave', () => { if (document.body.classList.contains('slides')) window.focus(); });

  // ---------- 讀即時行程編號 ----------
  fetch('app/demo-data/live.json').then((r) => r.json()).then((d) => { TID = d.tid || ''; })
    .catch(() => {}).finally(() => {
      const start = location.hash && $(location.hash);
      const d = start ? demoOf(start) : null;
      show(...(d || ['trip', FALLBACK.c01[1]]));
      if (new URLSearchParams(location.search).has('slides')) enterSlides(start ? sections.indexOf(start) : 0);
    });
})();

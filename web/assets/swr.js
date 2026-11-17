// 足跡回應只在本機暫存；每筆資料以帳號 uid 與完整 URL 隔離。
const DB = 'qiji-cache';
const STORE = 'responses';

function openCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('快取資料庫被佔用'));
  });
}

async function cached(key, value) {
  const db = await openCache();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, value === undefined ? 'readonly' : 'readwrite');
      const request = value === undefined ? tx.objectStore(STORE).get(key) : tx.objectStore(STORE).put(value, key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function clearSwrCache() {
  try {
    const db = await openCache();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* 快取本來就不可用 */ }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch { resolve(); }
  });
}

export async function swr(url, { onData, key } = {}) {
  if (key == null) throw new Error('快取需要使用者 uid');
  const cacheKey = `${key}:${url}`;
  let old;
  try {
    old = await cached(cacheKey);
    if (old) onData(old.data, { stale: true });
  } catch { /* 私密模式或配額限制時直接走網路 */ }

  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: old?.etag ? { 'If-None-Match': old.etag } : {},
  });
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('請先登入');
  }
  if (res.status === 304 && old) {
    onData(old.data, { stale: false, unchanged: true });
    return old.data;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `錯誤 ${res.status}`);
  try { await cached(cacheKey, { etag: res.headers.get('ETag'), data, savedAt: Date.now() }); }
  catch { /* 快取失敗不影響畫面 */ }
  onData(data, { stale: false });
  return data;
}

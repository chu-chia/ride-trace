// 只在軌跡或目前位置改變時重建 GeoJSON，避免停車時反覆喚醒地圖的資料處理與 GPU。
export function trailChangeDetector() {
  const refs = new WeakMap();
  let nextRef = 0, previous = null;
  const point = (p) => p ? `${p[0]},${p[1]}` : '';
  const changed = (members) => {
    const parts = [];
    for (const [uid, m] of members) {
      const trail = m.trail;
      if (!refs.has(trail)) refs.set(trail, ++nextRef);
      parts.push(uid, m.u.color, refs.get(trail), trail.length,
        point(trail[0]), point(trail[trail.length - 1]), point(m.pos));
    }
    const key = parts.join('|');
    if (key === previous) return false;
    previous = key;
    return true;
  };
  changed.reset = () => { previous = null; };
  return changed;
}

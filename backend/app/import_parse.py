"""足跡匯入：把各家 App 匯出的檔案解析成 (ts_ms, lat, lon, ele) 的點。

支援：
- GPX：靈感足跡、Strava、Garmin、Traccar 等幾乎所有運動／軌跡 App（trkpt、rtept，要有 <time>）
- KML：Google 地圖時間軸舊版匯出（gx:Track、TimeStamp＋Point、TimeSpan＋LineString）
- Google 時間軸 JSON：
    * 手機內匯出的新版 Timeline.json（Android：semanticSegments／rawSignals；iPhone：最外層是陣列、"geo:緯度,經度"）
    * Google Takeout 舊版 Records.json（locations：latitudeE7／longitudeE7）
    * Google Takeout 舊版 Semantic Location History 每月檔（timelineObjects）
- ZIP：裡面的 .gpx／.kml／.json 全部讀（例如整包 Takeout）

這個模組只做純計算，不碰 Redis，方便單獨測試。
"""
import io
import json
import re
import zipfile
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

MAX_ACCURACY_M = 200          # Google 紀錄裡精度差於 200 公尺的點（基地台定位）不要
MAX_UNZIP_BYTES = 1024 ** 3   # ZIP 解開後最多 1 GB，防止壓縮炸彈
FLOAT = re.compile(r"-?\d+(?:\.\d+)?")


class ImportError_(ValueError):
    """檔案看不懂：訊息會直接顯示給使用者。"""


def _ts(s) -> int | None:
    """ISO 8601 字串或毫秒數字 → 毫秒時間戳。"""
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)) or (isinstance(s, str) and s.isdigit()):
        v = int(s)
        return v if v > 10 ** 11 else v * 1000   # 秒或毫秒都收
    try:
        d = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def _ok(lat, lon) -> bool:
    return -90 <= lat <= 90 and -180 <= lon <= 180 and not (lat == 0 and lon == 0)


def _latlng(s) -> tuple[float, float] | None:
    """"25.0330°, 121.5654°"、"geo:25.0330,121.5654"、{"latitudeE7":…} 都轉成 (lat, lon)。"""
    if isinstance(s, dict):
        if "latitudeE7" in s or "latE7" in s:
            lat = (s.get("latitudeE7") if "latitudeE7" in s else s.get("latE7")) / 1e7
            lon = (s.get("longitudeE7") if "longitudeE7" in s else s.get("lngE7")) / 1e7
            return (lat, lon) if _ok(lat, lon) else None
        if "latLng" in s or "LatLng" in s:
            return _latlng(s.get("latLng") or s.get("LatLng"))
        return None
    if not isinstance(s, str):
        return None
    nums = FLOAT.findall(s)
    if len(nums) < 2:
        return None
    lat, lon = float(nums[0]), float(nums[1])
    return (lat, lon) if _ok(lat, lon) else None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


# ---------- GPX ----------

def parse_gpx(data: bytes) -> tuple[list, int]:
    pts, notime = [], 0
    for _, el in ET.iterparse(io.BytesIO(data), events=("end",)):
        name = _local(el.tag)
        if name not in ("trkpt", "rtept"):
            continue
        try:
            lat, lon = float(el.get("lat")), float(el.get("lon"))
        except (TypeError, ValueError):
            el.clear()
            continue
        ts = ele = None
        for c in el:
            n = _local(c.tag)
            if n == "time":
                ts = _ts(c.text)
            elif n == "ele":
                try:
                    ele = float(c.text)
                except (TypeError, ValueError):
                    pass
        el.clear()
        if ts is None:
            notime += 1
        elif _ok(lat, lon):
            pts.append((ts, lat, lon, ele or 0.0))
    return pts, notime


# ---------- KML ----------

def _coords(text: str) -> list[tuple[float, float, float]]:
    out = []
    for tok in (text or "").split():
        p = tok.split(",")
        if len(p) >= 2:
            try:
                out.append((float(p[1]), float(p[0]), float(p[2]) if len(p) > 2 else 0.0))
            except ValueError:
                pass
    return out


def parse_kml(data: bytes) -> tuple[list, int]:
    pts, notime = [], 0
    root = ET.parse(io.BytesIO(data)).getroot()
    for pm in root.iter():
        if _local(pm.tag) != "Placemark":
            continue
        tracks = [e for e in pm.iter() if _local(e.tag) == "Track"]
        if tracks:  # gx:Track：<when> 和 <gx:coord> 一對一
            for tr in tracks:
                whens = [_ts(e.text) for e in tr if _local(e.tag) == "when"]
                cs = [e.text for e in tr if _local(e.tag) == "coord"]
                for t, c in zip(whens, cs):
                    v = (c or "").split()
                    if t is None or len(v) < 2:
                        notime += 1
                        continue
                    lat, lon = float(v[1]), float(v[0])
                    if _ok(lat, lon):
                        pts.append((t, lat, lon, float(v[2]) if len(v) > 2 else 0.0))
            continue
        when = begin = end = None
        coords = []
        for e in pm.iter():
            n = _local(e.tag)
            if n == "when":
                when = _ts(e.text)
            elif n == "begin":
                begin = _ts(e.text)
            elif n == "end":
                end = _ts(e.text)
            elif n == "coordinates":
                coords += _coords(e.text)
        if not coords:
            continue
        if when is None and begin is not None:
            when = begin
        if when is None:
            notime += len(coords)
            continue
        if end and end > when and len(coords) > 1:
            # 舊版時間軸：一段路只有開始和結束時間，中間的點平均分配
            step = (end - when) / (len(coords) - 1)
            for i, (lat, lon, ele) in enumerate(coords):
                if _ok(lat, lon):
                    pts.append((int(when + step * i), lat, lon, ele))
        else:
            for i, (lat, lon, ele) in enumerate(coords):
                if _ok(lat, lon):
                    pts.append((when + i * 1000, lat, lon, ele))
    return pts, notime


# ---------- Google 時間軸 JSON ----------

def _records(obj: dict) -> list:
    """Takeout 舊版 Records.json。"""
    pts = []
    for loc in obj.get("locations") or []:
        acc = loc.get("accuracy")
        if acc is not None and acc > MAX_ACCURACY_M:
            continue
        ll = _latlng(loc)
        ts = _ts(loc.get("timestamp") or loc.get("timestampMs"))
        if ll and ts:
            pts.append((ts, ll[0], ll[1], float(loc.get("altitude") or 0)))
    return pts


def _semantic_old(obj: dict) -> list:
    """Takeout 舊版 Semantic Location History（每月一個檔）。"""
    pts = []
    for it in obj.get("timelineObjects") or []:
        seg = it.get("activitySegment")
        if seg:
            for p in (seg.get("simplifiedRawPath") or {}).get("points") or []:
                ll, ts = _latlng(p), _ts(p.get("timestamp") or p.get("timestampMs"))
                if ll and ts:
                    pts.append((ts, ll[0], ll[1], 0.0))
            d = seg.get("duration") or {}
            for key, tkey in (("startLocation", "startTimestamp"), ("endLocation", "endTimestamp")):
                ll, ts = _latlng(seg.get(key) or {}), _ts(d.get(tkey) or d.get(tkey + "Ms"))
                if ll and ts:
                    pts.append((ts, ll[0], ll[1], 0.0))
        visit = it.get("placeVisit")
        if visit:
            d = visit.get("duration") or {}
            ll, ts = _latlng(visit.get("location") or {}), _ts(d.get("startTimestamp") or d.get("startTimestampMs"))
            if ll and ts:
                pts.append((ts, ll[0], ll[1], 0.0))
    return pts


def _timeline_android(obj: dict) -> list:
    """手機內匯出的新版 Timeline.json（Android）。"""
    pts = []
    for seg in obj.get("semanticSegments") or []:
        for p in seg.get("timelinePath") or []:
            ll, ts = _latlng(p.get("point")), _ts(p.get("time"))
            if ll and ts:
                pts.append((ts, ll[0], ll[1], 0.0))
        visit = seg.get("visit")
        if visit:
            ll = _latlng(((visit.get("topCandidate") or {}).get("placeLocation") or {}).get("latLng"))
            ts = _ts(seg.get("startTime"))
            if ll and ts:
                pts.append((ts, ll[0], ll[1], 0.0))
    for sig in obj.get("rawSignals") or []:
        pos = sig.get("position")
        if not pos:
            continue
        acc = pos.get("accuracyMeters")
        if acc is not None and acc > MAX_ACCURACY_M:
            continue
        ll, ts = _latlng(pos.get("LatLng") or pos.get("latLng")), _ts(pos.get("timestamp"))
        if ll and ts:
            pts.append((ts, ll[0], ll[1], float(pos.get("altitudeMeters") or 0)))
    return pts


def _timeline_ios(arr: list) -> list:
    """iPhone 的 Google 地圖匯出：陣列，每筆有 startTime／endTime。"""
    pts = []
    for it in arr:
        if not isinstance(it, dict):
            continue
        t0 = _ts(it.get("startTime"))
        if t0 is None:
            continue
        for p in it.get("timelinePath") or []:
            ll = _latlng(p.get("point"))
            try:
                off = float(p.get("durationMinutesOffsetFromStartTime") or 0)
            except (TypeError, ValueError):
                off = 0
            if ll:
                pts.append((int(t0 + off * 60_000), ll[0], ll[1], 0.0))
        act = it.get("activity")
        if act:
            t1 = _ts(it.get("endTime")) or t0
            for key, t in (("start", t0), ("end", t1)):
                ll = _latlng(act.get(key))
                if ll:
                    pts.append((t, ll[0], ll[1], 0.0))
        visit = it.get("visit")
        if visit:
            ll = _latlng((visit.get("topCandidate") or {}).get("placeLocation"))
            if ll:
                pts.append((t0, ll[0], ll[1], 0.0))
    return pts


def parse_json(data: bytes) -> tuple[list, str]:
    try:
        obj = json.loads(data)
    except ValueError as e:
        raise ImportError_("JSON 格式錯誤，檔案可能不完整") from e
    if isinstance(obj, list):
        return _timeline_ios(obj), "Google 時間軸（iPhone）"
    if not isinstance(obj, dict):
        raise ImportError_("看不懂這個 JSON 的格式")
    if "semanticSegments" in obj or "rawSignals" in obj:
        return _timeline_android(obj), "Google 時間軸（Android）"
    if "locations" in obj:
        return _records(obj), "Google Takeout Records.json"
    if "timelineObjects" in obj:
        return _semantic_old(obj), "Google Takeout 時間軸（每月）"
    raise ImportError_("看不懂這個 JSON 的格式（支援 Google 時間軸的 Timeline.json、Records.json）")


# ---------- 入口 ----------

def sniff(name: str, data: bytes) -> str:
    n = (name or "").lower()
    head = data[:2048].lstrip().lower()
    if data[:4] == b"PK\x03\x04" or n.endswith(".zip"):
        return "zip"
    if n.endswith(".gpx") or b"<gpx" in head:
        return "gpx"
    if n.endswith(".kml") or b"<kml" in head:
        return "kml"
    if n.endswith(".json") or head[:1] in (b"{", b"["):
        return "json"
    raise ImportError_("不支援的檔案格式，請用 GPX、KML、Google 時間軸 JSON 或 ZIP")


def parse_any(name: str, data: bytes) -> dict:
    """回傳 {"points": 依時間排序的點, "format": 說明, "notime": 沒有時間而略過的點數, "files": 讀了幾個檔}。"""
    kind = sniff(name, data)
    pts, notime, fmts, files = [], 0, [], 0
    if kind == "zip":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            raise ImportError_("ZIP 檔損毀") from e
        total = 0
        for info in zf.infolist():
            low = info.filename.lower()
            if info.is_dir() or not low.endswith((".gpx", ".kml", ".json")):
                continue
            total += info.file_size
            if total > MAX_UNZIP_BYTES:
                raise ImportError_("ZIP 解開後超過 1 GB，請分批匯入")
            try:
                sub = parse_any(info.filename, zf.read(info))
            except (ImportError_, ET.ParseError):
                continue  # Takeout 裡還有設定檔之類看不懂的 JSON，略過
            pts += sub["points"]
            notime += sub["notime"]
            fmts.append(sub["format"])
            files += 1
        if not files:
            raise ImportError_("ZIP 裡找不到可以匯入的 GPX、KML 或時間軸 JSON")
        fmt = "ZIP：" + "、".join(sorted(set(fmts)))
    else:
        try:
            if kind == "gpx":
                pts, notime = parse_gpx(data)
                fmt = "GPX"
            elif kind == "kml":
                pts, notime = parse_kml(data)
                fmt = "KML"
            else:
                pts, fmt = parse_json(data)
        except ET.ParseError as e:
            raise ImportError_(f"{kind.upper()} 格式錯誤，檔案可能不完整") from e
        files = 1
    pts.sort()
    return {"points": pts, "format": fmt, "notime": notime, "files": files}

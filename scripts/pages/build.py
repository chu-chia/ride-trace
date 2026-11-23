"""產生 GitHub Pages 網站（_site/）：根目錄是報告網頁（report/），/app/ 是騎跡的展示版（web/＋展示資料）。

展示版不改 web/ 的程式，只在複製時：
- 把絕對路徑（/assets/、/vendor/、/trip…）改成 /ride-trace/app/…（Pages 網址前面多一層 repo 名稱，伺服器也不會把 /trip 對到 trip.html）
- 每一頁 <head> 最前面插入 demo.js：把 /api 和 /ws 換成 report/demo-data/ 錄好的資料
- 地圖預設底圖改成可以由 demo.js 指定（報告切淺色時，嵌入的頁面一起變淺色）

用法：python3 scripts/pages/build.py [--base /ride-trace/]   之後 python3 scripts/pages/serve.py 本機預覽
"""
import argparse
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB, REPORT, OUT = ROOT / "web", ROOT / "report", ROOT / "_site"
PAGES = "trip|replay|plan|war|footprint|settings|about|login|admin"
TEXT = {".html", ".js", ".css", ".webmanifest"}


def rewrite(text: str, app: str, suffix: str) -> str:
    q = "[\"'`(]"
    text = re.sub(rf"({q})/(assets|vendor)/", rf"\1{app}\2/", text)
    text = re.sub(rf"({q})/manifest\.webmanifest", rf"\1{app}manifest.webmanifest", text)
    text = re.sub(rf"([\"'`])/nav\?", rf"\1{app}trip.html?nav=1&", text)
    text = re.sub(rf"([\"'`])/nav(?=[\"'`])", rf"\1{app}trip.html?nav=1", text)
    text = re.sub(rf"([\"'`])/({PAGES})(?=[?#\"'`])", rf"\1{app}\2.html", text)
    home = f"{app}index.html"
    for a, b in [('href="/"', f'href="{home}"'), ('data-back-to="/"', f'data-back-to="{home}"'),
                 ('[href="/"]', f'[href="{home}"]'), ("location.replace('/')", f"location.replace('{home}')"),
                 ("`/?kicked=", f"`{home}?kicked="), (".href = '/';", f".href = '{home}';"),
                 ("replaceState(null, '', '/')", f"replaceState(null, '', '{home}')"), ("|| '/';", f"|| '{home}';")]:
        text = text.replace(a, b)
    if suffix == ".js":
        text = re.sub(r"\{ style: '(dark|navy)',", r"{ style: window.__demoStyle || '\1',", text)
    return text


def build(base: str):
    app = base + "app/"
    if OUT.exists():
        shutil.rmtree(OUT)
    # 報告網頁
    shutil.copytree(REPORT, OUT, ignore=shutil.ignore_patterns("app-demo", "demo-data", "*.md"))
    # 騎跡展示版
    dst = OUT / "app"
    for src in WEB.rglob("*"):
        if src.is_dir() or src.name in ("deployed.json",) or src.name.startswith("."):
            continue
        out = dst / src.relative_to(WEB)
        out.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in TEXT and "vendor" not in src.parts:
            t = rewrite(src.read_text(encoding="utf-8"), app, src.suffix)
            if src.suffix == ".html":
                tag = f'<script src="{app}assets/demo.js"></script>'
                t = re.sub(r"(<meta charset=[^>]*>)", r"\1" + tag, t, count=1) if "<meta charset" in t else t.replace("<head>", "<head>" + tag, 1)
            out.write_text(t, encoding="utf-8")
        else:
            shutil.copy2(src, out)
    (dst / "assets" / "demo.js").write_text((REPORT / "app-demo" / "demo.js").read_text(encoding="utf-8").replace("__BASE__", app), encoding="utf-8")
    if (REPORT / "demo-data").exists():
        shutil.copytree(REPORT / "demo-data", dst / "demo-data")
    (OUT / ".nojekyll").write_text("")
    n = sum(1 for _ in OUT.rglob("*") if _.is_file())
    print(f"完成：{OUT}（{n} 個檔案，展示版在 {app}）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="/ride-trace/")
    build(ap.parse_args().base)

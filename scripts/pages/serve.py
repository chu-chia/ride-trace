"""本機預覽 GitHub Pages：http://localhost:8756/ride-trace/（把網址前面的 /ride-trace 去掉後對到 _site/）。"""
import http.server
import os
from functools import partial
from pathlib import Path

SITE = Path(__file__).resolve().parents[2] / "_site"
PREFIX = "/ride-trace"


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path.startswith(PREFIX):
            path = path[len(PREFIX):] or "/"
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8756))
    print(f"http://localhost:{port}{PREFIX}/")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(H, directory=str(SITE))).serve_forever()

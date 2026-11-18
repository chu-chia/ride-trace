"""Redis 連線字串：容器內由 docker compose 給 REDIS_URL；在主機跑 tools 時從 .env 讀 REDIS_PASSWORD 組出來。"""
import os

_ENV_FILE = os.path.join(os.path.dirname(__file__), "..", "..", ".env")


def _from_env_file(name: str) -> str:
    try:
        with open(_ENV_FILE, encoding="utf-8") as f:
            for line in f:
                key, sep, val = line.strip().partition("=")
                if sep and key.strip() == name:
                    return val.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def default_redis_url() -> str:
    if os.environ.get("REDIS_URL"):
        return os.environ["REDIS_URL"]
    pw = os.environ.get("REDIS_PASSWORD") or _from_env_file("REDIS_PASSWORD")
    auth = f":{pw}@" if pw else ""
    return f"redis://{auth}localhost:6390/0"

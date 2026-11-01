import os
from pathlib import Path


def _xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or Path.home() / default)


CONFIG_DIR = _xdg("XDG_CONFIG_HOME", ".config") / "ytmusic-daemon"
AUTH_FILE = CONFIG_DIR / "browser.json"
_RUNTIME = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
RUNTIME_DIR = Path(_RUNTIME) / "ytmusic-daemon"
CACHE_DIR = _xdg("XDG_CACHE_HOME", ".cache") / "ytmusic-daemon"

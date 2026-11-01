"""Cover art cache: downloads thumbnails to disk so the extension never touches the network.

Downloads are anonymous (no account cookies) and limited to Google/YouTube image hosts.
"""

import hashlib
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

import requests

from .paths import CACHE_DIR

log = logging.getLogger(__name__)

COVERS_DIR = CACHE_DIR / "covers"
ALLOWED_HOST_SUFFIXES = (".googleusercontent.com", ".ytimg.com", ".ggpht.com", ".gstatic.com")
MAX_BYTES = 2 * 1024 * 1024
MAX_FILES = 3000
TIMEOUT = 10


def is_allowed(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    host = parts.hostname or ""
    return parts.scheme == "https" and any(host.endswith(s) for s in ALLOWED_HOST_SUFFIXES)


class CoverCache:
    def __init__(self):
        COVERS_DIR.mkdir(parents=True, exist_ok=True)
        self._session = requests.Session()
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cover")
        self._lock = threading.Lock()
        self._inflight: dict[str, object] = {}

    @staticmethod
    def path_for(url: str):
        return COVERS_DIR / hashlib.sha1(url.encode()).hexdigest()

    def get_many(self, urls: list[str]) -> dict[str, str | None]:
        """Map each URL to a local file path (None if it couldn't be fetched)."""
        futures = {}
        result: dict[str, str | None] = {}
        for url in dict.fromkeys(urls):  # dedupe, keep order
            if not isinstance(url, str) or not is_allowed(url):
                result[url] = None
                continue
            path = self.path_for(url)
            if path.exists():
                result[url] = str(path)
                continue
            with self._lock:
                fut = self._inflight.get(url)
                if fut is None:
                    fut = self._pool.submit(self._download, url, path)
                    self._inflight[url] = fut
                    fut.add_done_callback(lambda _f, u=url: self._forget(u))
            futures[url] = fut
        for url, fut in futures.items():
            result[url] = fut.result()
        return result

    def _forget(self, url: str) -> None:
        with self._lock:
            self._inflight.pop(url, None)

    def _download(self, url: str, path) -> str | None:
        tmp = path.with_suffix(".part")
        try:
            with self._session.get(url, timeout=TIMEOUT, stream=True) as r:
                r.raise_for_status()
                if not r.headers.get("content-type", "").startswith("image/"):
                    return None
                size = 0
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(64 * 1024):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise ValueError("cover too large")
                        f.write(chunk)
            os.replace(tmp, path)
            return str(path)
        except (requests.RequestException, OSError, ValueError) as e:
            log.debug("cover download failed (%s)", type(e).__name__)
            tmp.unlink(missing_ok=True)
            return None

    def prune(self) -> None:
        """Keep only the MAX_FILES most recently downloaded covers."""
        try:
            files = sorted(COVERS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return
        for old in files[MAX_FILES:]:
            old.unlink(missing_ok=True)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

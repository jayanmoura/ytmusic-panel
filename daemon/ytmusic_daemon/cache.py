import threading
import time
from typing import Any, Callable


class TTLCache:
    """Small thread-safe key/value cache with per-entry expiry."""

    def __init__(self, ttl: float):
        self.ttl = ttl
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get_or_fetch(self, key: str, fetch: Callable[[], Any], force: bool = False) -> Any:
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit and not force and now - hit[0] < self.ttl:
                return hit[1]
        value = fetch()
        with self._lock:
            self._data[key] = (time.monotonic(), value)
        return value

    def invalidate(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._data.clear()
            else:
                self._data.pop(key, None)

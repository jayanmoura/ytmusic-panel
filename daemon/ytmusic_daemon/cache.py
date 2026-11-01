import threading
import time
from collections.abc import Callable
from typing import Any


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

    def get(self, key: str) -> Any | None:
        with self._lock:
            hit = self._data.get(key)
            if hit and time.monotonic() - hit[0] < self.ttl:
                return hit[1]
        return None

    def get_stale(self, key: str) -> tuple[Any | None, bool]:
        """(value, fresh): expired entries are still returned, with fresh=False."""
        with self._lock:
            hit = self._data.get(key)
        if not hit:
            return None, False
        return hit[1], time.monotonic() - hit[0] < self.ttl

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.monotonic(), value)

    def invalidate(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._data.clear()
            else:
                self._data.pop(key, None)

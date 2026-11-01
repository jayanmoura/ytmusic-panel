"""Resolve YouTube Music tracks to direct audio URLs ahead of time.

Asking yt-dlp takes about 2 seconds per track, which mpv would otherwise
spend before every song starts. The service resolves the track the user is
pointing at and the next one in the queue in advance, and hands the result to
mpv (see player.py and mpv/preload.lua).
"""

import logging
import os
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

log = logging.getLogger(__name__)

VENV_BIN = Path(sys.executable).parent
# Stream URLs expire after about 6 hours; stay well within that.
TTL = 3600
MAX_ENTRIES = 200

YDL_OPTIONS = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "format": "bestaudio/best",
    "extractor_args": {"youtube": {
        # Same client as mpv's own fallback: its URLs play directly without 403s.
        "player_client": ["web_music"],
        "player_skip": ["webpage", "configs"],
        "skip": ["dash", "hls", "translated_subs"],
    }},
}


class Resolver:
    def __init__(self, on_resolved=None):
        # Called with (video_id, entry) from a worker thread.
        self._on_resolved = on_resolved
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ytm-resolve")
        self._local = threading.local()
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}
        self._inflight: dict[str, Future] = {}
        # yt-dlp needs the venv's deno on PATH for YouTube's JS challenges.
        path = os.environ.get("PATH", "/usr/bin:/bin")
        if str(VENV_BIN) not in path.split(":"):
            os.environ["PATH"] = f"{VENV_BIN}:{path}"

    def _ydl(self):
        # One YoutubeDL per worker thread: instances aren't thread-safe.
        ydl = getattr(self._local, "ydl", None)
        if ydl is None:
            import yt_dlp
            ydl = self._local.ydl = yt_dlp.YoutubeDL(YDL_OPTIONS)
        return ydl

    def cached(self, video_id: str) -> dict | None:
        with self._lock:
            entry = self._entries.get(video_id)
        if entry and entry["expires"] > time.time():
            return entry
        return None

    def prefetch(self, video_id: str) -> Future:
        """Start resolving in the background (no-op if cached or running)."""
        with self._lock:
            entry = self._entries.get(video_id)
            if entry and entry["expires"] > time.time():
                fut = Future()
                fut.set_result(entry)
                return fut
            fut = self._inflight.get(video_id)
            if fut is None:
                fut = self._pool.submit(self._resolve, video_id)
                self._inflight[video_id] = fut
                fut.add_done_callback(lambda _f: self._forget(video_id))
            return fut

    def resolve(self, video_id: str, timeout: float) -> dict | None:
        """Wait for a resolution; None if it fails or takes too long."""
        try:
            return self.prefetch(video_id).result(timeout)
        except Exception:
            return None

    def _forget(self, video_id: str) -> None:
        with self._lock:
            self._inflight.pop(video_id, None)

    def _resolve(self, video_id: str) -> dict | None:
        started = time.monotonic()
        try:
            info = self._ydl().extract_info(
                f"https://music.youtube.com/watch?v={video_id}", download=False)
        except Exception as e:
            # Unavailable or blocked; mpv will try on its own and report it.
            log.info("could not resolve a track ahead of time (%s)", type(e).__name__)
            return None
        url = info.get("url")
        if not url:
            return None
        headers = [f"{k}: {v}" for k, v in (info.get("http_headers") or {}).items()]
        entry = {
            "url": url,
            "headers": headers,
            "title": info.get("track") or info.get("title") or "",
            "expires": int(time.time() + TTL),
        }
        with self._lock:
            if len(self._entries) >= MAX_ENTRIES:
                now = time.time()
                self._entries = {k: v for k, v in self._entries.items() if v["expires"] > now}
                while len(self._entries) >= MAX_ENTRIES:
                    self._entries.pop(next(iter(self._entries)))
            self._entries[video_id] = entry
        log.debug("resolved in %.1fs", time.monotonic() - started)
        if self._on_resolved:
            try:
                self._on_resolved(video_id, entry)
            except Exception:
                log.exception("resolved callback failed")
        return entry

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

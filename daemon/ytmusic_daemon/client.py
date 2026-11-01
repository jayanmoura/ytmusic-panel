"""Thin wrapper around ytmusicapi: auth loading, caching and result shaping.

Never log headers, cookies or the auth file contents.
"""

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor

import requests
from ytmusicapi import YTMusic
from ytmusicapi.exceptions import YTMusicError, YTMusicServerError, YTMusicUserError

from .cache import TTLCache
from .paths import AUTH_FILE

log = logging.getLogger(__name__)

PLAYLISTS_TTL = 300  # seconds
TRACKS_TTL = 600
# First page served immediately; the rest is fetched in the background.
FIRST_PAGE_LIMIT = 100


class AuthError(Exception):
    """Credentials missing, unreadable or rejected by the server."""


class ServiceError(Exception):
    """Network or backend failure unrelated to auth."""


class UnavailableError(ServiceError):
    """The backend answered, but not with the expected content (bad id, removed item)."""


class Client:
    def __init__(self):
        self._yt: YTMusic | None = None
        self._auth_mtime: float | None = None
        # "missing" | "unverified" | "ok" | "invalid"
        self.auth_state = "missing"
        self._lock = threading.RLock()
        self._cache = TTLCache(PLAYLISTS_TTL)
        self._tracks_cache = TTLCache(TRACKS_TTL)
        self._full_fetches: dict[str, Future] = {}
        self._bg = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ytm-bg")

    # -- auth -----------------------------------------------------------------

    def _ensure_client(self) -> YTMusic:
        """(Re)load credentials when the auth file appears or changes."""
        with self._lock:
            try:
                mtime = AUTH_FILE.stat().st_mtime
            except FileNotFoundError:
                self._yt = None
                self._auth_mtime = None
                self.auth_state = "missing"
                raise AuthError("auth file not found")

            if self._yt is None or mtime != self._auth_mtime:
                session = requests.Session()
                session.request = _with_timeout(session.request, 20)
                try:
                    self._yt = YTMusic(str(AUTH_FILE), requests_session=session, language="pt")
                except Exception as e:
                    self._yt = None
                    self._auth_mtime = mtime
                    self.auth_state = "invalid"
                    log.warning("could not load auth file (%s)", type(e).__name__)
                    raise AuthError("auth file invalid") from None
                self._auth_mtime = mtime
                self.auth_state = "unverified"
                self._cache.invalidate()
                self._tracks_cache.invalidate()
                log.info("credentials loaded")
            elif self.auth_state == "invalid":
                raise AuthError("credentials rejected")
            return self._yt

    def load_auth(self) -> None:
        try:
            self._ensure_client()
        except AuthError:
            pass

    def _call(self, fn):
        """Run fn(yt) translating library errors into AuthError/ServiceError."""
        yt = self._ensure_client()
        try:
            result = fn(yt)
        except YTMusicServerError as e:
            msg = str(e)
            if "HTTP 401" in msg or "HTTP 403" in msg:
                self.auth_state = "invalid"
                log.warning("server rejected credentials")
                raise AuthError("credentials rejected") from None
            log.warning("server error: %s", msg.splitlines()[0])
            raise ServiceError("server error") from None
        except YTMusicUserError as e:
            # Raised by _check_auth() when the file has no usable credentials.
            self.auth_state = "invalid"
            log.warning("auth error: %s", e)
            raise AuthError("not authenticated") from None
        except (requests.RequestException, YTMusicError) as e:
            log.warning("request failed (%s)", type(e).__name__)
            raise ServiceError("network error") from None
        except (KeyError, IndexError, TypeError) as e:
            # ytmusicapi parse failure; the message embeds the raw response, so don't log it.
            log.warning("unexpected response shape (%s)", type(e).__name__)
            raise UnavailableError("unexpected response") from None
        if self.auth_state == "unverified":
            self.auth_state = "ok"
        return result

    # -- api ------------------------------------------------------------------

    def get_playlists(self, force: bool = False) -> list[dict]:
        def fetch():
            raw = self._call(lambda yt: yt.get_library_playlists(limit=None))
            return [_shape_playlist(p) for p in raw if p.get("playlistId")]

        return self._cache.get_or_fetch("playlists", fetch, force=force)

    def get_playlist_tracks(self, playlist_id: str, force: bool = False) -> dict:
        """Full list if cached, otherwise the first page with complete=False.

        Calling again while the background fetch runs waits for it.
        """
        if force:
            self._tracks_cache.invalidate(playlist_id)
        cached = self._tracks_cache.get(playlist_id)
        if cached:
            return cached

        with self._lock:
            pending = self._full_fetches.get(playlist_id)
        if pending:
            return pending.result()

        first = self._fetch_playlist(playlist_id, FIRST_PAGE_LIMIT)
        if first["complete"]:
            self._tracks_cache.set(playlist_id, first)
            return first

        with self._lock:
            if playlist_id not in self._full_fetches:
                fut = self._bg.submit(self._fetch_full, playlist_id)
                self._full_fetches[playlist_id] = fut
                fut.add_done_callback(lambda _f: self._forget_fetch(playlist_id))
        return first

    def _fetch_full(self, playlist_id: str) -> dict:
        result = self._fetch_playlist(playlist_id, None)
        self._tracks_cache.set(playlist_id, result)
        log.info("playlist fully loaded: %d tracks", len(result["tracks"]))
        return result

    def _forget_fetch(self, playlist_id: str) -> None:
        with self._lock:
            self._full_fetches.pop(playlist_id, None)

    def _fetch_playlist(self, playlist_id: str, limit: int | None) -> dict:
        raw = self._call(lambda yt: yt.get_playlist(playlist_id, limit=limit))
        tracks = [_shape_track(t) for t in raw.get("tracks") or []]
        total = raw.get("trackCount")
        complete = (
            limit is None
            or len(tracks) < limit
            or (total is not None and len(tracks) >= total)
        )
        return {
            "id": playlist_id,
            "title": raw.get("title") or "",
            "count": total,
            "complete": complete,
            "tracks": tracks,
        }

    def shutdown(self) -> None:
        self._bg.shutdown(wait=False, cancel_futures=True)


def _with_timeout(request, timeout):
    def wrapped(*args, **kwargs):
        kwargs.setdefault("timeout", timeout)
        return request(*args, **kwargs)

    return wrapped


def _best_thumb(item: dict) -> str | None:
    thumbs = item.get("thumbnails") or []
    return thumbs[-1].get("url") if thumbs else None


def _shape_track(t: dict) -> dict:
    artists = ", ".join(a["name"] for a in t.get("artists") or [] if a.get("name"))
    album = t.get("album") or {}
    return {
        "videoId": t.get("videoId"),
        "title": t.get("title") or "",
        "artists": artists,
        "album": album.get("name"),
        "duration": t.get("duration"),
        "duration_seconds": t.get("duration_seconds"),
        "available": bool(t.get("isAvailable", True)) and bool(t.get("videoId")),
        "explicit": bool(t.get("isExplicit")),
        "thumbnail": _best_thumb(t),
    }


def _shape_playlist(p: dict) -> dict:
    count = p.get("count")
    try:
        count = int(str(count).replace(".", "").replace(",", "")) if count is not None else None
    except ValueError:
        count = None
    return {
        "id": p["playlistId"],
        "title": p.get("title") or "",
        "count": count,
        "owned": bool(p.get("owned")),
        "thumbnail": _best_thumb(p),
    }

"""Thin wrapper around ytmusicapi: auth loading, caching and result shaping.

Never log headers, cookies or the auth file contents.
"""

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor

import requests
from ytmusicapi import YTMusic
from ytmusicapi.models.content.enums import LikeStatus
from ytmusicapi.exceptions import YTMusicError, YTMusicServerError, YTMusicUserError

from .cache import TTLCache
from .paths import AUTH_FILE

log = logging.getLogger(__name__)

LIKED_PLAYLIST_ID = "LM"
PLAYLISTS_TTL = 300  # seconds
TRACKS_TTL = 600
SEARCH_TTL = 120
SEARCH_LIMIT = 30
# First page served immediately; the rest is fetched in the background.
FIRST_PAGE_LIMIT = 100
# Minimum seconds between automatic re-logins.
REAUTH_INTERVAL = 60


class AuthError(Exception):
    """Credentials missing, unreadable or rejected by the server."""


class ServiceError(Exception):
    """Network or backend failure unrelated to auth."""


class DuplicateError(Exception):
    """The track is already in the target playlist."""


class UnavailableError(ServiceError):
    """The backend answered, but not with the expected content (bad id, removed item)."""


class Client:
    def __init__(self):
        self._yt: YTMusic | None = None
        # ytmusicapi's "songs" search filter returns nothing with language="pt",
        # so searches use a second instance in English (song titles aren't translated).
        self._yt_search: YTMusic | None = None
        self._auth_mtime: float | None = None
        # "missing" | "unverified" | "ok" | "invalid"
        self.auth_state = "missing"
        self._lock = threading.RLock()
        self._cache = TTLCache(PLAYLISTS_TTL)
        self._tracks_cache = TTLCache(TRACKS_TTL)
        self._search_cache = TTLCache(SEARCH_TTL)
        self._full_fetches: dict[str, Future] = {}
        self._bg = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ytm-bg")
        # Callable that renews the credentials file; returns True on success.
        self.reauth = None
        self._last_reauth = -REAUTH_INTERVAL
        # videoId -> shaped track, so PlayTrack can show metadata for known songs.
        self._known_tracks: dict[str, dict] = {}

    # -- auth -----------------------------------------------------------------

    def _ensure_client(self) -> YTMusic:
        """(Re)load credentials when the auth file appears or changes."""
        with self._lock:
            try:
                mtime = AUTH_FILE.stat().st_mtime
            except FileNotFoundError:
                self._yt = self._yt_search = None
                self._auth_mtime = None
                self.auth_state = "missing"
                raise AuthError("auth file not found")

            if self._yt is None or mtime != self._auth_mtime:
                session = requests.Session()
                session.request = _with_timeout(session.request, 20)
                try:
                    self._yt = YTMusic(str(AUTH_FILE), requests_session=session, language="pt")
                    self._yt_search = YTMusic(str(AUTH_FILE), requests_session=session,
                                              language="en")
                except Exception as e:
                    self._yt = self._yt_search = None
                    self._auth_mtime = mtime
                    self.auth_state = "invalid"
                    log.warning("could not load auth file (%s)", type(e).__name__)
                    raise AuthError("auth file invalid") from None
                self._auth_mtime = mtime
                self.auth_state = "unverified"
                self._cache.invalidate()
                self._tracks_cache.invalidate()
                self._search_cache.invalidate()
                log.info("credentials loaded")
            elif self.auth_state == "invalid":
                raise AuthError("credentials rejected")
            return self._yt

    def load_auth(self) -> None:
        try:
            self._ensure_client()
        except AuthError:
            pass

    def _call(self, fn, search: bool = False):
        """Run fn(yt) translating library errors into AuthError/ServiceError.

        If the credentials are rejected and `reauth` can renew them (e.g. from
        the browser the login came from), retry once.
        """
        try:
            return self._call_once(fn, search)
        except AuthError:
            if not self._try_reauth():
                raise
        return self._call_once(fn, search)

    def _try_reauth(self) -> bool:
        if self.reauth is None:
            return False
        with self._lock:
            now = time.monotonic()
            if now - self._last_reauth < REAUTH_INTERVAL:
                return False
            self._last_reauth = now
        try:
            return bool(self.reauth())
        except Exception:
            log.warning("automatic re-login failed")
            return False

    def _call_once(self, fn, search: bool = False):
        yt = self._ensure_client()
        if search:
            yt = self._yt_search
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

    def get_account(self, force: bool = False) -> dict:
        def fetch():
            info = self._call(lambda yt: yt.get_account_info())
            return {
                "name": info.get("accountName"),
                "handle": info.get("channelHandle"),
                "photo": info.get("accountPhotoUrl"),
            }

        return self._cache.get_or_fetch("account", fetch, force=force)

    def get_playlist_tracks(self, playlist_id: str, force: bool = False) -> dict:
        """Full list if cached, otherwise the first page with complete=False.

        An expired cached list is still returned right away and refreshed in
        the background. Calling again while a background fetch runs waits for it.
        """
        if force:
            self._tracks_cache.invalidate(playlist_id)
        cached, fresh = self._tracks_cache.get_stale(playlist_id)
        if cached:
            if not fresh:
                self._fetch_full_in_background(playlist_id)
            return cached

        with self._lock:
            pending = self._full_fetches.get(playlist_id)
        if pending and (result := pending.result()):
            return result

        first = self._fetch_playlist(playlist_id, FIRST_PAGE_LIMIT)
        if first["complete"]:
            self._tracks_cache.set(playlist_id, first)
            return first

        self._fetch_full_in_background(playlist_id)
        return first

    def _fetch_full_in_background(self, playlist_id: str) -> None:
        with self._lock:
            if playlist_id not in self._full_fetches:
                fut = self._bg.submit(self._fetch_full, playlist_id)
                self._full_fetches[playlist_id] = fut
                fut.add_done_callback(lambda _f: self._forget_fetch(playlist_id))

    def prefetch_playlists(self, playlists: list[dict]) -> None:
        """Load every playlist in the background so opening one is instant."""
        for p in playlists:
            if self._tracks_cache.get(p["id"]) is None:
                self._fetch_full_in_background(p["id"])

    def _fetch_full(self, playlist_id: str) -> dict | None:
        try:
            result = self._fetch_playlist(playlist_id, None)
        except (AuthError, ServiceError):
            # Prefetches can fail quietly; a direct request will report the error.
            log.warning("background playlist fetch failed")
            return None
        self._tracks_cache.set(playlist_id, result)
        log.info("playlist fully loaded: %d tracks", len(result["tracks"]))
        return result

    def _forget_fetch(self, playlist_id: str) -> None:
        with self._lock:
            self._full_fetches.pop(playlist_id, None)

    def _fetch_playlist(self, playlist_id: str, limit: int | None) -> dict:
        raw = self._call(lambda yt: yt.get_playlist(playlist_id, limit=limit))
        tracks = [_shape_track(t) for t in raw.get("tracks") or []]
        self._remember(tracks)
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

    def search(self, query: str) -> list[dict]:
        query = " ".join(query.split())
        if not query:
            return []

        def fetch():
            raw = self._call(
                lambda yt: yt.search(query, filter="songs", limit=SEARCH_LIMIT), search=True)
            tracks = [_shape_track(t) for t in raw if t.get("videoId")][:SEARCH_LIMIT]
            self._remember(tracks)
            return tracks

        return self._search_cache.get_or_fetch(query.casefold(), fetch)

    def add_to_playlist(self, playlist_id: str, video_id: str) -> None:
        if playlist_id == LIKED_PLAYLIST_ID:
            # "Liked music" can't be edited directly; liking the song adds it.
            self._call(lambda yt: yt.rate_song(video_id, LikeStatus.LIKE))
        else:
            cached = self._tracks_cache.get(playlist_id)
            if cached and any(t["videoId"] == video_id for t in cached["tracks"]):
                raise DuplicateError()
            result = self._call(
                lambda yt: yt.add_playlist_items(playlist_id, [video_id], duplicates=False))
            status = result.get("status", "") if isinstance(result, dict) else ""
            if "SUCCEEDED" not in status:
                # Without duplicates=True the backend refuses songs already present.
                log.warning("add to playlist not confirmed (status %r)", status or None)
                raise DuplicateError()
        self._tracks_cache.invalidate(playlist_id)
        self._cache.invalidate("playlists")  # track counts changed
        log.info("track added to a playlist")

    def remove_from_playlist(self, playlist_id: str, video_id: str) -> None:
        if playlist_id == LIKED_PLAYLIST_ID:
            self._call(lambda yt: yt.rate_song(video_id, LikeStatus.INDIFFERENT))
        else:
            cached, _fresh = self._tracks_cache.get_stale(playlist_id)
            track = next((t for t in (cached or {}).get("tracks", [])
                          if t["videoId"] == video_id and t.get("setVideoId")), None)
            if track is None:
                raise UnavailableError("track not found in playlist")
            item = {"videoId": video_id, "setVideoId": track["setVideoId"]}
            result = self._call(lambda yt: yt.remove_playlist_items(playlist_id, [item]))
            status = result if isinstance(result, str) else result.get("status", "")
            if "SUCCEEDED" not in str(status):
                log.warning("remove from playlist not confirmed (status %r)", status or None)
                raise ServiceError("remove not confirmed")
        # Drop it locally right away; counts are refetched with the playlists.
        cached, _fresh = self._tracks_cache.get_stale(playlist_id)
        if cached:
            tracks = [t for t in cached["tracks"] if t["videoId"] != video_id]
            count = cached["count"] - 1 if isinstance(cached["count"], int) else None
            self._tracks_cache.set(playlist_id, dict(cached, tracks=tracks, count=count))
        self._cache.invalidate("playlists")
        log.info("track removed from a playlist")

    def reset(self) -> None:
        """Forget the account (after logout or a new login)."""
        with self._lock:
            self._yt = self._yt_search = None
            self._auth_mtime = None
        for cache in (self._cache, self._tracks_cache, self._search_cache):
            cache.invalidate()

    def _remember(self, tracks: list[dict]) -> None:
        with self._lock:
            for t in tracks:
                if t["videoId"]:
                    self._known_tracks[t["videoId"]] = t

    def track_info(self, video_id: str) -> dict:
        with self._lock:
            known = self._known_tracks.get(video_id)
        return known or {
            "videoId": video_id, "title": None, "artists": "", "album": None,
            "duration": None, "duration_seconds": None, "available": True,
            "explicit": False, "thumbnail": None,
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
        # Needed to remove the item from a playlist; only set for owned ones.
        "setVideoId": t.get("setVideoId"),
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

"""Thin wrapper around ytmusicapi: auth loading, caching and result shaping.

Never log headers, cookies or the auth file contents.
"""

import logging
import threading

import requests
from ytmusicapi import YTMusic
from ytmusicapi.exceptions import YTMusicError, YTMusicServerError, YTMusicUserError

from .cache import TTLCache
from .paths import AUTH_FILE

log = logging.getLogger(__name__)

PLAYLISTS_TTL = 300  # seconds


class AuthError(Exception):
    """Credentials missing, unreadable or rejected by the server."""


class ServiceError(Exception):
    """Network or backend failure unrelated to auth."""


class Client:
    def __init__(self):
        self._yt: YTMusic | None = None
        self._auth_mtime: float | None = None
        # "missing" | "unverified" | "ok" | "invalid"
        self.auth_state = "missing"
        self._lock = threading.RLock()
        self._cache = TTLCache(PLAYLISTS_TTL)

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
        if self.auth_state == "unverified":
            self.auth_state = "ok"
        return result

    # -- api ------------------------------------------------------------------

    def get_playlists(self, force: bool = False) -> list[dict]:
        def fetch():
            raw = self._call(lambda yt: yt.get_library_playlists(limit=None))
            return [_shape_playlist(p) for p in raw if p.get("playlistId")]

        return self._cache.get_or_fetch("playlists", fetch, force=force)


def _with_timeout(request, timeout):
    def wrapped(*args, **kwargs):
        kwargs.setdefault("timeout", timeout)
        return request(*args, **kwargs)

    return wrapped


def _shape_playlist(p: dict) -> dict:
    count = p.get("count")
    try:
        count = int(str(count).replace(".", "").replace(",", "")) if count is not None else None
    except ValueError:
        count = None
    thumbs = p.get("thumbnails") or []
    return {
        "id": p["playlistId"],
        "title": p.get("title") or "",
        "count": count,
        "owned": bool(p.get("owned")),
        "thumbnail": thumbs[-1]["url"] if thumbs else None,
    }

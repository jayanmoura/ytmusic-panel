"""Validation of everything that arrives over D-Bus.

D-Bus already guarantees the types in the signature (s, i, d, b); this
checks values. Invalid input is rejected with "invalid_request" before it
reaches ytmusicapi, yt-dlp or mpv. Each method's arguments are listed in
METHOD_ARGS, so a new method without an entry fails loudly in the tests.
"""

import json
import math
import re

# YouTube video ids are always 11 characters from the URL-safe base64 alphabet.
VIDEO_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
# Playlist ids: PL..., OLAK5uy_..., RDCLAK5uy_..., VL<id> (ytmusicapi strips the
# VL), and the special two-letter ones LM (liked music) and SE (episodes).
PLAYLIST_ID_RE = re.compile(r"[A-Za-z0-9_-]{2,128}")
BROWSER_RE = re.compile(r"[a-z]{1,20}")

MAX_QUERY_LENGTH = 200
MAX_INDEX = 100_000
MAX_SEEK_SECONDS = 24 * 3600
MAX_COVERS = 200
MAX_URL_LENGTH = 2048


class InvalidRequest(Exception):
    """Rejected input. The message is safe to show (it never echoes the value)."""


def video_id(value) -> str:
    if not isinstance(value, str) or not VIDEO_ID_RE.fullmatch(value):
        raise InvalidRequest("Música inválida.")
    return value


def playlist_id(value) -> str:
    if not isinstance(value, str) or not PLAYLIST_ID_RE.fullmatch(value):
        raise InvalidRequest("Playlist inválida.")
    return value


def query(value) -> str:
    if not isinstance(value, str) or len(value) > MAX_QUERY_LENGTH:
        raise InvalidRequest("Busca muito longa.")
    if any(ord(c) < 32 for c in value):
        raise InvalidRequest("Busca inválida.")
    return value


def index(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_INDEX:
        raise InvalidRequest("Posição inválida.")
    return value


def boolean(value) -> bool:
    if not isinstance(value, bool):
        raise InvalidRequest("Valor inválido.")
    return value


def seconds(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidRequest("Posição inválida.")
    value = float(value)
    if not math.isfinite(value) or not 0 <= value <= MAX_SEEK_SECONDS:
        raise InvalidRequest("Posição inválida.")
    return value


def browser(value) -> str:
    if not isinstance(value, str) or not BROWSER_RE.fullmatch(value):
        raise InvalidRequest("Navegador inválido.")
    return value


def cover_urls(value) -> list[str]:
    """A JSON array of URLs (which hosts are allowed is checked in covers.py)."""
    if not isinstance(value, str):
        raise InvalidRequest("Lista de capas inválida.")
    try:
        urls = json.loads(value)
    except ValueError:
        raise InvalidRequest("Lista de capas inválida.") from None
    if (not isinstance(urls, list) or len(urls) > MAX_COVERS
            or not all(isinstance(u, str) and len(u) <= MAX_URL_LENGTH for u in urls)):
        raise InvalidRequest("Lista de capas inválida.")
    return urls


# D-Bus method -> one validator per input argument, in order.
METHOD_ARGS = {
    "GetStatus": (),
    "GetPlaylists": (),
    "RefreshPlaylists": (),
    "GetPlaylistTracks": (playlist_id,),
    "RefreshPlaylistTracks": (playlist_id,),
    "Search": (query,),
    "PlayPlaylist": (playlist_id, index, boolean),
    "PlayTrack": (video_id,),
    "AddToPlaylist": (playlist_id, video_id),
    "RemoveFromPlaylist": (playlist_id, video_id),
    "Prepare": (video_id,),
    "Enqueue": (video_id,),
    "PlayNext": (video_id,),
    "ListBrowsers": (),
    "LoginWithBrowser": (browser,),
    "Logout": (),
    "GetAccount": (),
    "GetCovers": (cover_urls,),
    "GetPosition": (),
    "Seek": (seconds,),
    "TogglePause": (),
    "Next": (),
    "Previous": (),
    "ToggleShuffle": (),
    "CycleRepeat": (),
}


def validate(method: str, args: tuple) -> tuple:
    """Return the validated (possibly converted) arguments for `method`."""
    validators = METHOD_ARGS.get(method)
    if validators is None:
        raise InvalidRequest("Método desconhecido.")
    if len(args) != len(validators):
        raise InvalidRequest("Número de argumentos inválido.")
    return tuple(check(arg) for check, arg in zip(validators, args))

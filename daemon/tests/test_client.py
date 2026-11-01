"""client.Client without the network: ytmusicapi is replaced by a fake object."""

import pytest
from ytmusicapi.exceptions import YTMusicServerError
from ytmusicapi.models.content.enums import LikeStatus

from ytmusic_daemon import client as client_mod
from ytmusic_daemon.client import (
    AuthError,
    Client,
    DuplicateError,
    UnavailableError,
    _shape_playlist,
    _shape_track,
)


class FakeYT:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def method(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {"status": "STATUS_SUCCEEDED"}
        return method


@pytest.fixture
def client(monkeypatch):
    c = Client()
    yt = FakeYT()
    monkeypatch.setattr(c, "_ensure_client", lambda: yt)
    c.yt = yt
    yield c
    c.shutdown()


def test_shape_track():
    raw = {
        "videoId": "abcdefghijk", "title": "Song", "duration": "3:10", "duration_seconds": 190,
        "artists": [{"name": "A"}, {"name": "B"}, {"name": None}],
        "album": {"name": "Album"}, "isAvailable": True, "isExplicit": True,
        "thumbnails": [{"url": "small"}, {"url": "big"}], "setVideoId": "SET1",
    }
    t = _shape_track(raw)
    assert t["artists"] == "A, B"
    assert t["album"] == "Album"
    assert t["thumbnail"] == "big"
    assert t["available"] and t["explicit"]
    assert t["setVideoId"] == "SET1"


def test_shape_track_without_video_id_is_unavailable():
    assert _shape_track({"title": "x"})["available"] is False


@pytest.mark.parametrize("count, expected", [
    ("1.692", 1692), ("1,692", 1692), (28, 28), (None, None), ("?", None),
])
def test_shape_playlist_count(count, expected):
    p = _shape_playlist({"playlistId": "PLx", "title": "T", "count": count, "owned": 1})
    assert p["count"] == expected
    assert p["owned"] is True


def test_playlist_tracks_served_from_cache_without_fetch(client, monkeypatch):
    data = {"id": "PLx", "title": "", "count": 1, "complete": True, "tracks": []}
    client._tracks_cache.set("PLx", data)
    monkeypatch.setattr(client, "_fetch_playlist", lambda *a: pytest.fail("fetched"))
    assert client.get_playlist_tracks("PLx") is data


def test_stale_playlist_returned_and_refreshed_in_background(client, monkeypatch):
    data = {"id": "PLx", "title": "", "count": 1, "complete": True, "tracks": []}
    client._tracks_cache.set("PLx", data)
    now = client_mod.time.monotonic()
    later = now + client_mod.TRACKS_TTL + 1
    monkeypatch.setattr("ytmusic_daemon.cache.time.monotonic", lambda: later)
    refreshed = []
    monkeypatch.setattr(client, "_fetch_full_in_background", refreshed.append)
    assert client.get_playlist_tracks("PLx") is data
    assert refreshed == ["PLx"]


def test_add_to_liked_rates_the_song(client):
    client.add_to_playlist("LM", "abcdefghijk")
    assert client.yt.calls == [("rate_song", ("abcdefghijk", LikeStatus.LIKE), {})]


def test_add_duplicate_detected_from_cache(client):
    client._tracks_cache.set("PLx", {"tracks": [{"videoId": "abcdefghijk"}]})
    with pytest.raises(DuplicateError):
        client.add_to_playlist("PLx", "abcdefghijk")
    assert client.yt.calls == []


def test_remove_uses_set_video_id_and_updates_cache(client):
    client._tracks_cache.set("PLx", {"id": "PLx", "count": 2, "complete": True, "tracks": [
        {"videoId": "aaaaaaaaaaa", "setVideoId": "S1"},
        {"videoId": "bbbbbbbbbbb", "setVideoId": "S2"},
    ]})
    client.remove_from_playlist("PLx", "aaaaaaaaaaa")
    name, args, _ = client.yt.calls[0]
    assert name == "remove_playlist_items"
    assert args == ("PLx", [{"videoId": "aaaaaaaaaaa", "setVideoId": "S1"}])
    cached, _fresh = client._tracks_cache.get_stale("PLx")
    assert [t["videoId"] for t in cached["tracks"]] == ["bbbbbbbbbbb"]
    assert cached["count"] == 1


def test_remove_unknown_track_fails_without_calling_the_api(client):
    client._tracks_cache.set("PLx", {"tracks": []})
    with pytest.raises(UnavailableError):
        client.remove_from_playlist("PLx", "aaaaaaaaaaa")
    assert client.yt.calls == []


def test_remove_from_liked_unrates(client):
    client.remove_from_playlist("LM", "abcdefghijk")
    assert client.yt.calls[0] == ("rate_song", ("abcdefghijk", LikeStatus.INDIFFERENT), {})


def test_rejected_credentials_retry_once_after_reauth(client):
    attempts = []

    def fn(yt):
        attempts.append(1)
        if len(attempts) == 1:
            raise YTMusicServerError("Server returned HTTP 401: Unauthorized.")
        return "ok"

    client.reauth = lambda: True
    assert client._call(fn) == "ok"
    assert len(attempts) == 2


def test_reauth_is_rate_limited(client):
    def fn(yt):
        raise YTMusicServerError("Server returned HTTP 403: Forbidden.")

    renewals = []
    client.reauth = lambda: renewals.append(1) or True
    with pytest.raises(AuthError):
        client._call(fn)
    with pytest.raises(AuthError):
        client._call(fn)  # within REAUTH_INTERVAL: no second renewal
    assert len(renewals) == 1

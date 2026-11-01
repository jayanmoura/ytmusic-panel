import pytest

from ytmusic_daemon import cache as cache_mod
from ytmusic_daemon.cache import TTLCache


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(cache_mod.time, "monotonic", lambda: now[0])
    return now


def test_get_or_fetch_caches_until_ttl(clock):
    c = TTLCache(10)
    calls = []
    fetch = lambda: calls.append(1) or len(calls)  # noqa: E731
    assert c.get_or_fetch("k", fetch) == 1
    clock[0] += 9
    assert c.get_or_fetch("k", fetch) == 1
    clock[0] += 2
    assert c.get_or_fetch("k", fetch) == 2


def test_force_refetches(clock):
    c = TTLCache(10)
    c.set("k", "old")
    assert c.get_or_fetch("k", lambda: "new", force=True) == "new"
    assert c.get("k") == "new"


def test_get_expires(clock):
    c = TTLCache(5)
    c.set("k", 1)
    assert c.get("k") == 1
    clock[0] += 6
    assert c.get("k") is None


def test_get_stale(clock):
    c = TTLCache(5)
    assert c.get_stale("k") == (None, False)
    c.set("k", "v")
    assert c.get_stale("k") == ("v", True)
    clock[0] += 6
    assert c.get_stale("k") == ("v", False)


def test_invalidate(clock):
    c = TTLCache(5)
    c.set("a", 1)
    c.set("b", 2)
    c.invalidate("a")
    assert c.get("a") is None and c.get("b") == 2
    c.invalidate()
    assert c.get("b") is None

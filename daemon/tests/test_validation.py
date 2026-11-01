import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from ytmusic_daemon import validation as v
from ytmusic_daemon.validation import InvalidRequest


@pytest.mark.parametrize("value", ["dQw4w9WgXcQ", "j7WN8IJqsMQ", "a-b_c-d_e-f"])
def test_video_id_valid(value):
    assert v.video_id(value) == value


@pytest.mark.parametrize("value", [
    "", "abc", "dQw4w9WgXcQx", "../../etc/pa", "dQw4w9WgXc!", "dQw4w9 gXcQ", None, 123,
])
def test_video_id_invalid(value):
    with pytest.raises(InvalidRequest):
        v.video_id(value)


@pytest.mark.parametrize("value", [
    "LM", "SE", "PLcZj6bRxZl4_G1IYsBO3mDASFsHCS4L-n", "VLPL4fGSI1pDJn6", "OLAK5uy_abc",
    "RDCLAK5uy_xyz",
])
def test_playlist_id_valid(value):
    assert v.playlist_id(value) == value


@pytest.mark.parametrize("value", ["", "L", "PL x;rm", "PL/../x", "x" * 129, None])
def test_playlist_id_invalid(value):
    with pytest.raises(InvalidRequest):
        v.playlist_id(value)


def test_query_limits():
    assert v.query("") == ""
    assert v.query("a" * 200) == "a" * 200
    with pytest.raises(InvalidRequest):
        v.query("a" * 201)
    with pytest.raises(InvalidRequest):
        v.query("abc\ndef")


def test_index_rejects_bool_and_out_of_range():
    assert v.index(0) == 0
    for bad in (-1, v.MAX_INDEX + 1, True, 1.5, "1"):
        with pytest.raises(InvalidRequest):
            v.index(bad)


def test_seconds():
    assert v.seconds(12) == 12.0
    assert v.seconds(0.5) == 0.5
    for bad in (-5, float("nan"), float("inf"), 1e9, True, "3"):
        with pytest.raises(InvalidRequest):
            v.seconds(bad)


def test_boolean_and_browser():
    assert v.boolean(False) is False
    with pytest.raises(InvalidRequest):
        v.boolean(0)
    assert v.browser("firefox") == "firefox"
    for bad in ("Fire fox", "", "FIREFOX", "a" * 21):
        with pytest.raises(InvalidRequest):
            v.browser(bad)


def test_cover_urls():
    assert v.cover_urls('["https://a/b"]') == ["https://a/b"]
    for bad in ("{}", "[1]", "nope", "[" + ",".join(['"x"'] * 201) + "]", '["' + "x" * 3000 + '"]'):
        with pytest.raises(InvalidRequest):
            v.cover_urls(bad)


def test_validate_dispatch():
    assert v.validate("PlayPlaylist", ("LM", 3, True)) == ("LM", 3, True)
    with pytest.raises(InvalidRequest):
        v.validate("PlayPlaylist", ("LM", 3))  # wrong arity
    with pytest.raises(InvalidRequest):
        v.validate("NoSuchMethod", ())


def _dbus_methods() -> dict[str, int]:
    """Method -> number of input args, read from service.py without importing it (no gi)."""
    src = (Path(__file__).parent.parent / "ytmusic_daemon" / "service.py").read_text()
    xml = re.search(r'INTROSPECTION_XML = f"""(.*?)"""', src, re.S).group(1)
    root = ET.fromstring(xml.replace("{INTERFACE}", "x"))
    return {m.get("name"): len(m.findall("arg[@direction='in']")) for m in root.iter("method")}


def test_every_dbus_method_is_validated():
    methods = _dbus_methods()
    assert set(methods) == set(v.METHOD_ARGS)
    for name, count in methods.items():
        assert len(v.METHOD_ARGS[name]) == count, name

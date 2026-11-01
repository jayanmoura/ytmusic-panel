"""Queue logic of player.Player, with mpv replaced by a recorder (no process, no IPC)."""

import random

import pytest

from ytmusic_daemon import player as player_mod
from ytmusic_daemon.player import Player, track_url


class FakePlayer(Player):
    """Player whose mpv only records commands and keeps a playlist-pos."""

    def __init__(self):
        super().__init__()
        self.sent = []

    def _running(self):
        return True

    def _start(self):
        pass

    def _send(self, command):
        self.sent.append(command)

    def playing_at(self, mpv_pos):
        """Simulate mpv reporting the current entry."""
        self._starting = None
        self._props.update({"playlist-pos": mpv_pos, "idle-active": False,
                            "core-idle": False, "pause": False})


def tracks(n):
    return [{"videoId": f"vid{i:08d}", "title": f"t{i}"} for i in range(n)]


@pytest.fixture(autouse=True)
def runtime_dir(tmp_path, monkeypatch):
    # play() writes m3u queue files here.
    monkeypatch.setattr(player_mod, "RUNTIME_DIR", tmp_path)


def test_play_loads_chosen_track_first():
    p = FakePlayer()
    q = tracks(5)
    p.play(q, 2)
    assert p.queue == q
    assert p.sent[0] == ["loadfile", track_url("vid00000002"), "replace"]
    assert p.sent[1][0] == "loadlist" and p.sent[1][2] == "append"
    # The ones before the chosen track wait for file-loaded.
    assert p._pending_before[1] == q[:2]
    assert p.state()["index"] == 2


def test_play_shuffled_keeps_chosen_first_and_original_order():
    random.seed(1)
    p = FakePlayer()
    p.shuffle = True
    q = tracks(10)
    p.play(q, 4)
    assert p.queue[0] is q[4]
    assert sorted(t["videoId"] for t in p.queue) == sorted(t["videoId"] for t in q)
    assert p._original == q
    assert p._pending_before is None


def test_toggle_shuffle_and_back_restores_order_around_current():
    random.seed(2)
    p = FakePlayer()
    q = tracks(8)
    p.play(q, 0)
    p.playing_at(3)  # now on q[3]
    p.toggle_shuffle()
    assert p.shuffle is True
    assert p.queue[0] is q[3]  # current track first, the rest shuffled
    assert sorted(t["videoId"] for t in p.queue) == sorted(t["videoId"] for t in q)
    assert ["playlist-clear"] in p.sent

    p.playing_at(0)
    p.toggle_shuffle()
    assert p.shuffle is False
    assert p.queue == q  # original order back, current still q[3]
    assert p.queue.index(q[3]) == 3


def test_toggle_shuffle_when_stopped_only_flips_the_flag():
    p = FakePlayer()
    p.toggle_shuffle()
    assert p.shuffle is True
    assert p.sent == []


def test_cycle_repeat():
    p = FakePlayer()
    seen = []
    for _ in range(3):
        p.cycle_repeat()
        seen.append(p.repeat)
    assert seen == ["all", "one", "off"]
    assert ["set_property", "loop-playlist", "inf"] in p.sent
    assert ["set_property", "loop-file", "inf"] in p.sent


def test_enqueue_when_stopped_plays_it():
    p = FakePlayer()
    t = tracks(1)[0]
    p.enqueue(t)
    assert p.queue == [t]
    assert p.sent[0][0] == "loadfile" and p.sent[0][2] == "replace"


def test_enqueue_and_play_next_while_playing():
    p = FakePlayer()
    q = tracks(4)
    p.play(q, 0)
    p.playing_at(1)
    extra, nxt = {"videoId": "extra000001"}, {"videoId": "next0000001"}
    p.enqueue(extra)
    p.play_next(nxt)
    assert p.queue[-1] is extra
    assert p.queue[2] is nxt  # right after the current (index 1)
    assert p._original.index(nxt) == p._original.index(q[1]) + 1
    assert ["loadfile", track_url("next0000001"), "insert-next"] in p.sent


def test_stop_clears_queue():
    p = FakePlayer()
    p.play(tracks(3), 0)
    p.stop()
    assert p.queue == [] and p._original == []
    assert ["stop"] in p.sent


def test_state_reports_modes_even_when_stopped():
    p = FakePlayer()
    p.shuffle = True
    p.repeat = "one"
    p._props = {"idle-active": True}
    s = p.state()
    assert s["state"] == "stopped"
    assert s["shuffle"] is True and s["repeat"] == "one"

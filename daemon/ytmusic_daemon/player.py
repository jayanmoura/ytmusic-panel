"""mpv controlled over its JSON IPC socket.

mpv runs audio-only with --idle, is started on first use and kept alive.
The queue mirrors mpv's internal playlist so we can map playlist-pos back to
our track metadata.
"""

import json
import logging
import os
import random
import shlex
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from .paths import RUNTIME_DIR

log = logging.getLogger(__name__)

VENV_BIN = Path(sys.executable).parent
YTDLP = VENV_BIN / "yt-dlp"
MPRIS_PLUGIN_CANDIDATES = [
    Path("/usr/lib/mpv-mpris/mpris.so"),
    Path("/etc/mpv/scripts/mpris.so"),
]
PRELOAD_SCRIPT = Path(__file__).with_name("preload.lua")
# Per-process names so a second daemon (e.g. in a nested dev session) can't clash.
SOCKET_PATH = RUNTIME_DIR / f"mpv-{os.getpid()}.sock"
COMMAND_TIMEOUT = 5.0

OBSERVED = ["pause", "playlist-pos", "idle-active", "core-idle", "duration", "path",
            "media-title"]
REPEAT_MODES = ("off", "all", "one")
# "Previous" restarts the current track instead when past this point (seconds).
RESTART_THRESHOLD = 3.0

URL_PREFIX = "https://music.youtube.com/watch?v="


def track_url(video_id: str) -> str:
    return URL_PREFIX + video_id


def video_id_from_url(url) -> str | None:
    if isinstance(url, str) and url.startswith(URL_PREFIX):
        return url[len(URL_PREFIX):]
    return None


class PlayerError(Exception):
    pass


class Player:
    def __init__(self, on_change=None, on_track_loaded=None):
        self._on_change = on_change  # called from the reader thread
        # Called with the queue index of each track that starts (own thread).
        self._on_track_loaded = on_track_loaded
        # videoId -> resolved stream (see resolver.py), mirrored into mpv.
        self._preloads: dict[str, dict] = {}
        self._proc: subprocess.Popen | None = None
        self._sock: socket.socket | None = None
        self._reader: threading.Thread | None = None
        self._lock = threading.RLock()  # serializes start/commands
        self._pending: dict[int, list] = {}  # request_id -> [Event, reply]
        self._next_id = 1
        self._props: dict = {}
        self.queue: list[dict] = []
        # Queue in its original order, to undo shuffling.
        self._original: list[dict] = []
        self.shuffle = False
        self.repeat = "off"
        self._queue_gen = 0
        # Tracks before the start one are inserted once it has loaded (see play()).
        self._pending_before: tuple[int, list[dict]] | None = None
        # mpv's playlist-pos + offset = index in self.queue, until they're inserted.
        self._pos_offset = 0
        # Queue index being started; mpv reports idle until the URL resolves.
        self._starting: int | None = None
        self._list_serial = 0

    # -- process & socket ------------------------------------------------------

    def _running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None and self._sock is not None

    def _start(self) -> None:
        if self._running():
            return
        self._stop_process()
        RUNTIME_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        SOCKET_PATH.unlink(missing_ok=True)

        args = [
            "mpv", "--no-config", "--idle=yes", "--no-video", "--audio-display=no",
            "--no-terminal", "--input-terminal=no",
            f"--input-ipc-server={SOCKET_PATH}",
            "--ytdl-format=bestaudio/best",
            f"--script-opts=ytdl_hook-ytdl_path={YTDLP}",
            # yt-dlp's default client returns stream URLs that 403 outside yt-dlp
            # (they need chunked downloads); web_music URLs play directly in mpv.
            "--ytdl-raw-options=extractor-args=youtube:player_client=web_music",
            # mpv-mpris builds its bus name from this, so it must be a valid
            # D-Bus name element (a space here makes the plugin hang mpv).
            "--audio-client-name=ytmusic",
            "--title=YouTube Music",
            f"--loop-playlist={'inf' if self.repeat == 'all' else 'no'}",
            f"--loop-file={'inf' if self.repeat == 'one' else 'no'}",
        ]
        # Debug/testing hook, e.g. YTMUSIC_MPV_EXTRA_ARGS="--ao=null".
        args += shlex.split(os.environ.get("YTMUSIC_MPV_EXTRA_ARGS", ""))
        args.append(f"--script={PRELOAD_SCRIPT}")
        plugin = next((p for p in MPRIS_PLUGIN_CANDIDATES if p.exists()), None)
        if plugin:
            args.append(f"--script={plugin}")
        else:
            log.warning("mpv-mpris plugin not found; media keys won't work")

        # yt-dlp needs the venv's deno on PATH to solve YouTube's JS challenges.
        env = dict(os.environ, PATH=f"{VENV_BIN}:{os.environ.get('PATH', '/usr/bin:/bin')}")
        self._proc = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        deadline = time.monotonic() + 5
        while True:
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(str(SOCKET_PATH))
                break
            except (FileNotFoundError, ConnectionRefusedError):
                sock.close()
                if self._proc.poll() is not None or time.monotonic() > deadline:
                    self._stop_process()
                    raise PlayerError("mpv did not start") from None
                time.sleep(0.05)

        self._sock = sock
        self._props = {}
        self.queue = []
        self._reader = threading.Thread(target=self._read_loop, args=(sock,),
                                        name="mpv-ipc", daemon=True)
        self._reader.start()
        for i, prop in enumerate(OBSERVED, start=1):
            self._send(["observe_property", i, prop])
        now = time.time()
        for video_id, entry in list(self._preloads.items()):
            if entry["expires"] > now:
                self._push_preload(video_id, entry)
        log.info("mpv started (pid %d)", self._proc.pid)

    def _stop_process(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None

    def _read_loop(self, sock: socket.socket) -> None:
        buf = b""
        while True:
            try:
                chunk = sock.recv(65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                self._dispatch(msg)
        # Wake up anyone still waiting for a reply.
        for waiter in list(self._pending.values()):
            waiter[1] = {"error": "disconnected"}
            waiter[0].set()
        if self._sock is sock:
            log.warning("mpv connection closed")
            self._sock = None
            self._props = {}
            self._notify()

    def _dispatch(self, msg: dict) -> None:
        if "request_id" in msg and msg["request_id"] in self._pending:
            waiter = self._pending[msg["request_id"]]
            waiter[1] = msg
            waiter[0].set()
            return
        event = msg.get("event")
        if event == "property-change":
            self._props[msg["name"]] = msg.get("data")
            self._notify()
        elif event in ("file-loaded", "end-file", "idle"):
            if event == "file-loaded" or msg.get("reason") == "error":
                self._starting = None
            self._notify()
        if event == "file-loaded" and self._on_track_loaded:
            index = self.state().get("index")
            if index is not None:
                threading.Thread(target=self._on_track_loaded, args=(index,),
                                 name="mpv-loaded", daemon=True).start()
        if event == "file-loaded" and self._pending_before:
            gen, before = self._pending_before
            self._pending_before = None
            # Can't send commands from the reader thread (it delivers the replies).
            threading.Thread(target=self._insert_before, args=(gen, before),
                             name="mpv-insert", daemon=True).start()
        if event == "end-file" and msg.get("reason") == "error":
            # Usually an unavailable/blocked video; mpv moves on by itself.
            log.warning("track failed to play: %s", msg.get("file_error", "unknown error"))

    def _notify(self) -> None:
        if self._on_change:
            try:
                self._on_change()
            except Exception:
                log.exception("playback change callback failed")

    def _send(self, command: list):
        """Send a command and wait for mpv's reply. Caller must hold no socket lock."""
        with self._lock:
            if not self._sock:
                raise PlayerError("mpv not running")
            rid = self._next_id
            self._next_id += 1
            waiter = [threading.Event(), None]
            self._pending[rid] = waiter
            payload = json.dumps({"command": command, "request_id": rid}) + "\n"
            try:
                self._sock.sendall(payload.encode())
            except OSError as e:
                self._pending.pop(rid, None)
                raise PlayerError(f"mpv socket error: {e}") from None
        try:
            if not waiter[0].wait(COMMAND_TIMEOUT):
                raise PlayerError(f"mpv timeout on {command[0]}")
        finally:
            self._pending.pop(rid, None)
        reply = waiter[1] or {}
        if reply.get("error") != "success":
            raise PlayerError(f"mpv {command[0]}: {reply.get('error')}")
        return reply.get("data")

    # -- playback --------------------------------------------------------------

    def _write_list(self, tracks: list[dict]) -> Path:
        self._list_serial += 1
        path = RUNTIME_DIR / f"queue-{os.getpid()}-{self._list_serial % 3}.m3u"
        path.write_text("".join(track_url(t["videoId"]) + "\n" for t in tracks))
        return path

    def play(self, tracks: list[dict], start: int = 0) -> None:
        """Replace the queue with `tracks` and start at `start`.

        The chosen track is loaded first so it starts right away, and the ones
        after it are appended. The ones before it are inserted only after it
        has loaded: inserting while yt-dlp is still resolving the first URL
        makes mpv start from the top of the list instead.
        """
        if not tracks:
            raise PlayerError("empty queue")
        tracks = list(tracks)
        original = list(tracks)
        if self.shuffle:
            # The chosen track plays first; the rest in random order.
            rest = tracks[:start] + tracks[start + 1:]
            random.shuffle(rest)
            tracks, start = [tracks[start]] + rest, 0
        with self._lock:
            self._start()
            self._queue_gen += 1
            self._original = original
            self.queue = list(tracks)
            self._pos_offset = start
            self._starting = start
            self._pending_before = (self._queue_gen, tracks[:start]) if start > 0 else None
            self._send(["loadfile", track_url(tracks[start]["videoId"]), "replace"])
            if start + 1 < len(tracks):
                self._send(["loadlist", str(self._write_list(tracks[start + 1:])), "append"])
            self._send(["set_property", "pause", False])
        self._notify()

    def _insert_before(self, gen: int, before: list[dict]) -> None:
        with self._lock:
            if gen != self._queue_gen or not self._running():
                return
            try:
                self._send(["loadlist", str(self._write_list(before)), "insert-at", 0])
                self._pos_offset = 0
            except PlayerError as e:
                log.warning("could not insert previous tracks: %s", e)

    def append(self, tracks: list[dict]) -> None:
        if not tracks:
            return
        with self._lock:
            if not self._running():
                return
            self._original.extend(tracks)
            if self.shuffle:
                tracks = random.sample(tracks, len(tracks))
            path = self._write_list(tracks)
            self._send(["loadlist", str(path), "append"])
            self.queue.extend(tracks)

    def enqueue(self, track: dict) -> None:
        """Add to the end of the queue, or play it if nothing is playing."""
        with self._lock:
            if self.state()["state"] == "stopped":
                self.play([track])
                return
            self._send(["loadfile", track_url(track["videoId"]), "append"])
            self.queue.append(track)
            self._original.append(track)
        self._notify()

    def play_next(self, track: dict) -> None:
        """Insert right after the current track, or play it if nothing is playing."""
        with self._lock:
            if self.state()["state"] == "stopped":
                self.play([track])
                return
            pos = self._props.get("playlist-pos")
            if not isinstance(pos, int) or pos < 0:
                pos = (self._starting or 0) - self._pos_offset
            self._send(["loadfile", track_url(track["videoId"]), "insert-next"])
            current = self.track_at(pos + self._pos_offset)
            self.queue.insert(pos + self._pos_offset + 1, track)
            at = next((i for i, t in enumerate(self._original) if t is current), None)
            self._original.insert(at + 1 if at is not None else len(self._original), track)
        self._notify()

    # -- repeat & shuffle -----------------------------------------------------------

    def cycle_repeat(self) -> None:
        """off -> all (the queue) -> one (the current track) -> off."""
        with self._lock:
            self.repeat = REPEAT_MODES[(REPEAT_MODES.index(self.repeat) + 1) % len(REPEAT_MODES)]
            if self._running():
                self._send(["set_property", "loop-playlist",
                            "inf" if self.repeat == "all" else "no"])
                self._send(["set_property", "loop-file", "inf" if self.repeat == "one" else "no"])
        self._notify()

    def toggle_shuffle(self) -> None:
        with self._lock:
            self.shuffle = not self.shuffle
            if self._running() and self.state()["state"] != "stopped":
                self._reorder()
        self._notify()

    def _reorder(self) -> None:
        """Rebuild mpv's playlist around the current track, shuffled or in the
        original order. mpv's own shuffle would leave self.queue out of sync."""
        index = self.state().get("index")
        current = self.track_at(index) if index is not None else None
        if current is None:
            return
        # Tracks still waiting to be inserted before the first one are in _original.
        self._pending_before = None
        others = list(self._original)
        at = next((i for i, t in enumerate(others) if t is current), None)
        if at is None:
            at = next((i for i, t in enumerate(others) if t["videoId"] == current["videoId"]), None)
        if at is not None:
            del others[at]
        if self.shuffle:
            before, after = [], random.sample(others, len(others))
        else:
            split = at if at is not None else 0
            before, after = others[:split], others[split:]
        self._send(["playlist-clear"])  # keeps the current entry
        if after:
            self._send(["loadlist", str(self._write_list(after)), "append"])
        if before:
            self._send(["loadlist", str(self._write_list(before)), "insert-at", 0])
        self.queue = before + [current] + after
        self._pos_offset = 0
        self._starting = None if self._starting is None else len(before)

    # -- preloaded streams ---------------------------------------------------------

    def preload(self, video_id: str, entry: dict) -> None:
        """Hand a resolved stream to mpv; preload.lua uses it when the track opens."""
        with self._lock:
            now = time.time()
            self._preloads = {k: v for k, v in self._preloads.items() if v["expires"] > now}
            self._preloads[video_id] = entry
            if self._running():
                self._push_preload(video_id, entry)

    def _push_preload(self, video_id: str, entry: dict) -> None:
        try:
            self._send(["set_property", f"user-data/ytmusic/{video_id}", entry])
        except PlayerError as e:
            log.debug("could not hand a stream to mpv: %s", e)

    def track_at(self, index: int) -> dict | None:
        with self._lock:
            return self.queue[index] if 0 <= index < len(self.queue) else None

    # -- controls ----------------------------------------------------------------

    def toggle_pause(self) -> None:
        with self._lock:
            if self._running():
                self._send(["cycle", "pause"])

    def next(self) -> None:
        with self._lock:
            if self._running():
                self._send_quiet(["playlist-next", "weak"])

    def previous(self) -> None:
        with self._lock:
            if not self._running():
                return
            try:
                position = self._send(["get_property", "time-pos"]) or 0
            except PlayerError:
                position = 0
            if position > RESTART_THRESHOLD:
                self._send(["seek", 0, "absolute"])
            else:
                self._send_quiet(["playlist-prev", "weak"])

    def _send_quiet(self, command: list) -> None:
        """For commands mpv rejects at the ends of the playlist."""
        try:
            self._send(command)
        except PlayerError as e:
            log.debug("ignored: %s", e)

    def state(self) -> dict:
        props = self._props
        modes = {"shuffle": self.shuffle, "repeat": self.repeat}
        if not self._running():
            return {"state": "stopped", "index": None, "track": None, **modes}
        pos = props.get("playlist-pos")
        index = pos + self._pos_offset if isinstance(pos, int) and pos >= 0 else None
        if self._starting is not None and index is None:
            index = self._starting
        idle = props.get("idle-active", True) and index is None
        if idle:
            return {"state": "stopped", "index": None, "track": None, **modes}
        track = self.queue[index] if index is not None and index < len(self.queue) else None
        # The URL is authoritative; the index can be briefly off while inserting.
        vid = video_id_from_url(props.get("path"))
        if vid and (track is None or track["videoId"] != vid):
            track = next((t for t in self.queue if t["videoId"] == vid), track)
        if track is not None and not track.get("title") and props.get("media-title"):
            track = dict(track, title=props["media-title"])
        if props.get("pause"):
            state = "paused"
        elif self._starting is not None or props.get("core-idle") or props.get("idle-active"):
            state = "loading"
        else:
            state = "playing"
        return {
            "state": state,
            "index": index,
            "length": len(self.queue),
            "duration": props.get("duration"),
            "track": track,
            **modes,
        }

    def shutdown(self) -> None:
        with self._lock:
            if self._sock:
                try:
                    self._send(["quit"])
                except PlayerError:
                    pass
            self._stop_process()
        SOCKET_PATH.unlink(missing_ok=True)
        for path in RUNTIME_DIR.glob(f"queue-{os.getpid()}-*.m3u"):
            path.unlink(missing_ok=True)

"""mpv controlled over its JSON IPC socket.

mpv runs audio-only with --idle, is started on first use and kept alive.
The queue mirrors mpv's internal playlist so we can map playlist-pos back to
our track metadata.
"""

import json
import logging
import os
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
# Per-process names so a second daemon (e.g. in a nested dev session) can't clash.
SOCKET_PATH = RUNTIME_DIR / f"mpv-{os.getpid()}.sock"
COMMAND_TIMEOUT = 5.0

OBSERVED = ["pause", "playlist-pos", "idle-active", "core-idle", "duration", "path"]

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
    def __init__(self, on_change=None):
        self._on_change = on_change  # called from the reader thread
        self._proc: subprocess.Popen | None = None
        self._sock: socket.socket | None = None
        self._reader: threading.Thread | None = None
        self._lock = threading.RLock()  # serializes start/commands
        self._pending: dict[int, list] = {}  # request_id -> [Event, reply]
        self._next_id = 1
        self._props: dict = {}
        self.queue: list[dict] = []
        self._queue_gen = 0
        # Tracks before the start one are inserted once it has loaded (see play()).
        self._pending_before: tuple[int, list[dict]] | None = None
        # mpv's playlist-pos + offset = index in self.queue, until they're inserted.
        self._pos_offset = 0
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
        ]
        # Debug/testing hook, e.g. YTMUSIC_MPV_EXTRA_ARGS="--ao=null".
        args += shlex.split(os.environ.get("YTMUSIC_MPV_EXTRA_ARGS", ""))
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
        elif event == "file-loaded" and self._pending_before:
            gen, before = self._pending_before
            self._pending_before = None
            # Can't send commands from the reader thread (it delivers the replies).
            threading.Thread(target=self._insert_before, args=(gen, before),
                             name="mpv-insert", daemon=True).start()
        elif event == "end-file" and msg.get("reason") == "error":
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
        with self._lock:
            self._start()
            self._queue_gen += 1
            self.queue = list(tracks)
            self._pos_offset = start
            self._pending_before = (self._queue_gen, tracks[:start]) if start > 0 else None
            self._send(["loadfile", track_url(tracks[start]["videoId"]), "replace"])
            if start + 1 < len(tracks):
                self._send(["loadlist", str(self._write_list(tracks[start + 1:])), "append"])
            self._send(["set_property", "pause", False])

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
            path = self._write_list(tracks)
            self._send(["loadlist", str(path), "append"])
            self.queue.extend(tracks)

    def state(self) -> dict:
        props = self._props
        idle = props.get("idle-active", True) and props.get("playlist-pos", -1) in (-1, None)
        if not self._running() or idle:
            return {"state": "stopped", "index": None, "track": None}
        pos = props.get("playlist-pos")
        index = pos + self._pos_offset if isinstance(pos, int) and pos >= 0 else None
        track = self.queue[index] if index is not None and index < len(self.queue) else None
        # The URL is authoritative; the index can be briefly off while inserting.
        vid = video_id_from_url(props.get("path"))
        if vid and (track is None or track["videoId"] != vid):
            track = next((t for t in self.queue if t["videoId"] == vid), track)
        if props.get("pause"):
            state = "paused"
        elif props.get("core-idle"):
            state = "loading"
        else:
            state = "playing"
        return {
            "state": state,
            "index": index,
            "length": len(self.queue),
            "duration": props.get("duration"),
            "track": track,
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

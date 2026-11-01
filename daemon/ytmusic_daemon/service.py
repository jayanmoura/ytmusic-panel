"""ytmusic-daemon: session D-Bus service backing the ytmusic-panel extension.

Every method returns a JSON string:
    {"ok": true, "data": ...}
    {"ok": false, "error": "<code>", "message": "<human readable>"}
Error codes: auth_required, network, unavailable, bad_request, player, internal.
"""

import json
import logging
import signal
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from . import BUS_NAME, INTERFACE, OBJECT_PATH  # noqa: E402
from .client import AuthError, Client, ServiceError, UnavailableError  # noqa: E402
from .player import Player, PlayerError  # noqa: E402

log = logging.getLogger("ytmusic-daemon")

INTROSPECTION_XML = f"""
<node>
  <interface name="{INTERFACE}">
    <method name="GetStatus">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="GetPlaylists">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="RefreshPlaylists">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="GetPlaylistTracks">
      <arg type="s" name="playlist_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="RefreshPlaylistTracks">
      <arg type="s" name="playlist_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="PlayPlaylist">
      <arg type="s" name="playlist_id" direction="in"/>
      <arg type="i" name="start_index" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="PlayTrack">
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="TogglePause">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Next">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Previous">
      <arg type="s" name="json" direction="out"/>
    </method>
    <signal name="PlaybackChanged">
      <arg type="s" name="json"/>
    </signal>
    <signal name="AuthRequired"/>
  </interface>
</node>
"""

AUTH_MESSAGE = "Faça login com ytmusic-daemon-login."


def ok(data) -> str:
    return json.dumps({"ok": True, "data": data}, ensure_ascii=False)


def err(code: str, message: str) -> str:
    return json.dumps({"ok": False, "error": code, "message": message}, ensure_ascii=False)


class BadRequest(Exception):
    """Invalid arguments; the message is shown to the user."""


class Service:
    def __init__(self, loop: GLib.MainLoop):
        self.loop = loop
        self.client = Client()
        self.player = Player(on_change=self._on_player_change)
        self._playback_emit_id = 0
        self._last_playback_json = None
        # Bumped on every new queue so late background appends are dropped.
        self._play_gen = 0
        self._play_lock = threading.Lock()
        self.connection: Gio.DBusConnection | None = None
        self._reg_id = 0
        # Network calls run off the main loop so D-Bus stays responsive.
        # Some calls block waiting on background fetches, so keep a few spare workers.
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ytm")
        node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
        self._iface = node.interfaces[0]

        # name -> callable(*args) -> json str; blocking ones go to the pool.
        self._sync_methods = {
            "GetStatus": self._get_status,
        }
        self._async_methods = {
            "GetPlaylists": lambda: ok(self.client.get_playlists()),
            "RefreshPlaylists": lambda: ok(self.client.get_playlists(force=True)),
            "GetPlaylistTracks": lambda pid: ok(self.client.get_playlist_tracks(pid)),
            "RefreshPlaylistTracks": lambda pid: ok(
                self.client.get_playlist_tracks(pid, force=True)),
            "PlayPlaylist": lambda pid, start: ok(self._play_playlist(pid, start)),
            "PlayTrack": lambda vid: ok(self._play_track(vid)),
            "TogglePause": lambda: self._control(self.player.toggle_pause),
            "Next": lambda: self._control(self.player.next),
            "Previous": lambda: self._control(self.player.previous),
        }

    # -- bus plumbing -----------------------------------------------------------

    def on_bus_acquired(self, connection, name):
        self.connection = connection
        self._reg_id = connection.register_object(
            OBJECT_PATH, self._iface, self._on_method_call, None, None)

    def on_name_acquired(self, connection, name):
        log.info("ready on %s", name)
        # Warm the playlist cache so the first popup opens fast.
        self._pool.submit(self._warm_up)

    def on_name_lost(self, connection, name):
        log.error("could not own bus name %s (already running?)", name)
        self.loop.quit()

    def _on_method_call(self, conn, sender, path, iface, method, params, invocation):
        args = params.unpack()
        if method in self._sync_methods:
            invocation.return_value(GLib.Variant("(s)", (self._sync_methods[method](*args),)))
            return
        fn = self._async_methods.get(method)
        if fn is None:
            invocation.return_dbus_error(f"{INTERFACE}.Error.UnknownMethod", method)
            return
        self._pool.submit(self._run_async, method, fn, args, invocation)

    def _run_async(self, method, fn, args, invocation):
        try:
            result = fn(*args)
        except AuthError:
            result = err("auth_required", AUTH_MESSAGE)
            GLib.idle_add(self._emit_auth_required)
        except BadRequest as e:
            result = err("bad_request", str(e))
        except PlayerError as e:
            log.warning("player error: %s", e)
            result = err("player", "Não foi possível tocar (mpv).")
        except UnavailableError:
            result = err("unavailable", "Conteúdo indisponível no YouTube Music.")
        except ServiceError:
            result = err("network", "Não foi possível falar com o YouTube Music.")
        except Exception:
            log.exception("unhandled error in %s", method)
            result = err("internal", "Erro interno no serviço.")
        GLib.idle_add(self._reply, invocation, result)

    @staticmethod
    def _reply(invocation, result):
        invocation.return_value(GLib.Variant("(s)", (result,)))
        return GLib.SOURCE_REMOVE

    def _emit_auth_required(self):
        if self.connection:
            self.connection.emit_signal(None, OBJECT_PATH, INTERFACE, "AuthRequired", None)
        return GLib.SOURCE_REMOVE

    # -- playback signal --------------------------------------------------------

    def _on_player_change(self):
        # Called from the mpv reader thread; coalesce bursts of property
        # changes into one signal on the main loop.
        GLib.idle_add(self._schedule_playback_emit)

    def _schedule_playback_emit(self):
        if not self._playback_emit_id:
            self._playback_emit_id = GLib.timeout_add(80, self._emit_playback)
        return GLib.SOURCE_REMOVE

    def _emit_playback(self):
        self._playback_emit_id = 0
        payload = json.dumps(self.player.state(), ensure_ascii=False)
        if payload != self._last_playback_json and self.connection:
            self._last_playback_json = payload
            self.connection.emit_signal(None, OBJECT_PATH, INTERFACE, "PlaybackChanged",
                                        GLib.Variant("(s)", (payload,)))
        return GLib.SOURCE_REMOVE

    def _control(self, action) -> str:
        action()
        return ok(self.player.state())

    def _warm_up(self):
        try:
            playlists = self.client.get_playlists()
            log.info("cache warmed: %d playlists", len(playlists))
        except AuthError:
            log.warning("not logged in: run ytmusic-daemon-login")
            GLib.idle_add(self._emit_auth_required)
        except ServiceError:
            log.warning("warm-up failed, will retry on demand")

    # -- methods ---------------------------------------------------------------

    def _get_status(self) -> str:
        return ok({
            "auth": self.client.auth_state,
            "logged_in": self.client.auth_state in ("ok", "unverified"),
            "playback": self.player.state(),
        })

    def _play_playlist(self, playlist_id: str, start_index: int) -> dict:
        data = self.client.get_playlist_tracks(playlist_id)
        if not data["complete"] and start_index >= len(data["tracks"]):
            data = self.client.get_playlist_tracks(playlist_id)  # waits for the full list
        tracks = data["tracks"]
        if not 0 <= start_index < len(tracks):
            raise BadRequest("Música fora da playlist.")

        playable = [t for t in tracks if t["available"]]
        # Start at the chosen track, or the next playable one after it.
        first = next((t for t in tracks[start_index:] if t["available"]), None)
        if first is None:
            raise BadRequest("Nenhuma música disponível para tocar.")
        start = next(i for i, t in enumerate(playable) if t is first)

        with self._play_lock:
            self._play_gen += 1
            gen = self._play_gen
            self.player.play(playable, start)
        log.info("playing playlist: %d tracks from %d", len(playable), start)

        if not data["complete"]:
            self._pool.submit(self._append_rest, playlist_id, len(tracks), gen)
        return {"queued": len(playable), "index": start}

    def _append_rest(self, playlist_id: str, already: int, gen: int) -> None:
        try:
            full = self.client.get_playlist_tracks(playlist_id)
        except (AuthError, ServiceError):
            log.warning("could not load the rest of the playlist")
            return
        rest = [t for t in full["tracks"][already:] if t["available"]]
        with self._play_lock:
            if gen != self._play_gen:
                return
            try:
                self.player.append(rest)
            except PlayerError as e:
                log.warning("append failed: %s", e)
                return
        log.info("queued %d more tracks", len(rest))

    def _play_track(self, video_id: str) -> dict:
        if not video_id:
            raise BadRequest("Música inválida.")
        with self._play_lock:
            self._play_gen += 1
            self.player.play([self.client.track_info(video_id)], 0)
        log.info("playing single track")
        return {"queued": 1, "index": 0}

    def shutdown(self):
        if self._playback_emit_id:
            GLib.source_remove(self._playback_emit_id)
            self._playback_emit_id = 0
        if self.connection and self._reg_id:
            self.connection.unregister_object(self._reg_id)
        self._pool.shutdown(wait=False, cancel_futures=True)
        self.client.shutdown()
        self.player.shutdown()


def main():
    # journald adds timestamps; keep the format short.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s",
                        stream=sys.stderr)
    loop = GLib.MainLoop()
    service = Service(loop)

    # Load the auth state early so GetStatus is meaningful before warm-up ends.
    service.client.load_auth()

    owner_id = Gio.bus_own_name(
        Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
        service.on_bus_acquired, service.on_name_acquired, service.on_name_lost)

    for sig in (signal.SIGINT, signal.SIGTERM):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, lambda *a: (loop.quit(), False)[1])

    try:
        loop.run()
    finally:
        Gio.bus_unown_name(owner_id)
        service.shutdown()
        log.info("stopped")


if __name__ == "__main__":
    main()

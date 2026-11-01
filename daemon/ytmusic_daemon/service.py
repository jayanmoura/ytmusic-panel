"""ytmusic-daemon: session D-Bus service backing the ytmusic-panel extension.

Every method returns a JSON string:
    {"ok": true, "data": ...}
    {"ok": false, "error": "<code>", "message": "<human readable>"}
Error codes: auth_required, network, unavailable, bad_request, invalid_request,
duplicate, player, internal. invalid_request means the arguments failed
validation (see validation.py) and nothing was done.
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
from .client import AuthError, Client, DuplicateError, ServiceError, UnavailableError  # noqa: E402
from . import browser_login  # noqa: E402
from .browser_login import BrowserLoginError  # noqa: E402
from .covers import CoverCache  # noqa: E402
from .player import Player, PlayerError  # noqa: E402
from .resolver import Resolver  # noqa: E402
from .validation import InvalidRequest, validate  # noqa: E402

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
    <method name="Search">
      <arg type="s" name="query" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="PlayPlaylist">
      <arg type="s" name="playlist_id" direction="in"/>
      <arg type="i" name="start_index" direction="in"/>
      <arg type="b" name="oldest_first" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="PlayTrack">
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="AddToPlaylist">
      <arg type="s" name="playlist_id" direction="in"/>
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="GetCovers">
      <arg type="s" name="urls_json" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Prepare">
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Enqueue">
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="PlayNext">
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="RemoveFromPlaylist">
      <arg type="s" name="playlist_id" direction="in"/>
      <arg type="s" name="video_id" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="ListBrowsers">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="LoginWithBrowser">
      <arg type="s" name="browser" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Logout">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="GetAccount">
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
    <method name="GetPosition">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Seek">
      <arg type="d" name="seconds" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="ToggleShuffle">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="CycleRepeat">
      <arg type="s" name="json" direction="out"/>
    </method>
    <signal name="PlaybackChanged">
      <arg type="s" name="json"/>
    </signal>
    <signal name="AuthRequired"/>
  </interface>
</node>
"""

AUTH_MESSAGE = "Faça login nas configurações da extensão."
# How long a play request waits for the stream to resolve here before letting
# mpv resolve it itself (slower, but always works).
PLAY_RESOLVE_TIMEOUT = 5


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
        self.client.reauth = self._reauth
        self.player = Player(on_change=self._on_player_change,
                             on_track_loaded=self._on_track_loaded)
        self.resolver = Resolver(on_resolved=self.player.preload)
        self.covers = CoverCache()
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
            "Prepare": self._prepare,
            "ListBrowsers": lambda: ok({
                "browsers": browser_login.installed_browsers(),
                "current": browser_login.saved_browser(),
            }),
        }
        self._async_methods = {
            "GetPlaylists": lambda: ok(self._get_playlists()),
            "RefreshPlaylists": lambda: ok(self._get_playlists(force=True)),
            "GetPlaylistTracks": lambda pid: ok(self.client.get_playlist_tracks(pid)),
            "RefreshPlaylistTracks": lambda pid: ok(
                self.client.get_playlist_tracks(pid, force=True)),
            "Search": lambda q: ok(self._search(q)),
            "GetAccount": lambda: ok(self._get_account()),
            "PlayPlaylist": lambda pid, start, oldest_first: ok(
                self._play_playlist(pid, start, oldest_first)),
            "PlayTrack": lambda vid: ok(self._play_track(vid)),
            "AddToPlaylist": lambda pid, vid: ok(self._add_to_playlist(pid, vid)),
            "RemoveFromPlaylist": lambda pid, vid: ok(self._remove_from_playlist(pid, vid)),
            "Enqueue": lambda vid: ok(self._enqueue(vid, play_next=False)),
            "PlayNext": lambda vid: ok(self._enqueue(vid, play_next=True)),
            "LoginWithBrowser": lambda browser: ok(self._login_with_browser(browser)),
            "Logout": lambda: ok(self._logout()),
            "GetCovers": lambda urls: ok(self._get_covers(urls)),
            "TogglePause": lambda: self._control(self.player.toggle_pause),
            "Next": lambda: self._control(self.player.next),
            "Previous": lambda: self._control(self.player.previous),
            "ToggleShuffle": lambda: self._control(self.player.toggle_shuffle),
            "GetPosition": lambda: ok(self.player.position()),
            "Seek": lambda seconds: (self.player.seek(seconds), ok(self.player.position()))[1],
            "CycleRepeat": lambda: self._control(self.player.cycle_repeat),
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
        # Validate before anything else, so bad input never reaches ytmusicapi or mpv.
        try:
            args = validate(method, params.unpack())
        except InvalidRequest as e:
            log.warning("invalid arguments for %s", method)
            invocation.return_value(GLib.Variant("(s)", (err("invalid_request", str(e)),)))
            return
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
        except (BadRequest, BrowserLoginError) as e:
            result = err("bad_request", str(e))
        except DuplicateError:
            result = err("duplicate", "Essa música já está na playlist.")
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
        self.covers.prune()
        try:
            playlists = self._get_playlists()
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

    def _get_playlists(self, force: bool = False) -> list[dict]:
        playlists = self.client.get_playlists(force=force)
        self.client.prefetch_playlists(playlists)
        return playlists

    # -- playback ----------------------------------------------------------------

    def _prepare(self, video_id: str) -> str:
        """The user is about to pick this track (e.g. hovering it): resolve it now."""
        self.resolver.prefetch(video_id)
        return ok(None)

    def _on_track_loaded(self, index: int) -> None:
        # Resolve the next track while this one plays, so it starts without a gap.
        upcoming = self.player.track_at(index + 1)
        if upcoming:
            self.resolver.prefetch(upcoming["videoId"])

    def _play_playlist(self, playlist_id: str, start_index: int,
                       oldest_first: bool = False) -> dict:
        """start_index is in the playlist's own order (newest first); with
        oldest_first the queue runs from the oldest track to the newest."""
        data = self.client.get_playlist_tracks(playlist_id)
        if not data["complete"] and (oldest_first or start_index >= len(data["tracks"])):
            data = self.client.get_playlist_tracks(playlist_id)  # waits for the full list
        tracks = data["tracks"]
        if not 0 <= start_index < len(tracks):
            raise BadRequest("Música fora da playlist.")
        if oldest_first:
            tracks = tracks[::-1]
            start_index = len(tracks) - 1 - start_index

        playable = [t for t in tracks if t["available"]]
        # Start at the chosen track, or the next playable one after it.
        first = next((t for t in tracks[start_index:] if t["available"]), None)
        if first is None:
            raise BadRequest("Nenhuma música disponível para tocar.")
        start = next(i for i, t in enumerate(playable) if t is first)
        self.resolver.resolve(first["videoId"], PLAY_RESOLVE_TIMEOUT)

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

    def _add_to_playlist(self, playlist_id: str, video_id: str) -> dict:
        playlists = {p["id"]: p for p in self.client.get_playlists()}
        target = playlists.get(playlist_id)
        if target is None:
            raise BadRequest("Playlist não encontrada.")
        if not target["owned"] and playlist_id != "LM":
            raise BadRequest("Você só pode adicionar músicas às suas playlists.")
        self.client.add_to_playlist(playlist_id, video_id)
        return {"playlist": target["title"]}

    def _enqueue(self, video_id: str, play_next: bool) -> dict:
        track = self.client.track_info(video_id)
        self.resolver.prefetch(video_id)
        with self._play_lock:
            if play_next:
                self.player.play_next(track)
            else:
                self.player.enqueue(track)
        return {"title": track.get("title")}

    def _remove_from_playlist(self, playlist_id: str, video_id: str) -> dict:
        playlists = {p["id"]: p for p in self.client.get_playlists()}
        target = playlists.get(playlist_id)
        if target is None:
            raise BadRequest("Playlist não encontrada.")
        if not target["owned"] and playlist_id != "LM":
            raise BadRequest("Você só pode remover músicas das suas playlists.")
        self.client.remove_from_playlist(playlist_id, video_id)
        return {"playlist": target["title"]}

    # -- login -------------------------------------------------------------------

    def _login_with_browser(self, browser: str) -> dict:
        browser_login.login_with_browser(browser)
        self.client.reset()
        account = self._get_account()  # also verifies the new credentials
        self._pool.submit(self._warm_up)
        return account

    def _logout(self) -> None:
        browser_login.logout()
        self.client.reset()
        with self._play_lock:
            self._play_gen += 1  # drop pending appends of the old queue
            self.player.stop()
        GLib.idle_add(self._emit_auth_required)

    def _reauth(self) -> bool:
        """Credentials rejected: take a fresh copy from the login's browser."""
        browser = browser_login.saved_browser()
        if not browser:
            return False
        try:
            browser_login.login_with_browser(browser)
        except BrowserLoginError:
            return False
        log.info("credentials renewed from the browser")
        return True

    def _get_covers(self, urls: list[str]) -> dict:
        return self.covers.get_many(urls)

    def _get_account(self) -> dict:
        account = dict(self.client.get_account())
        # Local cached file, so the preferences window never touches the network.
        url = account.pop("photo")
        account["photo_path"] = self.covers.get_many([url]).get(url) if url else None
        return account

    def _search(self, query: str) -> list[dict]:
        return self.client.search(query)

    def _play_track(self, video_id: str) -> dict:
        self.resolver.resolve(video_id, PLAY_RESOLVE_TIMEOUT)
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
        self.resolver.shutdown()
        self.player.shutdown()
        self.covers.shutdown()


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

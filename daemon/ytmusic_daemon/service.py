"""ytmusic-daemon: session D-Bus service backing the ytmusic-panel extension.

Every method returns a JSON string:
    {"ok": true, "data": ...}
    {"ok": false, "error": "<code>", "message": "<human readable>"}
Error codes: auth_required, network, bad_request, internal.
"""

import json
import logging
import signal
import sys
from concurrent.futures import ThreadPoolExecutor

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from . import BUS_NAME, INTERFACE, OBJECT_PATH  # noqa: E402
from .client import AuthError, Client, ServiceError  # noqa: E402

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
    <signal name="AuthRequired"/>
  </interface>
</node>
"""

AUTH_MESSAGE = "Faça login com ytmusic-daemon-login."


def ok(data) -> str:
    return json.dumps({"ok": True, "data": data}, ensure_ascii=False)


def err(code: str, message: str) -> str:
    return json.dumps({"ok": False, "error": code, "message": message}, ensure_ascii=False)


class Service:
    def __init__(self, loop: GLib.MainLoop):
        self.loop = loop
        self.client = Client()
        self.connection: Gio.DBusConnection | None = None
        self._reg_id = 0
        # Network calls run off the main loop so D-Bus stays responsive.
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ytm")
        node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
        self._iface = node.interfaces[0]

        # name -> callable(*args) -> json str; blocking ones go to the pool.
        self._sync_methods = {
            "GetStatus": self._get_status,
        }
        self._async_methods = {
            "GetPlaylists": lambda: ok(self.client.get_playlists()),
            "RefreshPlaylists": lambda: ok(self.client.get_playlists(force=True)),
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
            "playback": {"state": "stopped"},
        })

    def shutdown(self):
        if self.connection and self._reg_id:
            self.connection.unregister_object(self._reg_id)
        self._pool.shutdown(wait=False, cancel_futures=True)


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

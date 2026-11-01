import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'io.github.jayan.YTMusic';
const OBJECT_PATH = '/io/github/jayan/YTMusic';

const IFACE_XML = `
<node>
  <interface name="io.github.jayan.YTMusic">
    <method name="GetStatus"><arg type="s" direction="out"/></method>
    <method name="GetPlaylists"><arg type="s" direction="out"/></method>
    <method name="RefreshPlaylists"><arg type="s" direction="out"/></method>
    <method name="GetPlaylistTracks">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="RefreshPlaylistTracks">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="Search">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="PlayPlaylist">
      <arg type="s" direction="in"/><arg type="i" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="PlayTrack">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="AddToPlaylist">
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="GetCovers">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="GetAccount"><arg type="s" direction="out"/></method>
    <method name="Prepare">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="Enqueue">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="PlayNext">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="RemoveFromPlaylist">
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ListBrowsers"><arg type="s" direction="out"/></method>
    <method name="LoginWithBrowser">
      <arg type="s" direction="in"/><arg type="s" direction="out"/>
    </method>
    <method name="Logout"><arg type="s" direction="out"/></method>
    <method name="TogglePause"><arg type="s" direction="out"/></method>
    <method name="Next"><arg type="s" direction="out"/></method>
    <method name="Previous"><arg type="s" direction="out"/></method>
    <method name="ToggleShuffle"><arg type="s" direction="out"/></method>
    <method name="CycleRepeat"><arg type="s" direction="out"/></method>
    <signal name="PlaybackChanged"><arg type="s"/></signal>
    <signal name="AuthRequired"/>
  </interface>
</node>`;

const YTMusicProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

// Long enough for a full library fetch on a slow connection.
const CALL_TIMEOUT_MS = 60000;

export class YTMusicError extends Error {
    /**
     * @param {string} code auth_required | network | unavailable | bad_request | duplicate | player | internal | offline | cancelled
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * Async-only client for the ytmusic-daemon D-Bus service.
 * Calls resolve with the `data` field of the daemon's JSON reply.
 */
export class YTMusicClient {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._proxyPromise = null;
        this._authSignalId = 0;
        this._playbackSignalId = 0;
        this.onAuthRequired = null;
        this.onPlaybackChanged = null;
    }

    _getProxy() {
        this._proxyPromise ??= YTMusicProxy.newAsync(
            Gio.DBus.session, BUS_NAME, OBJECT_PATH, this._cancellable,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES
        ).then(proxy => {
            proxy.g_default_timeout = CALL_TIMEOUT_MS;
            this._authSignalId = proxy.connectSignal('AuthRequired',
                () => this.onAuthRequired?.());
            this._playbackSignalId = proxy.connectSignal('PlaybackChanged',
                (_proxy, _sender, [json]) => {
                    try {
                        this.onPlaybackChanged?.(JSON.parse(json));
                    } catch (e) {
                        console.warn(`[ytmusic-panel] bad PlaybackChanged payload: ${e}`);
                    }
                });
            this._proxy = proxy;
            return proxy;
        }).catch(e => {
            this._proxyPromise = null;
            throw e;
        });
        return this._proxyPromise;
    }

    async call(method, ...args) {
        let json;
        try {
            const proxy = await this._getProxy();
            const invoke = proxy[`${method}Async`];
            if (!invoke)
                throw new Error(`ytmusic-panel: method ${method} missing from IFACE_XML`);
            [json] = await invoke.call(proxy, ...args, this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new YTMusicError('cancelled', 'cancelled');
            // Only bus/transport failures mean the service is unreachable;
            // anything else is a bug and should surface as such.
            if (e instanceof GLib.Error)
                throw new YTMusicError('offline', e.message);
            throw e;
        }

        let reply;
        try {
            reply = JSON.parse(json);
        } catch {
            throw new YTMusicError('internal', 'Resposta inválida do serviço.');
        }
        if (!reply.ok)
            throw new YTMusicError(reply.error, reply.message);
        return reply.data;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy && this._authSignalId)
            this._proxy.disconnectSignal(this._authSignalId);
        if (this._proxy && this._playbackSignalId)
            this._proxy.disconnectSignal(this._playbackSignalId);
        this._authSignalId = 0;
        this._playbackSignalId = 0;
        this.onPlaybackChanged = null;
        this._proxy = null;
        this._proxyPromise = null;
        this.onAuthRequired = null;
    }
}

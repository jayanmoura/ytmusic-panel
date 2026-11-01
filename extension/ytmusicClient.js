import Gio from 'gi://Gio';

const BUS_NAME = 'io.github.jayan.YTMusic';
const OBJECT_PATH = '/io/github/jayan/YTMusic';

const IFACE_XML = `
<node>
  <interface name="io.github.jayan.YTMusic">
    <method name="GetStatus"><arg type="s" direction="out"/></method>
    <method name="GetPlaylists"><arg type="s" direction="out"/></method>
    <method name="RefreshPlaylists"><arg type="s" direction="out"/></method>
    <signal name="AuthRequired"/>
  </interface>
</node>`;

const YTMusicProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

// Long enough for a full library fetch on a slow connection.
const CALL_TIMEOUT_MS = 60000;

export class YTMusicError extends Error {
    /**
     * @param {string} code auth_required | network | internal | offline | cancelled
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
        this.onAuthRequired = null;
    }

    _getProxy() {
        this._proxyPromise ??= YTMusicProxy.newAsync(
            Gio.DBus.session, BUS_NAME, OBJECT_PATH, this._cancellable,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES
        ).then(proxy => {
            proxy.g_default_timeout = CALL_TIMEOUT_MS;
            this._authSignalId = proxy.connectSignal('AuthRequired',
                () => this.onAuthRequired?.());
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
            [json] = await proxy[`${method}Async`](...args, this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new YTMusicError('cancelled', 'cancelled');
            throw new YTMusicError('offline', e.message);
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
        this._authSignalId = 0;
        this._proxy = null;
        this._proxyPromise = null;
        this.onAuthRequired = null;
    }
}

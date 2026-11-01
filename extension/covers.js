// Cover images: actors are created with a placeholder and queued; flush()
// asks the service for local copies of everything queued, in batches.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

export class CoverLoader {
    /** @param {object} indicator the panel indicator (client and settings) */
    constructor(indicator) {
        this._indicator = indicator;
        this._pending = []; // [url, St.Bin] waiting for flush()
    }

    cover(url, styleClass = 'ytmusic-cover') {
        if (!this._indicator._settings.get_boolean('show-covers'))
            return null;
        const bin = new St.Bin({
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ytmusic-cover-placeholder'}),
        });
        if (url) {
            this._pending.push([url, bin]);
            bin.connect('destroy', () => {
                bin._destroyed = true;
            });
        }
        return bin;
    }

    // Asks the daemon for local copies of the covers queued since the last call.
    async flush() {
        const pending = this._pending;
        this._pending = [];
        if (pending.length === 0)
            return;
        const urls = [...new Set(pending.map(([url]) => url))];
        for (let i = 0; i < urls.length; i += 200) {
            let paths;
            try {
                paths = await this._indicator._client.call('GetCovers', JSON.stringify(urls.slice(i, i + 200)));
            } catch (e) {
                if (!e.code)
                    console.error(e, '[ytmusic-panel] cover loading failed');
                else if (e.code !== 'cancelled')
                    console.warn(`[ytmusic-panel] covers unavailable: ${e.code}`);
                return;
            }
            if (!this._indicator._client)
                return;
            for (const [url, bin] of pending) {
                const path = paths[url];
                if (path && !bin._destroyed)
                    this._setCoverImage(bin, path);
            }
        }
    }

    _setCoverImage(bin, path) {
        bin.child = null;
        const uri = GLib.filename_to_uri(path, null);
        bin.style = `${bin._baseStyle ?? ''} background-image: url("${uri}");`;
    }

    destroy() {
        this._pending = [];
    }
}

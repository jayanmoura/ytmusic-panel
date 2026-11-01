// Short confirmations ("Link copiado"), shown over the bottom of the list.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {TOAST_MS} from '../constants.js';

export class Toast {
    constructor() {
        this._timeoutId = 0;
        this.actor = new St.Label({
            style_class: 'ytmusic-toast',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
    }

    show(text) {
        this.actor.text = text;
        this.actor.visible = true;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_MS, () => {
            this._timeoutId = 0;
            this.actor.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}

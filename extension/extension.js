// ytmusic-panel: YouTube Music in the GNOME Shell top bar (unofficial).
// The popup lives in indicator.js; this file only adds and removes it.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {YTMusicIndicator} from './indicator.js';

export default class YTMusicPanelExtension extends Extension {
    enable() {
        this._indicator = new YTMusicIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.focusSearchOnOpen();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const YTMusicIndicator = GObject.registerClass(
class YTMusicIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'YouTube Music');

        this._settings = extension.getSettings();

        const gicon = Gio.icon_new_for_string(
            `${extension.path}/icons/ytmusic-symbolic.svg`);
        this.add_child(new St.Icon({
            gicon,
            style_class: 'system-status-icon',
        }));

        this.menu.box.add_style_class_name('ytmusic-popup');

        // Content area; later stages replace this with the stacked views.
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._section.actor.add_child(this._content);

        this._content.add_child(new St.Label({
            text: 'YouTube Music: em breve suas playlists aparecem aqui.',
            style_class: 'ytmusic-placeholder',
            x_expand: true,
        }));

        this._settingsChangedId = this._settings.connect(
            'changed::popup-max-height', () => this._applyMaxHeight());
        this._applyMaxHeight();
    }

    _applyMaxHeight() {
        const h = this._settings.get_int('popup-max-height');
        this._content.style = `max-height: ${h}px;`;
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;
        super.destroy();
    }
});

export default class YTMusicPanelExtension extends Extension {
    enable() {
        this._indicator = new YTMusicIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

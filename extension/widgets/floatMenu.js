// The track menu (⋮) that floats over the content, and its actions.
// It lives in a layer inside the popup: actors outside the popup don't get
// clicks while the popup holds the pointer grab.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {ERROR_TEXT, LIKED_PLAYLIST_ID, SHARE_URL} from '../constants.js';
import {ellipsized} from './common.js';

export class FloatMenu {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this._track = null;

        this.layer = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
        });
        // Clicking or scrolling anywhere outside the floating menu closes it.
        // The layer itself isn't reactive, so the content gets events while
        // the scrim is hidden.
        this._scrim = new St.Widget({reactive: true, visible: false});
        this._scrim.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._scrim.connect('scroll-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.layer.add_child(this._scrim);
        this.menu = new St.BoxLayout({
            style_class: 'ytmusic-float-menu',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this.layer.add_child(this.menu);
    }

    open(track, anchor) {
        if (!track.videoId)
            return;
        const indicator = this._indicator;
        this.close();
        this._track = track;
        const menu = this.menu;

        const title = ellipsized(new St.Label({text: track.title, style_class: 'ytmusic-float-title'}));
        menu.add_child(title);

        const playlist = indicator._playlist;
        const actions = [
            ['list-add-symbolic', 'Adicionar à fila', () => this._enqueue(track, 'Enqueue')],
            ['media-skip-forward-symbolic', 'Tocar a seguir', () => this._enqueue(track, 'PlayNext')],
            ['folder-new-symbolic', 'Adicionar a outra playlist', () => {
                this.close();
                indicator._picker.open(track);
            }],
            ['edit-copy-symbolic', 'Compartilhar (copiar link)', () => this._share(track)],
        ];
        for (const [icon, label, callback] of actions)
            menu.add_child(this._actionRow(icon, label, callback));

        if (playlist && (playlist.owned || playlist.id === LIKED_PLAYLIST_ID)) {
            const label = playlist.id === LIKED_PLAYLIST_ID
                ? 'Remover de Músicas que gostei' : 'Remover da playlist';
            const row = this._actionRow('user-trash-symbolic', label, () => {
                // First click asks for confirmation.
                if (!row._confirming) {
                    row._confirming = true;
                    row._label.text = 'Clique de novo para remover';
                    row.add_style_class_name('ytmusic-row-destructive');
                    return;
                }
                this._remove(track, playlist);
            });
            menu.add_child(row);
        }

        // Place it under the ⋮ button, right-aligned to it; above when there's no room.
        const layer = this.layer;
        this._scrim.set_size(layer.width, layer.height);
        this._scrim.visible = true;
        menu.visible = true;
        const [, menuWidth] = menu.get_preferred_width(-1);
        const [, menuHeight] = menu.get_preferred_height(menuWidth);
        const [layerX, layerY] = layer.get_transformed_position();
        const [anchorX, anchorY] = anchor.get_transformed_position();
        const [anchorW, anchorH] = anchor.get_transformed_size();
        let x = anchorX - layerX + anchorW - menuWidth;
        let y = anchorY - layerY + anchorH;
        if (y + menuHeight > layer.height)
            y = anchorY - layerY - menuHeight;
        x = Math.max(4, Math.min(x, layer.width - menuWidth - 4));
        y = Math.max(4, Math.min(y, layer.height - menuHeight - 4));
        menu.set_position(Math.round(x), Math.round(y));
        menu.get_first_child()?.get_next_sibling()?.grab_key_focus();
    }

    close() {
        if (!this._track)
            return;
        this._track = null;
        this.menu.destroy_all_children();
        this.menu.visible = false;
        this._scrim.visible = false;
    }

    _actionRow(iconName, text, callback) {
        const box = new St.BoxLayout({style_class: 'ytmusic-row-content', x_expand: true});
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        box.add_child(label);
        const button = new St.Button({
            style_class: 'ytmusic-float-item',
            child: box,
            can_focus: true,
            x_expand: true,
            accessible_name: text,
        });
        button._label = label;
        button.connect('clicked', callback);
        return button;
    }

    async _enqueue(track, method) {
        const indicator = this._indicator;
        this.close();
        try {
            await indicator._client.call(method, track.videoId);
            if (!indicator._destroyed)
                indicator._showToast(method === 'PlayNext' ? 'Vai tocar a seguir' : 'Adicionada à fila');
        } catch (e) {
            if (e.code !== 'cancelled' && !indicator._destroyed)
                indicator._showToast((ERROR_TEXT[e.code] ?? [e.message])[0]);
        }
    }

    _share(track) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, SHARE_URL + track.videoId);
        this.close();
        this._indicator._showToast('Link copiado');
    }

    async _remove(track, playlist) {
        const indicator = this._indicator;
        this.close();
        try {
            await indicator._client.call('RemoveFromPlaylist', playlist.id, track.videoId);
        } catch (e) {
            if (e.code !== 'cancelled' && !indicator._destroyed)
                indicator._showToast(e.code === 'bad_request' ? e.message : (ERROR_TEXT[e.code] ?? [e.message])[0]);
            return;
        }
        if (indicator._destroyed)
            return;
        indicator._onTrackRemoved(track, playlist);
    }

    destroy() {
        this._track = null;
    }
}

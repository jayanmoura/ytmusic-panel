// "Adicionar a playlist": the user's playlists over the current view. It
// sits on top of that view (which is only hidden) so going back keeps its
// rows and scroll position.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ERROR_TEXT, LIKED_PLAYLIST_ID} from '../constants.js';

export class PickerView {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this.scroll = new St.ScrollView({
            style_class: 'ytmusic-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            visible: false,
        });
        this.list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.scroll.set_child(this.list);
    }

    async open(track) {
        const indicator = this._indicator;
        if (!track.videoId)
            return;
        indicator._enterOverlay(track, 'Adicionar a playlist', track.title);

        if (!indicator._playlists) {
            this._setMessage('Carregando playlists…');
            try {
                indicator._playlists = indicator._sortPlaylists(await indicator._client.call('GetPlaylists'));
            } catch (e) {
                if (e.code !== 'cancelled' && !indicator._destroyed && indicator._pickerTrack === track)
                    this._setMessage(...(ERROR_TEXT[e.code] ?? ERROR_TEXT.internal));
                return;
            }
            if (indicator._destroyed || indicator._pickerTrack !== track)
                return;
        }
        this.render(track);
    }

    clear() {
        this.list.destroy_all_children();
    }

    _setMessage(title, hint = null) {
        this.list.destroy_all_children();
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'ytmusic-message',
            x_expand: true,
        });
        box.add_child(new St.Label({text: title, style_class: 'ytmusic-message-title'}));
        if (hint) {
            const label = new St.Label({text: hint, style_class: 'ytmusic-message-hint'});
            label.clutter_text.line_wrap = true;
            box.add_child(label);
        }
        this.list.add_child(box);
    }

    render(track) {
        const indicator = this._indicator;
        this.list.destroy_all_children();
        // Only playlists the user can edit; skip the one being browsed.
        const current = indicator._view === 'tracks' ? indicator._playlist?.id : null;
        const targets = indicator._playlists.filter(p =>
            (p.owned || p.id === LIKED_PLAYLIST_ID) && p.id !== current);
        if (targets.length === 0) {
            this._setMessage('Nenhuma playlist sua disponível.');
            return;
        }
        for (const playlist of targets) {
            const row = indicator._playlistsView.createRow(playlist, () => this._addToPlaylist(track, playlist));
            this.list.add_child(row);
        }
        indicator._covers.flush();
    }

    async _addToPlaylist(track, playlist) {
        const indicator = this._indicator;
        // Block double clicks while the request runs.
        for (const row of this.list.get_children())
            row.reactive = false;
        try {
            await indicator._client.call('AddToPlaylist', playlist.id, track.videoId);
            if (indicator._destroyed)
                return;
            const where = playlist.id === LIKED_PLAYLIST_ID ? 'Músicas que gostei' : playlist.title;
            Main.notify('YouTube Music', `"${track.title}" adicionada a ${where}.`);
            if (indicator._pickerTrack === track) {
                indicator._playlists = null; // counts changed; reload on next visit
                indicator._closePicker();
            }
        } catch (e) {
            if (e.code === 'cancelled' || indicator._destroyed)
                return;
            const message = e.code === 'duplicate' || e.code === 'bad_request'
                ? e.message
                : (ERROR_TEXT[e.code] ?? ERROR_TEXT.internal)[0];
            Main.notify('YouTube Music', message);
            if (indicator._pickerTrack === track) {
                for (const row of this.list.get_children())
                    row.reactive = true;
            }
        }
    }

    destroy() {}
}

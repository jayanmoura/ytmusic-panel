// The first screen: the user's playlists ("Músicas que gostei" first).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {LIKED_PLAYLIST_ID} from '../constants.js';
import {trackCountText} from '../util.js';
import {ellipsized} from '../widgets/common.js';

export class PlaylistsView {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
    }

    show() {
        const indicator = this._indicator;
        indicator._view = 'playlists';
        indicator._playlist = null;
        indicator._tracksView.reset();
        indicator._setSearchText('');
        indicator._setSearchMode(false);
        indicator._sortButton.visible = false;
        indicator._setHeader('Playlists');
        if (indicator._playlists)
            this.render();
        this.load(false);
    }

    load(force) {
        const indicator = this._indicator;
        if (!indicator._playlists)
            indicator._showMessage('Carregando playlists…');
        return indicator._load(
            () => indicator._client.call(force ? 'RefreshPlaylists' : 'GetPlaylists'),
            data => {
                indicator._playlists = indicator._sortPlaylists(data);
                this.render();
            });
    }

    render() {
        const indicator = this._indicator;
        indicator._clearList();
        if (indicator._playlists.length === 0) {
            indicator._showMessage('Nenhuma playlist encontrada.');
            return;
        }
        for (const playlist of indicator._playlists)
            indicator._list.add_child(this.createRow(playlist));
        indicator._covers.flush();
    }

    createRow(playlist, onClick = () => this._indicator._tracksView.show(playlist)) {
        const indicator = this._indicator;
        const row = new St.BoxLayout({x_expand: true, style_class: 'ytmusic-row-content'});
        const cover = indicator._covers.cover(playlist.thumbnail);
        if (cover)
            row.add_child(cover);

        row.add_child(ellipsized(new St.Label({
            text: playlist.title,
            style_class: 'ytmusic-row-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        })));

        if (playlist.id === LIKED_PLAYLIST_ID) {
            row.add_child(new St.Icon({
                gicon: indicator._icon('heart-symbolic'),
                icon_size: 14,
                style_class: 'ytmusic-row-heart',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else if (playlist.count !== null && playlist.count !== undefined) {
            row.add_child(new St.Label({
                text: trackCountText(playlist.count),
                style_class: 'ytmusic-row-detail',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const button = new St.Button({
            style_class: 'ytmusic-row',
            child: row,
            can_focus: true,
            x_expand: true,
            accessible_name: playlist.title,
        });
        button.connect('clicked', onClick);
        return button;
    }

    destroy() {}
}

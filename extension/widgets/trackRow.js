// A track row: play button, cover, title/artist, duration and either the ⋮
// menu (inside a playlist) or "add to a playlist" (search results).
// Hovering a row asks the service to resolve the track's audio in advance.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {PREPARE_DELAY_MS} from '../constants.js';
import {ellipsized, iconButton} from './common.js';

export class TrackRowFactory {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this._prepareTimeoutId = 0;
    }

    create(track, onPlay, inPlaylist = false) {
        const indicator = this._indicator;
        const row = new St.BoxLayout({
            style_class: 'ytmusic-row ytmusic-track-row',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        if (track.available && track.videoId)
            row.connect('notify::hover', () => this._onTrackHover(row, track));
        if (!track.available)
            row.add_style_class_name('ytmusic-row-unavailable');
        row._videoId = track.videoId;
        if (track.videoId && track.videoId === indicator._playback?.track?.videoId)
            row.add_style_class_name('ytmusic-row-playing');

        const playButton = iconButton('media-playback-start-symbolic', 'Tocar', onPlay);
        playButton.add_style_class_name('ytmusic-row-play');
        playButton.reactive = track.available;
        playButton.can_focus = track.available;
        row.add_child(playButton);
        const cover = indicator._covers.cover(track.thumbnail);
        if (cover)
            row.add_child(cover);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: track.artists ? `${track.title}, ${track.artists}` : track.title,
        });
        text.add_child(ellipsized(new St.Label({
            text: track.title,
            style_class: 'ytmusic-row-title',
        })));
        if (track.artists) {
            text.add_child(ellipsized(new St.Label({
                text: track.artists,
                style_class: 'ytmusic-row-detail',
            })));
        }
        row.add_child(text);

        if (track.duration) {
            row.add_child(new St.Label({
                text: track.duration,
                style_class: 'ytmusic-row-detail',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Inside a playlist: a menu with the track actions; in search results: add to a playlist.
        const actionButton = inPlaylist
            ? iconButton('view-more-symbolic', 'Mais opções',
                button => indicator._float.open(track, button))
            : iconButton('list-add-symbolic', 'Adicionar a uma playlist',
                () => indicator._picker.open(track));
        actionButton.add_style_class_name('ytmusic-row-add');
        actionButton.reactive = track.available;
        actionButton.can_focus = track.available;
        row.add_child(actionButton);
        return row;
    }

    _onTrackHover(row, track) {
        if (this._prepareTimeoutId) {
            GLib.source_remove(this._prepareTimeoutId);
            this._prepareTimeoutId = 0;
        }
        if (!row.hover)
            return;
        this._prepareTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREPARE_DELAY_MS, () => {
            this._prepareTimeoutId = 0;
            this._indicator._client?.call('Prepare', track.videoId).catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._prepareTimeoutId) {
            GLib.source_remove(this._prepareTimeoutId);
            this._prepareTimeoutId = 0;
        }
    }
}

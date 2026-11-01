// The expanded player ("Tocando agora"): album, big cover, title, artist,
// a progress bar that seeks on click, and the playback buttons. It is shown
// through the indicator's overlay and takes the mini player's space.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {NOW_PLAYING, NOW_PLAYING_CHROME, PROGRESS_SYNC_MS, PROGRESS_TICK_MS} from '../constants.js';
import {formatTime, largeCover} from '../util.js';
import {ellipsized} from '../widgets/common.js';
import {createControlSet} from './controls.js';

export class NowPlaying {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this._progressTimeoutId = 0;
        this._progressBase = {position: 0, at: 0, duration: null};
        this._lastSync = 0;
        this._nowPlayingKey = null;
    }

    get isOpen() {
        return this._indicator._overlayActor === this.actor;
    }

    build(parent) {
        this.actor = new St.BoxLayout({
            style_class: 'ytmusic-np',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        const inner = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(inner);

        // Like the YouTube Music phone app: album on top, cover, title and
        // artist, progress, then the controls.
        this._npAlbum = ellipsized(new St.Label({style_class: 'ytmusic-np-album', x_align: Clutter.ActorAlign.CENTER}));
        inner.add_child(this._npAlbum);

        this._npCoverSlot = new St.Bin({x_align: Clutter.ActorAlign.CENTER});
        this._npCoverUrl = undefined;
        inner.add_child(this._npCoverSlot);

        this._npTitle = ellipsized(new St.Label({style_class: 'ytmusic-np-title', x_align: Clutter.ActorAlign.CENTER}));
        this._npArtist = ellipsized(new St.Label({style_class: 'ytmusic-np-artist', x_align: Clutter.ActorAlign.CENTER}));
        inner.add_child(this._npTitle);
        inner.add_child(this._npArtist);

        // Progress: click anywhere on it to jump there. The reactive area is
        // taller than the visible bar so it's easy to hit.
        this._progress = new St.Widget({
            style_class: 'ytmusic-progress',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._progressTrack = new St.Widget({
            style_class: 'ytmusic-progress-track',
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressFill = new St.Widget({style_class: 'ytmusic-progress-fill'});
        this._progressKnob = new St.Widget({style_class: 'ytmusic-progress-knob'});
        this._progressTrack.add_child(this._progressFill);
        this._progressTrack.add_child(this._progressKnob);
        this._progress.add_child(this._progressTrack);
        this._progress.connect('button-press-event', (actor, event) => {
            const [x, y] = event.get_coords();
            const [ok, localX] = actor.transform_stage_point(x, y);
            if (ok && actor.width > 0)
                this._seekTo(localX / actor.width);
            return Clutter.EVENT_STOP;
        });
        inner.add_child(this._progress);

        const times = new St.BoxLayout({style_class: 'ytmusic-np-times', x_expand: true});
        this._npElapsed = new St.Label({style_class: 'ytmusic-np-time', x_expand: true});
        this._npTotal = new St.Label({style_class: 'ytmusic-np-time'});
        times.add_child(this._npElapsed);
        times.add_child(this._npTotal);
        inner.add_child(times);

        const controls = new St.BoxLayout({
            style_class: 'ytmusic-np-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const set = createControlSet(this._indicator);
        set.playPause.add_style_class_name('ytmusic-play-pause');
        set.playPause.add_style_class_name('ytmusic-np-play');
        for (const button of [set.shuffle, set.prev, set.playPause, set.next, set.repeat]) {
            button.child.icon_size = button === set.playPause ? 28 : 20;
            controls.add_child(button);
        }
        this._indicator._controlSets.push(set);
        inner.add_child(controls);

        parent.add_child(this.actor);
    }

    toggle() {
        const indicator = this._indicator;
        if (this.isOpen) {
            indicator._closePicker();
            return;
        }
        if (!indicator._playback || indicator._playback.state === 'stopped')
            return;
        indicator._float.close();
        // The controls move into the expanded player; it takes the mini player's space.
        // (the search row is hidden by the overlay too)
        const playerSection = indicator._mini.section;
        indicator._npExtraHeight = playerSection.actor.height +
            indicator._playerSeparator.actor.height + indicator._searchRow.height +
            (indicator._subtitle.visible ? indicator._subtitle.height : 0);
        playerSection.actor.hide();
        indicator._playerSeparator.actor.hide();
        const h = indicator._listHeight ?? indicator._settings.get_int('popup-height');
        indicator._setListHeight(h, h);
        indicator._enterOverlay(NOW_PLAYING, 'Tocando agora', null, this.actor);
        this._nowPlayingKey = null;
        this._npCoverUrl = undefined; // re-create the cover at the current size
        this._render();
        this.syncPosition();
        this.startProgress();
    }

    // Playback changed while the expanded player is open.
    onPlaybackChanged(state, active) {
        if (!this.isOpen)
            return;
        if (!active) {
            this._indicator._closePicker();
            return;
        }
        this._render();
        // Track or play/pause changed: re-read the position.
        const key = `${state.track?.videoId}|${state.state}`;
        if (key !== this._nowPlayingKey) {
            this._nowPlayingKey = key;
            this.syncPosition();
        }
    }

    _render() {
        const indicator = this._indicator;
        const state = indicator._playback;
        const track = state?.track;
        this._npTitle.text = track?.title || 'Música sem título';
        this._npArtist.text = state?.state === 'loading' ? 'Carregando…' : track?.artists || '';
        this._npAlbum.text = track?.album ?? '';
        this._npAlbum.visible = !!track?.album;

        const url = largeCover(track?.thumbnail);
        if (url !== this._npCoverUrl) {
            this._npCoverUrl = url;
            this._npCoverSlot.child?.destroy();
            const cover = indicator._covers.cover(url, 'ytmusic-cover ytmusic-np-cover') ??
                new St.Bin({
                    style_class: 'ytmusic-cover ytmusic-np-cover',
                    child: new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ytmusic-cover-placeholder'}),
                });
            // As big as the popup height allows, leaving room for the rest.
            const height = (indicator._listHeight ?? 560) + indicator._npExtraHeight;
            const size = Math.max(120, Math.min(300, height - NOW_PLAYING_CHROME));
            cover._baseStyle = `width: ${size}px; height: ${size}px;`;
            cover.style = cover._baseStyle;
            this._npCoverSlot.child = cover;
            indicator._covers.flush();
        }
        if (state?.duration)
            this._progressBase.duration = state.duration;
        if (state?.state === 'loading')
            this._progress.add_style_class_name('ytmusic-progress-loading');
        else
            this._progress.remove_style_class_name('ytmusic-progress-loading');
        this._tickProgress();
    }

    async syncPosition() {
        const indicator = this._indicator;
        this._lastSync = GLib.get_monotonic_time();
        try {
            const data = await indicator._client.call('GetPosition');
            if (!indicator._destroyed)
                this._setPositionBase(data.position, data.duration);
        } catch (e) {
            // Keep interpolating; the next sync will correct it.
        }
    }

    _setPositionBase(position, duration) {
        this._progressBase = {
            position: position ?? 0,
            at: GLib.get_monotonic_time(),
            duration: duration ?? this._progressBase.duration,
        };
        this._tickProgress();
    }

    _currentPosition() {
        const {position, at, duration} = this._progressBase;
        const playing = this._indicator._playback?.state === 'playing';
        const now = position + (playing ? (GLib.get_monotonic_time() - at) / 1e6 : 0);
        return duration ? Math.min(now, duration) : now;
    }

    _tickProgress() {
        const duration = this._progressBase.duration;
        const position = this._currentPosition();
        const ratio = duration ? Math.max(0, Math.min(1, position / duration)) : 0;
        const width = this._progressTrack.width;
        const fill = Math.round(width * ratio);
        this._progressFill.set_size(fill, this._progressTrack.height);
        const knob = this._progressKnob;
        knob.set_position(Math.round(fill - knob.width / 2),
            Math.round((this._progressTrack.height - knob.height) / 2));
        this._npElapsed.text = formatTime(position);
        this._npTotal.text = duration ? formatTime(duration) : '--:--';
    }

    startProgress() {
        this.stopProgress();
        this._progressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_TICK_MS, () => {
            this._tickProgress();
            if (GLib.get_monotonic_time() - this._lastSync > PROGRESS_SYNC_MS * 1000)
                this.syncPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopProgress() {
        if (this._progressTimeoutId) {
            GLib.source_remove(this._progressTimeoutId);
            this._progressTimeoutId = 0;
        }
    }

    async _seekTo(ratio) {
        const indicator = this._indicator;
        const duration = this._progressBase.duration;
        if (!duration || indicator._playback?.state === 'stopped')
            return;
        const seconds = Math.max(0, Math.min(1, ratio)) * duration;
        this._setPositionBase(seconds, duration); // move the bar right away
        try {
            const data = await indicator._client.call('Seek', seconds);
            if (!indicator._destroyed)
                this._setPositionBase(data.position, data.duration);
        } catch (e) {
            if (!indicator._destroyed)
                this.syncPosition();
        }
    }

    destroy() {
        this.stopProgress();
    }
}

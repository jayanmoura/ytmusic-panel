// Inside a playlist: its tracks, the filter typed in the search field, the
// newest/oldest order and the "show more" pagination.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {FILTER_DEBOUNCE_MS, TRACKS_PAGE_SIZE} from '../constants.js';
import {normalize, numberFormat, trackCountText} from '../util.js';
import {setToggled} from '../widgets/common.js';

export class TracksView {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this._tracks = [];
        this._renderedTracks = 0;
        this._moreButton = null;
        this._trackFilter = '';
        this._oldestFirst = false;
        this._tracksComplete = false;
        this._shownTracks = []; // indices into _tracks that pass the filter, in display order
        this._filterTimeoutId = 0;
        this._restoreScrollIdleId = 0;
    }

    get hasTracks() {
        return this._tracks.length > 0;
    }

    // Leaving the playlist.
    reset() {
        this._tracks = [];
        this._trackFilter = '';
    }

    // The shared list was cleared (its "show more" button went with it).
    onListCleared() {
        this._moreButton = null;
    }

    show(playlist) {
        const indicator = this._indicator;
        indicator._view = 'tracks';
        indicator._playlist = playlist;
        this._tracks = [];
        this._trackFilter = '';
        indicator._header.setSearchText('');
        indicator._header.setSearchMode(true);
        this._oldestFirst = false;
        this._tracksComplete = false;
        this._updateSortButton();
        indicator._header.sortButton.visible = true;
        indicator._header.set(playlist.title, null, true);
        indicator._showLoading('Carregando músicas…');
        this.load(false);
    }

    load(force) {
        const indicator = this._indicator;
        const playlist = indicator._playlist;
        const method = force ? 'RefreshPlaylistTracks' : 'GetPlaylistTracks';
        return indicator._load(
            () => indicator._client.call(method, playlist.id),
            (data, serial) => {
                this._tracks = data.tracks;
                this._tracksComplete = data.complete;
                this._updateSortButton();
                this._updateTracksSubtitle(data);
                this.render();
                if (!data.complete)
                    this._loadRemainingTracks(playlist, serial);
            });
    }

    // The daemon served the first page; a second call waits for the full list.
    async _loadRemainingTracks(playlist, serial) {
        const indicator = this._indicator;
        try {
            const data = await indicator._client.call('GetPlaylistTracks', playlist.id);
            if (serial !== indicator._serial)
                return;
            this._tracks = data.tracks;
            this._tracksComplete = data.complete;
            this._updateSortButton();
            this._updateTracksSubtitle(data);
            if (this._trackFilter)
                this.render(); // more matches may have arrived
            else
                this._updateShownTracks();
            this._updateMoreButton();
        } catch (e) {
            // The first page is already on screen; just note it.
            if (e.code !== 'cancelled')
                console.warn(`[ytmusic-panel] full playlist load failed: ${e.code}`);
        }
    }

    _updateTracksSubtitle(data) {
        const subtitle = this._indicator._header.subtitle;
        const count = data.complete ? data.tracks.length : data.count;
        subtitle.text = count !== null && count !== undefined ? trackCountText(count) : '';
        subtitle.visible = !!subtitle.text;
    }

    _updateShownTracks() {
        const filter = normalize(this._trackFilter.trim());
        this._shownTracks = [];
        this._tracks.forEach((t, i) => {
            if (!filter || normalize(`${t.title} ${t.artists} ${t.album ?? ''}`).includes(filter))
                this._shownTracks.push(i);
        });
        if (this._oldestFirst)
            this._shownTracks.reverse();
    }

    render() {
        const indicator = this._indicator;
        indicator._clearList();
        this._renderedTracks = 0;
        this._updateShownTracks();
        if (this._tracks.length === 0) {
            indicator._showMessage('Esta playlist está vazia.');
            return;
        }
        if (this._shownTracks.length === 0) {
            indicator._showMessage('Nenhuma música encontrada nesta playlist.', 'Tente outras palavras.');
            return;
        }
        this._renderMoreTracks();
    }

    _renderMoreTracks() {
        const indicator = this._indicator;
        this._moreButton?.destroy();
        this._moreButton = null;

        const end = Math.min(this._renderedTracks + TRACKS_PAGE_SIZE, this._shownTracks.length);
        for (let n = this._renderedTracks; n < end; n++) {
            const i = this._shownTracks[n];
            indicator._list.add_child(indicator._trackRows.create(this._tracks[i], () => this._playFrom(i), true));
        }
        this._renderedTracks = end;
        indicator._covers.flush();
        this._updateMoreButton();
    }

    toggleOldestFirst() {
        if (!this._tracksComplete)
            return;
        this._oldestFirst = !this._oldestFirst;
        this._updateSortButton();
        this.render();
    }

    // Reversing only makes sense with the whole list, so it waits for it.
    _updateSortButton() {
        const button = this._indicator._header.sortButton;
        button.child.icon_name = this._oldestFirst
            ? 'view-sort-ascending-symbolic' : 'view-sort-descending-symbolic';
        button.accessible_name = this._oldestFirst
            ? 'Mostrando as mais antigas primeiro' : 'Mostrando as mais recentes primeiro';
        setToggled(button, this._oldestFirst);
        button.reactive = this._tracksComplete;
        button.can_focus = this._tracksComplete;
    }

    // Re-render after a change to _tracks without jumping back to the top.
    _rerenderTracksKeepingScroll() {
        const scrollView = this._indicator._scroll;
        const scroll = scrollView.vadjustment.value;
        const rendered = this._renderedTracks;
        this.render();
        while (this._renderedTracks < Math.min(rendered, this._shownTracks.length) &&
               this._renderedTracks > 0)
            this._renderMoreTracks();
        if (this._restoreScrollIdleId)
            GLib.source_remove(this._restoreScrollIdleId);
        this._restoreScrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restoreScrollIdleId = 0;
            scrollView.vadjustment.value = scroll;
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateMoreButton() {
        const remaining = this._shownTracks.length - this._renderedTracks;
        if (this._renderedTracks === 0 || remaining <= 0) {
            this._moreButton?.destroy();
            this._moreButton = null;
            return;
        }
        const label = `Mostrar mais (${numberFormat.format(remaining)} restantes)`;
        if (this._moreButton) {
            this._moreButton.label = label;
            return;
        }
        this._moreButton = new St.Button({
            style_class: 'ytmusic-more-button',
            label,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._moreButton.connect('clicked', () => this._renderMoreTracks());
        this._indicator._list.add_child(this._moreButton);
    }

    // The search field filters the playlist instead of searching.
    scheduleFilter(text) {
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);
        this._filterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILTER_DEBOUNCE_MS, () => {
            this._filterTimeoutId = 0;
            if (this._indicator._view === 'tracks' && this._tracks.length > 0) {
                this._trackFilter = text;
                this.render();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // A track was removed through the floating menu.
    onTrackRemoved(track, playlist) {
        const indicator = this._indicator;
        if (indicator._view === 'tracks' && indicator._playlist === playlist) {
            this._tracks = this._tracks.filter(t => t.videoId !== track.videoId);
            this._updateTracksSubtitle({complete: true, tracks: this._tracks});
            this._rerenderTracksKeepingScroll();
        }
    }

    _playFrom(index) {
        const indicator = this._indicator;
        if (!indicator._playlist)
            return;
        indicator._play('PlayPlaylist', indicator._playlist.id, index, this._oldestFirst);
    }

    destroy() {
        for (const id of ['_filterTimeoutId', '_restoreScrollIdleId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
    }
}

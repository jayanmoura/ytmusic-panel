// Search results (YouTube Music songs), with a debounce while typing.

import GLib from 'gi://GLib';

import {SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS} from '../constants.js';

export class SearchView {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this._query = '';
        this._results = [];
        this._searchTimeoutId = 0;
        this._viewBeforeSearch = 'playlists';
    }

    get hasResults() {
        return this._results.length > 0;
    }

    // The search field changed outside a playlist.
    onTextChanged(text) {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }

        const query = text.trim();
        if (!query) {
            this._leaveSearch();
            return;
        }
        if (query.length < SEARCH_MIN_CHARS)
            return;
        this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._searchTimeoutId = 0;
            this._search(query);
            return GLib.SOURCE_REMOVE;
        });
    }

    runNow() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        const query = this._indicator._searchEntry.get_text().trim();
        if (query)
            this._search(query);
    }

    _search(query) {
        const indicator = this._indicator;
        if (indicator._view !== 'search') {
            // Remember where to go back to.
            this._viewBeforeSearch = indicator._view;
            indicator._view = 'search';
        }
        this._query = query;
        this._results = [];
        indicator._setHeader('Resultados', `"${query}"`, true);
        indicator._showLoading('Buscando…');
        return indicator._load(
            () => indicator._client.call('Search', query),
            data => {
                this._results = data;
                this.render();
            });
    }

    _leaveSearch() {
        const indicator = this._indicator;
        if (indicator._view !== 'search')
            return;
        indicator._serial++; // drop any in-flight search reply
        this._query = '';
        this._results = [];
        if (this._viewBeforeSearch === 'tracks' && indicator._playlist) {
            indicator._tracksView.show(indicator._playlist);
        } else {
            indicator._view = 'playlists';
            indicator._playlistsView.show();
        }
    }

    render() {
        const indicator = this._indicator;
        indicator._clearList();
        if (this._results.length === 0) {
            indicator._showMessage('Nenhuma música encontrada.', 'Tente outras palavras.');
            return;
        }
        for (const track of this._results)
            indicator._list.add_child(indicator._trackRows.create(track, () => indicator._play('PlayTrack', track.videoId)));
        indicator._covers.flush();
    }

    destroy() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
    }
}

// Top of the popup: the search row (field + settings button) and the header
// (back, title, newest/oldest order, refresh; subtitle on its own line).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {ellipsized, iconButton} from './common.js';

export class Header {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        // True while the field is changed by code, so it doesn't search or filter.
        this.settingSearchText = false;
    }

    // Adds the search row and the header to `box`, in that order.
    build(box) {
        const indicator = this._indicator;
        this._box = box;

        // Search field.
        this.searchEntry = new St.Entry({
            style_class: 'ytmusic-search',
            hint_text: 'Buscar músicas',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16}),
        });
        this.clearSearchIcon = new St.Icon({icon_name: 'edit-clear-symbolic', icon_size: 16});
        this.searchEntry.clutter_text.connect('text-changed', () => indicator._onSearchChanged());
        this.searchEntry.connect('secondary-icon-clicked', () => this.searchEntry.set_text(''));
        this.searchEntry.clutter_text.connect('activate', () => indicator._runSearchNow());

        // Search row: [search field] [settings]
        this.searchRow = new St.BoxLayout({style_class: 'ytmusic-search-row'});
        this.searchRow.add_child(this.searchEntry);
        this._settingsButton = iconButton('emblem-system-symbolic', 'Configurações',
            () => indicator._openSettings());
        this.searchRow.add_child(this._settingsButton);
        box.add_child(this.searchRow);

        // Header: [back] title [refresh], subtitle on its own line below the
        // title, so the back arrow stays aligned with the title text.
        const header = new St.BoxLayout({
            style_class: 'ytmusic-header',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._header = header;
        const titleRow = new St.BoxLayout({style_class: 'ytmusic-title-row'});
        header.add_child(titleRow);

        this.backButton = iconButton('go-previous-symbolic', 'Voltar',
            () => indicator._goBack());
        this.backButton.visible = false;
        titleRow.add_child(this.backButton);

        this.title = ellipsized(new St.Label({
            text: 'Playlists',
            style_class: 'ytmusic-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        titleRow.add_child(this.title);

        // Tracks view only: newest first (the playlist's order) or oldest first.
        this.sortButton = iconButton('view-sort-descending-symbolic', '',
            () => indicator._tracksView.toggleOldestFirst());
        this.sortButton.visible = false;
        titleRow.add_child(this.sortButton);

        this.refreshButton = iconButton('view-refresh-symbolic', 'Atualizar',
            () => indicator._refresh());
        titleRow.add_child(this.refreshButton);

        this.subtitle = ellipsized(new St.Label({style_class: 'ytmusic-subtitle', visible: false}));
        header.add_child(this.subtitle);
        box.add_child(header);
    }

    set(title, subtitle = null, canGoBack = false) {
        this.title.text = title;
        this.subtitle.text = subtitle ?? '';
        this.subtitle.visible = !!subtitle;
        this.backButton.visible = canGoBack;
        // Indent the subtitle under the title, past the back arrow.
        if (canGoBack)
            this.subtitle.add_style_class_name('ytmusic-subtitle-indented');
        else
            this.subtitle.remove_style_class_name('ytmusic-subtitle-indented');
    }

    // Inside a playlist the search field sits under its name and filters it.
    setSearchMode(inPlaylist) {
        if (inPlaylist)
            this._box.set_child_above_sibling(this.searchRow, this._header);
        else
            this._box.set_child_below_sibling(this.searchRow, this._header);
        this._settingsButton.visible = !inPlaylist;
        this.searchEntry.hint_text = inPlaylist ? 'Buscar nesta playlist' : 'Buscar músicas';
    }

    // Change the field without triggering a search or filter.
    setSearchText(text) {
        this.settingSearchText = true;
        this.searchEntry.set_text(text);
        this.searchEntry.secondary_icon = text ? this.clearSearchIcon : null;
        this.settingSearchText = false;
    }

    destroy() {}
}

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ERROR_TEXT} from './constants.js';
import {sortPlaylists} from './util.js';
import {CoverLoader} from './covers.js';
import {YTMusicClient} from './ytmusicClient.js';
import {ellipsized, iconButton} from './widgets/common.js';
import {FloatMenu} from './widgets/floatMenu.js';
import {Toast} from './widgets/toast.js';
import {TrackRowFactory} from './widgets/trackRow.js';
import {PickerView} from './views/pickerView.js';
import {PlaylistsView} from './views/playlistsView.js';
import {SearchView} from './views/searchView.js';
import {TracksView} from './views/tracksView.js';
import {updateControlSet} from './player/controls.js';
import {MiniPlayer} from './player/miniPlayer.js';
import {NowPlaying} from './player/nowPlaying.js';

const YTMusicIndicator = GObject.registerClass(
class YTMusicIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'YouTube Music');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new YTMusicClient();
        this._client.onAuthRequired = () => this._onAuthRequired();
        this._client.onPlaybackChanged = state => this._updatePlayer(state);
        this._playback = null;

        this._view = 'playlists';
        this._playlists = null;
        this._playlist = null; // playlist shown in the tracks view
        this._settingSearchText = false;
        this._overlayActor = null; // what the overlay shows: picker list or expanded player
        this._controlSets = []; // mini player and expanded player buttons
        this._npExtraHeight = 0; // mini player height, given to the expanded player
        // Set by destroy(); async replies that land later must not touch actors.
        this._destroyed = false;
        // Bumped on every navigation/load; stale async replies are dropped.
        this._serial = 0;
        this._covers = new CoverLoader(this);
        this._trackRows = new TrackRowFactory(this);
        this._playlistsView = new PlaylistsView(this);
        this._tracksView = new TracksView(this);
        this._searchView = new SearchView(this);
        this._picker = new PickerView(this);
        this._mini = new MiniPlayer(this);
        this._np = new NowPlaying(this);

        this.add_child(new St.Icon({
            gicon: this._icon('ytmusic-symbolic'),
            style_class: 'system-status-icon',
        }));

        this.menu.box.add_style_class_name('ytmusic-popup');
        this._buildContent();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (this._destroyed)
                return; // the menu closes while being destroyed
            if (!open) {
                this._np.stopProgress();
                this._float.close();
                this._mini.updateMarquee(); // stops it
                return;
            }
            this._refreshPlayer();
            this._fitHeight();
            this._mini.updateMarquee();
            if (this._overlayActor === this._np.actor)
                this._np.startProgress();
            if (this._view === 'playlists')
                this._playlistsView.load(false);
        });
        // Also subscribes to PlaybackChanged (the proxy is created on first call).
        this._refreshPlayer();

        this._settingsChangedIds = [
            this._settings.connect('changed::popup-height', () => this._applyHeight()),
            this._settings.connect('changed::popup-theme', () => this._applyTheme()),
            this._settings.connect('changed::show-episodes-playlist', () => this._onLibraryOptionsChanged()),
            this._settings.connect('changed::show-covers', () => this._onLibraryOptionsChanged()),
        ];
        this._applyHeight();

        // The shell switches its own light/dark stylesheet on these.
        const stSettings = St.Settings.get();
        this._stSettingsIds = [
            stSettings.connect('notify::color-scheme', () => this._applyTheme()),
            stSettings.connect('notify::shell-color-scheme', () => this._applyTheme()),
        ];
        this._applyTheme();
    }

    // Must run after the panel's PopupMenuManager registered this menu: its own
    // open handler pushes a modal that moves key focus to the menu actor.
    focusSearchOnOpen() {
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && !this._destroyed)
                this._searchEntry.grab_key_focus();
        });
    }

    _icon(name) {
        return Gio.icon_new_for_string(`${this._extension.path}/icons/${name}.svg`);
    }

    _buildContent() {
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        // The track menu (⋮) floats over the content in its own layer; it has
        // to live inside the popup to receive clicks while the popup is open.
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        stack.add_child(box);
        this._float = new FloatMenu(this);
        stack.add_child(this._float.layer);
        section.actor.add_child(stack);

        // Search field.
        this._searchEntry = new St.Entry({
            style_class: 'ytmusic-search',
            hint_text: 'Buscar músicas',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16}),
        });
        this._clearSearchIcon = new St.Icon({icon_name: 'edit-clear-symbolic', icon_size: 16});
        this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._searchEntry.connect('secondary-icon-clicked', () => this._searchEntry.set_text(''));
        this._searchEntry.clutter_text.connect('activate', () => this._runSearchNow());

        // Search row: [search field] [settings]
        this._searchRow = new St.BoxLayout({style_class: 'ytmusic-search-row'});
        this._searchRow.add_child(this._searchEntry);
        this._settingsButton = iconButton('emblem-system-symbolic', 'Configurações',
            () => this._openSettings());
        this._searchRow.add_child(this._settingsButton);
        box.add_child(this._searchRow);

        // Header: [back] title [refresh], subtitle on its own line below the
        // title, so the back arrow stays aligned with the title text.
        const header = new St.BoxLayout({
            style_class: 'ytmusic-header',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._header = header;
        this._contentBox = box;
        const titleRow = new St.BoxLayout({style_class: 'ytmusic-title-row'});
        header.add_child(titleRow);

        this._backButton = iconButton('go-previous-symbolic', 'Voltar',
            () => this._goBack());
        this._backButton.visible = false;
        titleRow.add_child(this._backButton);

        this._title = ellipsized(new St.Label({
            text: 'Playlists',
            style_class: 'ytmusic-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        titleRow.add_child(this._title);

        // Tracks view only: newest first (the playlist's order) or oldest first.
        this._sortButton = iconButton('view-sort-descending-symbolic', '',
            () => this._tracksView.toggleOldestFirst());
        this._sortButton.visible = false;
        titleRow.add_child(this._sortButton);

        this._refreshButton = iconButton('view-refresh-symbolic', 'Atualizar',
            () => this._refresh());
        titleRow.add_child(this._refreshButton);

        this._subtitle = ellipsized(new St.Label({style_class: 'ytmusic-subtitle', visible: false}));
        header.add_child(this._subtitle);
        box.add_child(header);

        // Scrollable body shared by all views.
        this._scroll = new St.ScrollView({
            style_class: 'ytmusic-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll.set_child(this._list);
        box.add_child(this._scroll);

        // "Add to playlist" picker, shown over the current view.
        box.add_child(this._picker.scroll);
        this._np.build(box);
        this._pickerTrack = null;
        this._savedHeader = null;

        // Short confirmations ("Link copiado"), shown over the bottom of the list.
        this._toast = new Toast();
        box.add_child(this._toast.actor);

        this._playerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._playerSeparator);
        this._mini.build();
        this._updatePlayer(null);
    }

    // Fixed height, so the setting is visible even when the list is short.
    // The shell caps the whole menu to the screen; when that happens the
    // list must shrink instead of pushing the mini player out of view.
    // Sizes go through CSS: setting min_height on a ScrollView directly can
    // make its minimum exceed its natural height, which aborts the shell.
    _applyHeight() {
        const h = this._settings.get_int('popup-height');
        this._setListHeight(h, h);
        if (this.menu.isOpen)
            this._fitHeight();
    }

    _setListHeight(min, max) {
        for (const scroll of [this._scroll, this._picker.scroll])
            scroll.style = `min-height: ${min}px; max-height: ${max}px;`;
        // The expanded player also takes the space of the mini player it hides.
        const extra = this._npExtraHeight;
        this._np.actor.style = `min-height: ${min + extra}px; max-height: ${max + extra}px;`;
        this._listHeight = min;
    }

    // Called with the menu open (the actors must be on the stage to measure).
    _fitHeight() {
        const h = this._settings.get_int('popup-height');
        const monitor = Main.layoutManager.findIndexForActor(this);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            monitor >= 0 ? monitor : Main.layoutManager.primaryIndex);
        // Height of everything in the popup except the visible list.
        const scroll = this._overlayActor ?? this._scroll;
        const [, listNat] = scroll.get_preferred_height(-1);
        const [, menuNat] = this.menu.box.get_preferred_height(-1);
        const chrome = menuNat - listNat;
        // Panel menus keep a bottom margin; leave room for it and the popup border.
        const available = Math.max(200, workArea.height - chrome - 48);
        const target = Math.min(h, available);
        this._setListHeight(target, target);
    }

    _applyTheme() {
        const choice = this._settings.get_string('popup-theme');
        const shellVariant = Main.getStyleVariant() === 'light' ? 'light' : 'dark';
        const variant = choice === 'auto' ? shellVariant : choice;
        const box = this.menu.box;
        box.remove_style_class_name('ytmusic-theme-light');
        box.remove_style_class_name('ytmusic-theme-dark');
        box.add_style_class_name(`ytmusic-theme-${variant}`);
        if (variant !== shellVariant)
            box.add_style_class_name('ytmusic-theme-forced');
        else
            box.remove_style_class_name('ytmusic-theme-forced');
    }

    _setHeader(title, subtitle = null, canGoBack = false) {
        this._title.text = title;
        this._subtitle.text = subtitle ?? '';
        this._subtitle.visible = !!subtitle;
        this._backButton.visible = canGoBack;
        // Indent the subtitle under the title, past the back arrow.
        if (canGoBack)
            this._subtitle.add_style_class_name('ytmusic-subtitle-indented');
        else
            this._subtitle.remove_style_class_name('ytmusic-subtitle-indented');
    }

    _openSettings() {
        this.menu.close();
        this._extension.openPreferences();
    }

    // Inside a playlist the search field sits under its name and filters it.
    _setSearchMode(inPlaylist) {
        if (inPlaylist)
            this._contentBox.set_child_above_sibling(this._searchRow, this._header);
        else
            this._contentBox.set_child_below_sibling(this._searchRow, this._header);
        this._settingsButton.visible = !inPlaylist;
        this._searchEntry.hint_text = inPlaylist ? 'Buscar nesta playlist' : 'Buscar músicas';
    }

    // Change the field without triggering a search or filter.
    _setSearchText(text) {
        this._settingSearchText = true;
        this._searchEntry.set_text(text);
        this._searchEntry.secondary_icon = text ? this._clearSearchIcon : null;
        this._settingSearchText = false;
    }

    _showToast(text) {
        this._toast.show(text);
    }

    // A track was removed through the floating menu.
    _onTrackRemoved(track, playlist) {
        this._playlists = null; // counts changed; reload on next visit
        this._tracksView.onTrackRemoved(track, playlist);
        this._showToast('Removida da playlist');
    }

    _goBack() {
        if (this._pickerTrack) {
            this._closePicker();
            return;
        }
        if (this._view === 'search')
            this._searchEntry.set_text(''); // _onSearchChanged leaves the search view
        else
            this._playlistsView.show();
    }

    _clearList() {
        this._float.close();
        this._list.destroy_all_children();
        this._list.style = null;
        this._tracksView.onListCleared();
        this._scroll.vadjustment.value = 0;
    }

    // Loading placeholder that keeps the current height, so the popup doesn't
    // shrink to a small box and grow back when the content arrives.
    _showLoading(text) {
        const height = this._list.height;
        this._showMessage(text);
        if (height > 0)
            this._list.style = `min-height: ${height}px;`;
    }

    _refresh() {
        if (this._view === 'search')
            this._runSearchNow();
        else if (this._view === 'tracks')
            this._tracksView.load(true);
        else
            this._playlistsView.load(true);
    }

    // Shared bookkeeping for async loads: replies from superseded loads are dropped.
    async _load(promise, onData) {
        const serial = ++this._serial;
        this._refreshButton.reactive = false;
        try {
            const data = await promise();
            if (serial === this._serial)
                onData(data, serial);
        } catch (e) {
            if (e.code !== 'cancelled' && serial === this._serial)
                this._onLoadError(e);
        } finally {
            if (serial === this._serial)
                this._refreshButton.reactive = true;
        }
    }

    _onLoadError(e) {
        const hasData = {
            playlists: !!this._playlists,
            tracks: this._tracksView.hasTracks,
            search: this._searchView.hasResults,
        }[this._view];
        // Network hiccup with data on screen: keep showing what we have.
        if (e.code === 'network' && hasData)
            return;
        if (e.code === 'auth_required')
            this._playlists = null;
        if (!ERROR_TEXT[e.code])
            console.error(e, '[ytmusic-panel] unexpected error');
        this._showMessage(...(ERROR_TEXT[e.code] ?? ERROR_TEXT.internal));
    }

    _onAuthRequired() {
        this._playlists = null;
        if (this.menu.isOpen)
            this._showMessage(...ERROR_TEXT.auth_required);
    }

    _showMessage(title, hint = null) {
        this._clearList();
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
        this._list.add_child(box);
    }

    // Covers the current view with the picker/actions list.
    _enterOverlay(track, title, subtitle, actor = this._picker.scroll) {
        if (!this._pickerTrack) {
            this._savedHeader = {
                title: this._title.text,
                subtitle: this._subtitle.visible ? this._subtitle.text : null,
                back: this._backButton.visible,
            };
        }
        this._pickerTrack = track;
        this._setHeader(title, subtitle, true);
        this._refreshButton.visible = false;
        this._sortButton.visible = false;
        this._searchRow.visible = false;
        this._scroll.visible = false;
        if (this._overlayActor && this._overlayActor !== actor)
            this._overlayActor.visible = false;
        this._overlayActor = actor;
        actor.visible = true;
        if (actor === this._picker.scroll)
            this._picker.scroll.vadjustment.value = 0;
    }

    _closePicker() {
        if (!this._pickerTrack)
            return;
        this._pickerTrack = null;
        this._picker.clear();
        this._picker.scroll.visible = false;
        if (this._overlayActor === this._np.actor) {
            this._mini.section.actor.show();
            this._playerSeparator.actor.show();
            this._npExtraHeight = 0;
            const h = this._listHeight ?? this._settings.get_int('popup-height');
            this._setListHeight(h, h);
            this._mini.updateMarquee();
        }
        this._np.actor.visible = false;
        this._overlayActor = null;
        this._np.stopProgress();
        this._scroll.visible = true;
        this._refreshButton.visible = true;
        this._sortButton.visible = this._view === 'tracks';
        this._searchRow.visible = true;
        const h = this._savedHeader;
        this._setHeader(h.title, h.subtitle, h.back);
        this._savedHeader = null;
    }

    // -- search ----------------------------------------------------------------

    _onSearchChanged() {
        if (this._settingSearchText)
            return;
        this._closePicker();
        const text = this._searchEntry.get_text();
        this._searchEntry.secondary_icon = text ? this._clearSearchIcon : null;

        if (this._view === 'tracks')
            this._tracksView.scheduleFilter(text);
        else
            this._searchView.onTextChanged(text);
    }

    _runSearchNow() {
        if (this._view === 'tracks')
            return; // the filter already follows each keystroke
        this._searchView.runNow();
    }

    // -- covers ----------------------------------------------------------------

    _sortPlaylists(data) {
        this._allPlaylists = data;
        return sortPlaylists(data, this._settings.get_boolean('show-episodes-playlist'));
    }

    _onLibraryOptionsChanged() {
        if (this._allPlaylists)
            this._playlists = this._sortPlaylists(this._allPlaylists);
        this._mini.forgetCover();
        this._updatePlayer(this._playback);
        if (this._pickerTrack)
            this._picker.render(this._pickerTrack);
        else if (this._view === 'playlists' && this._playlists)
            this._playlistsView.render();
        else if (this._view === 'tracks' && this._tracksView.hasTracks)
            this._tracksView.render();
        else if (this._view === 'search' && this._searchView.hasResults)
            this._searchView.render();
    }

    // Square cover with a placeholder; the image is filled in by _flushCovers().
    async _refreshPlayer() {
        try {
            const status = await this._client.call('GetStatus');
            this._updatePlayer(status.playback);
        } catch (e) {
            if (e.code !== 'cancelled')
                this._updatePlayer(null);
        }
    }

    async _control(method) {
        try {
            this._updatePlayer(await this._client.call(method));
        } catch (e) {
            if (e.code !== 'cancelled' && !this._destroyed)
                Main.notify('YouTube Music', (ERROR_TEXT[e.code] ?? [e.message])[0]);
        }
    }

    _updatePlayer(state) {
        // Late replies can land after destroy().
        if (!this._client)
            return;
        this._playback = state;
        const track = state?.track;
        const active = !!state && state.state !== 'stopped';

        this._mini.updateText(state, active);
        for (const set of this._controlSets)
            updateControlSet(set, state, active);
        this._highlightPlayingRow(active ? track?.videoId : null);
        this._mini.updateCover(active ? track?.thumbnail ?? null : null, active);
        this._np.onPlaybackChanged(state, active);
    }

    _highlightPlayingRow(videoId) {
        if (this._view !== 'tracks' && this._view !== 'search')
            return;
        for (const row of this._list.get_children()) {
            if (row._videoId === undefined)
                continue;
            if (videoId && row._videoId === videoId)
                row.add_style_class_name('ytmusic-row-playing');
            else
                row.remove_style_class_name('ytmusic-row-playing');
        }
    }

    // -- playback --------------------------------------------------------------

    async _play(method, ...args) {
        try {
            await this._client.call(method, ...args);
        } catch (e) {
            if (e.code === 'cancelled' || this._destroyed)
                return;
            const [title, hint] = ERROR_TEXT[e.code] ?? [e.message, null];
            Main.notify('YouTube Music', hint ? `${title} ${hint}` : title);
        }
    }

    destroy() {
        this._destroyed = true;
        this._serial++;
        this._mini.destroy();
        this._np.destroy();
        this._playlistsView.destroy();
        this._tracksView.destroy();
        this._searchView.destroy();
        this._picker.destroy();
        this._toast.destroy();
        this._trackRows.destroy();
        this._float.destroy();
        this._covers.destroy();
        this._client?.destroy();
        this._client = null;
        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];
        this._settings = null;
        const stSettings = St.Settings.get();
        for (const id of this._stSettingsIds)
            stSettings.disconnect(id);
        this._stSettingsIds = [];
        super.destroy();
    }
});

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

// The panel button and its popup: builds the content, navigates between the
// views and the overlays, and hands playback state to the player modules.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ERROR_TEXT} from './constants.js';
import {sortPlaylists} from './util.js';
import {Appearance} from './appearance.js';
import {CoverLoader} from './covers.js';
import {YTMusicClient} from './ytmusicClient.js';
import {FloatMenu} from './widgets/floatMenu.js';
import {Header} from './widgets/header.js';
import {Toast} from './widgets/toast.js';
import {TrackRowFactory} from './widgets/trackRow.js';
import {PickerView} from './views/pickerView.js';
import {PlaylistsView} from './views/playlistsView.js';
import {SearchView} from './views/searchView.js';
import {TracksView} from './views/tracksView.js';
import {updateControlSet} from './player/controls.js';
import {MiniPlayer} from './player/miniPlayer.js';
import {NowPlaying} from './player/nowPlaying.js';

export const YTMusicIndicator = GObject.registerClass(
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
        this._header = new Header(this);
        this._appearance = new Appearance(this);
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
            this._appearance.fitHeight();
            this._mini.updateMarquee();
            if (this._overlayActor === this._np.actor)
                this._np.startProgress();
            if (this._view === 'playlists')
                this._playlistsView.load(false);
        });
        // Also subscribes to PlaybackChanged (the proxy is created on first call).
        this._refreshPlayer();

        this._settingsChangedIds = [
            this._settings.connect('changed::popup-height', () => this._appearance.applyHeight()),
            this._settings.connect('changed::popup-theme', () => this._appearance.applyTheme()),
            this._settings.connect('changed::show-episodes-playlist', () => this._onLibraryOptionsChanged()),
            this._settings.connect('changed::show-covers', () => this._onLibraryOptionsChanged()),
        ];
        this._appearance.applyHeight();

        // The shell switches its own light/dark stylesheet on these.
        const stSettings = St.Settings.get();
        this._stSettingsIds = [
            stSettings.connect('notify::color-scheme', () => this._appearance.applyTheme()),
            stSettings.connect('notify::shell-color-scheme', () => this._appearance.applyTheme()),
        ];
        this._appearance.applyTheme();
    }

    // Must run after the panel's PopupMenuManager registered this menu: its own
    // open handler pushes a modal that moves key focus to the menu actor.
    focusSearchOnOpen() {
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && !this._destroyed)
                this._header.searchEntry.grab_key_focus();
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

        this._header.build(box);

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

    _openSettings() {
        this.menu.close();
        this._extension.openPreferences();
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
            this._header.searchEntry.set_text(''); // _onSearchChanged leaves the search view
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
        this._header.refreshButton.reactive = false;
        try {
            const data = await promise();
            if (serial === this._serial)
                onData(data, serial);
        } catch (e) {
            if (e.code !== 'cancelled' && serial === this._serial)
                this._onLoadError(e);
        } finally {
            if (serial === this._serial)
                this._header.refreshButton.reactive = true;
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
                title: this._header.title.text,
                subtitle: this._header.subtitle.visible ? this._header.subtitle.text : null,
                back: this._header.backButton.visible,
            };
        }
        this._pickerTrack = track;
        this._header.set(title, subtitle, true);
        this._header.refreshButton.visible = false;
        this._header.sortButton.visible = false;
        this._header.searchRow.visible = false;
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
            const h = this._appearance.listHeight ?? this._settings.get_int('popup-height');
            this._appearance.setListHeight(h, h);
            this._mini.updateMarquee();
        }
        this._np.actor.visible = false;
        this._overlayActor = null;
        this._np.stopProgress();
        this._scroll.visible = true;
        this._header.refreshButton.visible = true;
        this._header.sortButton.visible = this._view === 'tracks';
        this._header.searchRow.visible = true;
        const h = this._savedHeader;
        this._header.set(h.title, h.subtitle, h.back);
        this._savedHeader = null;
    }

    // -- search ----------------------------------------------------------------

    _onSearchChanged() {
        if (this._header.settingSearchText)
            return;
        this._closePicker();
        const text = this._header.searchEntry.get_text();
        this._header.searchEntry.secondary_icon = text ? this._header.clearSearchIcon : null;

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
        this._header.destroy();
        this._appearance.destroy();
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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ERROR_TEXT, NOW_PLAYING, NOW_PLAYING_CHROME, PROGRESS_SYNC_MS, PROGRESS_TICK_MS} from './constants.js';
import {formatTime, largeCover, sortPlaylists} from './util.js';
import {CoverLoader} from './covers.js';
import {YTMusicClient} from './ytmusicClient.js';
import {ClipBox, ellipsized, iconButton, setToggled} from './widgets/common.js';
import {FloatMenu} from './widgets/floatMenu.js';
import {Toast} from './widgets/toast.js';
import {TrackRowFactory} from './widgets/trackRow.js';
import {PickerView} from './views/pickerView.js';
import {PlaylistsView} from './views/playlistsView.js';
import {SearchView} from './views/searchView.js';
import {TracksView} from './views/tracksView.js';

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
        this._progressTimeoutId = 0;
        // Set by destroy(); async replies that land later must not touch actors.
        this._destroyed = false;
        this._progressBase = {position: 0, at: 0, duration: null};
        this._lastSync = 0;
        // Bumped on every navigation/load; stale async replies are dropped.
        this._serial = 0;
        this._covers = new CoverLoader(this);
        this._trackRows = new TrackRowFactory(this);
        this._playlistsView = new PlaylistsView(this);
        this._tracksView = new TracksView(this);
        this._searchView = new SearchView(this);
        this._picker = new PickerView(this);

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
                this._stopProgress();
                this._float.close();
                this._updateMarquee(); // stops it
                return;
            }
            this._refreshPlayer();
            this._fitHeight();
            this._updateMarquee();
            if (this._overlayActor === this._nowPlaying)
                this._startProgress();
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
        this._buildNowPlaying(box);
        this._pickerTrack = null;
        this._savedHeader = null;

        // Short confirmations ("Link copiado"), shown over the bottom of the list.
        this._toast = new Toast();
        box.add_child(this._toast.actor);

        this._playerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._playerSeparator);
        this._buildPlayer();
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
        this._nowPlaying.style = `min-height: ${min + extra}px; max-height: ${max + extra}px;`;
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
        if (this._overlayActor === this._nowPlaying) {
            this._playerSection.actor.show();
            this._playerSeparator.actor.show();
            this._npExtraHeight = 0;
            const h = this._listHeight ?? this._settings.get_int('popup-height');
            this._setListHeight(h, h);
            this._updateMarquee();
        }
        this._nowPlaying.visible = false;
        this._overlayActor = null;
        this._stopProgress();
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
        this._playerCoverUrl = undefined;
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
    _updatePlayerCover(url, active) {
        if (url === this._playerCoverUrl)
            return;
        this._playerCoverUrl = url;
        this._playerCoverSlot.child?.destroy();
        this._playerCoverSlot.child = active ? this._covers.cover(url, 'ytmusic-cover ytmusic-player-cover') : null;
        this._covers.flush();
    }

    // -- mini player -----------------------------------------------------------

    _buildPlayer() {
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);
        this._playerSection = section;

        const player = new St.BoxLayout({style_class: 'ytmusic-player', x_expand: true});
        section.actor.add_child(player);

        // Cover and title open the expanded player.
        const openBox = new St.BoxLayout({style_class: 'ytmusic-player-open-content', x_expand: true});
        this._playerOpenButton = new St.Button({
            style_class: 'ytmusic-player-open',
            child: openBox,
            x_expand: true,
            can_focus: true,
            accessible_name: 'Abrir o player',
        });
        this._playerOpenButton.connect('clicked', () => this._toggleNowPlaying());
        player.add_child(this._playerOpenButton);

        this._playerCoverSlot = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._playerCoverUrl = undefined;
        openBox.add_child(this._playerCoverSlot);

        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._playerTitle = new St.Label({style_class: 'ytmusic-player-title'});
        this._titleClip = new ClipBox();
        this._titleClip.add_child(this._playerTitle);
        this._titleClip.connect('notify::width', () => this._updateMarquee());
        this._playerArtist = ellipsized(new St.Label({style_class: 'ytmusic-player-artist'}));
        info.add_child(this._titleClip);
        info.add_child(this._playerArtist);
        openBox.add_child(info);

        const controls = new St.BoxLayout({style_class: 'ytmusic-player-controls'});
        this._repeatButton = iconButton('media-playlist-repeat-symbolic', 'Repetir',
            () => this._control('CycleRepeat'));
        this._shuffleButton = iconButton('media-playlist-shuffle-symbolic', 'Aleatório',
            () => this._control('ToggleShuffle'));
        this._prevButton = iconButton('media-skip-backward-symbolic', 'Anterior',
            () => this._control('Previous'));
        this._playPauseButton = iconButton('media-playback-start-symbolic', 'Tocar',
            () => this._control('TogglePause'));
        this._playPauseButton.add_style_class_name('ytmusic-play-pause');
        this._nextButton = iconButton('media-skip-forward-symbolic', 'Próxima',
            () => this._control('Next'));
        this._controlSets.push({
            repeat: this._repeatButton, shuffle: this._shuffleButton, prev: this._prevButton,
            playPause: this._playPauseButton, next: this._nextButton,
        });
        controls.add_child(this._repeatButton);
        controls.add_child(this._shuffleButton);
        controls.add_child(this._prevButton);
        controls.add_child(this._playPauseButton);
        controls.add_child(this._nextButton);
        player.add_child(controls);

        this._updatePlayer(null);
    }

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

        const title = active ? track?.title || 'Música sem título' : 'Nada tocando';
        if (this._playerTitle.text !== title) {
            this._playerTitle.text = title;
            this._updateMarquee();
        }
        if (!active) {
            this._playerArtist.text = 'Escolha uma playlist ou música';
        } else {
            this._playerArtist.text = state.state === 'loading'
                ? 'Carregando…'
                : track?.artists || '';
        }

        const playing = state?.state === 'playing' || state?.state === 'loading';
        const repeat = state?.repeat ?? 'off';
        for (const set of this._controlSets) {
            set.playPause.child.icon_name = playing
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
            set.playPause.accessible_name = playing ? 'Pausar' : 'Tocar';

            for (const button of [set.prev, set.playPause, set.next]) {
                button.reactive = active;
                button.can_focus = active;
            }

            // Repeat and shuffle also work before anything plays (they apply to the next queue).
            set.repeat.child.icon_name = repeat === 'one'
                ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
            set.repeat.accessible_name = {
                off: 'Repetir: desligado', all: 'Repetir: todas', one: 'Repetir: esta música',
            }[repeat];
            setToggled(set.repeat, repeat !== 'off');
            set.shuffle.accessible_name = state?.shuffle ? 'Aleatório: ligado' : 'Aleatório: desligado';
            setToggled(set.shuffle, !!state?.shuffle);
            for (const button of [set.repeat, set.shuffle]) {
                button.reactive = !!state;
                button.can_focus = !!state;
            }
        }

        this._highlightPlayingRow(active ? track?.videoId : null);
        this._updatePlayerCover(active ? track?.thumbnail ?? null : null, active);
        this._playerOpenButton.reactive = active;
        this._playerOpenButton.can_focus = active;

        if (this._overlayActor === this._nowPlaying) {
            if (!active) {
                this._closePicker();
            } else {
                this._renderNowPlaying();
                // Track or play/pause changed: re-read the position.
                const key = `${track?.videoId}|${state.state}`;
                if (key !== this._nowPlayingKey) {
                    this._nowPlayingKey = key;
                    this._syncPosition();
                }
            }
        }
    }

    // -- expanded player ----------------------------------------------------------

    _buildNowPlaying(parent) {
        this._nowPlaying = new St.BoxLayout({
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
        this._nowPlaying.add_child(inner);

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
        const set = {
            shuffle: iconButton('media-playlist-shuffle-symbolic', 'Aleatório',
                () => this._control('ToggleShuffle')),
            prev: iconButton('media-skip-backward-symbolic', 'Anterior',
                () => this._control('Previous')),
            playPause: iconButton('media-playback-start-symbolic', 'Tocar',
                () => this._control('TogglePause')),
            next: iconButton('media-skip-forward-symbolic', 'Próxima',
                () => this._control('Next')),
            repeat: iconButton('media-playlist-repeat-symbolic', 'Repetir',
                () => this._control('CycleRepeat')),
        };
        set.playPause.add_style_class_name('ytmusic-play-pause');
        set.playPause.add_style_class_name('ytmusic-np-play');
        for (const button of [set.shuffle, set.prev, set.playPause, set.next, set.repeat]) {
            button.child.icon_size = button === set.playPause ? 28 : 20;
            controls.add_child(button);
        }
        this._controlSets.push(set);
        inner.add_child(controls);

        parent.add_child(this._nowPlaying);
    }

    _toggleNowPlaying() {
        if (this._overlayActor === this._nowPlaying) {
            this._closePicker();
            return;
        }
        if (!this._playback || this._playback.state === 'stopped')
            return;
        this._float.close();
        // The controls move into the expanded player; it takes the mini player's space.
        // (the search row is hidden by the overlay too)
        this._npExtraHeight = this._playerSection.actor.height +
            this._playerSeparator.actor.height + this._searchRow.height +
            (this._subtitle.visible ? this._subtitle.height : 0);
        this._playerSection.actor.hide();
        this._playerSeparator.actor.hide();
        const h = this._listHeight ?? this._settings.get_int('popup-height');
        this._setListHeight(h, h);
        this._enterOverlay(NOW_PLAYING, 'Tocando agora', null, this._nowPlaying);
        this._nowPlayingKey = null;
        this._npCoverUrl = undefined; // re-create the cover at the current size
        this._renderNowPlaying();
        this._syncPosition();
        this._startProgress();
    }

    _renderNowPlaying() {
        const state = this._playback;
        const track = state?.track;
        this._npTitle.text = track?.title || 'Música sem título';
        this._npArtist.text = state?.state === 'loading' ? 'Carregando…' : track?.artists || '';
        this._npAlbum.text = track?.album ?? '';
        this._npAlbum.visible = !!track?.album;

        const url = largeCover(track?.thumbnail);
        if (url !== this._npCoverUrl) {
            this._npCoverUrl = url;
            this._npCoverSlot.child?.destroy();
            const cover = this._covers.cover(url, 'ytmusic-cover ytmusic-np-cover') ??
                new St.Bin({
                    style_class: 'ytmusic-cover ytmusic-np-cover',
                    child: new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ytmusic-cover-placeholder'}),
                });
            // As big as the popup height allows, leaving room for the rest.
            const height = (this._listHeight ?? 560) + this._npExtraHeight;
            const size = Math.max(120, Math.min(300, height - NOW_PLAYING_CHROME));
            cover._baseStyle = `width: ${size}px; height: ${size}px;`;
            cover.style = cover._baseStyle;
            this._npCoverSlot.child = cover;
            this._covers.flush();
        }
        if (state?.duration)
            this._progressBase.duration = state.duration;
        if (state?.state === 'loading')
            this._progress.add_style_class_name('ytmusic-progress-loading');
        else
            this._progress.remove_style_class_name('ytmusic-progress-loading');
        this._tickProgress();
    }

    async _syncPosition() {
        this._lastSync = GLib.get_monotonic_time();
        try {
            const data = await this._client.call('GetPosition');
            if (!this._destroyed)
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
        const playing = this._playback?.state === 'playing';
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

    _startProgress() {
        this._stopProgress();
        this._progressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_TICK_MS, () => {
            this._tickProgress();
            if (GLib.get_monotonic_time() - this._lastSync > PROGRESS_SYNC_MS * 1000)
                this._syncPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopProgress() {
        if (this._progressTimeoutId) {
            GLib.source_remove(this._progressTimeoutId);
            this._progressTimeoutId = 0;
        }
    }

    async _seekTo(ratio) {
        const duration = this._progressBase.duration;
        if (!duration || this._playback?.state === 'stopped')
            return;
        const seconds = Math.max(0, Math.min(1, ratio)) * duration;
        this._setPositionBase(seconds, duration); // move the bar right away
        try {
            const data = await this._client.call('Seek', seconds);
            if (!this._destroyed)
                this._setPositionBase(data.position, data.duration);
        } catch (e) {
            if (!this._destroyed)
                this._syncPosition();
        }
    }

    // Long titles scroll back and forth while the popup is open.
    _updateMarquee() {
        const label = this._playerTitle;
        label.remove_transition('translation-x');
        label.translation_x = 0;
        // Animations on hidden actors finish at once, which would loop forever.
        if (!this.menu.isOpen || !this._titleClip.mapped)
            return;
        const overflow = label.width - this._titleClip.width;
        if (this._titleClip.width <= 0 || overflow <= 2)
            return;
        const duration = Math.max(1500, overflow * 30);
        const step = (to, next) => label.ease({
            translation_x: to,
            duration,
            delay: 1500,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: next,
        });
        const loop = () => {
            if (this._titleClip.mapped)
                step(-overflow, () => step(0, loop));
        };
        loop();
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
        this._playerTitle.remove_transition('translation-x');
        if (this._progressTimeoutId) {
            GLib.source_remove(this._progressTimeoutId);
            this._progressTimeoutId = 0;
        }
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

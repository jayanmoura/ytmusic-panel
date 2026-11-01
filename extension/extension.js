import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {YTMusicClient} from './ytmusicClient.js';

const LIKED_PLAYLIST_ID = 'LM';
const EPISODES_PLAYLIST_ID = 'SE'; // "Episódios para mais tarde"

// Rows are created in pages so huge playlists don't stall the shell.
const TRACKS_PAGE_SIZE = 100;
const FILTER_DEBOUNCE_MS = 150;
// Hovering a track this long asks the service to resolve its audio ahead of a click.
const PREPARE_DELAY_MS = 250;
const TOAST_MS = 2000;
const SHARE_URL = 'https://music.youtube.com/watch?v=';

const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_MIN_CHARS = 2;

const numberFormat = new Intl.NumberFormat('pt-BR');

const ERROR_TEXT = {
    auth_required: [
        'Você não está conectado ao YouTube Music.',
        'Abra as configurações (engrenagem) e entre com o navegador.',
    ],
    offline: [
        'O serviço ytmusic-daemon não está respondendo.',
        'No terminal, rode: systemctl --user start ytmusic-daemon',
    ],
    network: [
        'Não foi possível falar com o YouTube Music.',
        'Verifique a conexão e clique em atualizar.',
    ],
    unavailable: [
        'Conteúdo indisponível no YouTube Music.',
        'A playlist pode ter sido removida ou estar privada.',
    ],
    internal: [
        'O serviço encontrou um erro.',
        'Veja os logs: journalctl --user -u ytmusic-daemon',
    ],
};

function sortPlaylists(playlists, showEpisodes) {
    const visible = playlists.filter(p => showEpisodes || p.id !== EPISODES_PLAYLIST_ID);
    const liked = visible.filter(p => p.id === LIKED_PLAYLIST_ID);
    return [...liked, ...visible.filter(p => p.id !== LIKED_PLAYLIST_ID)];
}

function trackCountText(count) {
    if (count === 1)
        return '1 música';
    return `${numberFormat.format(count)} músicas`;
}

const PROGRESS_TICK_MS = 250;
// The position is interpolated locally and re-read from the service this often.
const PROGRESS_SYNC_MS = 5000;
const NOW_PLAYING = {videoId: null}; // overlay marker for the expanded player
// Height of everything in the expanded player except the cover.
const NOW_PLAYING_CHROME = 250;

// Thumbnails come at 120px; ask the image server for a size fit for the big cover.
function largeCover(url) {
    return url?.replace(/=w\d+-h\d+/, '=w544-h544').replace(/=s\d+(?=-|$)/, '=s544') ?? null;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '0:00';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Case and accent insensitive, for the playlist filter.
function normalize(text) {
    return (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

// Clips its child and asks for no minimum width, so a long title doesn't push
// the player controls; the child keeps its natural width (FixedLayout) and
// scrolls inside (see _updateMarquee).
const ClipBox = GObject.registerClass(
class ClipBox extends St.Widget {
    _init() {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            x_expand: true,
        });
    }

    vfunc_get_preferred_width(forHeight) {
        const [, natural] = super.vfunc_get_preferred_width(forHeight);
        return [0, natural];
    }
});

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
        this._tracks = [];
        this._renderedTracks = 0;
        this._moreButton = null;
        this._query = '';
        this._results = [];
        this._searchTimeoutId = 0;
        this._viewBeforeSearch = 'playlists';
        this._pendingCovers = []; // [url, St.Bin] waiting for _flushCovers()
        this._trackFilter = '';
        this._oldestFirst = false;
        this._tracksComplete = false;
        this._shownTracks = []; // indices into _tracks that pass the filter, in display order
        this._filterTimeoutId = 0;
        this._prepareTimeoutId = 0;
        this._toastTimeoutId = 0;
        this._settingSearchText = false;
        this._floatTrack = null;
        this._overlayActor = null; // what the overlay shows: picker list or expanded player
        this._controlSets = []; // mini player and expanded player buttons
        this._npExtraHeight = 0; // mini player height, given to the expanded player
        this._progressTimeoutId = 0;
        this._progressBase = {position: 0, at: 0, duration: null};
        this._lastSync = 0;
        // Bumped on every navigation/load; stale async replies are dropped.
        this._serial = 0;

        this.add_child(new St.Icon({
            gicon: this._icon('ytmusic-symbolic'),
            style_class: 'system-status-icon',
        }));

        this.menu.box.add_style_class_name('ytmusic-popup');
        this._buildContent();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                this._stopProgress();
                this._closeFloat();
                this._updateMarquee(); // stops it
                return;
            }
            this._refreshPlayer();
            this._fitHeight();
            this._updateMarquee();
            if (this._overlayActor === this._nowPlaying)
                this._startProgress();
            if (this._view === 'playlists')
                this._loadPlaylists(false);
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
            if (open)
                this._searchEntry.grab_key_focus();
        });
    }

    _icon(name) {
        return Gio.icon_new_for_string(`${this._extension.path}/icons/${name}.svg`);
    }

    _iconButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'ytmusic-icon-button',
            can_focus: true,
            accessible_name: accessibleName,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', callback);
        return button;
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
        this._floatLayer = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
        });
        // Clicking or scrolling anywhere outside the floating menu closes it.
        // The layer itself isn't reactive, so the content gets events while
        // the scrim is hidden.
        this._floatScrim = new St.Widget({reactive: true, visible: false});
        this._floatScrim.connect('button-press-event', () => {
            this._closeFloat();
            return Clutter.EVENT_STOP;
        });
        this._floatScrim.connect('scroll-event', () => {
            this._closeFloat();
            return Clutter.EVENT_STOP;
        });
        this._floatLayer.add_child(this._floatScrim);
        this._floatMenu = new St.BoxLayout({
            style_class: 'ytmusic-float-menu',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._floatLayer.add_child(this._floatMenu);
        stack.add_child(this._floatLayer);
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
        this._settingsButton = this._iconButton('emblem-system-symbolic', 'Configurações',
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

        this._backButton = this._iconButton('go-previous-symbolic', 'Voltar',
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
        this._sortButton = this._iconButton('view-sort-descending-symbolic', '',
            () => this._toggleOldestFirst());
        this._sortButton.visible = false;
        titleRow.add_child(this._sortButton);

        this._refreshButton = this._iconButton('view-refresh-symbolic', 'Atualizar',
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

        // "Add to playlist" picker. It sits on top of the current view (which
        // is only hidden) so going back keeps that view's rows and scroll.
        this._pickerScroll = new St.ScrollView({
            style_class: 'ytmusic-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            visible: false,
        });
        this._pickerList = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._pickerScroll.set_child(this._pickerList);
        box.add_child(this._pickerScroll);
        this._buildNowPlaying(box);
        this._pickerTrack = null;
        this._savedHeader = null;

        // Short confirmations ("Link copiado"), shown over the bottom of the list.
        this._toast = new St.Label({
            style_class: 'ytmusic-toast',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._toast);

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
        for (const scroll of [this._scroll, this._pickerScroll])
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
        this._toast.text = text;
        this._toast.visible = true;
        if (this._toastTimeoutId)
            GLib.source_remove(this._toastTimeoutId);
        this._toastTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_MS, () => {
            this._toastTimeoutId = 0;
            this._toast.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _goBack() {
        if (this._pickerTrack) {
            this._closePicker();
            return;
        }
        if (this._view === 'search')
            this._searchEntry.set_text(''); // _onSearchChanged leaves the search view
        else
            this._showPlaylists();
    }

    _clearList() {
        this._closeFloat();
        this._list.destroy_all_children();
        this._list.style = null;
        this._moreButton = null;
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
            this._loadTracks(true);
        else
            this._loadPlaylists(true);
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
            tracks: this._tracks.length > 0,
            search: this._results.length > 0,
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

    // -- playlists view --------------------------------------------------------

    _showPlaylists() {
        this._view = 'playlists';
        this._playlist = null;
        this._tracks = [];
        this._trackFilter = '';
        this._setSearchText('');
        this._setSearchMode(false);
        this._sortButton.visible = false;
        this._setHeader('Playlists');
        if (this._playlists)
            this._renderPlaylists();
        this._loadPlaylists(false);
    }

    _loadPlaylists(force) {
        if (!this._playlists)
            this._showMessage('Carregando playlists…');
        return this._load(
            () => this._client.call(force ? 'RefreshPlaylists' : 'GetPlaylists'),
            data => {
                this._playlists = this._sortPlaylists(data);
                this._renderPlaylists();
            });
    }

    _renderPlaylists() {
        this._clearList();
        if (this._playlists.length === 0) {
            this._showMessage('Nenhuma playlist encontrada.');
            return;
        }
        for (const playlist of this._playlists)
            this._list.add_child(this._createPlaylistRow(playlist));
        this._flushCovers();
    }

    _createPlaylistRow(playlist, onClick = () => this._showTracks(playlist)) {
        const row = new St.BoxLayout({x_expand: true, style_class: 'ytmusic-row-content'});
        const cover = this._cover(playlist.thumbnail);
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
                gicon: this._icon('heart-symbolic'),
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

    // -- tracks view -----------------------------------------------------------

    _showTracks(playlist) {
        this._view = 'tracks';
        this._playlist = playlist;
        this._tracks = [];
        this._trackFilter = '';
        this._setSearchText('');
        this._setSearchMode(true);
        this._oldestFirst = false;
        this._tracksComplete = false;
        this._updateSortButton();
        this._sortButton.visible = true;
        this._setHeader(playlist.title, null, true);
        this._showLoading('Carregando músicas…');
        this._loadTracks(false);
    }

    _loadTracks(force) {
        const playlist = this._playlist;
        const method = force ? 'RefreshPlaylistTracks' : 'GetPlaylistTracks';
        return this._load(
            () => this._client.call(method, playlist.id),
            (data, serial) => {
                this._tracks = data.tracks;
                this._tracksComplete = data.complete;
                this._updateSortButton();
                this._updateTracksSubtitle(data);
                this._renderTracks();
                if (!data.complete)
                    this._loadRemainingTracks(playlist, serial);
            });
    }

    // The daemon served the first page; a second call waits for the full list.
    async _loadRemainingTracks(playlist, serial) {
        try {
            const data = await this._client.call('GetPlaylistTracks', playlist.id);
            if (serial !== this._serial)
                return;
            this._tracks = data.tracks;
            this._tracksComplete = data.complete;
            this._updateSortButton();
            this._updateTracksSubtitle(data);
            if (this._trackFilter)
                this._renderTracks(); // more matches may have arrived
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
        const count = data.complete ? data.tracks.length : data.count;
        this._subtitle.text = count !== null && count !== undefined ? trackCountText(count) : '';
        this._subtitle.visible = !!this._subtitle.text;
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

    _renderTracks() {
        this._clearList();
        this._renderedTracks = 0;
        this._updateShownTracks();
        if (this._tracks.length === 0) {
            this._showMessage('Esta playlist está vazia.');
            return;
        }
        if (this._shownTracks.length === 0) {
            this._showMessage('Nenhuma música encontrada nesta playlist.', 'Tente outras palavras.');
            return;
        }
        this._renderMoreTracks();
    }

    _renderMoreTracks() {
        this._moreButton?.destroy();
        this._moreButton = null;

        const end = Math.min(this._renderedTracks + TRACKS_PAGE_SIZE, this._shownTracks.length);
        for (let n = this._renderedTracks; n < end; n++) {
            const i = this._shownTracks[n];
            this._list.add_child(this._createTrackRow(this._tracks[i], () => this._playFrom(i), true));
        }
        this._renderedTracks = end;
        this._flushCovers();
        this._updateMoreButton();
    }

    // Re-render after a change to _tracks without jumping back to the top.
    _toggleOldestFirst() {
        if (!this._tracksComplete)
            return;
        this._oldestFirst = !this._oldestFirst;
        this._updateSortButton();
        this._renderTracks();
    }

    // Reversing only makes sense with the whole list, so it waits for it.
    _updateSortButton() {
        const button = this._sortButton;
        button.child.icon_name = this._oldestFirst
            ? 'view-sort-ascending-symbolic' : 'view-sort-descending-symbolic';
        button.accessible_name = this._oldestFirst
            ? 'Mostrando as mais antigas primeiro' : 'Mostrando as mais recentes primeiro';
        this._setToggled(button, this._oldestFirst);
        button.reactive = this._tracksComplete;
        button.can_focus = this._tracksComplete;
    }

    _rerenderTracksKeepingScroll() {
        const scroll = this._scroll.vadjustment.value;
        const rendered = this._renderedTracks;
        this._renderTracks();
        while (this._renderedTracks < Math.min(rendered, this._shownTracks.length) &&
               this._renderedTracks > 0)
            this._renderMoreTracks();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scroll.vadjustment.value = scroll;
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
        this._list.add_child(this._moreButton);
    }

    _createTrackRow(track, onPlay, inPlaylist = false) {
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
        if (track.videoId && track.videoId === this._playback?.track?.videoId)
            row.add_style_class_name('ytmusic-row-playing');

        const playButton = this._iconButton('media-playback-start-symbolic', 'Tocar', onPlay);
        playButton.add_style_class_name('ytmusic-row-play');
        playButton.reactive = track.available;
        playButton.can_focus = track.available;
        row.add_child(playButton);
        const cover = this._cover(track.thumbnail);
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
            ? this._iconButton('view-more-symbolic', 'Mais opções',
                button => this._openActions(track, button))
            : this._iconButton('list-add-symbolic', 'Adicionar a uma playlist',
                () => this._openPicker(track));
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
            this._client?.call('Prepare', track.videoId).catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    // -- track actions (the ⋮ menu inside a playlist) ----------------------------

    _openActions(track, anchor) {
        if (!track.videoId)
            return;
        this._closeFloat();
        this._floatTrack = track;
        const menu = this._floatMenu;

        const title = ellipsized(new St.Label({text: track.title, style_class: 'ytmusic-float-title'}));
        menu.add_child(title);

        const playlist = this._playlist;
        const actions = [
            ['list-add-symbolic', 'Adicionar à fila', () => this._enqueue(track, 'Enqueue')],
            ['media-skip-forward-symbolic', 'Tocar a seguir', () => this._enqueue(track, 'PlayNext')],
            ['folder-new-symbolic', 'Adicionar a outra playlist', () => {
                this._closeFloat();
                this._openPicker(track);
            }],
            ['edit-copy-symbolic', 'Compartilhar (copiar link)', () => this._share(track)],
        ];
        for (const [icon, label, callback] of actions)
            menu.add_child(this._actionRow(icon, label, callback));

        if (playlist && (playlist.owned || playlist.id === LIKED_PLAYLIST_ID)) {
            const label = playlist.id === LIKED_PLAYLIST_ID
                ? 'Remover de Músicas que gostei' : 'Remover da playlist';
            const row = this._actionRow('user-trash-symbolic', label, () => {
                // First click asks for confirmation.
                if (!row._confirming) {
                    row._confirming = true;
                    row._label.text = 'Clique de novo para remover';
                    row.add_style_class_name('ytmusic-row-destructive');
                    return;
                }
                this._remove(track, playlist);
            });
            menu.add_child(row);
        }

        // Place it under the ⋮ button, right-aligned to it; above when there's no room.
        const layer = this._floatLayer;
        this._floatScrim.set_size(layer.width, layer.height);
        this._floatScrim.visible = true;
        menu.visible = true;
        const [, menuWidth] = menu.get_preferred_width(-1);
        const [, menuHeight] = menu.get_preferred_height(menuWidth);
        const [layerX, layerY] = layer.get_transformed_position();
        const [anchorX, anchorY] = anchor.get_transformed_position();
        const [anchorW, anchorH] = anchor.get_transformed_size();
        let x = anchorX - layerX + anchorW - menuWidth;
        let y = anchorY - layerY + anchorH;
        if (y + menuHeight > layer.height)
            y = anchorY - layerY - menuHeight;
        x = Math.max(4, Math.min(x, layer.width - menuWidth - 4));
        y = Math.max(4, Math.min(y, layer.height - menuHeight - 4));
        menu.set_position(Math.round(x), Math.round(y));
        menu.get_first_child()?.get_next_sibling()?.grab_key_focus();
    }

    _closeFloat() {
        if (!this._floatTrack)
            return;
        this._floatTrack = null;
        this._floatMenu.destroy_all_children();
        this._floatMenu.visible = false;
        this._floatScrim.visible = false;
    }

    _actionRow(iconName, text, callback) {
        const box = new St.BoxLayout({style_class: 'ytmusic-row-content', x_expand: true});
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        box.add_child(label);
        const button = new St.Button({
            style_class: 'ytmusic-float-item',
            child: box,
            can_focus: true,
            x_expand: true,
            accessible_name: text,
        });
        button._label = label;
        button.connect('clicked', callback);
        return button;
    }

    async _enqueue(track, method) {
        this._closeFloat();
        try {
            await this._client.call(method, track.videoId);
            this._showToast(method === 'PlayNext' ? 'Vai tocar a seguir' : 'Adicionada à fila');
        } catch (e) {
            if (e.code !== 'cancelled')
                this._showToast((ERROR_TEXT[e.code] ?? [e.message])[0]);
        }
    }

    _share(track) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, SHARE_URL + track.videoId);
        this._closeFloat();
        this._showToast('Link copiado');
    }

    async _remove(track, playlist) {
        this._closeFloat();
        try {
            await this._client.call('RemoveFromPlaylist', playlist.id, track.videoId);
        } catch (e) {
            if (e.code !== 'cancelled')
                this._showToast(e.code === 'bad_request' ? e.message : (ERROR_TEXT[e.code] ?? [e.message])[0]);
            return;
        }
        this._playlists = null; // counts changed; reload on next visit
        if (this._view === 'tracks' && this._playlist === playlist) {
            this._tracks = this._tracks.filter(t => t.videoId !== track.videoId);
            this._updateTracksSubtitle({complete: true, tracks: this._tracks});
            this._rerenderTracksKeepingScroll();
        }
        this._showToast('Removida da playlist');
    }

    // Covers the current view with the picker/actions list.
    _enterOverlay(track, title, subtitle, actor = this._pickerScroll) {
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
        if (actor === this._pickerScroll)
            this._pickerScroll.vadjustment.value = 0;
    }

    // -- add to playlist --------------------------------------------------------

    async _openPicker(track) {
        if (!track.videoId)
            return;
        this._enterOverlay(track, 'Adicionar a playlist', track.title);

        if (!this._playlists) {
            this._setPickerMessage('Carregando playlists…');
            try {
                this._playlists = this._sortPlaylists(await this._client.call('GetPlaylists'));
            } catch (e) {
                if (e.code !== 'cancelled' && this._pickerTrack === track)
                    this._setPickerMessage(...(ERROR_TEXT[e.code] ?? ERROR_TEXT.internal));
                return;
            }
            if (this._pickerTrack !== track)
                return;
        }
        this._renderPicker(track);
    }

    _closePicker() {
        if (!this._pickerTrack)
            return;
        this._pickerTrack = null;
        this._pickerList.destroy_all_children();
        this._pickerScroll.visible = false;
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

    _setPickerMessage(title, hint = null) {
        this._pickerList.destroy_all_children();
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
        this._pickerList.add_child(box);
    }

    _renderPicker(track) {
        this._pickerList.destroy_all_children();
        // Only playlists the user can edit; skip the one being browsed.
        const current = this._view === 'tracks' ? this._playlist?.id : null;
        const targets = this._playlists.filter(p =>
            (p.owned || p.id === LIKED_PLAYLIST_ID) && p.id !== current);
        if (targets.length === 0) {
            this._setPickerMessage('Nenhuma playlist sua disponível.');
            return;
        }
        for (const playlist of targets) {
            const row = this._createPlaylistRow(playlist, () => this._addToPlaylist(track, playlist));
            this._pickerList.add_child(row);
        }
        this._flushCovers();
    }

    async _addToPlaylist(track, playlist) {
        // Block double clicks while the request runs.
        for (const row of this._pickerList.get_children())
            row.reactive = false;
        try {
            await this._client.call('AddToPlaylist', playlist.id, track.videoId);
            const where = playlist.id === LIKED_PLAYLIST_ID ? 'Músicas que gostei' : playlist.title;
            Main.notify('YouTube Music', `"${track.title}" adicionada a ${where}.`);
            if (this._pickerTrack === track) {
                this._playlists = null; // counts changed; reload on next visit
                this._closePicker();
            }
        } catch (e) {
            if (e.code === 'cancelled')
                return;
            const message = e.code === 'duplicate' || e.code === 'bad_request'
                ? e.message
                : (ERROR_TEXT[e.code] ?? ERROR_TEXT.internal)[0];
            Main.notify('YouTube Music', message);
            if (this._pickerTrack === track) {
                for (const row of this._pickerList.get_children())
                    row.reactive = true;
            }
        }
    }

    // -- search ----------------------------------------------------------------

    _onSearchChanged() {
        if (this._settingSearchText)
            return;
        this._closePicker();
        const text = this._searchEntry.get_text();
        this._searchEntry.secondary_icon = text ? this._clearSearchIcon : null;

        if (this._view === 'tracks') {
            this._scheduleFilter(text);
            return;
        }

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

    _scheduleFilter(text) {
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);
        this._filterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILTER_DEBOUNCE_MS, () => {
            this._filterTimeoutId = 0;
            if (this._view === 'tracks' && this._tracks.length > 0) {
                this._trackFilter = text;
                this._renderTracks();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _runSearchNow() {
        if (this._view === 'tracks')
            return; // the filter already follows each keystroke
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        const query = this._searchEntry.get_text().trim();
        if (query)
            this._search(query);
    }

    _search(query) {
        if (this._view !== 'search') {
            // Remember where to go back to.
            this._viewBeforeSearch = this._view;
            this._view = 'search';
        }
        this._query = query;
        this._results = [];
        this._setHeader('Resultados', `"${query}"`, true);
        this._showLoading('Buscando…');
        return this._load(
            () => this._client.call('Search', query),
            data => {
                this._results = data;
                this._renderResults();
            });
    }

    _leaveSearch() {
        if (this._view !== 'search')
            return;
        this._serial++; // drop any in-flight search reply
        this._query = '';
        this._results = [];
        if (this._viewBeforeSearch === 'tracks' && this._playlist) {
            this._showTracks(this._playlist);
        } else {
            this._view = 'playlists';
            this._showPlaylists();
        }
    }

    _renderResults() {
        this._clearList();
        if (this._results.length === 0) {
            this._showMessage('Nenhuma música encontrada.', 'Tente outras palavras.');
            return;
        }
        for (const track of this._results)
            this._list.add_child(this._createTrackRow(track, () => this._play('PlayTrack', track.videoId)));
        this._flushCovers();
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
            this._renderPicker(this._pickerTrack);
        else if (this._view === 'playlists' && this._playlists)
            this._renderPlaylists();
        else if (this._view === 'tracks' && this._tracks.length)
            this._renderTracks();
        else if (this._view === 'search' && this._results.length)
            this._renderResults();
    }

    // Square cover with a placeholder; the image is filled in by _flushCovers().
    _cover(url, styleClass = 'ytmusic-cover') {
        if (!this._settings.get_boolean('show-covers'))
            return null;
        const bin = new St.Bin({
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ytmusic-cover-placeholder'}),
        });
        if (url) {
            this._pendingCovers.push([url, bin]);
            bin.connect('destroy', () => {
                bin._destroyed = true;
            });
        }
        return bin;
    }

    // Asks the daemon for local copies of the covers queued since the last call.
    async _flushCovers() {
        const pending = this._pendingCovers;
        this._pendingCovers = [];
        if (pending.length === 0)
            return;
        const urls = [...new Set(pending.map(([url]) => url))];
        for (let i = 0; i < urls.length; i += 200) {
            let paths;
            try {
                paths = await this._client.call('GetCovers', JSON.stringify(urls.slice(i, i + 200)));
            } catch (e) {
                if (!e.code)
                    console.error(e, '[ytmusic-panel] cover loading failed');
                else if (e.code !== 'cancelled')
                    console.warn(`[ytmusic-panel] covers unavailable: ${e.code}`);
                return;
            }
            if (!this._client)
                return;
            for (const [url, bin] of pending) {
                const path = paths[url];
                if (path && !bin._destroyed)
                    this._setCoverImage(bin, path);
            }
        }
    }

    _setCoverImage(bin, path) {
        bin.child = null;
        const uri = GLib.filename_to_uri(path, null);
        bin.style = `${bin._baseStyle ?? ''} background-image: url("${uri}");`;
    }

    _updatePlayerCover(url, active) {
        if (url === this._playerCoverUrl)
            return;
        this._playerCoverUrl = url;
        this._playerCoverSlot.child?.destroy();
        this._playerCoverSlot.child = active ? this._cover(url, 'ytmusic-cover ytmusic-player-cover') : null;
        this._flushCovers();
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
        this._repeatButton = this._iconButton('media-playlist-repeat-symbolic', 'Repetir',
            () => this._control('CycleRepeat'));
        this._shuffleButton = this._iconButton('media-playlist-shuffle-symbolic', 'Aleatório',
            () => this._control('ToggleShuffle'));
        this._prevButton = this._iconButton('media-skip-backward-symbolic', 'Anterior',
            () => this._control('Previous'));
        this._playPauseButton = this._iconButton('media-playback-start-symbolic', 'Tocar',
            () => this._control('TogglePause'));
        this._playPauseButton.add_style_class_name('ytmusic-play-pause');
        this._nextButton = this._iconButton('media-skip-forward-symbolic', 'Próxima',
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
            if (e.code !== 'cancelled')
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
            this._setToggled(set.repeat, repeat !== 'off');
            set.shuffle.accessible_name = state?.shuffle ? 'Aleatório: ligado' : 'Aleatório: desligado';
            this._setToggled(set.shuffle, !!state?.shuffle);
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
            shuffle: this._iconButton('media-playlist-shuffle-symbolic', 'Aleatório',
                () => this._control('ToggleShuffle')),
            prev: this._iconButton('media-skip-backward-symbolic', 'Anterior',
                () => this._control('Previous')),
            playPause: this._iconButton('media-playback-start-symbolic', 'Tocar',
                () => this._control('TogglePause')),
            next: this._iconButton('media-skip-forward-symbolic', 'Próxima',
                () => this._control('Next')),
            repeat: this._iconButton('media-playlist-repeat-symbolic', 'Repetir',
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
        this._closeFloat();
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
            const cover = this._cover(url, 'ytmusic-cover ytmusic-np-cover') ??
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
            this._flushCovers();
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
            this._setPositionBase(data.position, data.duration);
        } catch (e) {
            this._syncPosition();
        }
    }

    _setToggled(button, on) {
        if (on)
            button.add_style_class_name('ytmusic-toggle-on');
        else
            button.remove_style_class_name('ytmusic-toggle-on');
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

    _playFrom(index) {
        if (!this._playlist)
            return;
        this._play('PlayPlaylist', this._playlist.id, index, this._oldestFirst);
    }

    async _play(method, ...args) {
        try {
            await this._client.call(method, ...args);
        } catch (e) {
            if (e.code === 'cancelled')
                return;
            const [title, hint] = ERROR_TEXT[e.code] ?? [e.message, null];
            Main.notify('YouTube Music', hint ? `${title} ${hint}` : title);
        }
    }

    destroy() {
        this._serial++;
        this._playerTitle.remove_transition('translation-x');
        for (const id of ['_searchTimeoutId', '_filterTimeoutId', '_prepareTimeoutId', '_toastTimeoutId',
            '_progressTimeoutId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
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

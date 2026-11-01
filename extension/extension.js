import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {YTMusicClient} from './ytmusicClient.js';

const LIKED_PLAYLIST_ID = 'LM';
const HIDDEN_PLAYLIST_IDS = new Set(['SE']); // "Episódios para mais tarde"

// Rows are created in pages so huge playlists don't stall the shell.
const TRACKS_PAGE_SIZE = 100;

const numberFormat = new Intl.NumberFormat('pt-BR');

const ERROR_TEXT = {
    auth_required: [
        'Você não está conectado ao YouTube Music.',
        'No terminal, rode: ytmusic-daemon-login',
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

function sortPlaylists(playlists) {
    const visible = playlists.filter(p => !HIDDEN_PLAYLIST_IDS.has(p.id));
    const liked = visible.filter(p => p.id === LIKED_PLAYLIST_ID);
    return [...liked, ...visible.filter(p => p.id !== LIKED_PLAYLIST_ID)];
}

function trackCountText(count) {
    if (count === 1)
        return '1 música';
    return `${numberFormat.format(count)} músicas`;
}

function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

const YTMusicIndicator = GObject.registerClass(
class YTMusicIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'YouTube Music');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new YTMusicClient();
        this._client.onAuthRequired = () => this._onAuthRequired();

        this._view = 'playlists';
        this._playlists = null;
        this._playlist = null; // playlist shown in the tracks view
        this._tracks = [];
        this._renderedTracks = 0;
        this._moreButton = null;
        // Bumped on every navigation/load; stale async replies are dropped.
        this._serial = 0;

        this.add_child(new St.Icon({
            gicon: this._icon('ytmusic-symbolic'),
            style_class: 'system-status-icon',
        }));

        this.menu.box.add_style_class_name('ytmusic-popup');
        this._buildContent();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._view === 'playlists')
                this._loadPlaylists(false);
        });

        this._settingsChangedId = this._settings.connect(
            'changed::popup-max-height', () => this._applyMaxHeight());
        this._applyMaxHeight();
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
        section.actor.add_child(box);

        // Header: [back] title/subtitle [refresh]
        const header = new St.BoxLayout({style_class: 'ytmusic-header'});

        this._backButton = this._iconButton('go-previous-symbolic', 'Voltar',
            () => this._showPlaylists());
        this._backButton.visible = false;
        header.add_child(this._backButton);

        const titles = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = ellipsized(new St.Label({text: 'Playlists', style_class: 'ytmusic-title'}));
        this._subtitle = new St.Label({style_class: 'ytmusic-subtitle', visible: false});
        titles.add_child(this._title);
        titles.add_child(this._subtitle);
        header.add_child(titles);

        this._refreshButton = this._iconButton('view-refresh-symbolic', 'Atualizar',
            () => this._refresh());
        header.add_child(this._refreshButton);
        box.add_child(header);

        // Tracks view toolbar.
        this._toolbar = new St.BoxLayout({style_class: 'ytmusic-toolbar', visible: false});
        const playAllBox = new St.BoxLayout({style_class: 'ytmusic-pill-content'});
        playAllBox.add_child(new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: 14}));
        playAllBox.add_child(new St.Label({text: 'Tocar tudo', y_align: Clutter.ActorAlign.CENTER}));
        this._playAllButton = new St.Button({
            style_class: 'ytmusic-pill-button',
            child: playAllBox,
            can_focus: true,
            accessible_name: 'Tocar tudo',
        });
        this._playAllButton.connect('clicked', () => this._playFrom(0));
        this._toolbar.add_child(this._playAllButton);
        box.add_child(this._toolbar);

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
    }

    _applyMaxHeight() {
        const h = this._settings.get_int('popup-max-height');
        this._scroll.style = `max-height: ${h}px;`;
    }

    _setHeader(title, subtitle = null, canGoBack = false) {
        this._title.text = title;
        this._subtitle.text = subtitle ?? '';
        this._subtitle.visible = !!subtitle;
        this._backButton.visible = canGoBack;
        this._toolbar.visible = canGoBack;
    }

    _clearList() {
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
        if (this._view === 'tracks')
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
        const hasData = this._view === 'playlists' ? !!this._playlists : this._tracks.length > 0;
        // Network hiccup with data on screen: keep showing what we have.
        if (e.code === 'network' && hasData)
            return;
        if (e.code === 'auth_required')
            this._playlists = null;
        if (!ERROR_TEXT[e.code])
            console.warn(`[ytmusic-panel] ${e.code ?? ''} ${e.message}`);
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
                this._playlists = sortPlaylists(data);
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
    }

    _createPlaylistRow(playlist) {
        const row = new St.BoxLayout({x_expand: true});

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
        button.connect('clicked', () => this._showTracks(playlist));
        return button;
    }

    // -- tracks view -----------------------------------------------------------

    _showTracks(playlist) {
        this._view = 'tracks';
        this._playlist = playlist;
        this._tracks = [];
        this._setHeader(playlist.title, null, true);
        this._updatePlayAll();
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
                this._updateTracksSubtitle(data);
                this._updatePlayAll();
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
            this._updateTracksSubtitle(data);
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

    _renderTracks() {
        this._clearList();
        this._renderedTracks = 0;
        if (this._tracks.length === 0) {
            this._showMessage('Esta playlist está vazia.');
            return;
        }
        this._renderMoreTracks();
    }

    _renderMoreTracks() {
        this._moreButton?.destroy();
        this._moreButton = null;

        const end = Math.min(this._renderedTracks + TRACKS_PAGE_SIZE, this._tracks.length);
        for (let i = this._renderedTracks; i < end; i++)
            this._list.add_child(this._createTrackRow(this._tracks[i], i));
        this._renderedTracks = end;
        this._updateMoreButton();
    }

    _updateMoreButton() {
        const remaining = this._tracks.length - this._renderedTracks;
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

    _createTrackRow(track, index) {
        const row = new St.BoxLayout({
            style_class: 'ytmusic-row ytmusic-track-row',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        if (!track.available)
            row.add_style_class_name('ytmusic-row-unavailable');

        const playButton = this._iconButton('media-playback-start-symbolic', 'Tocar',
            () => this._playFrom(index));
        playButton.add_style_class_name('ytmusic-row-play');
        playButton.reactive = track.available;
        playButton.can_focus = track.available;
        row.add_child(playButton);

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
        return row;
    }

    // -- playback --------------------------------------------------------------

    _updatePlayAll() {
        const playable = this._tracks.some(t => t.available);
        this._playAllButton.reactive = playable;
        this._playAllButton.can_focus = playable;
    }

    _playFrom(index) {
        if (!this._playlist)
            return;
        this._play('PlayPlaylist', this._playlist.id, index);
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
        this._client?.destroy();
        this._client = null;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;
        super.destroy();
    }
});

export default class YTMusicPanelExtension extends Extension {
    enable() {
        this._indicator = new YTMusicIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

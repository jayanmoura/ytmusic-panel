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

const YTMusicIndicator = GObject.registerClass(
class YTMusicIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'YouTube Music');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new YTMusicClient();
        this._client.onAuthRequired = () => this._onAuthRequired();
        this._playlists = null;
        this._loadSerial = 0;

        this.add_child(new St.Icon({
            gicon: this._icon('ytmusic-symbolic'),
            style_class: 'system-status-icon',
        }));

        this.menu.box.add_style_class_name('ytmusic-popup');
        this._buildContent();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._loadPlaylists(false);
        });

        this._settingsChangedId = this._settings.connect(
            'changed::popup-max-height', () => this._applyMaxHeight());
        this._applyMaxHeight();
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
        section.actor.add_child(box);

        // Header: view title + refresh.
        const header = new St.BoxLayout({style_class: 'ytmusic-header'});
        this._title = new St.Label({
            text: 'Playlists',
            style_class: 'ytmusic-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._title);

        this._refreshButton = new St.Button({
            style_class: 'ytmusic-icon-button',
            can_focus: true,
            accessible_name: 'Atualizar',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}),
        });
        this._refreshButton.connect('clicked', () => this._loadPlaylists(true));
        header.add_child(this._refreshButton);
        box.add_child(header);

        // Scrollable body.
        this._scroll = new St.ScrollView({
            style_class: 'ytmusic-scroll vfade',
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

    // -- data ------------------------------------------------------------------

    async _loadPlaylists(force) {
        const serial = ++this._loadSerial;

        if (!this._playlists)
            this._showMessage('Carregando playlists…');
        this._refreshButton.reactive = false;

        try {
            const data = await this._client.call(force ? 'RefreshPlaylists' : 'GetPlaylists');
            if (serial !== this._loadSerial)
                return;
            this._playlists = sortPlaylists(data);
            this._renderPlaylists();
        } catch (e) {
            if (e.code === 'cancelled' || serial !== this._loadSerial)
                return;
            // Network hiccup with data on screen: keep showing what we have.
            if (e.code === 'network' && this._playlists)
                return;
            if (e.code === 'auth_required')
                this._playlists = null;
            const [title, hint] = ERROR_TEXT[e.code] ?? ERROR_TEXT.internal;
            this._showMessage(title, hint);
            if (!ERROR_TEXT[e.code])
                console.warn(`[ytmusic-panel] ${e.code ?? ''} ${e.message}`);
        } finally {
            if (serial === this._loadSerial && this._refreshButton)
                this._refreshButton.reactive = true;
        }
    }

    _onAuthRequired() {
        this._playlists = null;
        if (this.menu.isOpen)
            this._showMessage(...ERROR_TEXT.auth_required);
    }

    // -- rendering -------------------------------------------------------------

    _showMessage(title, hint = null) {
        this._list.destroy_all_children();
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

    _renderPlaylists() {
        this._list.destroy_all_children();
        if (this._playlists.length === 0) {
            this._showMessage('Nenhuma playlist encontrada.');
            return;
        }
        for (const playlist of this._playlists)
            this._list.add_child(this._createPlaylistRow(playlist));
    }

    _createPlaylistRow(playlist) {
        const row = new St.BoxLayout({x_expand: true});

        const title = new St.Label({
            text: playlist.title,
            style_class: 'ytmusic-row-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);

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

        return new St.Button({
            style_class: 'ytmusic-row',
            child: row,
            can_focus: true,
            x_expand: true,
            accessible_name: playlist.title,
        });
    }

    destroy() {
        this._loadSerial++;
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

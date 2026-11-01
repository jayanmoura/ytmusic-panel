import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {YTMusicClient} from './ytmusicClient.js';

const THEMES = [
    ['auto', 'Automático'],
    ['light', 'Claro'],
    ['dark', 'Escuro'],
];

export default class YTMusicPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const client = new YTMusicClient();
        window._settings = settings;
        window.connect('close-request', () => {
            client.destroy();
            return false;
        });

        const page = new Adw.PreferencesPage({
            title: 'Geral',
            icon_name: 'preferences-system-symbolic',
        });

        page.add(this._buildProfile(client));

        const sections = new Adw.PreferencesGroup();
        page.add(sections);
        sections.add(this._navRow(window, 'Aparência', 'Tema, altura do popup e capas',
            'applications-graphics-symbolic', () => this._appearancePage(settings)));
        sections.add(this._navRow(window, 'Biblioteca', 'Playlists mostradas no popup',
            'folder-music-symbolic', () => this._libraryPage(settings)));
        sections.add(this._navRow(window, 'Conta e serviço', 'Login e logs',
            'system-users-symbolic', () => this._servicePage()));

        window.add(page);
    }

    // -- profile header ----------------------------------------------------------

    _buildProfile(client) {
        const group = new Adw.PreferencesGroup();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 12,
        });
        const avatar = new Adw.Avatar({size: 96, show_initials: true});
        const name = new Gtk.Label({label: 'Carregando conta…', css_classes: ['title-2']});
        const handle = new Gtk.Label({css_classes: ['dim-label'], visible: false});
        box.append(avatar);
        box.append(name);
        box.append(handle);
        group.add(box);

        // The service fetches the account and caches the photo; this window
        // only reads a local file.
        client.call('GetAccount').then(account => {
            name.label = account.name ?? 'Conta do YouTube Music';
            avatar.text = account.name ?? '';
            if (account.handle) {
                handle.label = account.handle;
                handle.visible = true;
            }
            if (account.photo_path) {
                try {
                    avatar.custom_image = Gdk.Texture.new_from_filename(account.photo_path);
                } catch (e) {
                    console.warn(`ytmusic-panel: avatar not loaded: ${e.message}`);
                }
            }
        }).catch(e => {
            if (e.code === 'cancelled')
                return;
            name.label = e.code === 'auth_required' ? 'Você não está conectado' : 'Conta indisponível';
            handle.label = e.code === 'auth_required'
                ? 'Veja "Conta e serviço" para fazer login.'
                : 'O serviço ytmusic-daemon não respondeu.';
            handle.visible = true;
        });
        return group;
    }

    // -- navigation ----------------------------------------------------------------

    _navRow(window, title, subtitle, iconName, buildPage) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_prefix(new Gtk.Image({icon_name: iconName}));
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', () => {
            const content = buildPage();
            const toolbar = new Adw.ToolbarView({content});
            toolbar.add_top_bar(new Adw.HeaderBar());
            window.push_subpage(new Adw.NavigationPage({title, child: toolbar}));
        });
        return row;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const themeRow = new Adw.ComboRow({
            title: 'Tema do popup',
            subtitle: 'Automático segue o tema do sistema.',
            model: Gtk.StringList.new(THEMES.map(([, label]) => label)),
        });
        const syncTheme = () => {
            const index = THEMES.findIndex(([value]) => value === settings.get_string('popup-theme'));
            themeRow.selected = Math.max(0, index);
        };
        syncTheme();
        themeRow.connect('notify::selected', () => {
            settings.set_string('popup-theme', THEMES[themeRow.selected][0]);
        });
        const themeId = settings.connect('changed::popup-theme', syncTheme);
        themeRow.connect('destroy', () => settings.disconnect(themeId));
        group.add(themeRow);

        const heightRow = Adw.SpinRow.new_with_range(300, 1200, 20);
        heightRow.title = 'Altura do popup';
        heightRow.subtitle = 'Em pixels, só a parte da lista. Se não couber na tela, diminui sozinha.';
        settings.bind('popup-height', heightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(heightRow);

        const coversRow = new Adw.SwitchRow({
            title: 'Mostrar capas',
            subtitle: 'Capas das playlists e músicas, baixadas e guardadas pelo serviço.',
        });
        settings.bind('show-covers', coversRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(coversRow);
        return page;
    }

    _libraryPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const episodesRow = new Adw.SwitchRow({
            title: 'Mostrar "Episódios para mais tarde"',
            subtitle: 'Lista de podcasts salvos no YouTube Music.',
        });
        settings.bind('show-episodes-playlist', episodesRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(episodesRow);
        return page;
    }

    _servicePage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            description: 'Login, logs e reinstalação ficam no terminal. Veja o README do projeto.',
        });
        page.add(group);
        group.add(new Adw.ActionRow({
            title: 'Fazer login de novo',
            subtitle: '~/.local/share/ytmusic-daemon/venv/bin/ytmusic-daemon-login',
            subtitle_selectable: true,
        }));
        group.add(new Adw.ActionRow({
            title: 'Ver logs do serviço',
            subtitle: 'journalctl --user -u ytmusic-daemon',
            subtitle_selectable: true,
        }));
        return page;
    }
}

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

        page.add(this._buildProfile());
        this._loadProfile(client);

        const sections = new Adw.PreferencesGroup();
        page.add(sections);
        sections.add(this._navRow(window, 'Aparência', 'Tema, altura do popup e capas',
            'applications-graphics-symbolic', () => this._appearancePage(settings)));
        sections.add(this._navRow(window, 'Biblioteca', 'Playlists mostradas no popup',
            'folder-music-symbolic', () => this._libraryPage(settings)));
        sections.add(this._navRow(window, 'Conta e serviço', 'Login e logs',
            'system-users-symbolic', () => this._servicePage(window, client)));

        window.add(page);
    }

    // -- profile header ----------------------------------------------------------

    _buildProfile() {
        const group = new Adw.PreferencesGroup();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 12,
        });
        this._avatar = new Adw.Avatar({size: 96, show_initials: true});
        this._name = new Gtk.Label({css_classes: ['title-2']});
        this._handle = new Gtk.Label({css_classes: ['dim-label'], visible: false});
        box.append(this._avatar);
        box.append(this._name);
        box.append(this._handle);
        group.add(box);
        return group;
    }

    // The service fetches the account and caches the photo; this window
    // only reads a local file.
    async _loadProfile(client) {
        this._name.label = 'Carregando conta…';
        this._handle.visible = false;
        try {
            const account = await client.call('GetAccount');
            this._name.label = account.name ?? 'Conta do YouTube Music';
            this._avatar.text = account.name ?? '';
            this._handle.label = account.handle ?? '';
            this._handle.visible = !!account.handle;
            this._avatar.custom_image = null;
            if (account.photo_path) {
                try {
                    this._avatar.custom_image = Gdk.Texture.new_from_filename(account.photo_path);
                } catch (e) {
                    console.warn(`ytmusic-panel: avatar not loaded: ${e.message}`);
                }
            }
        } catch (e) {
            if (e.code === 'cancelled')
                return;
            this._avatar.text = '';
            this._avatar.custom_image = null;
            this._name.label = e.code === 'auth_required' ? 'Você não está conectado' : 'Conta indisponível';
            this._handle.label = e.code === 'auth_required'
                ? 'Entre em "Conta e serviço".'
                : 'O serviço ytmusic-daemon não respondeu.';
            this._handle.visible = true;
        }
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

    _servicePage(window, client) {
        const page = new Adw.PreferencesPage();

        const login = new Adw.PreferencesGroup({
            title: 'Entrar',
            description: 'Usa a sessão do YouTube que já está aberta no seu navegador. ' +
                'Antes, abra music.youtube.com nele e confira se está conectado.',
        });
        page.add(login);

        const browserRow = new Adw.ComboRow({title: 'Navegador', sensitive: false});
        login.add(browserRow);
        let browsers = [];
        client.call('ListBrowsers').then(data => {
            browsers = data.browsers;
            browserRow.model = Gtk.StringList.new(browsers.map(b => b.label));
            browserRow.selected = Math.max(0, browsers.findIndex(b => b.id === data.current));
            browserRow.sensitive = browsers.length > 0;
            if (browsers.length === 0)
                browserRow.subtitle = 'Nenhum navegador compatível encontrado.';
        }).catch(e => {
            if (e.code !== 'cancelled')
                browserRow.subtitle = 'O serviço ytmusic-daemon não respondeu.';
        });

        const loginButton = new Adw.ButtonRow({
            title: 'Entrar com o navegador',
            css_classes: ['suggested-action'],
        });
        loginButton.connect('activated', async () => {
            const browser = browsers[browserRow.selected];
            if (!browser)
                return;
            loginButton.sensitive = false;
            loginButton.title = 'Entrando…';
            try {
                const account = await client.call('LoginWithBrowser', browser.id);
                window.add_toast(new Adw.Toast({title: `Conectado como ${account.name ?? 'você'}`}));
                this._loadProfile(client);
            } catch (e) {
                if (e.code === 'cancelled')
                    return;
                window.add_toast(new Adw.Toast({title: e.message, timeout: 6}));
            }
            loginButton.title = 'Entrar com o navegador';
            loginButton.sensitive = true;
        });
        login.add(loginButton);

        const info = new Adw.PreferencesGroup({title: 'Como funciona'});
        page.add(info);
        const infoRow = new Adw.ActionRow({
            title: 'A sessão é a mesma do navegador',
            subtitle: 'Se você sair da conta do YouTube nesse navegador, o app também é ' +
                'desconectado. Para voltar, entre de novo no navegador e clique em ' +
                '"Entrar com o navegador". Enquanto você estiver conectado lá, o app ' +
                'renova o acesso sozinho.',
            subtitle_lines: 0,
        });
        infoRow.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
        info.add(infoRow);

        const account = new Adw.PreferencesGroup();
        page.add(account);
        const logoutButton = new Adw.ButtonRow({
            title: 'Sair da conta neste app',
            css_classes: ['destructive-action'],
        });
        logoutButton.connect('activated', async () => {
            try {
                await client.call('Logout');
                window.add_toast(new Adw.Toast({title: 'Você saiu da conta neste app'}));
                this._loadProfile(client);
            } catch (e) {
                if (e.code !== 'cancelled')
                    window.add_toast(new Adw.Toast({title: e.message}));
            }
        });
        account.add(logoutButton);

        const advanced = new Adw.PreferencesGroup({
            title: 'Avançado',
            description: 'Login copiando os cabeçalhos do navegador, e os logs do serviço (no terminal).',
        });
        page.add(advanced);
        advanced.add(new Adw.ActionRow({
            title: 'Login manual',
            subtitle: '~/.local/share/ytmusic-daemon/venv/bin/ytmusic-daemon-login',
            subtitle_selectable: true,
        }));
        advanced.add(new Adw.ActionRow({
            title: 'Ver logs do serviço',
            subtitle: 'journalctl --user -u ytmusic-daemon',
            subtitle_selectable: true,
        }));
        return page;
    }
}

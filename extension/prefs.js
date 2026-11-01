import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class YTMusicPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Geral',
            icon_name: 'preferences-system-symbolic',
        });

        const appearance = new Adw.PreferencesGroup({title: 'Aparência'});
        page.add(appearance);

        const heightRow = Adw.SpinRow.new_with_range(300, 1200, 20);
        heightRow.title = 'Altura máxima do popup';
        heightRow.subtitle = 'Em pixels. Acima disso a lista rola.';
        settings.bind('popup-max-height', heightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(heightRow);

        const coversRow = new Adw.SwitchRow({
            title: 'Mostrar capas',
            subtitle: 'Capas das playlists e músicas, baixadas e guardadas pelo serviço.',
        });
        settings.bind('show-covers', coversRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(coversRow);

        const library = new Adw.PreferencesGroup({title: 'Biblioteca'});
        page.add(library);

        const episodesRow = new Adw.SwitchRow({
            title: 'Mostrar "Episódios para mais tarde"',
            subtitle: 'Lista de podcasts salvos no YouTube Music.',
        });
        settings.bind('show-episodes-playlist', episodesRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        library.add(episodesRow);

        const service = new Adw.PreferencesGroup({
            title: 'Serviço',
            description: 'Login, logs e reinstalação ficam no terminal. Veja o README do projeto.',
        });
        page.add(service);
        service.add(new Adw.ActionRow({
            title: 'Fazer login de novo',
            subtitle: '~/.local/share/ytmusic-daemon/venv/bin/ytmusic-daemon-login',
            subtitle_selectable: true,
        }));
        service.add(new Adw.ActionRow({
            title: 'Ver logs do serviço',
            subtitle: 'journalctl --user -u ytmusic-daemon',
            subtitle_selectable: true,
        }));

        window.add(page);
    }
}

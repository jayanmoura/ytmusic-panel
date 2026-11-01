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
        const group = new Adw.PreferencesGroup({title: 'Aparência'});
        page.add(group);

        const heightRow = Adw.SpinRow.new_with_range(300, 1200, 20);
        heightRow.title = 'Altura máxima do popup';
        heightRow.subtitle = 'Em pixels. Acima disso a lista rola.';
        settings.bind('popup-max-height', heightRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(heightRow);

        window.add(page);
    }
}

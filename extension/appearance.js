// Popup appearance: the fixed list height (shrunk to fit the screen) and the
// light/dark theme (automatic, or forced in the preferences).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Appearance {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
        this.listHeight = undefined;
    }

    // Fixed height, so the setting is visible even when the list is short.
    // The shell caps the whole menu to the screen; when that happens the
    // list must shrink instead of pushing the mini player out of view.
    // Sizes go through CSS: setting min_height on a ScrollView directly can
    // make its minimum exceed its natural height, which aborts the shell.
    applyHeight() {
        const indicator = this._indicator;
        const h = indicator._settings.get_int('popup-height');
        this.setListHeight(h, h);
        if (indicator.menu.isOpen)
            this.fitHeight();
    }

    setListHeight(min, max) {
        const indicator = this._indicator;
        for (const scroll of [indicator._scroll, indicator._picker.scroll])
            scroll.style = `min-height: ${min}px; max-height: ${max}px;`;
        // The expanded player also takes the space of the mini player it hides.
        const extra = indicator._npExtraHeight;
        indicator._np.actor.style = `min-height: ${min + extra}px; max-height: ${max + extra}px;`;
        this.listHeight = min;
    }

    // Called with the menu open (the actors must be on the stage to measure).
    fitHeight() {
        const indicator = this._indicator;
        const h = indicator._settings.get_int('popup-height');
        const monitor = Main.layoutManager.findIndexForActor(indicator);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            monitor >= 0 ? monitor : Main.layoutManager.primaryIndex);
        // Height of everything in the popup except the visible list.
        const scroll = indicator._overlayActor ?? indicator._scroll;
        const [, listNat] = scroll.get_preferred_height(-1);
        const [, menuNat] = indicator.menu.box.get_preferred_height(-1);
        const chrome = menuNat - listNat;
        // Panel menus keep a bottom margin; leave room for it and the popup border.
        const available = Math.max(200, workArea.height - chrome - 48);
        const target = Math.min(h, available);
        this.setListHeight(target, target);
    }

    applyTheme() {
        const choice = this._indicator._settings.get_string('popup-theme');
        const shellVariant = Main.getStyleVariant() === 'light' ? 'light' : 'dark';
        const variant = choice === 'auto' ? shellVariant : choice;
        const box = this._indicator.menu.box;
        box.remove_style_class_name('ytmusic-theme-light');
        box.remove_style_class_name('ytmusic-theme-dark');
        box.add_style_class_name(`ytmusic-theme-${variant}`);
        if (variant !== shellVariant)
            box.add_style_class_name('ytmusic-theme-forced');
        else
            box.remove_style_class_name('ytmusic-theme-forced');
    }

    destroy() {}
}

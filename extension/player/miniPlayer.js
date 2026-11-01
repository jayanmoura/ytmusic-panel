// The mini player at the bottom of the popup: cover, title (scrolls when
// too long), artist and the playback buttons. Cover and title open the
// expanded player.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ClipBox, ellipsized} from '../widgets/common.js';
import {createControlSet} from './controls.js';

export class MiniPlayer {
    /** @param {object} indicator the panel indicator */
    constructor(indicator) {
        this._indicator = indicator;
    }

    build() {
        const indicator = this._indicator;
        const section = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(section);
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
        this._playerOpenButton.connect('clicked', () => indicator._np.toggle());
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
        this._titleClip.connect('notify::width', () => this.updateMarquee());
        this._playerArtist = ellipsized(new St.Label({style_class: 'ytmusic-player-artist'}));
        info.add_child(this._titleClip);
        info.add_child(this._playerArtist);
        openBox.add_child(info);

        const controls = new St.BoxLayout({style_class: 'ytmusic-player-controls'});
        const set = createControlSet(indicator);
        set.playPause.add_style_class_name('ytmusic-play-pause');
        this._repeatButton = set.repeat;
        this._shuffleButton = set.shuffle;
        indicator._controlSets.push(set);
        controls.add_child(set.repeat);
        controls.add_child(set.shuffle);
        controls.add_child(set.prev);
        controls.add_child(set.playPause);
        controls.add_child(set.next);
        player.add_child(controls);
    }

    get section() {
        return this._playerSection;
    }

    updateText(state, active) {
        const track = state?.track;
        const title = active ? track?.title || 'Música sem título' : 'Nada tocando';
        if (this._playerTitle.text !== title) {
            this._playerTitle.text = title;
            this.updateMarquee();
        }
        if (!active) {
            this._playerArtist.text = 'Escolha uma playlist ou música';
        } else {
            this._playerArtist.text = state.state === 'loading'
                ? 'Carregando…'
                : track?.artists || '';
        }
    }

    updateCover(url, active) {
        const covers = this._indicator._covers;
        if (url !== this._playerCoverUrl) {
            this._playerCoverUrl = url;
            this._playerCoverSlot.child?.destroy();
            this._playerCoverSlot.child = active ? covers.cover(url, 'ytmusic-cover ytmusic-player-cover') : null;
            covers.flush();
        }
        this._playerOpenButton.reactive = active;
        this._playerOpenButton.can_focus = active;
    }

    // Covers were switched on or off: rebuild the cover on the next update.
    forgetCover() {
        this._playerCoverUrl = undefined;
    }

    // Long titles scroll back and forth while the popup is open.
    updateMarquee() {
        const label = this._playerTitle;
        label.remove_transition('translation-x');
        label.translation_x = 0;
        // Animations on hidden actors finish at once, which would loop forever.
        if (!this._indicator.menu.isOpen || !this._titleClip.mapped)
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

    destroy() {
        this._playerTitle.remove_transition('translation-x');
    }
}

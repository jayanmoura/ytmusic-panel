// Small building blocks shared by every part of the popup.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

export function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

export function iconButton(iconName, accessibleName, callback) {
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

export function setToggled(button, on) {
    if (on)
        button.add_style_class_name('ytmusic-toggle-on');
    else
        button.remove_style_class_name('ytmusic-toggle-on');
}

// Clips its child and asks for no minimum width, so a long title doesn't push
// the player controls; the child keeps its natural width (FixedLayout) and
// scrolls inside (see _updateMarquee).
export const ClipBox = GObject.registerClass(
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

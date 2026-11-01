// Playback buttons (repeat, shuffle, previous, play/pause, next). The mini
// player and the expanded player each have a set; both follow the same state.

import {iconButton, setToggled} from '../widgets/common.js';

/** @param {object} indicator the panel indicator (its _control sends the command) */
export function createControlSet(indicator) {
    return {
        repeat: iconButton('media-playlist-repeat-symbolic', 'Repetir',
            () => indicator._control('CycleRepeat')),
        shuffle: iconButton('media-playlist-shuffle-symbolic', 'Aleatório',
            () => indicator._control('ToggleShuffle')),
        prev: iconButton('media-skip-backward-symbolic', 'Anterior',
            () => indicator._control('Previous')),
        playPause: iconButton('media-playback-start-symbolic', 'Tocar',
            () => indicator._control('TogglePause')),
        next: iconButton('media-skip-forward-symbolic', 'Próxima',
            () => indicator._control('Next')),
    };
}

export function updateControlSet(set, state, active) {
    const playing = state?.state === 'playing' || state?.state === 'loading';
    const repeat = state?.repeat ?? 'off';
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
    setToggled(set.repeat, repeat !== 'off');
    set.shuffle.accessible_name = state?.shuffle ? 'Aleatório: ligado' : 'Aleatório: desligado';
    setToggled(set.shuffle, !!state?.shuffle);
    for (const button of [set.repeat, set.shuffle]) {
        button.reactive = !!state;
        button.can_focus = !!state;
    }
}

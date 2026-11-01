// Pure helpers (no Shell or GObject imports).

import {EPISODES_PLAYLIST_ID, LIKED_PLAYLIST_ID} from './constants.js';

export const numberFormat = new Intl.NumberFormat('pt-BR');

export function sortPlaylists(playlists, showEpisodes) {
    const visible = playlists.filter(p => showEpisodes || p.id !== EPISODES_PLAYLIST_ID);
    const liked = visible.filter(p => p.id === LIKED_PLAYLIST_ID);
    return [...liked, ...visible.filter(p => p.id !== LIKED_PLAYLIST_ID)];
}

export function trackCountText(count) {
    if (count === 1)
        return '1 música';
    return `${numberFormat.format(count)} músicas`;
}

// Thumbnails come at 120px; ask the image server for a size fit for the big cover.
export function largeCover(url) {
    return url?.replace(/=w\d+-h\d+/, '=w544-h544').replace(/=s\d+(?=-|$)/, '=s544') ?? null;
}

export function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '0:00';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Case and accent insensitive, for the playlist filter.
export function normalize(text) {
    return (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

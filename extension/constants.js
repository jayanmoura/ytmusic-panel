// Shared constants: special playlist ids, timings and user-facing error texts.

export const LIKED_PLAYLIST_ID = 'LM';
export const EPISODES_PLAYLIST_ID = 'SE'; // "Episódios para mais tarde"

// Rows are created in pages so huge playlists don't stall the shell.
export const TRACKS_PAGE_SIZE = 100;
export const FILTER_DEBOUNCE_MS = 150;
// Hovering a track this long asks the service to resolve its audio ahead of a click.
export const PREPARE_DELAY_MS = 250;
export const TOAST_MS = 2000;
export const SHARE_URL = 'https://music.youtube.com/watch?v=';

export const SEARCH_DEBOUNCE_MS = 400;
export const SEARCH_MIN_CHARS = 2;

export const PROGRESS_TICK_MS = 250;
// The position is interpolated locally and re-read from the service this often.
export const PROGRESS_SYNC_MS = 5000;
export const NOW_PLAYING = {videoId: null}; // overlay marker for the expanded player
// Height of everything in the expanded player except the cover.
export const NOW_PLAYING_CHROME = 250;

export const ERROR_TEXT = {
    auth_required: [
        'Você não está conectado ao YouTube Music.',
        'Abra as configurações (engrenagem) e entre com o navegador.',
    ],
    offline: [
        'O serviço ytmusic-daemon não está respondendo.',
        'No terminal, rode: systemctl --user start ytmusic-daemon',
    ],
    network: [
        'Não foi possível falar com o YouTube Music.',
        'Verifique a conexão e clique em atualizar.',
    ],
    unavailable: [
        'Conteúdo indisponível no YouTube Music.',
        'A playlist pode ter sido removida ou estar privada.',
    ],
    internal: [
        'O serviço encontrou um erro.',
        'Veja os logs: journalctl --user -u ytmusic-daemon',
    ],
};

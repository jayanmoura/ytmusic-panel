# Changelog

All notable changes to this project are listed here. Versions follow the
`version-name` in `extension/metadata.json` and the `version` in
`daemon/pyproject.toml`.

## [1.2] - 2026-11-01

No new features: this release is about robustness, code organization, tests
and documentation.

### Fixed

- The extension no longer touches destroyed widgets when a reply from the
  service arrives after it was disabled (queue, remove, add to playlist,
  playback controls, progress bar and seek).
- The idle callback that restores the scroll position after removing a song
  is tracked and removed when the extension is disabled.
- The preferences window ignores replies that arrive after it was closed.

### Security

- The service validates the arguments of every D-Bus method before doing
  anything (video and playlist ids, search length, positions, seek time,
  browser name, cover list). Invalid input gets `"error": "invalid_request"`
  and never reaches ytmusicapi, yt-dlp or mpv.

### Changed

- The extension code is split into modules: `indicator.js`, `views/`,
  `player/`, `widgets/`, `appearance.js`, `covers.js`, `constants.js` and
  `util.js`. No file is above 500 lines and behavior is unchanged.
- `install.sh` packs every module and folder of the extension.
- The README is now in English, with a Brazilian Portuguese version in
  `README.pt-BR.md`, badges and screenshots (album covers and artist names
  hidden).
- Requirements mention only Wayland: GNOME 50 has no X11 session.

### Added

- 65 tests for the service with pytest (validation, cache, queue, shuffle and
  repeat, client logic, browser login), with no network, no mpv and no access
  to real credentials.
- Linting: ruff for Python and eslint (configured for GJS) for the extension.
- GitHub Actions CI on every push and pull request: ruff, pytest on Python
  3.12 and 3.14, eslint, and two consistency checks:
  `scripts/check-interface.py` (the D-Bus interface matches on both sides)
  and `scripts/check-calls.py` (indicator methods called by the modules
  exist).

## [1.1] - 2026-11-01

First public release.

### Features

- YouTube Music in the GNOME Shell 50 top bar: playlists ("Músicas que
  gostei" first), songs of a playlist, song search and playback.
- Inside a playlist: the search field filters its songs, newest or oldest
  first, and a floating menu per song (add to the queue, play next, add to
  another playlist, copy the link, remove from the playlist).
- Mini player with repeat, shuffle, previous, play/pause and next, and a
  scrolling title for long names.
- Expanded "now playing" view with a large cover and a progress bar that
  seeks on click.
- Fast playback: audio is resolved in advance when the pointer rests on a
  song and for the next song in the queue.
- Login with the browser's existing YouTube session (Firefox and
  Chromium-based browsers), renewed automatically while you stay signed in
  there; manual login with copied request headers as an alternative.
- Preferences: account header, light, dark or automatic theme, popup height,
  covers on or off, and account management.
- Media keys and GNOME's media controls through MPRIS.

[1.2]: https://github.com/jayanmoura/ytmusic-panel/compare/v1.1...v1.2
[1.1]: https://github.com/jayanmoura/ytmusic-panel/releases/tag/v1.1

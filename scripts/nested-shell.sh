#!/usr/bin/env bash
# Nested GNOME Shell for development, with its own copy of the daemon on the
# isolated session bus (the systemd-managed daemon lives on the real bus).
set -euo pipefail

DAEMON="$HOME/.local/share/ytmusic-daemon/venv/bin/ytmusic-daemon"
SIZE="${1:-1600x900}"

exec dbus-run-session -- bash -c "
    '$DAEMON' &
    MUTTER_DEBUG_DUMMY_MODE_SPECS='$SIZE' gnome-shell --devkit --wayland
    kill %1 2>/dev/null
"

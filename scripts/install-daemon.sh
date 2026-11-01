#!/usr/bin/env bash
# Creates the venv, installs the daemon (editable) and registers the user service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$HOME/.local/share/ytmusic-daemon/venv"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DBUS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"

if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv --system-site-packages "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade -e "$ROOT/daemon"
# YouTube changes often; always pull the newest yt-dlp (and its JS solver).
"$VENV/bin/pip" install -q --upgrade "yt-dlp[default]" deno

mkdir -p "$UNIT_DIR" "$DBUS_DIR"
install -m 644 "$ROOT/daemon/data/ytmusic-daemon.service" "$UNIT_DIR/"
install -m 644 "$ROOT/daemon/data/io.github.jayan.YTMusic.service" "$DBUS_DIR/"

systemctl --user daemon-reload
systemctl --user enable ytmusic-daemon.service
systemctl --user restart ytmusic-daemon.service

echo "Daemon instalado. Logs: journalctl --user -fu ytmusic-daemon"
echo "Login: $VENV/bin/ytmusic-daemon-login"

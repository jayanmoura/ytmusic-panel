#!/usr/bin/env bash
# Removes ytmusic-panel. Credentials and the cover cache are kept unless --purge.
set -euo pipefail

UUID="ytmusic-panel@jayan"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ytmusic-daemon.service"
DBUS_SERVICE="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/io.github.jayanmoura.YTMusic.service"
DATA_DIR="$HOME/.local/share/ytmusic-daemon"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ytmusic-daemon"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ytmusic-daemon"

PURGE=no
[ "${1:-}" = "--purge" ] && PURGE=yes

python3 - "$UUID" <<'EOF'
import ast, subprocess, sys
uuid = sys.argv[1]
out = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
                     capture_output=True, text=True, check=True).stdout.strip()
enabled = ast.literal_eval(out.removeprefix("@as ")) if out else []
if uuid in enabled:
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions",
                    str([u for u in enabled if u != uuid])], check=True)
EOF

# A --dev install is a symlink into the repo: remove the link, never the target.
if [ -L "$EXT_DIR" ]; then
    rm "$EXT_DIR"
elif [ -d "$EXT_DIR" ]; then
    rm -r "$EXT_DIR"
fi
echo "Extensão removida."

systemctl --user disable --now ytmusic-daemon.service 2>/dev/null || true
rm -f "$UNIT" "$DBUS_SERVICE"
systemctl --user daemon-reload
rm -rf "$DATA_DIR"
echo "Serviço e ambiente virtual removidos."

if [ "$PURGE" = yes ]; then
    rm -rf "$CONFIG_DIR" "$CACHE_DIR"
    echo "Credenciais e cache de capas apagados."
else
    echo "Credenciais mantidas em $CONFIG_DIR (use --purge para apagar)."
fi
echo "Saia e entre de novo na sessão para o ícone sumir do painel."

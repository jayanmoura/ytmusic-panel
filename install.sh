#!/usr/bin/env bash
# Installs ytmusic-panel: the daemon (venv + systemd user service) and the
# GNOME Shell extension. Never runs sudo; missing system packages are listed.
#
# Usage: ./install.sh          copy the extension into ~/.local/share
#        ./install.sh --dev    symlink it to this repo (edits take effect on relogin)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID="ytmusic-panel@jayan"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
VENV="$HOME/.local/share/ytmusic-daemon/venv"
AUTH_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ytmusic-daemon/browser.json"

MODE=copy
case "${1:-}" in
    --dev) MODE=dev ;;
    "") ;;
    *) echo "Uso: $0 [--dev]" >&2; exit 2 ;;
esac

step() { printf '\n==> %s\n' "$1"; }

# -- 1. system requirements ---------------------------------------------------
step "Conferindo dependências do sistema"
missing=()
command -v mpv >/dev/null || missing+=(mpv)
[ -e /usr/lib/mpv-mpris/mpris.so ] || [ -e /etc/mpv/scripts/mpris.so ] || missing+=(mpv-mpris)
python3 -c 'import gi' 2>/dev/null || missing+=(python3-gi)
python3 -c 'import ensurepip' 2>/dev/null || missing+=(python3-venv)
command -v gnome-extensions >/dev/null || missing+=(gnome-shell)
if [ ${#missing[@]} -gt 0 ]; then
    echo "Faltam pacotes do sistema. Instale com:"
    echo "    sudo apt install ${missing[*]}"
    echo "e rode este script de novo."
    exit 1
fi
shell_major=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if [ "$shell_major" != "50" ]; then
    echo "Aviso: esta extensão foi feita para o GNOME Shell 50 (encontrado: $shell_major)."
fi
echo "ok"

# -- 2. daemon -----------------------------------------------------------------
step "Instalando o serviço ytmusic-daemon"
if [ "$MODE" = dev ]; then
    "$ROOT/scripts/install-daemon.sh" --dev
else
    "$ROOT/scripts/install-daemon.sh"
fi

# -- 3. extension --------------------------------------------------------------
step "Instalando a extensão ($MODE)"
if [ "$MODE" = dev ]; then
    # A previous copy install is a plain directory of generated files.
    if [ -d "$EXT_DIR" ] && [ ! -L "$EXT_DIR" ]; then
        rm -r "$EXT_DIR"
    fi
    "$ROOT/scripts/dev-link.sh"
else
    # A previous --dev install is a symlink into this repo: remove only the
    # link, so the copy below can't write into the working tree.
    if [ -L "$EXT_DIR" ]; then
        rm "$EXT_DIR"
    fi
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    gnome-extensions pack "$ROOT/extension" --force --out-dir="$tmp" \
        --extra-source=ytmusicClient.js --extra-source=icons
    gnome-extensions install --force "$tmp/$UUID.shell-extension.zip"
    echo "Extensão copiada para $EXT_DIR"
fi

# Enable without touching the other extensions. On Wayland the running shell
# only notices a new extension after logging out and back in.
python3 - "$UUID" <<'EOF'
import ast, subprocess, sys
uuid = sys.argv[1]
def get(key):
    out = subprocess.run(["gsettings", "get", "org.gnome.shell", key],
                         capture_output=True, text=True, check=True).stdout.strip()
    return ast.literal_eval(out.removeprefix("@as ")) if out else []
def put(key, value):
    subprocess.run(["gsettings", "set", "org.gnome.shell", key, str(value)], check=True)
enabled, disabled = get("enabled-extensions"), get("disabled-extensions")
if uuid not in enabled:
    put("enabled-extensions", enabled + [uuid])
if uuid in disabled:
    put("disabled-extensions", [u for u in disabled if u != uuid])
EOF
echo "Extensão habilitada."

# -- 4. next steps -------------------------------------------------------------
step "Pronto"
if [ ! -s "$AUTH_FILE" ]; then
    echo "Falta o login. Rode e siga as instruções:"
    echo "    $VENV/bin/ytmusic-daemon-login"
fi
echo "Saia e entre de novo na sessão para o ícone aparecer no painel."
echo "Logs do serviço: journalctl --user -fu ytmusic-daemon"

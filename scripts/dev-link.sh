#!/usr/bin/env bash
# Links the extension into the user's extension dir and compiles its schemas.
set -euo pipefail

UUID="ytmusic-panel@jayan"
SRC="$(cd "$(dirname "$0")/.." && pwd)/extension"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")"

if [ -L "$DEST" ]; then
    ln -sfn "$SRC" "$DEST"
elif [ -e "$DEST" ]; then
    echo "Erro: $DEST existe e não é um link simbólico." >&2
    exit 1
else
    ln -s "$SRC" "$DEST"
fi

echo "Link: $DEST -> $SRC"

"""ytmusic-daemon-login: turn browser request headers into browser.json (mode 600).

Headers are read from stdin and never echoed back or logged.
"""

import os
import sys

from ytmusicapi import YTMusic
from ytmusicapi.auth.browser import setup_browser
from ytmusicapi.exceptions import YTMusicError

from .paths import AUTH_FILE, CONFIG_DIR

INSTRUCTIONS = """\
Login do YouTube Music (cabeçalhos do navegador)

1. Abra https://music.youtube.com logado na sua conta (Firefox ou Chrome).
2. Abra as ferramentas de desenvolvedor (F12), aba Rede (Network).
3. Filtre por "browse" e clique em alguma coisa na página (ex.: Biblioteca).
4. Clique numa requisição POST para "browse?...".
5. Copie os cabeçalhos da requisição (Request Headers):
   Firefox: botão direito na requisição, Copiar valor, Copiar cabeçalhos da requisição.
   Chrome: em Headers, seção Request Headers, selecione tudo e copie.
6. Cole aqui embaixo e pressione Enter e depois Ctrl+D.
"""


def write_private(path, content: str) -> None:
    """Write atomically, never letting the file exist with wider permissions."""
    CONFIG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(CONFIG_DIR, 0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def main():
    print(INSTRUCTIONS, file=sys.stderr)
    raw = sys.stdin.read()
    if not raw.strip():
        print("Nada foi colado. Cancelado.", file=sys.stderr)
        return 1

    try:
        headers_json = setup_browser(filepath=None, headers_raw=raw)
    except YTMusicError as e:
        # Messages from setup_browser only name missing header keys, never values.
        print(f"\nNão consegui ler os cabeçalhos: {str(e).splitlines()[0]}", file=sys.stderr)
        return 1
    finally:
        del raw

    write_private(AUTH_FILE, headers_json)
    print(f"\nCredenciais salvas em {AUTH_FILE} (permissão 600).", file=sys.stderr)

    print("Testando acesso à conta...", file=sys.stderr)
    try:
        playlists = YTMusic(str(AUTH_FILE), language="pt").get_library_playlists(limit=None)
    except Exception as e:
        print(f"Falhou ({type(e).__name__}). Tente copiar os cabeçalhos de novo.", file=sys.stderr)
        return 1
    print(f"Tudo certo: {len(playlists)} playlists encontradas.", file=sys.stderr)
    print("O daemon recarrega as credenciais sozinho na próxima chamada.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Log in with the browser's own YouTube session (its cookies).

Builds the same browser.json that ytmusicapi's header-based setup produces,
but from the cookies stored by the browser, so there is nothing to copy and
paste. Cookie values are never logged.
"""

import json
import logging
import os
import time
from pathlib import Path

from ytmusicapi.helpers import get_authorization, initialize_headers, sapisid_from_cookie

from .login import write_private
from .paths import AUTH_FILE, CONFIG_DIR

log = logging.getLogger(__name__)

# Which browser the login came from, so it can be refreshed from it later.
LOGIN_SOURCE_FILE = CONFIG_DIR / "login.json"
ORIGIN = "https://music.youtube.com"
COOKIE_DOMAINS = {".youtube.com", "youtube.com", "music.youtube.com", ".music.youtube.com"}

HOME = Path.home()
# yt-dlp browser name -> (label, profile directories that mean it's installed)
BROWSERS = {
    "firefox": ("Firefox", [
        HOME / ".mozilla/firefox",
        HOME / "snap/firefox/common/.mozilla/firefox",
        HOME / ".var/app/org.mozilla.firefox/.mozilla/firefox",
    ]),
    "chrome": ("Google Chrome", [HOME / ".config/google-chrome"]),
    "chromium": ("Chromium", [HOME / ".config/chromium", HOME / "snap/chromium/common/chromium"]),
    "brave": ("Brave", [HOME / ".config/BraveSoftware/Brave-Browser"]),
    "edge": ("Microsoft Edge", [HOME / ".config/microsoft-edge"]),
    "vivaldi": ("Vivaldi", [HOME / ".config/vivaldi"]),
    "opera": ("Opera", [HOME / ".config/opera"]),
}


class BrowserLoginError(Exception):
    """Shown to the user; never contains cookie data."""


class _QuietLogger:
    """yt-dlp logger that drops everything (its messages can include paths)."""

    def debug(self, *_args, **_kwargs):
        pass

    info = warning = error = debug

    def progress_bar(self):
        return None


def installed_browsers() -> list[dict]:
    return [
        {"id": name, "label": label}
        for name, (label, dirs) in BROWSERS.items()
        if any(d.is_dir() for d in dirs)
    ]


def saved_browser() -> str | None:
    try:
        return json.loads(LOGIN_SOURCE_FILE.read_text()).get("browser")
    except (OSError, ValueError):
        return None


def login_with_browser(browser: str) -> None:
    """Write AUTH_FILE from the browser's cookies. Raises BrowserLoginError."""
    if browser not in BROWSERS:
        raise BrowserLoginError("Navegador não suportado.")
    # Imported lazily: yt-dlp is large and only needed here and for playback.
    from yt_dlp.cookies import extract_cookies_from_browser

    try:
        jar = extract_cookies_from_browser(browser, logger=_QuietLogger())
    except Exception as e:
        log.warning("could not read %s cookies (%s)", browser, type(e).__name__)
        raise BrowserLoginError(
            f"Não consegui ler os cookies do {BROWSERS[browser][0]}.") from None

    now = time.time()
    cookies = {
        c.name: c.value for c in jar
        if c.domain in COOKIE_DOMAINS and not (c.expires and c.expires < now)
    }
    cookie = "; ".join(f"{k}={v}" for k, v in cookies.items())
    try:
        sapisid = sapisid_from_cookie(cookie)
    except KeyError:
        raise BrowserLoginError(
            f"Você não está conectado ao YouTube no {BROWSERS[browser][0]}.") from None

    headers = dict(initialize_headers())
    headers["cookie"] = cookie
    headers["x-goog-authuser"] = "0"
    # ytmusicapi recognizes browser credentials by this header and recomputes it per request.
    headers["authorization"] = get_authorization(f"{sapisid} {ORIGIN}")

    # Check the new credentials before replacing the ones in use.
    candidate = AUTH_FILE.with_name("browser.new.json")
    write_private(candidate, json.dumps(headers, ensure_ascii=True))
    try:
        _verify(candidate)
    except BrowserLoginError:
        candidate.unlink(missing_ok=True)
        raise
    os.replace(candidate, AUTH_FILE)
    write_private(LOGIN_SOURCE_FILE, json.dumps({"browser": browser}))
    log.info("logged in with %s cookies", browser)


def _verify(path: Path) -> None:
    import requests
    from ytmusicapi import YTMusic

    try:
        session = requests.Session()
        info = YTMusic(str(path), requests_session=session).get_account_info()
    except requests.RequestException:
        raise BrowserLoginError("Não foi possível falar com o YouTube Music.") from None
    except Exception as e:
        log.warning("browser credentials rejected (%s)", type(e).__name__)
        raise BrowserLoginError(
            "O YouTube não aceitou a sessão do navegador. Abra music.youtube.com "
            "nele, confira se está conectado e tente de novo.") from None
    if not info.get("accountName"):
        raise BrowserLoginError("A sessão do navegador não tem uma conta do YouTube.")


def logout() -> None:
    AUTH_FILE.unlink(missing_ok=True)
    LOGIN_SOURCE_FILE.unlink(missing_ok=True)
    log.info("logged out")

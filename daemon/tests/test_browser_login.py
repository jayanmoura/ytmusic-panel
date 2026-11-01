"""browser_login with fake cookies (no browser, no network). Paths point at the
temporary XDG folders set up in conftest.py."""

import json
import stat
from http.cookiejar import Cookie

import pytest
import yt_dlp.cookies

from ytmusic_daemon import browser_login
from ytmusic_daemon.browser_login import BrowserLoginError
from ytmusic_daemon.paths import AUTH_FILE


def cookie(name, value, domain=".youtube.com", expires=None):
    return Cookie(0, name, value, None, False, domain, True, True, "/", True, True,
                  expires, False, None, None, {})


@pytest.fixture(autouse=True)
def clean():
    AUTH_FILE.unlink(missing_ok=True)
    browser_login.LOGIN_SOURCE_FILE.unlink(missing_ok=True)
    yield
    AUTH_FILE.unlink(missing_ok=True)
    browser_login.LOGIN_SOURCE_FILE.unlink(missing_ok=True)


def fake_browser(monkeypatch, cookies):
    monkeypatch.setattr(yt_dlp.cookies, "extract_cookies_from_browser",
                        lambda *a, **k: cookies)


def test_login_writes_private_auth_file(monkeypatch):
    fake_browser(monkeypatch, [
        cookie("SAPISID", "s"), cookie("__Secure-3PAPISID", "abc"),
        cookie("OTHER", "x", domain=".google.com"),       # not a YouTube cookie
        cookie("OLD", "y", expires=1),                    # expired
    ])
    monkeypatch.setattr(browser_login, "_verify", lambda path: None)
    browser_login.login_with_browser("firefox")

    assert stat.S_IMODE(AUTH_FILE.stat().st_mode) == 0o600
    headers = json.loads(AUTH_FILE.read_text())
    assert headers["cookie"] == "SAPISID=s; __Secure-3PAPISID=abc"
    assert headers["authorization"].startswith("SAPISIDHASH ")
    assert headers["x-goog-authuser"] == "0"
    assert browser_login.saved_browser() == "firefox"
    assert not AUTH_FILE.with_name("browser.new.json").exists()


def test_not_logged_in_browser(monkeypatch):
    fake_browser(monkeypatch, [cookie("PREF", "x")])
    with pytest.raises(BrowserLoginError):
        browser_login.login_with_browser("firefox")
    assert not AUTH_FILE.exists()


def test_rejected_session_keeps_the_current_login(monkeypatch):
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text("previous")
    fake_browser(monkeypatch, [cookie("__Secure-3PAPISID", "abc")])

    def reject(path):
        raise BrowserLoginError("rejected")

    monkeypatch.setattr(browser_login, "_verify", reject)
    with pytest.raises(BrowserLoginError):
        browser_login.login_with_browser("firefox")
    assert AUTH_FILE.read_text() == "previous"
    assert not AUTH_FILE.with_name("browser.new.json").exists()


def test_unknown_browser():
    with pytest.raises(BrowserLoginError):
        browser_login.login_with_browser("netscape")


def test_logout_removes_files(monkeypatch):
    fake_browser(monkeypatch, [cookie("__Secure-3PAPISID", "abc")])
    monkeypatch.setattr(browser_login, "_verify", lambda path: None)
    browser_login.login_with_browser("firefox")
    browser_login.logout()
    assert not AUTH_FILE.exists()
    assert browser_login.saved_browser() is None

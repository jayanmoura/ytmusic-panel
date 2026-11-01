#!/usr/bin/env python3
"""Checks that the extension's D-Bus interface matches the daemon's.

Compares method/signal names and argument signatures between the
introspection XML in daemon/ytmusic_daemon/service.py and the IFACE_XML
in extension/ytmusicClient.js, and that every method the extension calls
is declared. Run it after touching either side.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def members(xml: str) -> dict:
    iface = ET.fromstring(xml).find("interface")
    out = {}
    for el in iface:
        args = tuple((a.get("direction", "out" if el.tag == "signal" else "in"), a.get("type"))
                     for a in el.findall("arg"))
        out[f"{el.tag} {el.get('name')}"] = args
    return out


daemon_src = (ROOT / "daemon/ytmusic_daemon/service.py").read_text()
daemon_xml = re.search(r'INTROSPECTION_XML = f"""(.*?)"""', daemon_src, re.S).group(1)
daemon_xml = daemon_xml.replace("{INTERFACE}", "io.github.jayanmoura.YTMusic")

ext_dir = ROOT / "extension"
client_src = (ext_dir / "ytmusicClient.js").read_text()
ext_xml = re.search(r"const IFACE_XML = `(.*?)`;", client_src, re.S).group(1)

daemon, ext = members(daemon_xml), members(ext_xml)
problems = []
for name in sorted(set(daemon) | set(ext)):
    if name not in ext:
        problems.append(f"falta na extensão: {name}")
    elif name not in daemon:
        problems.append(f"falta no daemon: {name}")
    elif daemon[name] != ext[name]:
        problems.append(f"assinatura diferente: {name} daemon={daemon[name]} extensão={ext[name]}")

ext_code = "".join(p.read_text() for p in ext_dir.glob("*.js"))
called = set(re.findall(r"(?:call|_play|_control)\('([A-Za-z]+)'", ext_code))
called |= set(re.findall(r"'(Refresh[A-Za-z]+|Get[A-Za-z]+)'", ext_code))
for method in sorted(called):
    if f"method {method}" not in ext:
        problems.append(f"chamado mas não declarado na extensão: {method}")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"interface ok: {len(daemon)} membros, {len(called)} métodos chamados pela extensão")

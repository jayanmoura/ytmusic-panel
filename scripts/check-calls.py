#!/usr/bin/env python3
"""Check that every indicator method the extension calls actually exists.

The views, player and widget modules get the indicator as a parameter and
call it as `indicator._name(...)`; the indicator calls itself as
`this._name(...)`. Nothing checks those calls before the code runs in the
shell, so a method lost in a refactor only shows up as a JS ERROR when that
path is used. This compares the calls with the methods and properties the
indicator defines.

Exit code 1 lists what's missing. Run from anywhere: python3 scripts/check-calls.py
"""

import re
import sys
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent / "extension"


def main() -> int:
    indicator_file = EXT / "indicator.js"
    if not indicator_file.exists():  # before the indicator had its own module
        indicator_file = EXT / "extension.js"
    indicator = indicator_file.read_text()
    methods = set(re.findall(r"^    (?:async |get )?(_?\w+)\(.*\) \{$", indicator, re.M))
    props = set(re.findall(r"this\.(_\w+) = ", indicator))
    known = methods | props

    missing = []
    for name in sorted(set(re.findall(r"this\.(_\w+)\(", indicator))):
        if name not in known:
            missing.append((indicator_file.name, name))

    modules = [p for p in EXT.rglob("*.js")
               if p != indicator_file and p.name not in ("extension.js", "prefs.js")]
    for path in sorted(modules):
        src = path.read_text()
        rel = path.relative_to(EXT)
        for name in sorted(set(re.findall(r"indicator\.(_\w+)\(", src))):
            if name not in known:
                missing.append((rel, name))
        # indicator._obj.method(...): _obj must be something the indicator sets
        for obj in sorted(set(re.findall(r"indicator\.(_\w+)\.\w+", src))):
            if obj not in props:
                missing.append((rel, f"{obj} (propriedade)"))

    if missing:
        for where, name in missing:
            print(f"{where}: indicator.{name} não existe", file=sys.stderr)
        return 1
    print(f"calls ok: {len(modules)} módulos conferidos contra {indicator_file.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

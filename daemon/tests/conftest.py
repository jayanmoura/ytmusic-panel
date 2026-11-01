"""Shared test setup.

The XDG folders point at a temporary directory before any project module is
imported (paths.py reads them at import time), so tests never touch the real
credentials, cache or runtime folders.
"""

import os
import tempfile

_ROOT = tempfile.mkdtemp(prefix="ytmusic-daemon-tests-")
for var in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"):
    os.environ[var] = os.path.join(_ROOT, var.lower())
    os.makedirs(os.environ[var], exist_ok=True)

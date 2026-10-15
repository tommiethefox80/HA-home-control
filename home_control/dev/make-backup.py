"""Makes a partial backup of one app the way Home Assistant's Supervisor does (securetar 2026.10),
so the app's backup reader can be tested against the real format.

  python make-backup.py <out.tar> <backup slug> <app slug> <app version> <data dir>
"""
import io
import json
import sys
import tarfile
import tempfile
import time
from pathlib import Path

from securetar import SecureTarArchive, atomic_contents_add

out, slug, app, version, data_dir = sys.argv[1:6]

archive = SecureTarArchive(Path(out), "w", bufsize=4 * 65536, create_version=3, password=None)
archive.open()

# the app's own tar, as Supervisor's App.backup() writes it
with tempfile.TemporaryDirectory() as tmp:
    Path(tmp, "addon.json").write_text(json.dumps({"user": {}, "system": {"slug": app}, "version": version, "state": "started"}))
    with archive.create_tar(f"./{app}.tar.gz", gzip=True) as backup:
        backup.add(tmp, arcname=".")
        atomic_contents_add(backup, Path(data_dir), file_filter=lambda p: False, arcname="data")

# backup.json last, as Supervisor does
meta = {
    "slug": slug, "version": 2, "name": f"Home Control {version} before moving", "date": "2026-10-14T22:30:00+00:00",
    "type": "partial", "supervisor_version": "2026.10.0", "extra": {}, "compressed": True, "protected": False,
    "crypto": None, "homeassistant": None, "addons": [{"slug": app, "name": "Home Control", "version": version, "size": 0}],
    "repositories": [], "folders": [], "docker": {},
}
raw = json.dumps(meta).encode()
info = tarfile.TarInfo(name="./backup.json")
info.size = len(raw)
info.mtime = int(time.time())
archive.tar.addfile(info, fileobj=io.BytesIO(raw))
archive.close()
print(out)

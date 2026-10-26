#!/usr/bin/env python3
"""Genera un pacchetto IINA dai sorgenti, senza dipendenze esterne."""

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
PLUGIN_FILES = (
    "Info.json", "main.js", "global.js", "channel-list.js", "epg-match.js", "source-config.js",
    "epg-helper.js", "python-runtime.js", "sidebar.html", "sidebar.js", "guide.html", "guide.js",
    "README.md",
    "docs/screenshots/in-onda.png", "docs/screenshots/canali-epg.png",
)


def build(output_dir):
    info = json.loads((ROOT / "Info.json").read_text(encoding="utf-8"))
    version = info["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Info.json: la versione deve avere il formato X.Y.Z")
    for field in ("entry", "globalEntry"):
        if info[field] not in PLUGIN_FILES:
            raise ValueError("Punto di ingresso non incluso nel pacchetto: " + info[field])
    contents = {filename: (ROOT / filename).read_bytes() for filename in PLUGIN_FILES}
    for filename in ("sidebar.html", "guide.html"):
        for script in re.findall(r'<script src="([^"]+)"', contents[filename].decode("utf-8")):
            if script not in contents:
                raise ValueError("Script non incluso nel pacchetto: " + script)

    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / ("IPTV-Italia-" + version + ".iinaplgz")
    handle, temporary = tempfile.mkstemp(prefix=".iptv-italia-", dir=output_dir)
    os.close(handle)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as package:
            for filename, content in contents.items():
                # Metadati fissi per ottenere lo stesso archivio dagli stessi sorgenti.
                member = ZipInfo(filename, date_time=(2020, 1, 1, 0, 0, 0))
                member.create_system = 3
                member.external_attr = 0o100644 << 16
                package.writestr(member, content, compress_type=ZIP_DEFLATED)
        with ZipFile(temporary) as package:
            if package.testzip() is not None:
                raise ValueError("Il controllo dell'archivio non è riuscito")
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist",
                        help="Cartella di destinazione (predefinita: dist/)")
    args = parser.parse_args()
    print("Pacchetto creato: " + str(build(args.output_dir.resolve())))


if __name__ == "__main__":
    main()

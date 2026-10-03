#!/usr/bin/env python3
"""Supplement the fixed public crop corpus with visible, asymmetric pixels.

The original POI sample tests alpha handling using a tiny uniform image. It
cannot prove a crop changed the appearance. This generated diagnostic keeps
that source unchanged and uses its package scaffold with a new test image.
"""
import argparse
import hashlib
from pathlib import Path
import struct
import zipfile
import zlib

SOURCE_SHA256 = "0ce76411a6e2fe3a5b8acf42722b973131a91b93cb5c3118a5a9c481b063e386"


def test_png():
    width, height = 600, 400
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # PNG filter: none
        for x in range(width):
            color = ((220, 50, 40), (30, 155, 70), (45, 90, 220), (240, 180, 25))[(x >= 300) + 2 * (y >= 200)]
            if x < 60 or x >= 540 or y < 20 or y >= 380:
                color = (30, 30, 30)  # Exactly the outer 10%/5% crop region.
            if 120 < x < 150 or 80 < y < 90:
                color = (255, 255, 255)  # Asymmetric internal reference marks.
            rows.extend(color)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def build_fixture(source, output):
    assert hashlib.sha256(source.read_bytes()).hexdigest() == SOURCE_SHA256, "Unexpected scaffold source"
    with zipfile.ZipFile(source) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries["ppt/media/image1.png"] = test_png()
    slide = entries["ppt/slides/slide1.xml"]
    old = b'<a:off x="0" y="0"/><a:ext cx="303840" cy="303840"/>'
    assert slide.count(old) == 1, "Expected one crop target"
    entries["ppt/slides/slide1.xml"] = slide.replace(old, b'<a:off x="720000" y="720000"/><a:ext cx="4320000" cy="2880000"/>')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output")
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "eval/public/downloads/poi-picture-transparency.pptx")
    args = parser.parse_args()
    build_fixture(args.source, Path(args.output))

"""Chromium resource packs (.pak, data pack version 5): read, change, write.

    python pak.py stats <pak> [...]                     counts by content type
    python pak.py dump <pak> <outDir>                   writes every PNG, SVG and WebP out
    python pak.py replace <pak> <id> <file> <outPak>    a new pack with one resource swapped
"""
import gzip
import io
import struct
import sys
from pathlib import Path


def read(path):
    """-> dict(encoding, res={id: bytes}, alias=[(id, index)])."""
    data = Path(path).read_bytes()
    version, encoding = struct.unpack_from("<IB", data, 0)
    if version != 5:
        raise ValueError(f"{path}: pack version {version}, expected 5")
    count, aliases = struct.unpack_from("<HH", data, 8)
    pos = 12
    index = [struct.unpack_from("<HI", data, pos + i * 6) for i in range(count + 1)]
    pos += (count + 1) * 6
    alias = [struct.unpack_from("<HH", data, pos + i * 4) for i in range(aliases)]
    res = {index[i][0]: data[index[i][1]:index[i + 1][1]] for i in range(count)}
    return dict(encoding=encoding, res=res, alias=alias)


def to_bytes(pak):
    ids = sorted(pak["res"])
    header = struct.pack("<IBxxxHH", 5, pak["encoding"], len(ids), len(pak["alias"]))
    offset = len(header) + (len(ids) + 1) * 6 + len(pak["alias"]) * 4
    table = []
    for i in ids:
        table.append(struct.pack("<HI", i, offset))
        offset += len(pak["res"][i])
    table.append(struct.pack("<HI", 0, offset))
    return header + b"".join(table) + b"".join(struct.pack("<HH", *a) for a in pak["alias"]) + b"".join(pak["res"][i] for i in ids)


def write(pak, out):
    Path(out).write_bytes(to_bytes(pak))


def kind(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:2] == b"\x1f\x8b":
        return "gzip"
    if b[:2] == b"\x1e\x9b":
        return "brotli"
    head = b[:300].lstrip()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in b[:600]):
        return "svg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:3] == b"GIF":
        return "gif"
    if b[:4] in (b"wOF2", b"wOFF"):
        return "font"
    return "other"


def png_size(b):
    return struct.unpack(">II", b[16:24])


def inflate(b):
    """A gzip resource unpacked; anything else as it is."""
    if kind(b) == "gzip":
        try:
            return gzip.GzipFile(fileobj=io.BytesIO(b)).read()
        except OSError:
            return b
    return b


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "stats":
        for path in sys.argv[2:]:
            pak = read(path)
            counts, mentions, svgs = {}, 0, 0
            for b in pak["res"].values():
                k = kind(b)
                counts[k] = counts.get(k, 0) + 1
                body = inflate(b)
                if kind(body) == "svg":
                    svgs += 1
                if b"Brave" in body or b"brave" in body:
                    mentions += 1
            print(f"{Path(path).name}: {len(pak['res'])} resources {counts}; SVG after gunzip: {svgs}; resources mentioning brave: {mentions}")
    elif cmd == "dump":
        pak, out = read(sys.argv[2]), Path(sys.argv[3])
        out.mkdir(parents=True, exist_ok=True)
        n = 0
        for i, b in pak["res"].items():
            body = inflate(b)
            k = kind(body)
            if k in ("png", "svg", "webp"):
                (out / f"{i}.{k}").write_bytes(body)
                n += 1
        print("wrote", n, "images to", out)
    elif cmd == "replace":
        pak = read(sys.argv[2])
        rid = int(sys.argv[3])
        if rid not in pak["res"]:
            sys.exit("no such resource id")
        new = Path(sys.argv[4]).read_bytes()
        if kind(pak["res"][rid]) == "gzip":
            new = gzip.compress(new)
        pak["res"][rid] = new
        write(pak, sys.argv[5])
        print("wrote", sys.argv[5])
    else:
        print(__doc__)

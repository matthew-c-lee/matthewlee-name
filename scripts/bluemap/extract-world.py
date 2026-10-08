"""Extract an offline world ZIP without paths, links, or decompression bombs."""

import pathlib
import shutil
import stat
import sys
import zipfile


def extract(source, destination, limit):
    root = pathlib.Path(destination).resolve()
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 100000:
            raise ValueError("Too many archive entries")
        total = 0
        paths = set()
        for entry in entries:
            name = entry.filename
            parts = pathlib.PurePosixPath(name).parts
            mode = entry.external_attr >> 16
            if (not parts or "\\" in name or "\x00" in name
                    or name.startswith("/") or any(part in (".", "..") or ":" in part for part in parts)
                    or stat.S_ISLNK(mode) or entry.flag_bits & 1):
                raise ValueError("Unsafe archive entry")
            if mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("Archive entries must be files or directories")
            target = root.joinpath(*parts).resolve()
            if not target.is_relative_to(root) or str(target).casefold() in paths:
                raise ValueError("Unsafe or duplicate archive path")
            paths.add(str(target).casefold())
            total += entry.file_size
            if total > limit:
                raise ValueError("Archive exceeds the world size limit")
        for entry in entries:
            target = root.joinpath(*pathlib.PurePosixPath(entry.filename).parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as original, target.open("xb") as output:
                shutil.copyfileobj(original, output, length=1024 * 1024)
            if target.stat().st_size != entry.file_size:
                raise ValueError("Incomplete archive entry")


if __name__ == "__main__":
    try:
        extract(sys.argv[1], sys.argv[2], int(sys.argv[3]))
    except Exception:
        # Do not echo private source names or exception details into CI logs.
        sys.exit(1)

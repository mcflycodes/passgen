"""Package the verified static payload with stable paths, metadata and ordering."""
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path


def package(dist: Path, output: Path, version: str) -> Path:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid release version")
    if dist.is_symlink() or not dist.is_dir():
        raise ValueError("Not a plain directory")
    entries = sorted(dist.rglob("*"))
    if any(p.is_symlink() or not (p.is_file() or p.is_dir()) for p in entries):
        raise ValueError("Non-regular payload entry")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"passgen-{version}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zipped:
        for path in entries:
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(dist).as_posix(), (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                zipped.writestr(info, path.read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return archive


if __name__ == "__main__":
    version = json.loads(Path("package.json").read_text(encoding="utf-8"))["version"]
    package(Path("dist"), Path("release"), version)
    shutil.copyfile("dist-manifest/SHA256SUMS", "release/SHA256SUMS")

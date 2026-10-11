"""Adds sha256 hashes to a pip-compile lock file from PyPI's JSON API.

pip-compile --generate-hashes downloads every wheel of every platform to hash it
(several GB for torch's CUDA wheels). PyPI publishes the sha256 of every file, so
this reads them instead: every file of each pinned version is listed, which keeps
the lock valid on any platform. It also refuses a pinned release younger than 14
days (a supply-chain precaution; override with --min-age-days).

    python scripts/add_hashes.py requirements.lock [--min-age-days 14]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

PIN = re.compile(r"^([A-Za-z0-9._-]+)==([^\s;\\]+)")
BACKSLASH = "\\"


def release_files(name: str, version: str) -> list[dict[str, object]]:
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as response:
        data = json.load(response)
    files: list[dict[str, object]] = data["urls"]
    if not files:
        raise SystemExit(f"{name}=={version}: no files on PyPI")
    return files


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("lock", type=Path)
    parser.add_argument("--min-age-days", type=int, default=14)
    args = parser.parse_args()

    out: list[str] = []
    too_new: list[str] = []
    cutoff = datetime.now(UTC) - timedelta(days=args.min_age_days)
    lines = args.lock.read_text(encoding="utf-8").splitlines()
    for line in lines:
        if line.lstrip().startswith("--hash="):
            continue  # re-run safe: old hashes are replaced
        match = PIN.match(line)
        if not match:
            out.append(line)
            continue
        name, version = match.groups()
        files = release_files(name, version)
        uploaded = min(datetime.fromisoformat(str(f["upload_time_iso_8601"]).replace("Z", "+00:00")) for f in files)
        if uploaded > cutoff:
            too_new.append(f"{name}=={version} (uploaded {uploaded.date()})")
        hashes = sorted({str(f["digests"]["sha256"]) for f in files})  # type: ignore[index]
        requirement = line.rstrip().removesuffix(BACKSLASH).rstrip()  # re-run safe
        out.append(f"{requirement} {BACKSLASH}")
        out.extend(
            f"    --hash=sha256:{h}" + (f" {BACKSLASH}" if i < len(hashes) - 1 else "") for i, h in enumerate(hashes)
        )
        print(f"{name}=={version}: {len(hashes)} files, uploaded {uploaded.date()}")
    if too_new:
        sys.exit("refusing releases younger than the minimum age:\n  " + "\n  ".join(too_new))
    args.lock.write_text("\n".join(out) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

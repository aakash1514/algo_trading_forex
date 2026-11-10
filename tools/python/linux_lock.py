"""Derives an app's Linux lock (requirements.linux.lock, used by its Docker image) from its Windows lock
(requirements.lock), so the two can never pin different versions:

  - every package keeps its exact pin and its sha256 hashes (the Windows lock already lists every
    file of each pinned release, Linux wheels included);
  - Windows-only packages are dropped (pywin32: mcp requires it only on win32);
  - torch is pinned to the CPU-only build of the same version, from PyTorch's own index
    (download.pytorch.org/whl/cpu, the official publisher), with the sha256 that index publishes for
    the cp312 Linux wheels. PyPI's Linux torch is the CUDA build (about 2 GB of nvidia packages).

    python -I tools/python/linux_lock.py apps/ml-service/requirements.lock
    python -I tools/python/linux_lock.py apps/research-agent/requirements.lock

Only the torch hashes need the network. The app's tests (test_linux_lock.py) check, offline, that the
Linux lock is exactly this derivation of the Windows one."""

from __future__ import annotations

import re
import sys
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

WINDOWS_ONLY = {"pywin32"}
TORCH_INDEX = "https://download.pytorch.org/whl/cpu/torch/"
TORCH_PLATFORMS = ("manylinux_2_28_x86_64", "manylinux_2_28_aarch64")
MIN_AGE = timedelta(days=14)
PIN = re.compile(r"^([A-Za-z0-9._-]+)==([^\s;\\]+)")


def blocks(text: str) -> tuple[list[str], list[tuple[str, str, list[str]]]]:
    """The header comment lines, then (name, version, lines) for each pinned package."""
    header: list[str] = []
    out: list[tuple[str, str, list[str]]] = []
    for line in text.splitlines():
        m = PIN.match(line)
        if m:
            out.append((m.group(1).lower(), m.group(2), [line]))
        elif out:
            out[-1][2].append(line)
        else:
            header.append(line)
    return header, out


def torch_cpu_block(version: str) -> list[str]:
    page = urllib.request.urlopen(TORCH_INDEX, timeout=60).read().decode()
    hashes: list[str] = []
    for platform in TORCH_PLATFORMS:
        name = re.escape(f"torch-{version}%2Bcpu-cp312-cp312-{platform}.whl")
        m = re.search(rf'{name}#sha256=([0-9a-f]{{64}})"[^>]*data-upload-time="([^"]+)"', page)
        if not m:
            raise SystemExit(f"torch {version}+cpu has no cp312 {platform} wheel on {TORCH_INDEX}")
        uploaded = datetime.fromisoformat(m.group(2).replace("Z", "+00:00"))
        if datetime.now(UTC) - uploaded < MIN_AGE:
            raise SystemExit(f"torch {version}+cpu ({platform}) is younger than 14 days")
        hashes.append(m.group(1))
    return [f"torch=={version}+cpu \\"] + [
        f"    --hash=sha256:{h}" + (" \\" if i < len(hashes) - 1 else "") for i, h in enumerate(sorted(hashes))
    ] + ["    # CPU-only build from download.pytorch.org/whl/cpu (tools/python/linux_lock.py)"]


def derive(windows_lock: str, torch_block: list[str] | None) -> str:
    _, pinned = blocks(windows_lock)
    lines = [
        "#",
        "# Linux lock for the Docker image, derived from requirements.lock by tools/python/linux_lock.py.",
        "# Do not edit: change requirements.in, re-lock, then run the script again.",
        "#",
    ]
    for name, _version, block in pinned:
        if name in WINDOWS_ONLY:
            continue
        if name == "torch":
            if torch_block is None:
                raise SystemExit("torch is pinned but no CPU block was given")
            lines.extend(torch_block)
        else:
            lines.extend(block)
    return "\n".join(lines) + "\n"


def main() -> None:
    windows = Path(sys.argv[1])
    text = windows.read_text(encoding="utf-8")
    torch = next((v for n, v, _ in blocks(text)[1] if n == "torch"), None)
    out = windows.with_name("requirements.linux.lock")
    out.write_text(derive(text, torch_cpu_block(torch) if torch else None), encoding="utf-8", newline="\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

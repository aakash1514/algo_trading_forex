"""requirements.linux.lock (the Docker image's lock) must be exactly tools/python/linux_lock.py's
derivation of requirements.lock: same pins and hashes, Windows-only packages dropped, torch as the
CPU build of the same version. Offline: the torch block is taken from the Linux lock itself."""

from __future__ import annotations

import importlib.util

from research_agent.config import REPO_ROOT, SERVICE_ROOT

spec = importlib.util.spec_from_file_location("linux_lock", REPO_ROOT / "tools" / "python" / "linux_lock.py")
assert spec and spec.loader
linux_lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linux_lock)


def test_the_linux_lock_is_the_derivation_of_the_windows_lock() -> None:
    windows = (SERVICE_ROOT / "requirements.lock").read_text(encoding="utf-8")
    linux = (SERVICE_ROOT / "requirements.linux.lock").read_text(encoding="utf-8")
    _, windows_pins = linux_lock.blocks(windows)
    _, linux_pins = linux_lock.blocks(linux)
    assert len(windows_pins) > 20 and len(linux_pins) > 20  # an empty or truncated lock must fail
    torch = next((block for name, _, block in linux_pins if name == "torch"), None)
    assert linux_lock.derive(windows, torch) == linux
    assert not any(name in linux_lock.WINDOWS_ONLY for name, _, _ in linux_pins)
    versions = {name: version for name, version, _ in windows_pins}
    for name, version, _ in linux_pins:
        assert version == (versions[name] + "+cpu" if name == "torch" else versions[name])

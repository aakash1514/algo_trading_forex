"""Resumability of the walk-forward run: a fold counts as finished only when its JSON
(written last, atomically) and every file it names exist with matching sha256."""

from __future__ import annotations

from pathlib import Path

from ml_service.splits import Fold
from ml_service.walk_forward import LOGISTIC_GRID, LSTM_GRID, file_sha256, finished, stem, write_json_atomic


def make_fold_files(out: Path) -> str:
    name = stem("EUR/USD", Fold(2022))
    files = {}
    for key, suffix in (("lstm", "-lstm.pt"), ("logistic", "-logistic.pt"), ("test_predictions", "-test.npz")):
        path = out / f"{name}{suffix}"
        path.write_bytes(f"{key} artifact bytes".encode())
        files[key] = {"path": path.name, "sha256": file_sha256(path)}
    write_json_atomic(out / f"{name}.json", {"files": files})
    return name


def test_grid_is_window_32_only() -> None:
    assert [c.name for c in LSTM_GRID] == ["lstm-h32-w32", "lstm-h64-w32"]
    assert [c.name for c in LOGISTIC_GRID] == ["logistic-w32"]


def test_a_complete_fold_is_finished(tmp_path: Path) -> None:
    make_fold_files(tmp_path)
    assert finished(tmp_path, "EUR/USD", Fold(2022))
    assert not finished(tmp_path, "EUR/USD", Fold(2021))  # never started
    assert not list(tmp_path.glob("*.tmp"))  # the atomic write leaves no temp file


def test_a_missing_or_changed_file_means_not_finished(tmp_path: Path) -> None:
    name = make_fold_files(tmp_path)
    (tmp_path / f"{name}-test.npz").write_bytes(b"truncated")
    assert not finished(tmp_path, "EUR/USD", Fold(2022))
    (tmp_path / f"{name}-test.npz").unlink()
    assert not finished(tmp_path, "EUR/USD", Fold(2022))


def test_a_broken_marker_means_not_finished(tmp_path: Path) -> None:
    name = make_fold_files(tmp_path)
    (tmp_path / f"{name}.json").write_text("{not json", encoding="utf-8")
    assert not finished(tmp_path, "EUR/USD", Fold(2022))

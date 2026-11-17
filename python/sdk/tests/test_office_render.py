"""Reject unreadable Office output independently of the selected native engine."""

from __future__ import annotations

import builtins
import os
import runpy
import subprocess
import sys
import tempfile
from queue import Queue
from threading import Thread
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw


CHECKS = runpy.run_path(Path(__file__).resolve().parents[3] / "scripts/fixtures/office-render.py")


@pytest.mark.parametrize("winerror", [32, 33])
def test_workspace_cleanup_waits_for_a_transient_windows_sharing_violation(
    monkeypatch: pytest.MonkeyPatch, winerror: int,
) -> None:
    error = PermissionError("native mapping still held")
    error.winerror = winerror
    calls = []

    def cleanup() -> None:
        calls.append("cleanup")
        if len(calls) == 1:
            raise error

    delays = []
    monkeypatch.setattr(CHECKS["time"], "sleep", delays.append)
    CHECKS["_cleanup_workspace"](SimpleNamespace(cleanup=cleanup))
    assert calls == ["cleanup", "cleanup"]
    assert len(delays) == 1 and 0 < delays[0] <= 0.05


@pytest.mark.parametrize("sharing", [False, True])
def test_workspace_cleanup_reports_unrelated_or_persistent_failures(
    monkeypatch: pytest.MonkeyPatch, sharing: bool,
) -> None:
    error = PermissionError("cleanup failed")
    error.winerror = 32 if sharing else 5
    clocks = iter([10, 16])
    monkeypatch.setattr(CHECKS["time"], "monotonic", lambda: next(clocks))
    delays = []
    monkeypatch.setattr(CHECKS["time"], "sleep", delays.append)

    def cleanup() -> None:
        raise error

    with pytest.raises(PermissionError) as raised:
        CHECKS["_cleanup_workspace"](SimpleNamespace(cleanup=cleanup))
    assert raised.value is error
    assert delays == []


@pytest.mark.skipif(os.name != "nt", reason="Windows executable mapping and sharing behavior")
def test_workspace_cleanup_retries_after_the_lock_owner_has_exited() -> None:
    temporary = tempfile.TemporaryDirectory(prefix="dsh-office-lock-")
    path = Path(temporary.name) / "mapped.exe"
    path.write_bytes(b"locked native fixture")
    child = subprocess.Popen([sys.executable, "-c", """
import ctypes, sys
from ctypes import wintypes
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                              wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
handle = kernel.CreateFileW(sys.argv[1], 0x80000000, 0, None, 3, 0, None)
if handle == wintypes.HANDLE(-1).value:
    raise ctypes.WinError(ctypes.get_last_error())
print('locked', flush=True)
try:
    assert sys.stdin.readline() == 'release\\n'
finally:
    kernel.CloseHandle(handle)
""", str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ready: Queue[str] = Queue()
    reader = Thread(target=lambda: ready.put(child.stdout.readline()))
    reader.start()
    calls = []
    try:
        assert ready.get(timeout=5) == "locked\n"
        reader.join(timeout=5)
        assert not reader.is_alive()

        def cleanup() -> None:
            calls.append("cleanup")
            try:
                temporary.cleanup()
            except OSError:
                child.stdin.write("release\n")
                child.stdin.flush()
                _, stderr = child.communicate(timeout=5)
                assert child.returncode == 0, stderr
                raise

        CHECKS["_cleanup_workspace"](SimpleNamespace(cleanup=cleanup))
        assert calls == ["cleanup", "cleanup"]
        assert not path.parent.exists()
    finally:
        if child.poll() is None:
            child.kill()
        reader.join(timeout=5)
        child.communicate(timeout=5)
        assert not reader.is_alive()
        temporary.cleanup()


def test_fixture_load_does_not_require_pillow(monkeypatch: pytest.MonkeyPatch) -> None:
    original_import = builtins.__import__

    def blocked_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "PIL" or name.startswith("PIL."):
            raise ModuleNotFoundError(name)
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    loaded = runpy.run_path(Path(__file__).resolve().parents[3] / "scripts/fixtures/office-render.py")
    assert callable(loaded["check_render_manifest"])


def content_image() -> Image.Image:
    image = Image.new("RGBA", (400, 200), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 180, 160), fill=(215, 48, 39))
    draw.rectangle((220, 20, 380, 160), fill=(35, 111, 194))
    draw.rectangle((30, 170, 370, 180), fill="black")
    return image


@pytest.mark.parametrize("invalid", [None, "white", "transparent", "swapped", "no-text"])
def test_content_guard_checks_visible_colors_and_order(tmp_path: Path, invalid: str | None) -> None:
    image = content_image()
    if invalid == "white":
        image = Image.new("RGBA", image.size, "white")
    elif invalid == "transparent":
        image.putalpha(0)
    elif invalid == "swapped":
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif invalid == "no-text":
        ImageDraw.Draw(image).rectangle((0, 165, 399, 199), fill="white")
    path = tmp_path / "page.png"
    image.save(path)
    if invalid is None:
        CHECKS["check_image"](path)
    else:
        with pytest.raises(AssertionError, match="Office image"):
            CHECKS["check_image"](path)


@pytest.mark.parametrize("invalid", [None, "backend", "rasterEngine", "source", "images"])
def test_manifest_guard_requires_direct_native_office(tmp_path: Path, invalid: str | None) -> None:
    path = tmp_path / "page.png"
    content_image().save(path)
    manifest = {"backend": "native", "rasterEngine": "libreoffice", "source": "saved", "images": [{"path": str(path)}]}
    if invalid:
        manifest[invalid] = [] if invalid == "images" else "other"
        with pytest.raises(AssertionError):
            CHECKS["check_render"](manifest, "native")
    else:
        CHECKS["check_render"](manifest, "native")


@pytest.mark.parametrize("fails", [False, True])
def test_workspace_retains_only_render_evidence_and_cleans_its_root(tmp_path: Path, fails: bool) -> None:
    artifacts = tmp_path / "artifacts"
    try:
        with CHECKS["workspace"](artifacts) as root:
            inputs = root / "relocated"
            inputs.mkdir()
            CHECKS["copy_documents"](inputs)
            batch = inputs / "cli-docx"
            batch.mkdir()
            content_image().save(batch / "page.png")
            (batch / "manifest.json").write_text("{}")
            (batch / "not-render-evidence.txt").write_text("excluded")
            (root / "runtime.bin").write_bytes(b"excluded")
            if fails:
                raise AssertionError("render failed")
    except AssertionError as error:
        assert fails and str(error) == "render failed"
    assert not root.exists()
    assert len(list(artifacts.glob("color-blocks.*"))) == 3
    assert sorted(file.name for file in (artifacts / "cli-docx").iterdir()) == ["manifest.json", "page.png"]
    assert not (artifacts / "runtime.bin").exists()
    assert (artifacts / "error.txt").exists() == fails


def test_cli_checks_every_format_before_reporting_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    documents = CHECKS["copy_documents"](tmp_path)
    calls = []

    def failed_command(arguments: list[str], **options: object) -> SimpleNamespace:
        calls.append(Path(arguments[arguments.index("--input") + 1]).suffix)
        return SimpleNamespace(returncode=7, stderr="engine failed", stdout="")

    monkeypatch.setattr(CHECKS["subprocess"], "run", failed_command)
    with pytest.raises(AssertionError) as failure:
        CHECKS["render_cli"](["kit"], documents, tmp_path, "native", {})
    assert calls == [".docx", ".pptx", ".xlsx"]
    for extension in documents:
        assert f"{extension}: AssertionError: exit 7: engine failed" in str(failure.value)


def test_cli_can_check_metadata_without_pillow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    document = tmp_path / "input.docx"
    document.write_bytes(b"fixture")
    manifest = {
        "backend": "native", "rasterEngine": "libreoffice", "source": "saved",
        "images": [{"path": str(tmp_path / "page.png")}],
    }

    monkeypatch.setattr(
        CHECKS["subprocess"], "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stderr="", stdout=CHECKS["json"].dumps(manifest)),
    )
    monkeypatch.setitem(CHECKS, "check_image", lambda path: pytest.fail(f"unexpected pixel check: {path}"))
    CHECKS["render_cli"](["kit"], {"docx": document}, tmp_path, "native", {}, check_content=False)

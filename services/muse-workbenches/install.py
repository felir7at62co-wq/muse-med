"""Install the Muse authentication adapter into an extracted 2026-11-17 source tree."""
import argparse
import os
from pathlib import Path
import re
import tempfile

from install_character_references import changes as character_reference_changes

HERE = Path(__file__).resolve().parent
AUDIENCES = ("jingliu",)


def install(audience, backend, frontend=None, *, library_only=False):
    """Validate every archive hook before atomically replacing individual files."""
    app = backend / "app"
    changes = {}

    def transform(path, before, after):
        text = changes.get(path, path.read_text(encoding="utf-8"))
        if after in text and text.count(after) == 1:
            return
        if text.count(before) != 1:
            raise ValueError(f"Unsupported archive hook in {path.name}")
        changes[path] = text.replace(before, after, 1)

    if audience != "jingliu":
        raise ValueError("Unsupported studio")
    if not library_only:
        prepare_app(audience, app, frontend, changes, transform)
    character_reference_changes(backend, frontend, transform, changes)

    for path, value in changes.items():
        if path.exists() and path.read_bytes() == value.encode():
            continue
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as target:
            target.write(value)
        try:
            os.chmod(target.name, mode)
            os.replace(target.name, path)
        finally:
            Path(target.name).unlink(missing_ok=True)


def prepare_app(audience, app, frontend, changes, transform):
    main = app / "main.py"
    anchor = "    app.include_router(auth_router)"
    install_hook = ('    from .muse_login import configure_muse_login\n'
                    f'    configure_muse_login(app, "{audience}")\n' + anchor)
    transform(main, anchor, install_hook)
    for path, rate in [(app / "routers/jianying.py", "DRAFT_FPS"), (app / "nd/export.py", "J.DRAFT_FPS")]:
        transform(path, f"draft.ScriptFile(w, h, {rate})", f"draft.ScriptFile(w, h, {rate}, maintrack_adsorb=True)")
        source = changes.get(path, path.read_text())
        source = re.sub(r"script\.add_track\((TrackType\.\w+(?:, [^\n()]+)?)\)", r"script.append_track(draft.TrackSpec(\1))", source)
        changes[path] = source.replace("track_name=", "track=")
    for key in ("    if settings.auth_upstream:\n", '            "login": bool(settings.auth_upstream),'):
        if key not in changes.get(main, main.read_text()):
            raise ValueError(f"Missing original Jingliu access control in {main.name}")
    for name in ("muse_login.py", "muse_login.js", "muse_storage.js"):
        changes[app / name] = (HERE / name).read_text(encoding="utf-8")

    if frontend:
        index = frontend / "index.html"
        transform(index, '<head>\n', '<head>\n<script src="/fwp/v2/auth/muse/storage.js"></script>\n')
        transform(index, '<p class="hint">用飞书扫码登录</p>', '<p class="hint">使用 Muse 账号进入镜流</p>')
        transform(index, 'id="gate-btn">飞书扫码登录', 'id="gate-btn">使用 Muse 登录')
        entry = frontend / "app.js"
        text = changes.get(entry, entry.read_text(encoding="utf-8"))
        replacement = """$('#gate-btn').onclick = () => location.assign('/fwp/v2/auth/muse/login');"""
        if replacement not in text:
            start = "$('#gate-btn').onclick = async () => {"
            end = "\n};\n\n$('#btn-logout').onclick"
            if text.count(start) != 1 or text.count(end) != 1:
                raise ValueError("Unsupported Jingliu login handler")
            head, old_handler = text.split(start)
            close = old_handler.index(end) + len("\n};")
            changes[entry] = head + replacement + old_handler[close:]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audience", choices=AUDIENCES, required=True)
    parser.add_argument("--backend", type=Path, required=True, help="Directory containing app/main.py")
    parser.add_argument("--frontend", type=Path, help="Jingliu dist-prod")
    parser.add_argument("--library-only", action="store_true", help="Update only the Jingliu shared catalog on an installed site")
    args = parser.parse_args()
    install(args.audience, args.backend, args.frontend, library_only=args.library_only)

"""Install the Muse authentication adapter into an extracted 2026-11-17 source tree."""
import argparse
import os
from pathlib import Path
import re
import tempfile

HERE = Path(__file__).resolve().parent
AUDIENCES = ("script-workshop", "jingliu")


def install(audience, backend, frontend=None):
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

    main = app / "main.py"
    anchor = "    app.include_router(auth_router)"
    # Both archived backends register this router once. Add the adapter outside that line's comment.
    install_hook = ('    from .muse_login import configure_muse_login\n'
                    f'    configure_muse_login(app, "{audience}")\n' + anchor)
    transform(main, anchor, install_hook)
    if audience == "jingliu":
        for key in ("    if settings.auth_upstream:\n", '            "login": bool(settings.auth_upstream),'):
            if key not in changes.get(main, main.read_text()):
                raise ValueError(f"Missing original Jingliu access control in {main.name}")
    for name in ("muse_login.py", "muse_login.js", "muse_storage.js"):
        changes[app / name] = (HERE / name).read_text(encoding="utf-8")

    if frontend and audience == "jingliu":
        index = frontend / "index.html"
        transform(index, '<head>\n', '<head>\n<script src="/fwp/v2/auth/muse/storage.js"></script>\n')
        transform(index, '<p class="hint">用飞书扫码登录</p>', '<p class="hint">使用 Muse 账号进入镜流</p>')
        transform(index, 'id="gate-btn">飞书扫码登录', 'id="gate-btn">使用 Muse 登录')
        entry = frontend / "app.js"
        text = entry.read_text(encoding="utf-8")
        replacement = """$('#gate-btn').onclick = () => location.assign('/fwp/v2/auth/muse/login');"""
        if replacement not in text:
            start = "$('#gate-btn').onclick = async () => {"
            end = "\n};\n\n$('#btn-logout').onclick"
            if text.count(start) != 1 or text.count(end) != 1:
                raise ValueError("Unsupported Jingliu login handler")
            head, old_handler = text.split(start)
            close = old_handler.index(end) + len("\n};")
            changes[entry] = head + replacement + old_handler[close:]
    elif frontend:
        layout = frontend / "app" / "layout.tsx"
        transform(layout, '<html lang="zh-CN">', '<html lang="zh-CN">\n      <head><script src="/v1/auth/muse/storage.js"></script></head>')
        banner = 'import { FeishuBindBanner } from "@/components/auth/FeishuBindBanner";'
        text = changes.get(layout, layout.read_text(encoding="utf-8"))
        if banner in text and text.count("<FeishuBindBanner />") == 1:
            text = text.replace(banner + "\n", "").replace("          <FeishuBindBanner />\n", "")
            text = re.sub(r"^.*\{/\* 过渡期: 未绑定飞书.*\n", "", text, flags=re.M)
            changes[layout] = text
        elif banner in text or "<FeishuBindBanner" in text:
            raise ValueError("Unsupported Workshop account binding banner")
        for page in ("login", "register"):
            path = frontend / "app" / page / "page.tsx"
            old = path.read_text(encoding="utf-8")
            if "export default" not in old:
                raise ValueError(f"Unsupported Workshop {page} page")
            changes[path] = ('import { redirect } from "next/navigation";\n\n'
                             'export default function MuseLoginPage() {\n'
                             '  redirect("/v1/auth/muse/login");\n}\n')

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audience", choices=AUDIENCES, required=True)
    parser.add_argument("--backend", type=Path, required=True, help="Directory containing app/main.py")
    parser.add_argument("--frontend", type=Path, help="Workshop apps/web or Jingliu dist-prod")
    args = parser.parse_args()
    install(args.audience, args.backend, args.frontend)

"""Add the workbench locations to the current Muse TLS virtual host and reload nginx."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path("/srv/muse-workbenches")
source = (root / "current/workbenches.locations.conf").read_bytes()
site = Path("/etc/nginx/sites-enabled/muse.aigc-pipeline.cn.conf").resolve(strict=True)
target = Path("/etc/nginx/muse-workbenches.locations.conf")
backup = root / "verification/nginx-before-paths.conf"
anchor = "    include /etc/nginx/muse-market-first-batch.locations.conf;"
include = "    include /etc/nginx/muse-workbenches.locations.conf;"
original = site.read_bytes()
prior = target.read_bytes() if target.exists() else None
if not backup.exists():
    shutil.copy2(site, backup)
text = original.decode()
if text.count(anchor) != 1 or text.count(include) > 1:
    raise ValueError("The Muse TLS virtual host has changed; inspect its location includes")
new = text if include in text else text.replace(anchor, anchor + "\n" + include)


def put(path, data):
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            os.fchmod(file.fileno(), mode)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


put(target, source)
put(site, new.encode())
try:
    subprocess.run(["nginx", "-t"], check=True)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
except Exception:
    put(site, original)
    if prior is None:
        target.unlink(missing_ok=True)
    else:
        put(target, prior)
    subprocess.run(["nginx","-t"],check=True)
    subprocess.run(["systemctl","reload","nginx"],check=True)
    raise
print("Muse HTTPS virtual host reloaded. Previous configuration retained in verification.")

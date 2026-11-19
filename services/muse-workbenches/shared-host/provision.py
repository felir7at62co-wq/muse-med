"""Create one fresh installation using the account verified by the deployment operator."""
import grp
import subprocess
import json
import os
import secrets
import sys
from pathlib import Path

BASE = Path("/srv/muse-workbenches")
ORIGIN = "https://muse.aigc-pipeline.cn"
identity = json.load(sys.stdin)
subject, username, cookie_name = (identity[k] for k in ("accountId", "username", "cookieName"))
if not all(isinstance(v, str) and v.strip() for v in (subject, username, cookie_name)):
    raise ValueError("Missing verified Muse identity")
if len(username) > 64 or any(c in "\r\n\0" for c in username + subject):
    raise ValueError("Invalid identity")
os.umask(0o077)


def save(path, content, group=None):
    with path.open("x", encoding="utf-8") as stream:
        stream.write(content)
        if group:
            os.fchown(stream.fileno(), 0, grp.getgrnam(group).gr_gid)
            os.fchmod(stream.fileno(), 0o640)


def token():
    return secrets.token_urlsafe(40)


config = BASE / "config"
private = config / "bootstrap"
private.mkdir(mode=0o700, exist_ok=True)
secrets_file = private / "secrets.json"
if not secrets_file.exists():
    save(secrets_file, json.dumps({"jingliu": token()}))
keys = json.loads(secrets_file.read_text())
common = dict(MUSE_WORKBENCH_ISSUER=ORIGIN, MUSE_WORKBENCH_PUBLIC_ORIGIN=ORIGIN,
              MUSE_WORKBENCH_SHARED_HOST="1", PYTHONDONTWRITEBYTECODE="1",
              PYTHONUNBUFFERED="1")
readers = "muse-wb-readers"
try:
    grp.getgrnam(readers)
except KeyError:
    subprocess.run(["groupadd", "--system", readers], check=True)
for user in ("muse-edge", "muse-jingliu"):
    subprocess.run(["usermod", "-aG", readers, user], check=True)
bindings = config / "bindings"
bindings.mkdir(mode=0o750, exist_ok=True)
os.chown(bindings, 0, grp.getgrnam(readers).gr_gid)
os.chmod(bindings, 0o750)
edge = dict(origin=ORIGIN, port=19740, gateway="http://127.0.0.1:19389", cookieName=cookie_name, apps={})
app = "jingliu"
data = BASE / "state" / app
binding = {"issuer": ORIGIN, "users": {subject: 10001}}
native_binding = bindings / (app + ".json")
if native_binding.exists():
    if json.loads(native_binding.read_text()) != binding:
        raise ValueError("Installation already has other workbench members")
else:
    save(native_binding, json.dumps(binding), readers)
env = dict(common, MUSE_WORKBENCH_SECRET=keys[app], MUSE_WORKBENCH_BINDINGS=str(native_binding),
           MUSE_WORKBENCH_STATE_DB=str(data / "muse-signin.sqlite3"))
env.update(FW_ENV="prod", FW_DATA_DIR=str(data), FW_DATABASE_URL="sqlite:///" + str(data / "jingliu.db"),
           FW_AUTH_UPSTREAM=ORIGIN, FW_PUBLIC_BASE_URL=ORIGIN + "/jingliu", FW_FEISHU_CALLBACK_BASE=ORIGIN + "/jingliu/fwp",
           FW_FEISHU_NOTIFY_ENABLED="false", FW_FEISHU_BOT_ENABLED="false", FW_ADMIN_USER_IDS="", HOME=str(data))
path = config / app / "service.env"
if not path.exists():
    save(path, "".join(k + "='" + v + "'\n" for k, v in env.items()), "muse-" + app)
edge["apps"][app] = dict(bindings=str(native_binding), nativeLogin="http://127.0.0.1:19743/v2/auth/muse/internal-session", secret=keys[app])
edge_path = config / "edge" / "config.json"
if not edge_path.exists():
    save(edge_path, json.dumps(edge), "muse-edge")
if not (private / "identity.json").exists():
    save(private / "identity.json", json.dumps({"id": 10001, "username": username}, ensure_ascii=False))
print("New workbench configuration and local account binding ready.")

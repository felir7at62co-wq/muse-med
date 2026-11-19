"""Provision an isolated Workshop SDK home using a previously authorized cloud Muse profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
from tempfile import NamedTemporaryFile

ENGINE_FILES = ("common.py", "native.py", "verification.py", "episode-scope.mjs", "episode-prompt.txt", "workshop_episode.py")


def write(path, data, uid, gid, mode):
    if path.is_symlink():
        raise ValueError(f"unexpected symlink: {path}")
    if path.is_file() and path.read_bytes() == data:
        return
    with NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        stream.write(data)
    try:
        os.chown(tmp, uid, gid)
        tmp.chmod(mode)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def prepare(root, runtime, approved_home, engine, skills, provider, model, slots, timeout):
    if slots < 1 or timeout < 1:
        raise ValueError("invalid runner capacity")
    account = pwd.getpwnam("muse-workshop")
    owned = account.pw_uid, account.pw_gid
    payload = {f: (engine / f).read_bytes() for f in ENGINE_FILES}
    fingerprint = hashlib.sha256(b"".join(f.encode() + b"\0" + hashlib.sha256(b).digest()
                                          for f, b in sorted(payload.items()))).hexdigest()
    installed = root / "runtime/reverse" / fingerprint
    installed.mkdir(parents=True, exist_ok=True)
    for f, b in payload.items():
        write(installed / f, b, 0, 0, 0o644)
    state = root / "state/workshop"
    home = state / "reverse-sdk"
    work = state / "reverse"
    for path in (home, work, home / "account", home / "presets", home / "presets/transcription"):
        path.mkdir(mode=0o700, exist_ok=True)
        os.chown(path, *owned)
    source = approved_home / "account/session.json"
    if source.is_symlink() or source.stat().st_mode & 0o077 or not json.loads(source.read_text()).get("cookie"):
        raise ValueError("approved account session missing or not private")
    dest = home / "account/session.json"
    if not dest.exists():
        write(dest, source.read_bytes(), *owned, 0o600)
    for name in ("preset.yml", "agent.cordis.yml"):
        write(home / "presets/transcription" / name, (approved_home / "presets/transcription" / name).read_bytes(), *owned, 0o600)
    profile = (approved_home / "transcription.patch.json").read_text()
    if profile.count(str(approved_home)) != 3:
        raise ValueError("unsupported cloud profile; verify the account, preset and session paths")
    write(home / "transcription.patch.json", profile.replace(str(approved_home), str(home)).encode(), *owned, 0o600)
    config_path = root / "config/workshop/reverse.json"
    cfg = {"sdkHome": str(home), "stateRoot": str(work), "runner": str(installed / "workshop_episode.py"),
           "python": str(runtime / "tools/sdk-venv/bin/python"), "pythonPath": str(runtime / "source/python/sdk/src"),
           "sourceRoot": str(runtime / "source"), "node": str(runtime / "tools/bin/node"),
           "dsh": str(runtime / "source/apps/cli/lib/bin.js"), "mediaRuntime": str(runtime / "resources/primary-runtime"),
           "skillFiles": str(skills), "sdkPatch": str(home / "transcription.patch.json"),
           "ffprobe": "/usr/bin/ffprobe", "ffmpeg": "/usr/bin/ffmpeg", "provider": provider, "model": model,
           "parallelEpisodes": slots, "episodeTimeoutSeconds": timeout, "episodeAttempts": 2}
    if config_path.exists():
        previous = json.loads(config_path.read_text())
        if previous.get("tosPrefix"):
            cfg["tosPrefix"] = previous["tosPrefix"]
    write(config_path, (json.dumps(cfg, indent=2) + "\n").encode(), 0, account.pw_gid, 0o640)
    print(json.dumps({"engine": fingerprint, "config": str(config_path), "parallelEpisodes": slots}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "runtime", "approved-home", "engine", "skills"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--slots", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=7200)
    args = parser.parse_args()
    prepare(args.root, args.runtime, args.approved_home, args.engine, args.skills,
            args.provider, args.model, args.slots, args.timeout)

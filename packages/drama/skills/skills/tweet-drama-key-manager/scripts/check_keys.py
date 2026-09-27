#!/usr/bin/env python3
"""Check the Jubian login token where the product actually keeps it.

Resolution order, highest first — the same order the DSH credential provider and
the Jubian tools use:

  1. inherited environment: JUBIANAI_ADMIN_TOKEN, then the legacy JUBIAN_TOKEN
  2. the harness credential store DSH_HOME/.credentials.yaml (refs:)
  3. explicit DSH_PIPELINE_ENV, else the nearest .agents/secrets/pipeline.env
     above the launch directory

Prints only variable names and which source supplied them, never values.
Exit code 0 if the required token is present, 1 if missing.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REQUIRED = ["JUBIANAI_ADMIN_TOKEN"]

# Accepted spellings of the login token, highest first. The legacy name is read
# but never reported as the current one.
TOKEN_ENV_KEYS = ("JUBIANAI_ADMIN_TOKEN", "JUBIAN_TOKEN")

# Optional values are reported only when a file supplies them. A product
# deployment keeps JUBIANAI_BASE_URL in the credential store; the draft editor
# directory stays a pipeline.env field.
OPTIONAL_ENV_KEYS = ("JUBIANAI_BASE_URL", "剪映草稿地址")

CREDENTIAL_FILENAME = ".credentials.yaml"
WORKSPACE_SECRET = Path(".agents") / "secrets" / "pipeline.env"


def harness_home() -> Path:
    """The one home this check reads: DSH_HOME, else ~/.dsh."""
    configured = os.environ.get("DSH_HOME")
    home = Path(configured).expanduser() if configured else Path.home() / ".dsh"
    return home.resolve()


def strip_scalar(value: str) -> str:
    """Drop a YAML inline comment and one layer of quoting; never the token's own tail semicolon."""
    comment = value.find(" #")
    if comment >= 0:
        value = value[:comment]
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value.strip()


def read_key_file(path: Path) -> dict[str, str]:
    """Read `key: value` / `key=value` pairs, skipping comments and continuations.

    A value that opens a quote without closing it on the same line is a folded
    multi-line scalar; keep it out rather than returning a fragment.
    """
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return values
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" in stripped and ("=" not in stripped or stripped.index(":") < stripped.index("=")):
            key, _, raw = stripped.partition(":")
        elif "=" in stripped:
            key, _, raw = stripped.partition("=")
        else:
            continue
        key, raw = key.strip(), raw.strip()
        if not key:
            continue
        if raw[:1] in ("\"", "'") and raw.count(raw[0]) < 2:
            continue  # an unclosed quote opens a folded multi-line scalar; a fragment is worse than nothing
        value = strip_scalar(raw)
        if value:
            values.setdefault(key, value)
    return values


def workspace_secret(start: Path | None = None) -> Path | None:
    """The nearest workspace pipeline.env at or above `start`, or None."""
    directory = (start or Path.cwd()).resolve()
    while True:
        candidate = directory / WORKSPACE_SECRET
        if candidate.is_file():
            return candidate
        parent = directory.parent
        if parent == directory:
            return None
        directory = parent


def secret_paths() -> list[Path]:
    """Candidate files in resolution order; a missing file is reported as absent."""
    explicit = os.environ.get("DSH_PIPELINE_ENV")
    candidates = [harness_home() / CREDENTIAL_FILENAME]
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    else:
        found = workspace_secret()
        if found is not None:
            candidates.append(found)
    return candidates


def resolve() -> tuple[list[tuple[str, str, Path]], dict[str, str]]:
    """Resolve the login token and optional values.

    @returns the `(key, source label, file)` rows that supplied a value, and the
      optional values found in the candidate files. No value is returned.
    """
    supplied: list[tuple[str, str, Path]] = []
    optionals: dict[str, str] = {}
    for key in TOKEN_ENV_KEYS:
        if os.environ.get(key):
            supplied.append((key, "环境变量", Path("<process environment>")))
            break
    for path in secret_paths():
        values = read_key_file(path)
        if not supplied:
            for key in TOKEN_ENV_KEYS:
                if values.get(key):
                    supplied.append((key, "凭据文件", path))
                    break
        for key in OPTIONAL_ENV_KEYS:
            if values.get(key):
                optionals.setdefault(key, str(path))
    return supplied, optionals


def main() -> int:
    supplied, optionals = resolve()
    secret = supplied[0] if supplied else None

    print("== 解析顺序（高到低）==")
    print("  环境变量 JUBIANAI_ADMIN_TOKEN / JUBIAN_TOKEN")
    print(f"  凭据库 {harness_home() / CREDENTIAL_FILENAME}")
    print("  DSH_PIPELINE_ENV，否则最近的 .agents/secrets/pipeline.env")
    print()
    print("== 实际来源 ==")
    if secret is None:
        for path in secret_paths():
            print(f"  [缺失] {path}")
    else:
        key, label, path = secret
        print(f"  [OK] JUBIANAI_ADMIN_TOKEN 来自{label}：{path}")
        if key != REQUIRED[0]:
            print(f"  [提醒] 命中的是兼容变量名 {key}，建议迁移到 {REQUIRED[0]}")
    print()
    print("== 可选 ==")
    for key in OPTIONAL_ENV_KEYS:
        print(f"  [{'OK' if key in optionals else '-'}] {key}")
    print()

    if secret is None:
        print("缺失必需变量: " + ", ".join(REQUIRED))
        print("请在产品设置里填写剧变登录凭证（或设置同名环境变量），不要手工散落明文；随后重跑本检查。")
        return 1
    print("必需变量齐全。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

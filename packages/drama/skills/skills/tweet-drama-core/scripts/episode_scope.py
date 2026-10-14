"""Validate explicit local assignments separately from whole-story episode totals."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def is_episode_id(value: Any) -> bool:
    """Accept canonical decimal episode IDs from 01 through 9999."""
    return (isinstance(value, str) and re.fullmatch(r"[0-9]{2,4}", value) is not None
            and 1 <= int(value) <= 9999 and value == f"{int(value):02d}")


def resolve_episode_scope(manifest: Any) -> list[str]:
    """Return the declared assignment, or the legacy full-story 01..N scope.

    Explicit assignments are never inferred from existing files or manifest rows.
    Missing assigned rows are checked by the source inventory, not omitted here.
    """
    if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1:
        raise ValueError("分集清单 version 必须为 1")
    entries = manifest.get("episodes")
    if not isinstance(entries, dict) or not entries:
        raise ValueError("分集清单缺少非空 episodes 对象")
    if any(not is_episode_id(ep) for ep in entries):
        raise ValueError("分集清单包含无效或未规范化集号")
    total = manifest.get("expected_episode_count")
    if "expected_episode_count" in manifest and (type(total) is not int or not 1 <= total <= 9999):
        raise ValueError("expected_episode_count 必须是 1–9999 的整数（整剧总集数）")
    if total is not None and any(int(ep) > total for ep in entries):
        raise ValueError("分集清单集号超出 expected_episode_count")
    if "work_scope" not in manifest:
        end = total if total is not None else max(map(int, entries))
        return [f"{number:02d}" for number in range(1, end + 1)]
    scope = manifest["work_scope"]
    if not isinstance(scope, dict) or set(scope) != {"episode_ids"}:
        raise ValueError("work_scope 必须是仅含 episode_ids 的对象")
    ids = scope["episode_ids"]
    if not isinstance(ids, list) or not ids or any(not is_episode_id(ep) for ep in ids):
        raise ValueError("work_scope.episode_ids 必须是非空规范集号列表（01–9999）")
    if ids != sorted(set(ids), key=int):
        raise ValueError("work_scope.episode_ids 必须按升序且无重复")
    if total is not None and any(int(ep) > total for ep in ids):
        raise ValueError("work_scope 集号超出 expected_episode_count")
    return list(ids)


def read_episode_manifest(path: Path) -> Any:
    """Read a manifest without silently replacing duplicate scope, ID or hash keys."""
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"分集清单包含重复字段: {key}")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_object)

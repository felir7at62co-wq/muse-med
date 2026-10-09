"""Fail-closed, offline episode-to-shot coverage evidence.

``audit`` reads only project files. ``accept`` signs only fully verified episodes.
This checks textual identity and explicit source-to-shot membership, not whether
an action was depicted well or a generated video is visually acceptable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VERSION = 1
SPEECH_KINDS = {"dialogue", "os", "vo"}
NON_SPEECH_KINDS = {"action", "scene", "state", "transition", "heading"}
SHOT_MARKER = re.compile(r"^【镜头(\d+)】[ \t]*$", re.MULTILINE)
SHOT_SPEECH = re.compile(r"^(台词|画外音|画外声|心声|旁白|解说|VO|OS|dialogue)[：:][ \t]*(.*)$", re.MULTILINE | re.IGNORECASE)
SOURCE_PREFIX = re.compile(r"^([^：:]{1,30})[：:]\s*(.+)$")
EPISODE_HEADER = re.compile(r"^\s*(?:第\s*(\d+)\s*[集话回章]|(?:EP|EPISODE)\s*[._-]?\s*(\d+)\b)", re.IGNORECASE)
OFFSCREEN_SUFFIX = re.compile(r"[（(]\s*(?:画外音|VO)\s*[）)]\s*$", re.IGNORECASE)
SOURCE_SUFFIX = re.compile(r"[（(]\s*(OS|VO|画外音|心声|旁白|解说)\s*[）)]\s*$", re.IGNORECASE)
ACTION_SPEECH = re.compile(r"^(?:[△▲]\s*|(?:动作|画面)[：:]\s*)([^：:]{1,30}?)(?:说道?|喊道?|问道?|答道?|念道?|低语|耳语|自语|开口)[：:]\s*(.+)$")
ACTION_SPEECH_HINT = re.compile(r"说|喊|问|答|念|低语|耳语|自语|开口|[“”\"「」]")
SKIP_SPEAKER = {"场景", "时间", "地点", "镜头", "画面", "动作", "人物", "状态", "环境", "转场", "备注", "说明"}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _content_sha(text: str) -> str:
    # script_processor.py hashes cleaned_content encoded as UTF-8.
    return _sha(text.encode("utf-8"))


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _project_file(project: Path, value: str) -> Path | None:
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        return None
    path = (project / value).resolve()
    return path if path.is_relative_to(project) else None


def _source_speech(line: str) -> tuple[str, str, str] | None:
    """Recognize unambiguous director-style source speech; never infer a speaker.

    Unsupported source speech layouts require review rather than a machine pass.
    """
    line = line.strip()
    action_speech = ACTION_SPEECH.fullmatch(line)
    if action_speech is not None:
        return "dialogue", action_speech.group(1).strip(), action_speech.group(2).strip()
    if not line or _non_speech_kind(line) is not None:
        return None
    match = SOURCE_PREFIX.fullmatch(line)
    if match is None:
        return None
    prefix, text = match.group(1).strip(), match.group(2).strip()
    if prefix in SKIP_SPEAKER or not text:
        return None
    if prefix.upper() in {"OS", "VO"}:
        inner = SOURCE_PREFIX.fullmatch(text)
        if inner is None:
            return None
        return prefix.lower(), inner.group(1).strip(), inner.group(2).strip()
    suffix = SOURCE_SUFFIX.search(prefix)
    if suffix is not None:
        marker = suffix.group(1).lower()
        if marker == "画外音":
            # Generic offscreen audio does not establish the original OS/VO subtype.
            return None
        kind = "os" if marker in {"os", "心声"} else "vo"
        speaker = prefix[:suffix.start()].strip()
    elif re.search(r"(?:OS|VO)$", prefix, re.IGNORECASE):
        # Common screenplay suffix without parentheses, e.g. “周桂芳OS”.
        marker = prefix[-2:].lower()
        kind, speaker = marker, prefix[:-2].strip()
    elif prefix in {"旁白", "解说", "心声"}:
        kind = "os" if prefix == "心声" else "vo"
        speaker = prefix
    else:
        kind, speaker = "dialogue", prefix
    if any(mark in speaker for mark in ("（", "）", "(", ")")):
        # An unknown parenthetical can be identity, performance, or voice mode.
        # Require a human-readable normalization before signing a pass.
        return None
    if not speaker or not text:
        return None
    return kind, speaker, text


def _non_speech_kind(line: str) -> str | None:
    """Only unambiguous headings and prefixed directions can pass unattended."""
    stripped = line.strip()
    if EPISODE_HEADER.fullmatch(stripped) or re.fullmatch(r"(?:第\s*\d+\s*集|EP\s*\d+)[：:].+", stripped, re.IGNORECASE):
        return "heading"
    if re.match(r"^\d{1,3}[-－]\d{1,3}(?:\s|$)", stripped) or re.match(r"^(?:场景|地点|时间|环境)[：:]", stripped):
        return "scene"
    if stripped.startswith(("△", "▲")):
        return None if ACTION_SPEECH_HINT.search(stripped) else "action"
    if re.match(r"^(?:动作|画面)[：:]", stripped):
        return None if ACTION_SPEECH_HINT.search(stripped) else "action"
    if re.match(r"^(?:人物状态|状态)[：:]", stripped):
        return "state"
    if re.match(r"^(?:转场|切至|闪回)[：:]", stripped):
        return "transition"
    return None


def _shot_speech(body: str) -> tuple[str, str | None, str, str] | None:
    lines = list(SHOT_SPEECH.finditer(body))
    if not lines:
        return None
    if len(lines) != 1:
        raise ValueError("镜头含多条发声行，须先通过 drama_shot validate")
    label, spoken = lines[0].group(1).lower(), lines[0].group(2).strip()
    field = re.search(r"^(?:发声类型|语音类型)[：:]\s*(.+)$", body, re.MULTILINE)
    declared = field.group(1).strip().lower() if field else ""
    speaker_field = re.search(r"^说话人[：:]\s*(.+)$", body, re.MULTILINE)
    speaker = speaker_field.group(1).strip() if speaker_field else ""
    offscreen = declared in {"vo", "画外音", "os"} or label in {"vo", "os", "画外音", "画外声", "心声", "旁白", "解说"}
    subtype = ("os" if label in {"os", "心声"} else
               "vo" if label in {"vo", "旁白", "解说", "画外音", "画外声"} else None)
    if subtype is None and declared in {"os", "心声", "旁白", "解说", "画外音"}:
        subtype = "os" if declared in {"os", "心声"} else "vo"
    if label in {"台词", "dialogue"}:
        prefix = SOURCE_PREFIX.fullmatch(spoken)
        if prefix is not None:
            prefixed = prefix.group(1).strip()
            if OFFSCREEN_SUFFIX.search(prefixed):
                prefixed = OFFSCREEN_SUFFIX.sub("", prefixed).strip()
                offscreen = True
            if speaker and speaker != prefixed:
                raise ValueError(f"说话人字段与台词前缀不一致：{speaker} / {prefixed}")
            speaker = prefixed
            spoken = prefix.group(2).strip()
    if OFFSCREEN_SUFFIX.search(speaker):
        speaker = OFFSCREEN_SUFFIX.sub("", speaker).strip()
        offscreen = True
    if declared == "action" or not speaker or not spoken:
        raise ValueError("镜头发声类型、说话人或原文缺失")
    return ("vo" if offscreen else "dialogue"), subtype, speaker, spoken


def _shots(text: str) -> dict[int, tuple[str, str | None, str, str] | None]:
    markers = list(SHOT_MARKER.finditer(text))
    if not markers:
        raise ValueError("镜头脚本没有【镜头N】标记")
    found: dict[int, tuple[str, str | None, str, str] | None] = {}
    for index, marker in enumerate(markers):
        number = int(marker.group(1))
        if number in found:
            raise ValueError(f"重复镜头编号 {number}")
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        found[number] = _shot_speech(text[marker.end():end])
    return found


def _episode(project: Path, ep: str, manifest_sha: str, expected_sha: str) -> dict[str, Any]:
    source_file = project / "episodes" / f"{ep}.txt"
    map_file = project / "shots_and_matches" / f"ep{ep}-source-map.json"
    record_file = project / "shots_and_matches" / f"ep{ep}-coverage-acceptance.json"
    result: dict[str, Any] = {
        "status": "pending", "accepted": False, "reasons": [],
        "source_file": str(source_file.relative_to(project)),
        "source_map": str(map_file.relative_to(project)),
        "record_path": str(record_file.relative_to(project)),
    }
    failures: list[str] = []
    pending: list[str] = []
    if not source_file.is_file():
        failures.append(f"EP{ep}: 分集文件缺失: {result['source_file']}")
        result.update(status="failed", reasons=failures)
        return result
    try:
        source_text = source_file.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        result.update(status="failed", reasons=[f"EP{ep}: 分集文件不可读取: {error}"])
        return result
    source_sha = _content_sha(source_text)
    result["source_sha256"] = source_sha
    result["source_file_sha256"] = _sha(source_file.read_bytes())
    if source_sha != expected_sha:
        failures.append(f"EP{ep}: 原文 SHA 与 episodes/manifest.json 不一致")
    source_lines = source_text.splitlines()
    nonempty = [number for number, line in enumerate(source_lines, 1) if line.strip()]
    if not nonempty:
        failures.append(f"EP{ep}: 分集正文为空")
    else:
        header = EPISODE_HEADER.match(source_lines[nonempty[0] - 1])
        if header is not None and int(header.group(1) or header.group(2)) != int(ep):
            failures.append(f"EP{ep}: 正文集号为 {int(header.group(1) or header.group(2)):02d}，与清单不符")
        # The splitter removes episode headings by default. File name and
        # manifest hash are the identity evidence when no heading is retained.
    if not map_file.is_file():
        pending.append(f"EP{ep}: 缺少来源到镜头映射 {result['source_map']}")
        result.update(status="failed" if failures else "pending", reasons=failures + pending)
        return result
    try:
        mapping = _read_json(map_file)
    except (OSError, ValueError) as error:
        result.update(status="failed", reasons=failures + [f"EP{ep}: 来源映射不可读取: {error}"])
        return result
    result["mapping_sha256"] = _sha(map_file.read_bytes())
    if not isinstance(mapping, dict) or mapping.get("version") != VERSION or mapping.get("episode") != ep:
        failures.append(f"EP{ep}: 来源映射版本或集号无效")
        mapping = mapping if isinstance(mapping, dict) else {}
    if mapping.get("source_sha256") != source_sha:
        failures.append(f"EP{ep}: 来源映射原文 SHA 与当前分集不符")
    shot_name = mapping.get("shot_script")
    shot_path = _project_file(project, shot_name)
    if shot_path is None or not re.match(rf"^shots/第0*{int(ep)}集.*镜头脚本\.md$", str(shot_name).replace("\\", "/")):
        failures.append(f"EP{ep}: 来源映射镜头脚本路径无效或集号错配")
    elif not shot_path.is_file():
        pending.append(f"EP{ep}: 镜头脚本缺失: {shot_name}")
    else:
        result["shot_script"] = shot_name
        result["shot_sha256"] = _sha(shot_path.read_bytes())
    if shot_path is None or not shot_path.is_file():
        result.update(status="failed" if failures else "pending", reasons=failures + pending)
        return result
    try:
        parsed_shots = _shots(shot_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError) as error:
        result.update(status="failed", reasons=failures + [f"EP{ep}: 镜头脚本无法核对: {error}"])
        return result
    entries = mapping.get("entries")
    if not isinstance(entries, list) or not entries:
        pending.append(f"EP{ep}: 来源映射缺少逐行 entries")
        result.update(status="failed" if failures else "pending", reasons=failures + pending)
        return result
    seen_lines: set[int] = set()
    used_speech: set[int] = set()
    unresolved_speech: set[int] = set()
    speech_count = 0
    last_speech_shot = 0
    last_source_line = 0
    for row in entries:
        if not isinstance(row, dict):
            failures.append(f"EP{ep}: 来源映射条目不是对象")
            continue
        line_no = row.get("source_line")
        if type(line_no) is not int or line_no < 1 or line_no > len(source_lines):
            failures.append(f"EP{ep}: 无效来源行号 {line_no}")
            continue
        if line_no in seen_lines:
            failures.append(f"EP{ep}: 来源行 {line_no} 重复映射")
            continue
        if line_no <= last_source_line:
            failures.append(f"EP{ep}: 来源行 {line_no} 映射顺序与原文不符")
        last_source_line = line_no
        seen_lines.add(line_no)
        line = source_lines[line_no - 1]
        if not line.strip() or row.get("source_text") != line:
            failures.append(f"EP{ep}: 来源行 {line_no} 原文不符或为空")
            continue
        kind = row.get("kind")
        if not isinstance(kind, str) or kind not in SPEECH_KINDS | NON_SPEECH_KINDS:
            failures.append(f"EP{ep}: 来源行 {line_no} 类型无效")
            continue
        shot_ids = row.get("shots")
        if not isinstance(shot_ids, list) or not shot_ids or any(type(s) is not int or s not in parsed_shots for s in shot_ids):
            failures.append(f"EP{ep}: 来源行 {line_no} 缺少有效镜头编号")
            continue
        if shot_ids != sorted(set(shot_ids)):
            failures.append(f"EP{ep}: 来源行 {line_no} 镜头顺序或重复编号错误")
        actual_source = _source_speech(line)
        if kind in SPEECH_KINDS:
            if actual_source is None:
                pending.append(f"EP{ep}: 来源行 {line_no} 发声格式无法独立解析，需人工确认")
                unresolved_speech.update(shot_ids)
                continue
            if (kind, row.get("speaker"), row.get("speech_text")) != actual_source:
                failures.append(f"EP{ep}: 来源行 {line_no} 发声原文、说话人或 OS/VO 类型与原文不符")
                continue
            speech_count += 1
            parts: list[str] = []
            for shot_id in shot_ids:
                speech = parsed_shots[shot_id]
                if speech is None:
                    failures.append(f"EP{ep}: 来源行 {line_no} 镜头 {shot_id} 漏对白")
                    continue
                voice, subtype, speaker, spoken = speech
                expected_voice = "dialogue" if kind == "dialogue" else "vo"
                if voice != expected_voice or speaker != actual_source[1]:
                    failures.append(f"EP{ep}: 来源行 {line_no} 镜头 {shot_id} 说话人或 OS/VO 发声类型错误")
                if kind in {"os", "vo"} and subtype is None:
                    pending.append(f"EP{ep}: 来源行 {line_no} 镜头 {shot_id} 未保留可验证的 OS/VO 子类型")
                elif kind in {"os", "vo"} and subtype != kind:
                    failures.append(f"EP{ep}: 来源行 {line_no} 镜头 {shot_id} OS/VO 子类型错误")
                if shot_id in used_speech:
                    failures.append(f"EP{ep}: 镜头 {shot_id} 发声重复映射")
                used_speech.add(shot_id)
                if shot_id < last_speech_shot:
                    failures.append(f"EP{ep}: 来源行 {line_no} 发声镜头顺序错误")
                last_speech_shot = shot_id
                parts.append(spoken)
            if "".join(parts) != actual_source[2]:
                failures.append(f"EP{ep}: 来源行 {line_no} 镜头发声原文遗漏或改写")
        elif actual_source is not None:
            failures.append(f"EP{ep}: 来源行 {line_no} 把发声误标为 {kind}")
        else:
            known_kind = _non_speech_kind(line)
            if known_kind is None:
                pending.append(f"EP{ep}: 来源行 {line_no} 无法独立判定是否发声或动作")
            elif known_kind != kind:
                failures.append(f"EP{ep}: 来源行 {line_no} 内容类型应为 {known_kind}，映射写成 {kind}")
    for line_no in nonempty:
        if line_no not in seen_lines:
            failures.append(f"EP{ep}: 来源行 {line_no} 缺少镜头来源映射")
    for shot_id, speech in parsed_shots.items():
        if speech is not None and shot_id not in used_speech | unresolved_speech:
            failures.append(f"EP{ep}: 镜头 {shot_id} 发声未对应原文来源")
    result["source_line_count"] = len(nonempty)
    result["speech_count"] = speech_count
    result["reasons"] = failures + pending
    result["status"] = "failed" if failures else ("pending" if pending else "passed")
    if result["status"] == "passed" and record_file.is_file():
        try:
            record = _read_json(record_file)
            required = _record_fields(result, ep, manifest_sha)
            result["accepted"] = isinstance(record, dict) and all(record.get(key) == value for key, value in required.items())
        except (OSError, ValueError):
            pass
    return result


def _record_fields(result: dict[str, Any], ep: str, manifest_sha: str) -> dict[str, Any]:
    return {
        "version": VERSION, "episode": ep, "status": "passed",
        "manifest_sha256": manifest_sha,
        "source_file": result["source_file"], "source_sha256": result["source_sha256"],
        "source_file_sha256": result["source_file_sha256"],
        "shot_script": result["shot_script"], "shot_sha256": result["shot_sha256"],
        "source_map": result["source_map"], "mapping_sha256": result["mapping_sha256"],
        "speech_count": result["speech_count"], "source_line_count": result["source_line_count"],
    }


def _source_preflight(project: Path, listed: dict[str, Any], episodes: list[str]) -> list[str]:
    """Check all expected source files before signing any individual episode."""
    failures: list[str] = []
    for ep in episodes:
        source_file = project / "episodes" / f"{ep}.txt"
        entry = listed[ep]
        expected_sha = entry.get("sha256") if isinstance(entry, dict) else None
        if not isinstance(expected_sha, str) or re.fullmatch(r"[0-9a-f]{64}", expected_sha) is None:
            failures.append(f"EP{ep}: 清单缺少有效原文 SHA")
            continue
        if not source_file.is_file():
            failures.append(f"EP{ep}: 分集文件缺失")
            continue
        try:
            content = source_file.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as error:
            failures.append(f"EP{ep}: 分集文件不可读取: {error}")
            continue
        if _content_sha(content) != expected_sha:
            failures.append(f"EP{ep}: 原文 SHA 与分集清单不一致")
        first = next((line for line in content.splitlines() if line.strip()), "")
        if not first:
            failures.append(f"EP{ep}: 分集正文为空")
            continue
        header = EPISODE_HEADER.match(first)
        if header and int(header.group(1) or header.group(2)) != int(ep):
            failures.append(f"EP{ep}: 正文集号与分集清单不一致")
        # Missing headings are normal with script_processor's default filter.
    return failures


def audit_project(project: Path | str) -> dict[str, Any]:
    project = Path(project).resolve()
    manifest_path = project / "episodes" / "manifest.json"
    output: dict[str, Any] = {"status": "pending", "reasons": [], "expected_episodes": [],
                              "episodes": {}, "source_integrity": False, "source_reasons": []}
    if not manifest_path.is_file():
        output["reasons"].append("缺少 episodes/manifest.json；不能推定预期集数")
        return output
    try:
        manifest = _read_json(manifest_path)
    except (OSError, ValueError) as error:
        output.update(status="failed", reasons=[f"分集清单不可读取: {error}"])
        return output
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("episodes"), dict) or not manifest["episodes"]:
        output.update(status="failed", reasons=["分集清单版本无效，或缺少非空 episodes 对象"])
        return output
    listed = manifest["episodes"]
    if any(not re.fullmatch(r"\d{2,4}", key) or int(key) < 1 or key != f"{int(key):02d}" for key in listed):
        output.update(status="failed", reasons=["分集清单包含无效或未规范化集号"])
        return output
    episodes = sorted(listed, key=int)
    output["expected_episodes"] = episodes
    declared_count = manifest.get("expected_episode_count")
    if declared_count is not None:
        if type(declared_count) is not int or not 1 <= declared_count <= 9999:
            output["reasons"].append("expected_episode_count 必须是 1–9999 的整数")
        else:
            output["declared_episode_count"] = declared_count
            declared_ids = {f"{number:02d}" for number in range(1, declared_count + 1)}
            if set(episodes) != declared_ids:
                missing = sorted(declared_ids - set(episodes), key=int)
                extra = sorted(set(episodes) - declared_ids, key=int)
                output["reasons"].append(
                    f"声明预期 {declared_count} 集与清单不符；缺少 "
                    f"{', '.join('EP' + ep for ep in missing) or '无'}，多出 "
                    f"{', '.join('EP' + ep for ep in extra) or '无'}"
                )
    expected = [f"{number:02d}" for number in range(1, int(episodes[-1]) + 1)]
    if episodes != expected:
        missing = sorted(set(expected) - set(episodes), key=int)
        output["reasons"].append("分集清单集号不连续，缺少 " + ", ".join(f"EP{ep}" for ep in missing))
    actual_files = {path.stem for path in (project / "episodes").glob("*.txt") if path.is_file()}
    if actual_files != set(episodes):
        missing = sorted(set(episodes) - actual_files)
        extra = sorted(actual_files - set(episodes))
        output["reasons"].append(f"分集文件与清单集号不一致；缺少 {missing}，多出 {extra}")
    output["source_reasons"] = output["reasons"] + _source_preflight(project, listed, episodes)
    output["source_integrity"] = not output["source_reasons"]
    manifest_sha = _sha(manifest_path.read_bytes())
    for ep in episodes:
        record = listed[ep]
        sha = record.get("sha256") if isinstance(record, dict) else None
        if not isinstance(sha, str) or re.fullmatch(r"[0-9a-f]{64}", sha) is None:
            output["episodes"][ep] = {"status": "failed", "accepted": False,
                                      "reasons": [f"EP{ep}: 清单缺少有效原文 SHA"]}
        else:
            output["episodes"][ep] = _episode(project, ep, manifest_sha, sha)
    if output["reasons"] or any(row["status"] == "failed" for row in output["episodes"].values()):
        output["status"] = "failed"
    elif any(row["status"] == "pending" for row in output["episodes"].values()):
        output["status"] = "pending"
    else:
        output["status"] = "passed"
    return output


def write_pass_records(project: Path | str, episodes: list[str] | tuple[str, ...] | None = None) -> dict[str, Any]:
    project = Path(project).resolve()
    audit = audit_project(project)
    # All source files must be intact; future episode maps/shots may remain
    # pending while the current episode is accepted and produced.
    if not audit["source_integrity"]:
        audit["accept_status"] = "blocked"
        audit["accept_reasons"] = audit["source_reasons"]
        return audit
    selected = ([str(ep).zfill(2) for ep in episodes] if episodes is not None else
                [ep for ep, row in audit["episodes"].items() if row["status"] == "passed"])
    reasons: list[str] = []
    if not selected:
        reasons.append("没有可签发的逐集覆盖验收")
    if any(not ep.isdecimal() or int(ep) < 1 for ep in selected):
        reasons.append("签发集号无效")
    elif selected != sorted(set(selected), key=int) or any(
        int(right) != int(left) + 1 for left, right in zip(selected, selected[1:])
    ):
        reasons.append("签发集号必须无重复、按升序且连续")
    for ep in selected:
        row = audit["episodes"].get(ep)
        if row is None:
            reasons.append(f"EP{ep}: 不在分集清单内")
        elif row["status"] != "passed":
            reasons.extend(row["reasons"] or [f"EP{ep}: 覆盖审计未通过"])
    if selected and selected[0].isdecimal() and selected[-1] in audit["expected_episodes"]:
        for ep in audit["expected_episodes"]:
            if int(ep) >= int(selected[0]):
                break
            if not audit["episodes"][ep]["accepted"]:
                reasons.append(f"EP{ep}: 前序集尚未签发覆盖验收")
    if reasons:
        audit["accept_status"] = "blocked"
        audit["accept_reasons"] = reasons
        return audit
    manifest_sha = _sha((project / "episodes" / "manifest.json").read_bytes())
    for ep in selected:
        row = audit["episodes"][ep]
        if row["accepted"]:
            continue
        path = project / row["record_path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {**_record_fields(row, ep, manifest_sha),
                  "checked_at": datetime.now(timezone.utc).isoformat()}
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False,
                                         dir=path.parent, suffix=".tmp") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
            staged = Path(handle.name)
        try:
            os.replace(staged, path)
        finally:
            staged.unlink(missing_ok=True)
    result = audit_project(project)
    result["accept_status"] = "passed" if all(result["episodes"][ep]["accepted"] for ep in selected) else "blocked"
    result["accepted_episodes"] = selected
    return result


def paid_ready(project: Path | str, episodes: list[str] | tuple[str, ...]) -> dict[str, Any]:
    """Local orchestration gate; callers must invoke this before paid work.

    This does not replace the Jubian executor's budget/idempotency protection.
    Direct calls to that executor do not pass through this optional workflow gate.
    """
    audit = audit_project(project)
    reasons = list(audit["source_reasons"])
    requested = [str(ep).zfill(2) for ep in episodes]
    if not requested:
        reasons.append("未指定待付费制作的集号")
    if any(not ep.isdecimal() or int(ep) < 1 for ep in requested):
        reasons.append("请求集号无效")
    if all(ep.isdecimal() for ep in requested) and (requested != sorted(set(requested), key=int) or any(
        int(right) != int(left) + 1 for left, right in zip(requested, requested[1:])
    )):
        reasons.append("请求集号必须无重复、按升序且连续")
    expected = audit["expected_episodes"]
    if any(ep not in expected for ep in requested):
        reasons.append("请求包含分集清单外的集号")
    if requested and all(ep in expected for ep in requested):
        latest = int(requested[-1])
        for ep in expected:
            if int(ep) > latest:
                break
            if not audit["episodes"][ep]["accepted"]:
                reasons.append(f"EP{ep}: 缺少当前有效的覆盖验收通过记录")
                reasons.extend(audit["episodes"][ep]["reasons"])
    return {"status": "passed" if not reasons else "blocked", "requested_episodes": requested,
            "reasons": reasons}


def main() -> int:
    parser = argparse.ArgumentParser(description="逐集原文到镜头的离线覆盖验收")
    parser.add_argument("project", type=Path)
    parser.add_argument("command", choices=("audit", "accept", "gate"))
    parser.add_argument("episodes", nargs="*", help="gate 时按序传入待付费制作集号")
    args = parser.parse_args()
    if args.command == "gate":
        result = paid_ready(args.project, args.episodes)
    else:
        if args.command == "audit" and args.episodes:
            parser.error("audit 不接受集号参数")
        result = audit_project(args.project) if args.command == "audit" else write_pass_records(args.project, args.episodes or None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.command == "accept":
        return 0 if result.get("accept_status") == "passed" else 1
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

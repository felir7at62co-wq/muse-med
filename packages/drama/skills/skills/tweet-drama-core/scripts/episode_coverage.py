"""Fail-closed, offline episode-to-shot coverage evidence.

``audit`` reads only project files. ``accept`` signs only fully verified episodes.
This checks textual identity and explicit source-to-shot membership, not whether
an action was depicted well or a generated video is visually acceptable.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from episode_scope import is_episode_id, read_episode_manifest, resolve_episode_scope


VERSION = 1
ACCEPTANCE_VERSION = 2
SPEECH_KINDS = {"dialogue", "os", "vo"}
NON_SPEECH_KINDS = {"action", "scene", "state", "transition", "heading"}
SHOT_MARKER = re.compile(r"^【镜头(\d+)】[ \t]*$", re.MULTILINE)
SHOT_SPEECH = re.compile(r"^(台词|画外音|画外声|心声|旁白|解说|VO|OS|dialogue)[：:][ \t]*(.*)$", re.MULTILINE | re.IGNORECASE)
SOURCE_PREFIX = re.compile(r"^([^：:]{1,30})[：:]\s*(.+)$")
EPISODE_HEADER = re.compile(r"^\s*(?:第\s*(\d+)\s*[集话回章]|(?:EP|EPISODE)\s*[._-]?\s*(\d+)\b)", re.IGNORECASE)
AMBIGUOUS_ANNOTATION = re.compile(
    r"(?<![A-Za-z])(?:OS|VO)(?![A-Za-z])|画外|心声|旁白|独白|配音|变声|少年|青年|中年|老年|幼年|童年|成年|年前|年后"
    r"|分身|替身|冒充|假扮|伪装|代说|代言|附身|幻影|前世|今生|回忆|声线|身份|分饰|饰演"
    r"|voice|flashback|younger|older|disguis|impersonat|possess|voiceover", re.IGNORECASE)
ANNOTATION_META = re.compile(r"未知|备注|待补|待定|待核|未识别|另见|TODO|TBD|UNKNOWN", re.IGNORECASE)
CAST_PREFIX = re.compile(r"^(?:人物|出场人物|登场人物|角色|角色表|CHARACTERS|CAST)\s*[：:]\s*(.+)$", re.I)
QUOTED_ANNOTATION = re.compile(r'''[“”‘’"'「」『』]''')
ACTION_SPEECH = re.compile(
    r"^(?:[△▲]\s*|(?:动作|画面)[：:]\s*)"
    r'''([^：:，,。.!！?？；;“”‘’"'「」『』]{1,30}?)(?:说道?|喊道?|问道?|答道?|念道?|低语|耳语|自语|开口)[：:]\s*(.+)$'''
)
ACTION_SPEECH_HINT = re.compile(r'''说|喊|问|答|念|低语|耳语|自语|开口|[“”‘’"'「」『』]''')
OBJECT_SOUND_WORD = r"(?:铛|咣|哐|砰|嘭|啪|咔嚓|咔哒|叮|咚|嗒|哒|滴|轰|噼里啪啦|吱呀|沙沙){1,6}"
QUOTE_PAIRS = (("“", "”"), ("‘", "’"), ('"', '"'), ("'", "'"), ("「", "」"), ("『", "』"))
QUOTED_OBJECT_SOUND = re.compile(
    "(?:" + "|".join(re.escape(left) + OBJECT_SOUND_WORD + re.escape(right)
                      for left, right in QUOTE_PAIRS) + ")"
    r"(?:(?:的|地)?(?:一|两|几|数)?声|的(?:枝叶|树叶|草叶|树枝)(?:摩擦|断裂|碰撞)?声)"
)
QUOTED_IMPACT = re.compile("|".join(
    re.escape(left) + r"(?:(?:砰|嘭|啪|哐|咣|咔嚓)[！!]){1,6}" + re.escape(right)
    for left, right in QUOTE_PAIRS))
PHYSICAL_IMPACT = re.compile(r"砸|撞|敲|劈|摔|断裂|分成两段|落地|碰|砍")
HUMAN_SOUND_CUE = re.compile(r"配音|变声|人声|口技|张口|开口|吼|嚷|呼唤|低语|耳语|自语")
SILENT_IDIOM = re.compile(r"二话不说|不由分说")
# A whole physical-handling sentence may contain a speech character in its object.
# Do not remove substrings: another clause can still describe spoken content.
WRITTEN_OBJECT_ACTION = re.compile(
    r"^(?:[△▲]\s*|(?:动作|画面)[：:]\s*)(?:他|她|两人|众人)?"
    r"(?:拿起|放下|翻开|合上)(?:了|着)?(?:一本|一份|这份|那份|那本|这本)?"
    r"(?:说明书|说明文件|说明页|问卷|答题卡|答案页)[。.!]?$"
)
SKIP_SPEAKER = {"场景", "时间", "地点", "镜头", "画面", "动作", "人物", "状态", "环境", "转场", "备注", "说明"}
PARSER_REPAIR_HINT = "识别能力缺口应保留原文并修复解析器；不改原文凑格式，不以人工备注代替accept/gate，不提供‘先跳过门禁’选项。pending期间不进行收费提交。"


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


def _source_characters(source: str) -> set[str]:
    """Read cast declarations, or plain dialogue identities when no roster exists."""
    names: set[str] = set()
    for line in source.splitlines():
        roster = CAST_PREFIX.fullmatch(line.strip())
        if roster is not None:
            names.update(re.sub(r"[（(].*$", "", name).strip() for name in
                         re.split(r"[、,，;；]", roster.group(1)))
    if not names:
        for line in source.splitlines():
            prefix = SOURCE_PREFIX.fullmatch(line.strip())
            if prefix is None or _non_speech_kind(line) is not None:
                continue
            value = prefix.group(1).strip()
            if value in SKIP_SPEAKER or re.search(r"[（）()\[\]【】△▲，,。.!！?？；;]", value):
                continue
            identity = _source_identity(value, set())
            if identity is not None:
                names.add(identity[1])
    return names


def _speaker_annotation(prefix: str, characters: set[str]) -> tuple[str, str] | None:
    """Read performance groups belonging to an already declared source identity."""
    parts = _speaker_parts(prefix)
    if parts is None or parts[0] not in characters or not parts[1]:
        return None
    return parts[0], '，'.join(parts[1])


def _performance_note(annotation: str) -> bool:
    """Use performance notation across genres while retaining semantic and metadata ambiguity."""
    return bool(re.search(r"[\u4e00-\u9fffA-Za-z]", annotation)
                and not AMBIGUOUS_ANNOTATION.search(annotation)
                and not QUOTED_ANNOTATION.search(annotation)
                and not ANNOTATION_META.search(annotation))


def _speaker_parts(prefix: str) -> tuple[str, list[str], str] | None:
    """Read balanced performance groups and one trailing voice marker without discarding text."""
    trailing = re.search(r"(?:OS|VO)$", prefix, re.I)
    marker = trailing.group().lower() if trailing else ""
    text = prefix[:trailing.start()].rstrip() if trailing else prefix
    pairs = {'（': '）', '(': ')', '[': ']', '【': '】'}
    start = next((index for index, char in enumerate(text) if char in pairs), len(text))
    base, notes, index = text[:start].strip(), [], start
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        if text[index] not in pairs:
            return None
        stack, begin = [pairs[text[index]]], index + 1
        index += 1
        while index < len(text) and stack:
            char = text[index]
            if char in pairs:
                stack.append(pairs[char])
            elif char in pairs.values():
                if char != stack.pop():
                    return None
            index += 1
        if stack:
            return None
        notes.append(text[begin:index - 1])
    if not base or re.search(r"[）)\]】]", base):
        return None
    return base, notes, marker


def _pending_source_reason(line: str, characters: set[str]) -> str:
    """Distinguish an unresolved listed-character annotation from an unknown source layout."""
    prefix = re.fullmatch(r"([^：:\n]+)[：:]\s*(.+)", line.strip())
    named = _speaker_annotation(prefix.group(1).strip(), characters) if prefix is not None else None
    if named is not None:
        if AMBIGUOUS_ANNOTATION.search(named[1]):
            return "已列角色的括注涉及身份、时期或发声方式，需根据原文核对"
        if QUOTED_ANNOTATION.search(named[1]):
            return "已列角色的括注含引语，需保留并核对发声内容"
        return "已列角色的括注尚未识别；说话人已在人物表中，须保留原文核对括注"
    return "来源行不能独立识别，需结合原文核对"


def _speech_prefix(line: str, characters: set[str]) -> re.Match[str] | None:
    """Allow long prefixes only when their resolved identity is source-declared."""
    match = SOURCE_PREFIX.fullmatch(line)
    if match is None:
        longer = re.fullmatch(r"([^：:\n]+)[：:]\s*(.+)", line)
        if longer is not None:
            identity = _source_identity(longer.group(1).strip(), characters)
            if identity is not None and identity[1] in characters:
                match = longer
    return match


def _source_identity(prefix: str, characters: set[str]) -> tuple[str, str] | None:
    """Resolve explicit voice markers beside supported, separately written performance notes.

    A voice marker cannot be inferred from an emotion or mixed into its note.
    Performance notes require a source declaration; conflicting markers fail.
    """
    parts = _speaker_parts(prefix)
    if parts is None:
        return None
    base, notes, trailing = parts
    markers: list[str] = [trailing.lower()] if trailing else []
    suffix = re.search(r"(?:OS|VO)$", base, re.I)
    if suffix is not None:
        markers.append(suffix.group().lower())
        base = base[:suffix.start()].strip()
        if re.search(r"(?:OS|VO)$", base, re.I):
            return None
    if base in {"旁白", "解说", "心声"}:
        markers.append("os" if base == "心声" else "vo")
    for annotation in notes:
        text = annotation.strip()
        if re.fullmatch(r"OS|VO|画外音|心声|内心独白|旁白|解说", text, re.I):
            markers.append("offscreen" if text == "画外音" else
                           "os" if text.lower() == "os" or text in {"心声", "内心独白"} else "vo")
        elif base not in characters | {"旁白", "解说", "心声"} or not _performance_note(text):
            return None
    if not base or len(markers) > 1:
        return None
    return markers[0] if markers else "dialogue", base


def _source_speech(line: str, characters: set[str]) -> tuple[str, str, str] | None:
    """Recognize source speech without inferring an undeclared annotated identity.

    Generic offscreen speech lacks OS/VO evidence for full coverage acceptance.
    Unsupported source speech layouts require review rather than a machine pass.
    """
    line = line.strip()
    action_speech = ACTION_SPEECH.fullmatch(line)
    if action_speech is not None:
        identity = _source_identity(action_speech.group(1).strip(), characters)
        if identity is None or identity[0] != "dialogue" or characters and identity[1] not in characters:
            return None
        return "dialogue", identity[1], action_speech.group(2).strip()
    if not line or _non_speech_kind(line) is not None:
        return None
    if line.startswith(("△", "▲")) or re.match(r"^(?:动作|画面)[：:]", line):
        return None
    match = _speech_prefix(line, characters)
    if match is None:
        return None
    prefix, text = match.group(1).strip(), match.group(2).strip()
    if prefix in SKIP_SPEAKER or not text:
        return None
    if prefix.upper() in {"OS", "VO"}:
        inner = _speech_prefix(text, characters)
        if inner is None:
            return None
        identity = _source_identity(inner.group(1).strip(), characters)
        if identity is None or identity[0] != "dialogue":
            return None
        return prefix.lower(), identity[1], inner.group(2).strip()
    identity = _source_identity(prefix, characters)
    if identity is None:
        return None
    kind, speaker = identity
    if not speaker or not text:
        return None
    return kind, speaker, text


def _non_speech_kind(line: str) -> str | None:
    """Only unambiguous headings and prefixed directions can pass unattended."""
    stripped = line.strip()
    if stripped in {"【下集钩子】", "【全剧终】"}:
        return "heading"
    if EPISODE_HEADER.fullmatch(stripped) or re.fullmatch(r"(?:第\s*\d+\s*集|EP\s*\d+)[：:].+", stripped, re.IGNORECASE):
        return "heading"
    if re.match(r"^[0-9]{1,4}[-－]\d{1,3}(?:\s|$)", stripped) or CAST_PREFIX.fullmatch(stripped) or re.match(r"^(?:场景|场次|地点|时间|环境)\s*[：:]", stripped):
        return "scene"
    if stripped.startswith(("△", "▲")) or re.match(r"^(?:动作|画面)[：:]", stripped):
        if WRITTEN_OBJECT_ACTION.fullmatch(stripped):
            return "action"
        body = re.sub(r"^(?:[△▲]\s*|(?:动作|画面)[：:]\s*)", "", stripped, count=1)
        # Only supported object sounds with sound or impact context are removable.
        # Remaining quotes, speech cues or colon clauses require speech review.
        remaining = body
        if not HUMAN_SOUND_CUE.search(body):
            remaining = QUOTED_OBJECT_SOUND.sub("", remaining)
            if PHYSICAL_IMPACT.search(body):
                remaining = QUOTED_IMPACT.sub("", remaining)
        remaining = SILENT_IDIOM.sub("", remaining)
        return None if ACTION_SPEECH_HINT.search(remaining) or re.search(r"[：:]", remaining) else "action"
    if re.match(r"^(?:人物状态|状态)[：:]", stripped):
        return "state"
    if re.match(r"^(?:转场|切至|闪回)[：:]", stripped):
        return "transition"
    return None


def _direction_speaker(line: str, characters: set[str]) -> str | None:
    """Read a terminal delivery cue with an explicit subject and no spoken payload."""
    direction = re.fullmatch(r"(?:[△▲]\s*|(?:动作|画面)[：:]\s*)([^：:“”‘’\"'「」『』]+)", line.strip())
    if direction is None:
        return None
    body = SILENT_IDIOM.sub("", direction.group(1))
    if AMBIGUOUS_ANNOTATION.search(body) or re.search(r"[（）()]", body):
        return None
    sentences = re.split(r"[。.!！?？]", body.rstrip("。.!！?？"))
    sentence = sentences[-1]
    names = sorted((name for name in characters if name), key=len, reverse=True)
    speaker = next((name for name in names if sentence.startswith(name)), None)
    if speaker is None:
        return None
    remainder = sentence[len(speaker):]
    hint = ACTION_SPEECH_HINT.search(remainder)
    if hint is None or ACTION_SPEECH_HINT.search(''.join(sentences[:-1])):
        return None
    tail = remainder[hint.start():].rstrip("。.!！?？")
    targets = "|".join(re.escape(name) for name in names)
    if re.fullmatch(rf"问(?:{targets})|喊(?:道)?|说(?:道)?", tail) is None:
        return None
    return speaker


def _source_non_speech_kind(lines: list[str], index: int, characters: set[str]) -> str | None:
    """Resolve a terminal delivery cue only beside the same named speaker's dialogue.

    Colon/quoted payloads, earlier speech hints and unresolved identities retain
    their standalone classification; the source and mapping supply no override.
    """
    kind = _non_speech_kind(lines[index])
    if kind is not None:
        return kind
    speaker = _direction_speaker(lines[index], characters)
    if speaker is None:
        return None
    following = next((line for line in lines[index + 1:] if line.strip()), "")
    speech = _source_speech(following, characters)
    return "action" if speech is not None and speech[:2] == ("dialogue", speaker) else None


def classify_source_lines(source: str) -> list[dict[str, Any]]:
    """Classify every nonempty source line with the context used by coverage.

    Rows preserve exact line text and one-based numbers. Unknown rows retain
    a null kind and a reason; callers must not discard them when making maps.
    Generic offscreen speech remains identifiable but lacks OS/VO evidence.
    """
    lines, characters = source.splitlines(), _source_characters(source)
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        speech = _source_speech(line, characters)
        row: dict[str, Any] = {"source_line": index + 1, "source_text": line}
        if speech is not None:
            row.update(kind=speech[0], speaker=speech[1], speech_text=speech[2])
            if speech[0] == "offscreen":
                row["reason"] = "来源行尚未明确 OS/VO 子类型"
        else:
            row["kind"] = _source_non_speech_kind(lines, index, characters)
            if row["kind"] is None:
                row["reason"] = _pending_source_reason(line, characters)
                cue_speaker = _direction_speaker(line, characters)
                following = next((text for text in lines[index + 1:] if text.strip()), "")
                next_speech = _source_speech(following, characters)
                if cue_speaker is not None and next_speech is not None and next_speech[1] != cue_speaker:
                    row["reason"] = f"动作引导发声者{cue_speaker}，紧邻台词属于{next_speech[1]}，说话人不一致；保留原文核对，不能猜补台词"
        rows.append(row)
    return rows


def source_line_report(project: Path | str, episode: str) -> dict[str, Any]:
    """Read mapping candidates without modifying source, maps or acceptance."""
    project = Path(project).resolve()
    ep = str(episode).zfill(2)
    if not is_episode_id(ep):
        raise ValueError("source-lines需要一个有效的单集号")
    source_path = project / "episodes" / f"{ep}.txt"
    source = source_path.read_text(encoding="utf-8-sig")
    entries = classify_source_lines(source)
    if not entries:
        raise ValueError("分集原文为空，不能生成来源分类")
    pending = [row["source_line"] for row in entries if "reason" in row]
    return {"status": "pending" if pending else "passed", "check": "source_line_classification",
            "episode": ep, "source": str(source_path), "source_sha256": _content_sha(source),
            "entries": entries, "pending_lines": pending, "coverage_acceptance": False,
            "next": "保留每一条来源行并补充真实镜头编号；分类不证明动作已呈现或映射已验收。不要调用单行内部函数重建或跳过来源行；完成映射后重新运行preflight、accept和gate。"
                    + (PARSER_REPAIR_HINT if pending else "")}


def scan_project_source(project: Path | str) -> dict[str, Any]:
    """Scan every assigned episode before shot authoring, preserving unresolved rows and source integrity."""
    project = Path(project).resolve()
    inventory = source_inventory(project)
    reports: dict[str, Any] = {}
    unresolved: list[dict[str, Any]] = []
    reasons = list(inventory['issues'])
    for episode in inventory['expected']:
        try:
            report = source_line_report(project, episode)
            reports[episode] = {'status': report['status'], 'source_sha256': report['source_sha256'],
                                'source_line_count': len(report['entries']), 'pending_lines': report['pending_lines']}
            unresolved.extend({'episode': episode, **row} for row in report['entries'] if 'reason' in row)
        except (OSError, UnicodeError, ValueError) as error:
            reasons.append(f'EP{episode}: {error}')
    return {'status': 'failed' if reasons else 'pending' if unresolved else 'passed',
            'check': 'assigned_source_classification', 'source_integrity': not reasons,
            'episodes': reports, 'pending': unresolved, 'reasons': reasons,
            'coverage_acceptance': False,
            'next': '先解决本次工作范围内的格式、身份、发声和归属歧义，再写分镜并逐集运行preflight、accept和gate。'
                    '本扫描不分配镜头、不签发验收、不提交视频。'}


def _shot_speech(body: str, characters: set[str]) -> tuple[str, str | None, str, str] | None:
    lines = list(SHOT_SPEECH.finditer(body))
    if not lines:
        return None
    if len(lines) != 1:
        raise ValueError("镜头含多条发声行，请拆成可逐条核对的来源映射")
    label, spoken = lines[0].group(1).lower(), lines[0].group(2).strip()
    field = re.search(r"^(?:发声类型|语音类型)[：:]\s*(.+)$", body, re.MULTILINE)
    declared = field.group(1).strip().lower() if field else ""
    speaker_field = re.search(r"^说话人[：:]\s*(.+)$", body, re.MULTILINE)
    speaker = speaker_field.group(1).strip() if speaker_field else ""
    identity = _source_identity(speaker, characters)
    voice_markers: list[str] = []
    if identity is not None:
        speaker = identity[1]
        if identity[0] != "dialogue":
            voice_markers.append(identity[0])
    offscreen = declared in {"vo", "画外音", "os"} or label in {"vo", "os", "画外音", "画外声", "心声", "旁白", "解说"}
    subtype = ("os" if label in {"os", "心声"} else
               "vo" if label in {"vo", "旁白", "解说", "画外音", "画外声"} else None)
    declared_voice = ("os" if declared in {"os", "心声"} else
                      "vo" if declared in {"旁白", "解说", "画外音"} else
                      "dialogue" if declared == "dialogue" else None)
    if subtype is not None and declared_voice is not None and subtype != declared_voice:
        raise ValueError("发声行标签与发声类型的OS/VO不一致")
    if subtype is None and declared in {"os", "心声", "旁白", "解说", "画外音"}:
        subtype = "os" if declared in {"os", "心声"} else "vo"
    if label in {"台词", "dialogue"}:
        prefix = _speech_prefix(spoken, characters)
        if prefix is not None:
            prefixed = prefix.group(1).strip()
            identity = _source_identity(prefixed, characters)
            if identity is not None:
                prefixed = identity[1]
                if identity[0] != "dialogue":
                    voice_markers.append(identity[0])
            if speaker and speaker != prefixed:
                raise ValueError(f"说话人字段与台词前缀不一致：{speaker} / {prefixed}")
            speaker = prefixed
            spoken = prefix.group(2).strip()
    for marker in voice_markers:
        offscreen = True
        if marker == "offscreen":
            continue
        if subtype is not None and subtype != marker or declared == "dialogue":
            raise ValueError("说话人或台词前缀的OS/VO与发声类型不一致")
        subtype = marker
    # The compiler's `vo` field also carries explicit OS. Without a semantic
    # label or prefix, it denotes VO; generic offscreen notation stays unresolved.
    if subtype is None and declared == "vo" and "offscreen" not in voice_markers:
        subtype = "vo"
    if declared == "action" or not speaker or not spoken:
        raise ValueError("镜头发声类型、说话人或原文缺失")
    return ("vo" if offscreen else "dialogue"), subtype, speaker, spoken


def _shots(text: str, characters: set[str]) -> dict[int, tuple[str, str | None, str, str] | None]:
    markers = list(SHOT_MARKER.finditer(text))
    if not markers:
        raise ValueError("镜头脚本没有【镜头N】标记")
    found: dict[int, tuple[str, str | None, str, str] | None] = {}
    for index, marker in enumerate(markers):
        number = int(marker.group(1))
        if number in found:
            raise ValueError(f"重复镜头编号 {number}")
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        found[number] = _shot_speech(text[marker.end():end], characters)
    return found


def _episode(project: Path, ep: str, manifest_sha: str, dependency_sha: str, expected_sha: str) -> dict[str, Any]:
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
    source_rows = {row["source_line"]: row for row in classify_source_lines(source_text)}
    characters = _source_characters(source_text)
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
    normalized_shot_name = str(shot_name).replace("\\", "/")
    matches_episode = re.fullmatch(rf"shots/第0*{int(ep)}集[^/]*镜头脚本\.md", normalized_shot_name) or re.fullmatch(
        rf"shots/EP0*{int(ep)}(?:[-_][^/]+)?\.md", normalized_shot_name, re.IGNORECASE)
    if shot_path is None or not matches_episode:
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
        parsed_shots = _shots(shot_path.read_text(encoding="utf-8-sig"), characters)
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
        source_row = source_rows[line_no]
        actual_source = ((source_row["kind"], source_row["speaker"], source_row["speech_text"])
                         if "speech_text" in source_row else None)
        if kind in SPEECH_KINDS:
            if actual_source is None or actual_source[0] == "offscreen":
                reason = source_row.get("reason", "发声格式无法独立解析")
                pending.append(f"EP{ep}: 来源行 {line_no} {reason}；须修复或核对后重新验收，不能人工备注放行")
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
            known_kind = source_row["kind"]
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
            if isinstance(record, dict) and record.get("version") == VERSION:
                required = _record_fields(result, ep, dependency_sha)
                required["version"] = VERSION
                del required["episode_manifest_sha256"]
                required["manifest_sha256"] = manifest_sha
            else:
                required = _record_fields(result, ep, dependency_sha)
            result["accepted"] = isinstance(record, dict) and all(record.get(key) == value for key, value in required.items())
        except (OSError, ValueError):
            pass
    return result


def _record_fields(result: dict[str, Any], ep: str, dependency_sha: str) -> dict[str, Any]:
    return {
        "version": ACCEPTANCE_VERSION, "episode": ep, "status": "passed",
        "episode_manifest_sha256": dependency_sha,
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
        entry = listed.get(ep)
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


def source_inventory(project: Path | str) -> dict[str, Any]:
    """Validate the declared scope and its source bytes for audit and projection."""
    project = Path(project).resolve()
    manifest_path = project / "episodes" / "manifest.json"
    actual = {path.stem for path in (project / "episodes").glob("*.txt") if path.is_file()}
    result: dict[str, Any] = {"manifest": {}, "expected": [], "actual": sorted(actual),
                              "issues": [], "manifest_exists": manifest_path.is_file(),
                              "explicit_scope": False, "story_episode_count": None}
    if not manifest_path.is_file():
        result["issues"] = ["缺少 episodes/manifest.json；不能推定预期集数"]
        return result
    try:
        manifest = read_episode_manifest(manifest_path)
        expected = resolve_episode_scope(manifest)
    except (OSError, ValueError) as error:
        result["issues"] = [f"分集清单不可读取或范围无效: {error}"]
        return result
    listed = manifest["episodes"]
    explicit = "work_scope" in manifest
    result.update(manifest=manifest, expected=expected, explicit_scope=explicit,
                  story_episode_count=manifest.get("expected_episode_count"))
    missing = set(expected) - set(listed)
    if missing:
        result["issues"].append("工作范围缺少分集清单条目: " + ", ".join("EP" + ep for ep in sorted(missing, key=int)))
    extra = actual - set(listed)
    if extra:
        result["issues"].append(f"分集文件不在清单内: {sorted(extra)}")
    if explicit:
        result["actual"] = sorted(actual & set(expected), key=int)
    result["issues"].extend(_source_preflight(project, listed, expected))
    return result


def _manifest_dependency_sha(manifest: dict[str, Any], ep: str) -> str:
    """Bind one episode entry and shared parsing settings, not collaborators' rows."""
    dependency = {"version": manifest["version"], "episode": ep,
                  "entry": manifest["episodes"].get(ep),
                  "filter_options": manifest.get("filter_options")}
    return _sha(json.dumps(dependency, sort_keys=True, ensure_ascii=False,
                           separators=(",", ":")).encode("utf-8"))


def audit_project(project: Path | str) -> dict[str, Any]:
    project = Path(project).resolve()
    inventory = source_inventory(project)
    output: dict[str, Any] = {"status": "pending", "reasons": list(inventory["issues"]),
                              "expected_episodes": inventory["expected"], "episodes": {},
                              "explicit_work_scope": inventory["explicit_scope"],
                              "source_integrity": not inventory["issues"],
                              "source_reasons": list(inventory["issues"])}
    if not inventory["manifest_exists"]:
        return output
    manifest = inventory["manifest"]
    if not manifest:
        output["status"] = "failed"
        return output
    if inventory["story_episode_count"] is not None:
        output["declared_episode_count"] = inventory["story_episode_count"]
    manifest_sha = _sha((project / "episodes" / "manifest.json").read_bytes())
    for ep in inventory["expected"]:
        record = manifest["episodes"].get(ep)
        sha = record.get("sha256") if isinstance(record, dict) else None
        if not isinstance(sha, str) or re.fullmatch(r"[0-9a-f]{64}", sha) is None:
            output["episodes"][ep] = {"status": "failed", "accepted": False,
                                      "reasons": [f"EP{ep}: 清单缺少有效原文 SHA"]}
        else:
            dependency_sha = _manifest_dependency_sha(manifest, ep)
            row = _episode(project, ep, manifest_sha, dependency_sha, sha)
            row["episode_manifest_sha256"] = dependency_sha
            output["episodes"][ep] = row
    if output["reasons"] or any(row["status"] == "failed" for row in output["episodes"].values()):
        output["status"] = "failed"
    elif any(row["status"] == "pending" for row in output["episodes"].values()):
        output["status"] = "pending"
    else:
        output["status"] = "passed"
    return output


def write_pass_records(project: Path | str, episodes: list[str] | tuple[str, ...] | None = None,
                       *, episode_only: bool = False) -> dict[str, Any]:
    """Sign verified coverage; episode-only mode requires one explicit in-scope ID."""
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
    if episode_only and (episodes is None or len(selected) != 1):
        reasons.append("仅本集模式必须显式指定一个集号")
    if not selected:
        reasons.append("没有可签发的逐集覆盖验收")
    if any(not is_episode_id(ep) for ep in selected):
        reasons.append("签发集号无效")
    elif selected != sorted(set(selected), key=int) or (not audit["explicit_work_scope"] and any(
        int(right) != int(left) + 1 for left, right in zip(selected, selected[1:])
    )):
        reasons.append("签发集号必须无重复、按升序；整剧模式还须连续")
    for ep in selected:
        row = audit["episodes"].get(ep)
        if row is None:
            reasons.append(f"EP{ep}: 不在声明工作范围内")
        elif row["status"] != "passed":
            reasons.extend(row["reasons"] or [f"EP{ep}: 覆盖审计未通过"])
    if not episode_only and not audit["explicit_work_scope"] and selected and selected[0].isdecimal() and selected[-1] in audit["expected_episodes"]:
        for ep in audit["expected_episodes"]:
            if int(ep) >= int(selected[0]):
                break
            if not audit["episodes"][ep]["accepted"]:
                reasons.append(f"EP{ep}: 前序集尚未签发覆盖验收")
    if reasons:
        audit["accept_status"] = "blocked"
        audit["accept_reasons"] = reasons
        return audit
    for ep in selected:
        row = audit["episodes"][ep]
        if row["accepted"]:
            continue
        path = project / row["record_path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {**_record_fields(row, ep, row["episode_manifest_sha256"]),
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


def paid_ready(project: Path | str, episodes: list[str] | tuple[str, ...], *, episode_only: bool = False) -> dict[str, Any]:
    """Local orchestration gate; callers must invoke this before paid work.

    This does not replace the Jubian executor's budget/idempotency protection.
    Direct calls to that executor do not pass through this optional workflow gate.
    Episode-only mode requires one in-scope episode and preserves source-integrity checks.
    """
    audit = audit_project(project)
    reasons = list(audit["source_reasons"])
    requested = [str(ep).zfill(2) for ep in episodes]
    if episode_only and len(requested) != 1:
        reasons.append("仅本集模式必须显式指定一个集号")
    if not requested:
        reasons.append("未指定待付费制作的集号")
    if any(not is_episode_id(ep) for ep in requested):
        reasons.append("请求集号无效")
    if all(is_episode_id(ep) for ep in requested) and (requested != sorted(set(requested), key=int) or (
        not audit["explicit_work_scope"] and any(
            int(right) != int(left) + 1 for left, right in zip(requested, requested[1:])
        )
    )):
        reasons.append("请求集号必须无重复、按升序；整剧模式还须连续")
    expected = audit["expected_episodes"]
    if any(ep not in expected for ep in requested):
        reasons.append("请求包含声明工作范围外的集号")
    if requested and all(ep in expected for ep in requested):
        required = requested if audit["explicit_work_scope"] or episode_only else [ep for ep in expected if int(ep) <= int(requested[-1])]
        for ep in required:
            if not audit["episodes"][ep]["accepted"]:
                reasons.append(f"EP{ep}: 缺少当前有效的覆盖验收通过记录")
                reasons.extend(audit["episodes"][ep]["reasons"])
    return {"status": "passed" if not reasons else "blocked", "requested_episodes": requested,
            "reasons": reasons}


def _preflight_shots(text: str, characters: set[str]) -> list[tuple[str, str | None, str, str] | None]:
    """Read ordered speech from either canonical shots or per-package Markdown shots."""
    markdown = list(re.finditer(r"^#{2,6}[ \t]+(?:镜头[0-9]+|画外音镜)[）)]?[ \t]*$", text, re.MULTILINE))
    canonical = list(SHOT_MARKER.finditer(text))
    if markdown and canonical:
        raise ValueError("镜头脚本混用不同标记格式，请先统一")
    if not markdown:
        if not canonical:
            raise ValueError("未找到可检查的逐镜台词：请使用【镜头N】或逐包 Markdown 镜头标题，并将发声写入各镜的台词字段；覆盖表和按包汇总不能代替逐镜内容")
        return list(_shots(text, characters).values())
    result = []
    for index, marker in enumerate(markdown):
        end = markdown[index + 1].start() if index + 1 < len(markdown) else len(text)
        body = text[marker.end():end]
        body = re.sub(r"^[ \t]*[-*][ \t]+(?=(?:台词|画外音|画外声|心声|旁白|解说|VO|OS|dialogue|发声类型|语音类型|说话人)[：:])", "", body, flags=re.MULTILINE | re.IGNORECASE)
        result.append(_shot_speech(body, characters))
    return result


def speech_preflight(project: Path | str, episode: str, script: Path | str,
                     *, source_file: Path | str | None = None) -> dict[str, Any]:
    """Compare ordered speech before writing cards, without signing full coverage.

    This supports ordinary screenplay performance annotations for characters
    explicitly listed in the source. Unknown source layouts require review.
    Punctuation and whitespace do not distinguish text; characters, speaker and
    dialogue versus offscreen speech do. Full OS/VO and action coverage remains
    owned by audit/accept/gate and their explicit source maps.
    """
    project = Path(project).resolve()
    ep = str(episode).zfill(2)
    if not is_episode_id(ep):
        raise ValueError("preflight需要一个有效的单集号")
    source_path = Path(source_file) if source_file is not None else project / "episodes" / f"{ep}.txt"
    source_path = source_path if source_path.is_absolute() else project / source_path
    shot_path = Path(script)
    shot_path = shot_path if shot_path.is_absolute() else project / shot_path
    source = source_path.read_text(encoding="utf-8-sig")
    authored = shot_path.read_text(encoding="utf-8-sig")
    if not source.strip():
        raise ValueError("分集原文为空，不能签发发声预检通过")
    header = EPISODE_HEADER.match(source.lstrip())
    if source_file is not None and header is not None and int(header.group(1) or header.group(2)) != int(ep):
        raise ValueError("原文集号与预检集号不一致")
    names = _source_characters(source)
    expected, actual = [], []
    pending, source_rows = [], []
    for row in classify_source_lines(source):
        number, stripped, kind = row["source_line"], row["source_text"].strip(), row["kind"]
        if kind is None:
            pending.append({"line": number, "text": stripped, "reason": row["reason"]})
        if "speech_text" not in row:
            continue
        speaker, spoken = row["speaker"], row["speech_text"]
        source_rows.append({"line": number, "kind": "vo" if kind == "offscreen" else kind,
                            "speaker": speaker, "text": spoken})
        expected.extend((speaker, "dialogue" if kind == "dialogue" else "vo", c)
                        for c in re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", spoken))
    shots = _preflight_shots(authored, names)
    for speech in shots:
        if speech is not None:
            kind, _subtype, speaker, spoken = speech
            actual.extend((speaker, kind, c) for c in re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", spoken))
    changes = []
    for tag, left, right, start, end in difflib.SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes():
        if tag != "equal":
            changes.append({"kind": tag, "source": "".join(t[2] for t in expected[left:right]),
                            "shots": "".join(t[2] for t in actual[start:end]),
                            "source_speaker": expected[left][0] if left < right else None,
                            "shot_speaker": actual[start][0] if start < end else None})
    return {"status": "failed" if changes else "pending" if pending else "passed", "episode": ep,
            "check": "ordered_speech_only", "source": str(source_path), "script": str(shot_path),
            "source_sha256": _content_sha(source), "script_sha256": _content_sha(authored),
            "source_speech": source_rows, "changes": changes, "pending": pending,
            "coverage_acceptance": False,
            "next": "缺词、增词、换说话人或发声方式变化先修正；本检查不签发动作覆盖或成片验收，不能替代accept/gate、实际看图和逐句听校。"
                    + (PARSER_REPAIR_HINT if pending else "")}


def main() -> int:
    parser = argparse.ArgumentParser(description="逐集原文到镜头的离线覆盖验收")
    parser.add_argument("project", type=Path)
    parser.add_argument("command", choices=("audit", "accept", "gate", "preflight", "source-lines", "source-scan"))
    parser.add_argument("episodes", nargs="*", help="gate 时按序传入待付费制作集号")
    parser.add_argument("--script", type=Path, help="preflight比较的完整单集镜头脚本")
    parser.add_argument("--source", type=Path, help="preflight使用的单集原文；省略时读取项目episodes目录")
    parser.add_argument("--episode-only", action="store_true", help="accept/gate仅核对显式指定的一集，不要求前序覆盖凭证；保留原文完整性检查")
    args = parser.parse_args()
    if args.episode_only and (args.command not in {"accept", "gate"} or len(args.episodes) != 1):
        parser.error("--episode-only仅用于显式指定一个集号的accept/gate")
    if args.command != "preflight" and (args.script is not None or args.source is not None):
        parser.error("--script和--source仅用于preflight")
    if args.command == "source-scan":
        if args.episodes:
            parser.error("source-scan按已声明工作范围扫描，不接受集号参数")
        result = scan_project_source(args.project)
    elif args.command == "source-lines":
        if len(args.episodes) != 1:
            parser.error("source-lines需要一个集号")
        try:
            result = source_line_report(args.project, args.episodes[0])
        except (OSError, UnicodeError, ValueError) as error:
            result = {"status": "failed", "check": "source_line_classification", "coverage_acceptance": False,
                      "reasons": [str(error)]}
    elif args.command == "preflight":
        if len(args.episodes) != 1 or args.script is None:
            parser.error("preflight需要一个集号和--script")
        try:
            result = speech_preflight(args.project, args.episodes[0], args.script, source_file=args.source)
        except (OSError, UnicodeError, ValueError) as error:
            result = {"status": "failed", "check": "ordered_speech_only", "coverage_acceptance": False,
                      "reasons": [str(error)]}
    elif args.command == "gate":
        result = paid_ready(args.project, args.episodes, episode_only=args.episode_only)
    else:
        if args.command == "audit" and args.episodes:
            parser.error("audit 不接受集号参数")
        result = audit_project(args.project) if args.command == "audit" else write_pass_records(
            args.project, args.episodes or None, episode_only=args.episode_only)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.command == "accept":
        return 0 if result.get("accept_status") == "passed" else 1
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

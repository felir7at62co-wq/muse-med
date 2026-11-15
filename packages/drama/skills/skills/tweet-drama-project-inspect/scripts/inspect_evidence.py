"""Report local evidence and optional episode-path candidates without acceptance.

This read-only diagnostic never approves media, changes task state or contacts a
provider. A matching receipt refers to its source file, not necessarily the
current episode master or the clips selected for it.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat


EPISODE_PATH = re.compile(r"(?<![A-Za-z0-9])EP0*([1-9][0-9]*)(?![0-9])|第0*([1-9][0-9]*)集", re.I)
SCAN_LIMITS = {"max_entries": (5000, 100000), "max_depth": (12, 64), "max_candidates": (200, 10000)}


def _episodes(value: str) -> list[int]:
    """Parse at most 100 episode numbers, each between 1 and 9999."""
    numbers = set()
    for part in value.split(","):
        match = re.fullmatch(r"\s*([0-9]{1,4})(?:\s*-\s*([0-9]{1,4}))?\s*", part)
        if match is None:
            raise ValueError("episodes must be numbers or ascending ranges, such as 1-7 or 1,3-5")
        start, end = int(match[1]), int(match[2] or match[1])
        if start < 1 or end < start or end > 9999 or end - start >= 100:
            raise ValueError("episodes must select at most 100 numbers between 1 and 9999")
        numbers.update(range(start, end + 1))
        if len(numbers) > 100:
            raise ValueError("episodes must select at most 100 numbers between 1 and 9999")
    return sorted(numbers)


def _artifact_scan(project: Path, episodes: list[int], limits: dict) -> dict:
    """List bounded path-name candidates without following links or reading contents."""
    result = {"status": "complete", "requested_episodes": episodes, "limits": limits,
              "entries_examined": 0, "candidates": [], "issues": [], "issue_count": 0,
              "acceptance": "not_evaluated"}
    requested = set(episodes)

    def issue(code, path, error=None):
        result["status"] = "partial"
        result["issue_count"] += 1
        if len(result["issues"]) < 20:
            row = {"code": code, "path": path.relative_to(project).as_posix()}
            if error is not None:
                row["error"] = str(error)
            result["issues"].append(row)

    pending = [(project, 0)]
    stopped = False
    while pending and not stopped:
        directory, depth = pending.pop()
        try:
            # Recheck the directory before opening it if it changed since discovery.
            metadata = directory.lstat()
            if (stat.S_ISLNK(metadata.st_mode)
                    or getattr(metadata, "st_file_attributes", 0) & 0x400):
                issue("link_skipped", directory)
                continue
            if not directory.resolve(strict=True).is_relative_to(project):
                issue("external_path_skipped", directory)
                continue
            entries = []
            with os.scandir(directory) as stream:
                for entry in stream:
                    if result["entries_examined"] >= limits["max_entries"]:
                        issue("entry_limit", directory)
                        stopped = True
                        break
                    result["entries_examined"] += 1
                    entries.append(entry)
        except OSError as error:
            issue("scan_error", directory, error)
            continue
        children = []
        for entry in sorted(entries, key=lambda item: item.name):
            path = Path(entry.path)
            try:
                metadata = entry.stat(follow_symlinks=False)
                if (stat.S_ISLNK(metadata.st_mode)
                        or getattr(metadata, "st_file_attributes", 0) & 0x400):
                    issue("link_skipped", path)
                    continue
                is_directory = stat.S_ISDIR(metadata.st_mode)
                if not is_directory and not stat.S_ISREG(metadata.st_mode):
                    continue
                relative = path.relative_to(project).as_posix()
                named_episodes = sorted({int(match[1] or match[2]) for match in EPISODE_PATH.finditer(relative)})
                if requested.intersection(named_episodes):
                    if len(result["candidates"]) >= limits["max_candidates"]:
                        issue("candidate_limit", path)
                        stopped = True
                        break
                    result["candidates"].append({"path": relative,
                                                 "kind": "directory" if is_directory else "file",
                                                 "episodes": named_episodes,
                                                 "episode_match": "ambiguous" if len(named_episodes) > 1 else "unambiguous"})
                if is_directory:
                    if depth >= limits["max_depth"]:
                        issue("depth_limit", path)
                    else:
                        children.append((path, depth + 1))
            except OSError as error:
                issue("scan_error", path, error)
        pending.extend(reversed(children))
    result["issues_omitted"] = result["issue_count"] - len(result["issues"])
    result["candidates"].sort(key=lambda row: row["path"])
    result["episodes"] = []
    for episode in episodes:
        matches = [row for row in result["candidates"] if episode in row["episodes"]]
        paths = [row["path"] for row in matches if row["episode_match"] == "unambiguous"]
        ambiguous = [row["path"] for row in matches if row["episode_match"] == "ambiguous"]
        discovery = "candidates_found" if paths else "ambiguous_candidates" if ambiguous else (
            "unknown_partial_scan" if result["status"] == "partial" else "not_found_in_scan")
        result["episodes"].append({"episode": episode, "discovery": discovery, "candidate_paths": paths,
                                   "ambiguous_candidate_paths": ambiguous, "acceptance": "not_evaluated"})
    return result


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _file_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _timed_words(path: Path) -> int:
    """Count structurally timed words without certifying alignment or speech."""
    rows = _json(path)
    if not isinstance(rows, list):
        return 0
    count = 0
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("words"), list):
            return 0
        for word in row["words"]:
            if not isinstance(word, dict) or not isinstance(word.get("text"), str) or not word["text"].strip():
                return 0
            start, end = word.get("start"), word.get("end")
            if (type(start) not in (int, float) or type(end) not in (int, float)
                    or not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start):
                return 0
            count += 1
    return count


def _receipt(project: Path, path: Path) -> dict:
    row = {"receipt": str(path.relative_to(project)), "next_action": "inspect_receipt_format"}
    try:
        data = _json(path)
        if not isinstance(data, dict):
            raise ValueError("receipt must be an object")
        row["status_snapshot"] = data.get("status")
        source_value = data.get("source")
        source = Path(source_value) if isinstance(source_value, str) and source_value else None
        if source is None:
            raise ValueError("missing source")
        source = (source if source.is_absolute() else project / source).resolve()
        if not source.is_relative_to(project):
            row["next_action"] = "review_external_source"
            return row
        row["source"] = str(source.relative_to(project))
        row["source_exists"] = source.is_file()
        if not source.is_file():
            row["next_action"] = "restore_or_reselect_source"
            return row
        expected = data.get("sourceSha256")
        if not isinstance(expected, str) or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
            raise ValueError("missing or invalid sourceSha256; sha256 identifies extracted audio, not source media")
        row["source_sha256"] = _file_hash(source)
        row["source_matches"] = row["source_sha256"] == expected
        if not row["source_matches"]:
            row["next_action"] = "stale_for_current_source"
            return row
        if data.get("status") != "complete":
            row["next_action"] = "inspect_original_receipt"
            return row
        stem, version = data.get("stem"), data.get("version")
        if (not isinstance(stem, str) or not stem or stem in {".", ".."}
                or any(c in stem for c in '/\\:') or type(version) is not int or version < 1):
            raise ValueError("invalid output stem or version")
        outputs = {ext: project / "transcript/raw" / f"{stem}-v{version}.{ext}" for ext in ("txt", "json", "srt")}
        if any(not item.resolve().is_relative_to(project) for item in outputs.values()):
            row["next_action"] = "review_external_output"
            return row
        row["outputs_present"] = {ext: item.is_file() and item.stat().st_size > 0 for ext, item in outputs.items()}
        if not all(row["outputs_present"].values()):
            row["next_action"] = "inspect_original_receipt"
            return row
        row["timed_word_candidates"] = _timed_words(outputs["json"])
        row["next_action"] = "review_for_active_sources" if row["timed_word_candidates"] else "review_output_format"
    except (OSError, UnicodeError, ValueError) as error:
        row["error"] = str(error)
    return row


def inspect_project(project: Path, episodes: str | None = None, *, max_entries: int = 5000,
                    max_depth: int = 12, max_candidates: int = 200) -> dict:
    """Read evidence without treating local task snapshots as current remote state."""
    project = project.resolve(strict=True)
    if not project.is_dir():
        raise ValueError("project must be a directory")
    selected = None if episodes is None else _episodes(episodes)
    limits = {"max_entries": max_entries, "max_depth": max_depth, "max_candidates": max_candidates}
    for name, value in limits.items():
        if type(value) is not int or not 1 <= value <= SCAN_LIMITS[name][1]:
            raise ValueError(f"{name} must be between 1 and {SCAN_LIMITS[name][1]}")
    receipts = [_receipt(project, path) for path in sorted((project / "transcript/jobs").glob("*.json"))]
    issues = []
    for path in sorted((project / "qa").glob("EP*-review.md")):
        text = path.read_text(encoding="utf-8-sig")
        latest = text[text.rfind("\n## ") + 1:] if "\n## " in text else text
        for paragraph in re.split(r"\n\s*\n|\n(?=- )", latest):
            claimed = re.search(r"(?<!不)(?<!非)可交付|整集(?:已|全部)?通过|验收通过", paragraph)
            unchecked = re.search(r"(?:VO|OS|旁白|台词|对白|声音|音频)[^\n。；]{0,40}(?:未|待)[^\n。；]{0,12}(?:听校|核对|逐字|核验|确认)", paragraph, re.I)
            if claimed and unchecked:
                issues.append({"code": "delivery_claim_with_unchecked_audio", "review": str(path.relative_to(project)),
                               "excerpt": paragraph.strip(), "next_action": "separate_visual_pass_from_final_acceptance"})
    result = {"version": 1, "project": str(project), "network_calls": 0, "production_files_modified": False,
            "transcription_receipts": receipts, "review_issues": issues,
            "limitations": ["Receipt status is a local snapshot; query the original task to establish current remote status.",
                            "Reuse candidates require matching the active clips and actual listening; word times alone do not approve speech.",
                            "Review-text checks detect explicit contradictions in the latest section, not all missing QA or visual defects.",
                            "No issue reported does not establish delivery acceptance or authorization for paid work."]}
    if selected is not None:
        result["artifact_scan"] = _artifact_scan(project, selected, limits)
        result["limitations"].append("Episode paths are discovery candidates only; file contents, completeness and delivery acceptance were not checked. Not found in a scan does not mean not produced.")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--episodes", help="Episode numbers or ranges, such as 1-7 or 1,3-5; at most 100")
    for name, (default, ceiling) in SCAN_LIMITS.items():
        parser.add_argument("--" + name.replace("_", "-"), type=int, default=default,
                            help=f"Episode scan limit: 1-{ceiling} (default {default})")
    args = parser.parse_args()
    try:
        result = inspect_project(args.project, args.episodes, max_entries=args.max_entries,
                                 max_depth=args.max_depth, max_candidates=args.max_candidates)
    except (OSError, UnicodeError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

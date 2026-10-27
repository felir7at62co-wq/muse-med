"""Report local transcription reuse candidates and conflicting delivery claims.

This read-only diagnostic never approves media, changes task state or contacts a
provider. A matching receipt refers to its source file, not necessarily the
current episode master or the clips selected for it.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re


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


def inspect_project(project: Path) -> dict:
    """Read evidence without treating local task snapshots as current remote state."""
    project = project.resolve(strict=True)
    if not project.is_dir():
        raise ValueError("project must be a directory")
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
    return {"version": 1, "project": str(project), "network_calls": 0, "production_files_modified": False,
            "transcription_receipts": receipts, "review_issues": issues,
            "limitations": ["Receipt status is a local snapshot; query the original task to establish current remote status.",
                            "Reuse candidates require matching the active clips and actual listening; word times alone do not approve speech.",
                            "Review-text checks detect explicit contradictions in the latest section, not all missing QA or visual defects.",
                            "No issue reported does not establish delivery acceptance or authorization for paid work."]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    args = parser.parse_args()
    try:
        result = inspect_project(args.project)
    except (OSError, UnicodeError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

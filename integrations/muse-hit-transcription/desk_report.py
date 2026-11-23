"""Per-episode report of a drama worked on the transcription desk, for comparing builds (A/B).

For each finished episode in the range: when it first passed the check, minutes since the previous episode passed,
model spend since then (the Bot's usage snapshot at each first pass, priced with the desk's `prices`), dialogue
coverage against the speech result, the frame review size and whether a 待核 file exists, and a character check
against the drama's `outline/人物表.json`: speakers the table does not know, and speakers written in a known misspelling
(`variants`). The summary gives the medians and totals. Usage: desk_report.py <desk config> <series id> [first last] [--json out.json]
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_runner import DIALOGUE, NOT_DIALOGUE  # noqa: E402

FIELDS = ("input", "cacheRead", "cacheWrite", "output")


def yuan(before, after, price):
    if not before or not after or not price:
        return None
    return round(sum((after.get(f, 0) - before.get(f, 0)) * price.get(f, 0) for f in FIELDS) / 1_000_000, 3)


def roster(workspace):
    """(known names, misspelling -> name) from the drama's character table; empty when there is none."""
    try:
        table = json.loads((Path(workspace) / "outline" / "人物表.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return set(), {}
    known, variants = set(), {}
    # Bots write the table either as {"characters": [...], ...} or as the bare list of characters.
    people = table if isinstance(table, list) else table.get("characters") or [] if isinstance(table, dict) else []
    for person in people:
        if not isinstance(person, dict) or not person.get("name"):
            continue
        known.add(person["name"])
        known.update(alias for alias in person.get("aliases") or [] if isinstance(alias, str))
        for variant in person.get("variants") or []:
            if isinstance(variant, str):
                variants[variant] = person["name"]
    for extra in (table.get("supporting_descriptive_names") or [] if isinstance(table, dict) else []):
        name = extra.get("name") if isinstance(extra, dict) else extra
        if isinstance(name, str):
            known.add(name)
    return known, variants


def character_check(workspace, number, known, variants):
    """Speakers in one episode's script that the character table does not know, and those in a known misspelling."""
    try:
        script = (Path(workspace) / "episodes" / f"第{number}集.md").read_text(encoding="utf-8")
    except OSError:
        return None
    speakers = set()
    for line in script.splitlines():
        line = line.strip()
        if not line or NOT_DIALOGUE.match(line):
            continue
        match = DIALOGUE.match(line)
        if match:
            speakers.add(re.sub(r"(OS|VO|画外音|内心)$", "", match.group(1).strip()).strip())
    if not known:
        return {"speakers": len(speakers)}
    return {"speakers": len(speakers), "unknown": sorted(name for name in speakers if name not in known and name not in variants),
            "misspelled": sorted(name for name in speakers if name in variants)}


def report(desk, prices, first=None, last=None):
    measures = desk.get("measures") or {}
    done_at = desk.get("doneAt") or {}
    price = (prices or {}).get(desk.get("model") or "")
    order = sorted(done_at, key=lambda n: (done_at[n], int(n)))
    rows, previous = [], None
    known, variants = roster(desk["workspace"]) if desk.get("workspace") else (set(), {})
    for number in order:
        row = measures.get(number) or {}
        at = datetime.strptime(done_at[number], "%Y-%m-%d %H:%M:%S")
        entry = {"episode": int(number), "doneAt": done_at[number],
                 "minutes": round((at - previous[0]).total_seconds() / 60, 1) if previous else None,
                 "yuan": yuan(previous[1], row.get("usage"), price) if previous else None,
                 "coverage": row.get("speechCoverage"), "frames": row.get("frames"), "qa": row.get("qa"),
                 "part": row.get("part"), "compactions": row.get("compactions"),
                 "characters": character_check(desk["workspace"], int(number), known, variants) if desk.get("workspace") else None}
        previous = (at, row.get("usage"))
        if (first is None or entry["episode"] >= first) and (last is None or entry["episode"] <= last):
            rows.append(entry)

    def median(key):
        values = [row[key] for row in rows if isinstance(row.get(key), (int, float))]
        return round(statistics.median(values), 3) if values else None
    summary = {"title": desk.get("title"), "bot": desk.get("bot"), "episodes": len(rows),
               "medianMinutes": median("minutes"), "medianYuan": median("yuan"), "medianCoverage": median("coverage"),
               "qaShare": round(sum(1 for row in rows if row.get("qa")) / len(rows), 2) if rows else None,
               "unknownSpeakers": sum(len((row.get("characters") or {}).get("unknown") or []) for row in rows),
               "misspelledSpeakers": sum(len((row.get("characters") or {}).get("misspelled") or []) for row in rows)}
    return {"summary": summary, "episodes": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("series")
    parser.add_argument("range", nargs="*", type=int)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    desk = json.loads((Path(cfg["stateRoot"]) / args.series / "desk.json").read_text(encoding="utf-8"))
    first, last = (args.range + [None, None])[:2]
    result = report(desk, cfg.get("prices"), first, last)
    print(json.dumps(result["summary"], ensure_ascii=False))
    for row in result["episodes"]:
        print(json.dumps(row, ensure_ascii=False))
    if args.json:
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

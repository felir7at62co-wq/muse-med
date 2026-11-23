"""Per-episode report of a drama worked on the transcription desk, for comparing builds (A/B).

For each finished episode in the range: when it first passed the check, minutes since the previous episode passed,
model spend since then (the Bot's usage snapshot at each first pass, priced with the desk's `prices`), dialogue
coverage against the speech result, the frame review size and whether a 待核 file exists. The summary gives the
medians. Usage: desk_report.py <desk config> <series id> [first last] [--json out.json]
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import statistics

FIELDS = ("input", "cacheRead", "cacheWrite", "output")


def yuan(before, after, price):
    if not before or not after or not price:
        return None
    return round(sum((after.get(f, 0) - before.get(f, 0)) * price.get(f, 0) for f in FIELDS) / 1_000_000, 3)


def report(desk, prices, first=None, last=None):
    measures = desk.get("measures") or {}
    done_at = desk.get("doneAt") or {}
    price = (prices or {}).get(desk.get("model") or "")
    order = sorted(done_at, key=lambda n: (done_at[n], int(n)))
    rows, previous = [], None
    for number in order:
        row = measures.get(number) or {}
        at = datetime.strptime(done_at[number], "%Y-%m-%d %H:%M:%S")
        entry = {"episode": int(number), "doneAt": done_at[number],
                 "minutes": round((at - previous[0]).total_seconds() / 60, 1) if previous else None,
                 "yuan": yuan(previous[1], row.get("usage"), price) if previous else None,
                 "coverage": row.get("speechCoverage"), "frames": row.get("frames"), "qa": row.get("qa"),
                 "part": row.get("part"), "compactions": row.get("compactions")}
        previous = (at, row.get("usage"))
        if (first is None or entry["episode"] >= first) and (last is None or entry["episode"] <= last):
            rows.append(entry)

    def median(key):
        values = [row[key] for row in rows if isinstance(row.get(key), (int, float))]
        return round(statistics.median(values), 3) if values else None
    summary = {"title": desk.get("title"), "bot": desk.get("bot"), "episodes": len(rows),
               "medianMinutes": median("minutes"), "medianYuan": median("yuan"), "medianCoverage": median("coverage"),
               "qaShare": round(sum(1 for row in rows if row.get("qa")) / len(rows), 2) if rows else None}
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

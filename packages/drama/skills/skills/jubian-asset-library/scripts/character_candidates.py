#!/usr/bin/env python3
"""Find local face/outfit references and validate a proposed pair without writing files."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path, PurePosixPath

from search_assets import ROOT, load_jsonl, tokenize

GROUP_NAME = re.compile(r"群像|合照|合影|多人|双人|三人|人群|拼图")


def _by_id(root: Path, name: str) -> dict[int, dict]:
    return {
        int(row["asset_id"]): row
        for row in load_jsonl(root / "index" / name)
        if isinstance(row.get("asset_id"), int)
    }


def _local_file(root: Path, relative: object, directory: str) -> str | None:
    if not isinstance(relative, str):
        return None
    normalized = relative.replace("\\", "/")
    part = PurePosixPath(normalized)
    if part.is_absolute() or not part.parts or part.parts[0] != directory or ".." in part.parts:
        return None
    resolved_root = root.resolve()
    path = root.joinpath(*part.parts).resolve()
    if not path.is_relative_to(resolved_root) or not path.is_file():
        return None
    return str(path)


def _gender(face: dict, tag: dict) -> str | None:
    value = str(face.get("gender") or "").strip()
    if value in {"男", "男性"}:
        return "male"
    if value in {"女", "女性"}:
        return "female"
    tagged = tag.get("gender")
    return tagged if tagged in {"male", "female", "mixed"} else None


def _age(face: dict, tag: dict) -> tuple[int | None, str | None]:
    value = face.get("age")
    match = re.search(r"\d+", str(value or ""))
    if match:
        years = int(match.group())
        group = ("child" if years < 13 else "teen" if years < 18 else
                 "young" if years <= 30 else "middle" if years < 60 else "senior")
        return years, group
    tagged = tag.get("age_group")
    return None, tagged if tagged in {"child", "teen", "young", "middle", "senior"} else None


def candidates(root: Path, kind: str, include_groups: bool = False) -> list[dict]:
    """Join existing indexes by asset ID; each call sees the latest JSONL files."""
    if kind not in {"face", "body"}:
        raise ValueError("kind must be face or body")
    assets = _by_id(root, "assets.jsonl")
    tags = _by_id(root, "tags.jsonl")
    faces = _by_id(root, "face-manifest.jsonl")
    bodies = _by_id(root, "fullbody-manifest.jsonl")
    clothes = _by_id(root, "clothing-library.jsonl")
    manifest = faces if kind == "face" else bodies
    directory = "faces" if kind == "face" else "fullbody"
    result = []
    for asset_id, row in manifest.items():
        if row.get("status") != "ok":
            continue
        asset = assets.get(asset_id)
        if not asset or asset.get("asset_type_label") != "character":
            continue
        path = _local_file(root, row.get("file"), directory)
        if path is None:
            continue
        name = str(asset.get("asset_name") or row.get("asset_name") or "")
        tag = tags.get(asset_id, {}).get("tags") or {}
        face = faces.get(asset_id, {}).get("label_parts") or {}
        face = face.get("face") or {}
        clothing = clothes.get(asset_id, {}).get("clothing") or {}
        group = (bool(GROUP_NAME.search(name + " ".join(tag.get("tags") or [])))
                 or tag.get("gender") == "mixed")
        if group and not include_groups:
            continue
        age_years, age_group = _age(face, tag)
        result.append({
            "asset_id": asset_id,
            "kind": kind,
            "local_path": path,
            "name": name,
            "project": asset.get("project_name") or row.get("project_name"),
            "style": asset.get("style_label") or row.get("style_label"),
            "gender": _gender(face, tag),
            "age_years": age_years,
            "age_group": age_group,
            "identity": face.get("identity") or tag.get("identity_hint") or "",
            "face_features": {key: face.get(key) or "" for key in
                              ("face_shape", "eyes", "hair", "skin", "distinctive")},
            "clothing": clothing.get("raw") or tag.get("clothing") or "",
            "tags": tag.get("tags") or [],
            "group_image": group,
        })
    return result


def _match_score(row: dict, query: str) -> float:
    query = query.strip().lower()
    if not query:
        return 0.0
    tokens = [token for token in tokenize(query) if len(token) >= 2]
    features = " ".join(str(value) for value in row["face_features"].values())
    fields = [
        (row["name"], 10),
        (row["identity"], 8),
        (row["clothing"], 8 if row["kind"] == "body" else 3),
        (features, 6 if row["kind"] == "face" else 2),
        (" ".join(row["tags"]), 5),
    ]
    score = 0.0
    for value, weight in fields:
        text = value.lower()
        if query in text:
            score += weight * 2
        score += sum(weight for token in tokens if token in text)
    return score


def search(root: Path, kind: str, query: str = "", style: str = "all",
           gender: str = "", age: str = "", limit: int = 5,
           include_groups: bool = False) -> list[dict]:
    """Return only candidates with actual query evidence when a query is supplied."""
    if limit < 1 or limit > 50:
        raise ValueError("limit must be between 1 and 50")
    ranked = []
    for row in candidates(root, kind, include_groups):
        if style != "all" and row["style"] != style:
            continue
        if gender and row["gender"] != gender:
            continue
        if age and row["age_group"] != age:
            continue
        score = _match_score(row, query)
        if query.strip() and score == 0:
            continue
        ranked.append({**row, "score": score})
    ranked.sort(key=lambda row: (-row["score"], row["asset_id"]))
    return ranked[:limit]


def pair(root: Path, face_id: int, body_id: int) -> dict:
    """Resolve two independently selected images and reject known unsafe pairings."""
    face = next((row for row in candidates(root, "face") if row["asset_id"] == face_id), None)
    body = next((row for row in candidates(root, "body") if row["asset_id"] == body_id), None)
    if face is None or body is None:
        raise ValueError("Face or body is missing, excluded as a group, or has no usable crop")
    if face["style"] != body["style"]:
        raise ValueError("Face and body styles differ")
    if face["gender"] and body["gender"] and face["gender"] != body["gender"]:
        raise ValueError("Face and body genders differ")
    warnings = []
    if face["age_group"] and body["age_group"] and face["age_group"] != body["age_group"]:
        warnings.append("Face and body age groups differ; review the character intent")
    return {
        "face": face,
        "body": body,
        "ordered_reference_paths": [face["local_path"], body["local_path"]],
        "warnings": warnings,
        "next": "Review both images and obtain approval before uploading either reference or generating an image",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Search local character faces and outfits")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--kind", choices=("face", "body"), default="face")
    parser.add_argument("--q", default="")
    parser.add_argument("--style", choices=("realistic", "3d", "all"), default="all")
    parser.add_argument("--gender", choices=("", "male", "female"), default="")
    parser.add_argument("--age", choices=("", "child", "teen", "young", "middle", "senior"), default="")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--include-groups", action="store_true",
                        help="Show group images for review; pair still rejects them")
    parser.add_argument("--pair", nargs=2, type=int, metavar=("FACE_ID", "BODY_ID"))
    args = parser.parse_args()
    try:
        if args.pair:
            output = pair(args.root, *args.pair)
        else:
            found = search(args.root, args.kind, args.q, args.style,
                           args.gender, args.age, args.limit, args.include_groups)
            output = {"kind": args.kind, "count": len(found), "candidates": found}
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

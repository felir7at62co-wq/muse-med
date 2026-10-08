#!/usr/bin/env python3
"""Find local face/outfit references and validate a proposed pair without writing files."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path, PurePosixPath

from search_assets import ROOT, load_jsonl, tokenize

GROUP_NAME = re.compile(r"群像|合照|合影|多人|双人|三人|人群|拼图")
COLOR = re.compile(
    r"(?:深|浅|亮|暗)?(?:米白|卡其|咖啡|砖红|藏青|墨绿|军绿|棕|褐|红|黑|白|灰|蓝|绿|黄|紫|粉|驼|米)色?"
)
OUTFIT_MODIFIER = re.compile(r"双排扣|单排扣|长款|短款|工作|工装|连帽|防水|做旧|纯色|帆布|牛仔|皮质|布质|围腰|外套|的|系|穿|一件")


def _item_match(clothing: str, requirement: str) -> tuple[str, str]:
    """Check that a color describes the requested garment, not another item."""
    colors, separator, garments = requirement.partition(":")
    color_terms = [part.strip().lower() for part in colors.split("|") if part.strip()]
    garment_terms = [part.strip().lower() for part in garments.split("|") if part.strip()]
    if not separator or not color_terms or not garment_terms:
        raise ValueError("Each required item must be COLOR[|ALTERNATIVE]:GARMENT[|ALTERNATIVE]")
    if not clothing.strip():
        return "needs_review", "Clothing description is missing"
    garment_pattern = re.compile("|".join(re.escape(term) for term in garment_terms))
    seen_garment = False
    for clause in re.split(r"[，,、；;。+＋]", clothing.lower()):
        for garment in garment_pattern.finditer(clause):
            seen_garment = True
            colors_before = list(COLOR.finditer(clause, 0, garment.start()))
            if not colors_before:
                continue
            color = colors_before[-1]
            between = clause[color.end():garment.start()]
            if OUTFIT_MODIFIER.sub("", between).strip():
                continue
            if any(term in color.group() for term in color_terms):
                return "qualified", clause[color.start():garment.end()]
            return "not_qualified", f"Different color for {garment.group()}: {clause[color.start():garment.end()]}"
    if seen_garment:
        return "needs_review", f"Color of {'/'.join(garment_terms)} is not established"
    return "not_qualified", f"Description does not include {'/'.join(garment_terms)}"


def _unnegated_match(description: str, term: str) -> bool:
    """Do not count an explicitly absent attribute as positive evidence."""
    for found in re.finditer(re.escape(term), description):
        before = description[max(0, found.start() - 2):found.start()]
        if not before.endswith(("无", "没有", "未", "不", "没")):
            return True
    return False


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
           include_groups: bool = False, required: list[str] | None = None,
           required_items: list[str] | None = None) -> list[dict]:
    """Rank candidates, requiring each supplied attribute in the relevant description."""
    if limit < 1 or limit > 50:
        raise ValueError("limit must be between 1 and 50")
    groups = [[term.strip().lower() for term in group.split("|") if term.strip()]
              for group in (required or [])]
    if any(not group for group in groups):
        raise ValueError("Each required attribute needs at least one nonempty term")
    if required_items and kind != "body":
        raise ValueError("Required outfit items apply to body candidates only")
    for item in required_items or []:
        colors, separator, garments = item.partition(":")
        if not separator or not any(part.strip() for part in colors.split("|")) or not any(part.strip() for part in garments.split("|")):
            raise ValueError("Each required item must be COLOR[|ALTERNATIVE]:GARMENT[|ALTERNATIVE]")
    ranked = []
    for row in candidates(root, kind, include_groups):
        reasons = []
        evidence_matches = []
        disqualified = False
        if style != "all" and row["style"] != style:
            if row["style"]:
                continue
            reasons.append("Style is not described")
        if gender and row["gender"] != gender:
            if row["gender"]:
                continue
            reasons.append("Gender is not described")
        if age and row["age_group"] != age:
            if row["age_group"]:
                continue
            reasons.append("Age group is not described")
        evidence = (row["clothing"] if kind == "body" else
                    " ".join([row["identity"], row["clothing"],
                              *row["face_features"].values()])).lower()
        for group in groups:
            matched = next((term for term in group if _unnegated_match(evidence, term)), None)
            if matched:
                evidence_matches.append(matched)
            elif evidence.strip():
                reasons.append(f"Required attribute is absent: {'/'.join(group)}")
                disqualified = True
            else:
                reasons.append(f"Description is missing for {'/'.join(group)}")
        if required_items:
            for item in required_items:
                status, detail = _item_match(row["clothing"], item)
                if status == "needs_review" and not row["clothing"].strip():
                    garment_terms = [part.strip().lower() for part in item.partition(":")[2].split("|")]
                    name_and_tags = (row["name"] + " ".join(row["tags"])).lower()
                    if not any(term in name_and_tags for term in garment_terms):
                        disqualified = True
                if status == "not_qualified":
                    reasons.append(detail)
                    disqualified = True
                elif status == "needs_review":
                    reasons.append(detail)
                else:
                    evidence_matches.append(detail)
        if disqualified:
            continue
        score = _match_score(row, query)
        if query.strip() and score == 0 and not evidence_matches:
            continue
        status = "qualified" if (groups or required_items) and not reasons else "needs_review"
        ranked.append({**row, "score": score, "match_status": status,
                       "match_evidence": evidence_matches, "review_reasons": reasons})
    ranked.sort(key=lambda row: (row["match_status"] != "qualified", -row["score"], row["asset_id"]))
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
    warnings.append("Face and body identity has not been established; review the images")
    return {
        "face": face,
        "body": body,
        "ordered_reference_paths": [face["local_path"], body["local_path"]],
        "identity_status": "pending_review",
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
    parser.add_argument("--require", action="append", default=[], metavar="TERM[|ALTERNATIVE]",
                        help="Required attribute in clothing or face description; repeat for AND")
    parser.add_argument("--require-item", action="append", default=[], metavar="COLOR[|ALT]:GARMENT[|ALT]",
                        help="Require color and garment in the same outfit phrase; repeat for AND")
    parser.add_argument("--include-groups", action="store_true",
                        help="Show group images for review; pair still rejects them")
    parser.add_argument("--pair", nargs=2, type=int, metavar=("FACE_ID", "BODY_ID"))
    args = parser.parse_args()
    try:
        if args.pair:
            output = pair(args.root, *args.pair)
        else:
            found = search(args.root, args.kind, args.q, args.style,
                           args.gender, args.age, args.limit, args.include_groups,
                           args.require, args.require_item)
            qualified = sum(row["match_status"] == "qualified" for row in found)
            output = {"kind": args.kind, "count": len(found),
                      "qualified_count": qualified,
                      "result_status": "qualified_candidates" if qualified else "no_qualified_candidates",
                      "candidates": found}
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

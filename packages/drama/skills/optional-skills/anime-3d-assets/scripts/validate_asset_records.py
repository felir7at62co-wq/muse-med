"""Read-only structural checks for schema-2 asset revisions, never visual QA."""
import argparse
import hashlib
import json
from graphlib import CycleError, TopologicalSorter
from pathlib import Path, PureWindowsPath

ID_FIELDS = ("project_id", "asset_id", "variant_id", "revision")
SCENE_ROLES = ("SCENE_FAMILY_MASTER", "ZONE_MASTER", "CAMERA_VIEW", "STATE_VARIANT", "DETAIL_INSERT", "CONTINUITY_MAP")
ENVIRONMENT_DELTA = {"lighting", "time", "weather", "wetness", "visibility", "snow"}


def revision_key(value):
    """Return a pinned revision identifier, or None for incomplete JSON fields."""
    if not isinstance(value, dict):
        return None
    parts = tuple(value.get(field) for field in ID_FIELDS)
    if any(not isinstance(part, str) or not part.strip() for part in parts):
        return None
    if parts[-1].casefold() == "latest":
        return None
    return parts


def local_file(root, value):
    """Resolve a portable file inside root; reject URLs, drive paths and escapes."""
    if not isinstance(value, str) or not value or ":" in value or "\\" in value or "\0" in value:
        return None
    path = Path(value)
    if path.is_absolute() or PureWindowsPath(value).drive:
        return None
    try:
        resolved = (root / path).resolve()
    except (OSError, ValueError):
        return None
    return resolved if resolved.is_relative_to(root.resolve()) else None


def has_evidence(value):
    """Accept nonempty observations in the existing string or list representation."""
    if isinstance(value, str):
        return bool(value.strip())
    return isinstance(value, list) and bool(value) and all(has_evidence(item) for item in value)


def continuity(record):
    """Read optional scene planning fields without interpreting image contents."""
    generation = record.get("generation")
    if not isinstance(generation, dict):
        return None
    parts = generation.get("prompt_parts")
    return parts.get("scene_continuity") if isinstance(parts, dict) else None


def check_scene(record, parents, errors, label):
    """Check declared parent locks and deltas for camera and environment variants."""
    scene = continuity(record)
    if not isinstance(scene, dict) or scene.get("role") not in SCENE_ROLES:
        errors.append(f"{label}: scene_continuity needs a supported role")
        return
    locked, delta = scene.get("locked"), scene.get("delta")
    if not isinstance(scene.get("family_id"), str) or not scene["family_id"].strip():
        errors.append(f"{label}: scene family_id is missing")
    if not isinstance(locked, dict) or not all(locked.get(name) for name in ("layout", "materials", "palette", "camera")):
        errors.append(f"{label}: locked layout, materials, palette and camera are required")
        return
    if not isinstance(delta, dict):
        errors.append(f"{label}: delta must be an object")
        return
    identity, state = record.get("identity"), record.get("state")
    if not isinstance(identity, dict) or not isinstance(state, dict):
        errors.append(f"{label}: identity and state must be objects")
        return
    for name in identity.keys() & locked.keys():
        if identity[name] != locked[name]:
            errors.append(f"{label}: identity {name} differs from locked plan")
    for name in state.keys() & delta.keys():
        if state[name] != delta[name]:
            errors.append(f"{label}: state {name} differs from delta")
    if scene["role"] not in {"CAMERA_VIEW", "STATE_VARIANT"}:
        return
    if len(parents) != 1:
        errors.append(f"{label}: one scene_parent dependency is required")
        return
    base = continuity(parents[0])
    if not isinstance(base, dict) or not isinstance(base.get("locked"), dict):
        errors.append(f"{label}: scene parent has no locked planning fields")
        return
    if scene["family_id"] != base.get("family_id"):
        errors.append(f"{label}: scene family differs from parent")
    inherited = dict(base["locked"])
    current = dict(locked)
    if scene["role"] == "CAMERA_VIEW":
        if delta.get("camera") != current.get("camera"):
            errors.append(f"{label}: camera target differs from delta")
        inherited.pop("camera", None)
        current.pop("camera", None)
        permitted = {"camera"}
    else:
        permitted = ENVIRONMENT_DELTA
    if current != inherited:
        errors.append(f"{label}: locked fields differ from parent")
    if set(delta) - permitted:
        errors.append(f"{label}: delta fields exceed {scene['role']} scope")


def check_file(item, root, errors, label):
    """Check a declared local file and hash without interpreting its media bytes."""
    path = local_file(root, item.get("path")) if isinstance(item, dict) else None
    if path is None:
        errors.append(f"{label}: file path must stay inside project root")
        return
    if not path.is_file():
        errors.append(f"{label}: files missing: {item['path']}")
        return
    try:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError as error:
        errors.append(f"{label}: file read failed: {error}")
        return
    if item.get("sha256") != digest:
        errors.append(f"{label}: sha256 differs: {item['path']}")


def check_review(record, root, errors, label):
    """Check review declarations and file hashes; observations remain caller-owned."""
    review, adoption = record.get("review"), record.get("adoption")
    if not isinstance(review, dict) or not isinstance(adoption, dict):
        errors.append(f"{label}: review and adoption must be objects")
        return
    if review.get("result") not in ("pass", "fail", "not_checked"):
        errors.append(f"{label}: unsupported review result")
    if adoption.get("status") not in ("candidate", "adopted", "retired"):
        errors.append(f"{label}: unsupported adoption status")
    passing = review.get("result") == "pass"
    adopted = adoption.get("status") == "adopted"
    if adopted and (not passing or not has_evidence(adoption.get("basis"))):
        errors.append(f"{label}: adoption requires passing review and basis")
    if passing:
        style = review.get("style_gate")
        if not isinstance(style, dict) or style.get("result") != "pass" or not has_evidence(style.get("evidence")):
            errors.append(f"{label}: passing review requires style evidence")
        dimensions = set()
        for name in ("checks", "quality_checks"):
            checks = review.get(name)
            if not isinstance(checks, list):
                errors.append(f"{label}: {name} must be an array")
                continue
            for check in checks:
                if not isinstance(check, dict) or not isinstance(check.get("dimension"), str):
                    errors.append(f"{label}: invalid {name} entry")
                    continue
                if check.get("result") != "pass" or not has_evidence(check.get("evidence")):
                    errors.append(f"{label}: {name} {check['dimension']} lacks passing evidence")
                if name == "quality_checks":
                    dimensions.add(check["dimension"])
        if record.get("type") == "scene" and not {"scene_clean_plate", "scene_reference_isolation", "scene_continuity"} <= dimensions:
            errors.append(f"{label}: scene quality checks are missing")
    files = record.get("files")
    if not isinstance(files, list):
        errors.append(f"{label}: files must be an array")
        return
    if passing and not files:
        errors.append(f"{label}: passing review requires actual files")
    for item in files:
        check_file(item, root, errors, label)


def validate_records(records, project_root):
    """Return structural errors for a complete local dependency set without writes."""
    errors, indexed, edges = [], {}, {}
    for index, record in enumerate(records):
        key = revision_key(record)
        if key is None:
            errors.append(f"record {index}: project/asset/variant/revision identifiers must be pinned")
            continue
        if record.get("schema_version") != 2 or record.get("style_family") != "3d_anime":
            errors.append(f"{key}: schema 2 and 3d_anime are required")
        if record.get("type") not in ("character", "creature", "scene", "prop", "effect"):
            errors.append(f"{key}: unsupported asset type")
        if key in indexed:
            errors.append(f"{key}: duplicate revision")
        indexed[key] = record
    for key, record in indexed.items():
        label = "/".join(key)
        edges[key], parents = [], []
        predecessor = record.get("parent_revision")
        if predecessor is not None:
            predecessor_key = revision_key(dict(zip(ID_FIELDS, (*key[:3], predecessor))))
            if predecessor_key is None or predecessor_key not in indexed:
                errors.append(f"{label}: parent_revision is unpinned or missing")
            else:
                edges[key].append(predecessor_key)
        dependencies = record.get("dependencies")
        if not isinstance(dependencies, list):
            errors.append(f"{label}: dependencies must be an array")
            dependencies = []
        for dependency in dependencies:
            parent_key = revision_key(dependency)
            if parent_key is None:
                errors.append(f"{label}: dependency revision must be pinned")
                continue
            parent = indexed.get(parent_key)
            if parent is None:
                errors.append(f"{label}: missing dependency {'/'.join(parent_key)}")
                continue
            if parent_key[0] != key[0]:
                errors.append(f"{label}: cross-project dependency needs local derived revision")
                continue
            edges[key].append(parent_key)
            purpose = dependency.get("purpose")
            if purpose == "scene_parent":
                parents.append(parent)
                if parent.get("type") != "scene":
                    errors.append(f"{label}: scene_parent must be a scene")
            if purpose == "identity_parent" and record.get("identity") != parent.get("identity"):
                errors.append(f"{label}: identity differs from identity_parent")
            if isinstance(record.get("adoption"), dict) and record["adoption"].get("status") == "adopted":
                if not isinstance(parent.get("review"), dict) or parent["review"].get("result") != "pass":
                    errors.append(f"{label}: adopted revision depends on unreviewed parent")
        if record.get("type") == "scene":
            check_scene(record, parents, errors, label)
        generation = record.get("generation")
        references = generation.get("references") if isinstance(generation, dict) else None
        if not isinstance(references, list):
            errors.append(f"{label}: generation.references must be an array")
        else:
            for reference in references:
                if not isinstance(reference, dict):
                    errors.append(f"{label}: invalid reference entry")
                    continue
                purpose = reference.get("purpose")
                if purpose not in ("style", "layout", "identity", "costume", "structure", "edit_source", "edit_base", "local_review"):
                    errors.append(f"{label}: reference purpose is unsupported")
                if purpose == "local_review" and reference.get("submitted") is True:
                    errors.append(f"{label}: local_review cannot be submitted")
                if reference.get("submitted") is True and "path" in reference:
                    check_file(reference, project_root, errors, f"{label}: reference")
                if record.get("type") != "scene":
                    continue
                kind = reference.get("content_kind")
                if purpose in ("style", "layout", "structure", "costume") and kind not in ("environment_only", "material_only"):
                    errors.append(f"{label}: scene reference {purpose} contains unapproved human content")
                if purpose == "identity":
                    errors.append(f"{label}: scene reference cannot supply character identity")
                if purpose in ("edit_source", "edit_base"):
                    parts = generation.get("prompt_parts")
                    if kind not in ("environment_only", "material_only") and (not isinstance(parts, dict) or parts.get("remove_people") is not True):
                        errors.append(f"{label}: edit source requires explicit people removal")
        check_review(record, project_root, errors, label)
    try:
        tuple(TopologicalSorter(edges).static_order())
    except CycleError as error:
        errors.append(f"dependency cycle: {error.args[1]}")
    return errors


def main():
    """Print a JSON report and exit 1 for malformed records or structural errors."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("records", nargs="+", type=Path)
    args = parser.parse_args()
    records, errors = [], []
    for path in args.records:
        try:
            records.append(json.loads(path.read_text(encoding="utf-8-sig")))
        except (OSError, ValueError) as error:
            errors.append(f"{path}: cannot read record JSON: {error}")
    errors.extend(validate_records(records, args.project_root))
    print(json.dumps({"structure_valid": not errors, "visual_review": "not_performed", "records": len(records), "errors": errors}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

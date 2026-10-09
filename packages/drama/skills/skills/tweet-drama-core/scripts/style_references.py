"""Archive style references and validate review records without network access."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

from asset_image_import import import_asset_image, validate_asset_name, _verify_image, MAX_IMAGE_BYTES, VALID_EXTENSIONS


def _load(project: Path) -> dict:
    path = project / "asset_style_references.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schema_version": 1, "roles": {}}
    if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("roles"), dict):
        raise ValueError("Invalid asset_style_references.json")
    return data


def import_references(project: Path, role_id: str, name: str, role_class: str, images: list[Path]) -> None:
    """Preserve other roles; importing a replacement always resets review approval."""
    project = project.resolve()
    _validate_role_details(role_id, name, role_class)
    if not images:
        raise ValueError("Provide a role and at least one user-supplied image")
    data = _load(project)
    records = []
    for source in images:
        archived, digest = _archive_image(project, source)
        records.append({"note_id": f"local-{digest}", "origin": "user_supplied",
                        "source_url": "", "title": source.name,
                        "local_image_paths": [archived.relative_to(project).as_posix()],
                        "review_status": "pending_review", "review_reason": "",
                        "extracted_visual_elements": {}})
    data["roles"][role_id] = {"role_name": name, "role_class": role_class,
                              "queries": [], "style_reference_status": "pending_review",
                              "review_authority": "user_confirmation", "review_reason": "",
                              "candidates": records}
    _write(project, data)


def import_library_pair(project: Path, role_id: str, name: str, role_class: str,
                        library_root: Path, face_id: int, body_id: int) -> None:
    """Archive exactly one checked face and one checked outfit from the local library."""
    project = project.resolve()
    library_root = library_root.resolve()
    _validate_role_details(role_id, name, role_class)
    library_scripts = Path(__file__).resolve().parents[2] / "jubian-asset-library" / "scripts"
    if not library_scripts.is_dir():
        raise ValueError("Bundled character library scripts are missing")
    sys.path.insert(0, str(library_scripts))
    try:
        from character_candidates import pair
        selected = pair(library_root, face_id, body_id)
    finally:
        sys.path.pop(0)
    data = _load(project)
    records = []
    for kind in ("face", "body"):
        choice = selected[kind]
        source = Path(choice["local_path"])
        archived, digest = _archive_image(project, source)
        records.append({
            "note_id": f"library-{kind}-{choice['asset_id']}-{digest}",
            "origin": "library",
            "library_asset_id": choice["asset_id"],
            "library_kind": kind,
            "source_relative_path": source.relative_to(library_root).as_posix(),
            "title": choice["name"],
            "local_image_paths": [archived.relative_to(project).as_posix()],
            "review_status": "pending_review",
            "review_reason": "",
            "extracted_visual_elements": {},
        })
    data["roles"][role_id] = {
        "role_name": name, "role_class": role_class, "queries": [],
        "style_reference_status": "pending_review",
        "review_authority": "user_confirmation", "review_reason": "",
        "candidates": records,
    }
    _write(project, data)


def import_online_reference(project: Path, role_id: str, name: str, role_class: str,
                            image: Path, source_page: str, image_url: str,
                            license_name: str, license_url: str,
                            usage_rights_reason: str, *, title: str = "", append: bool = False) -> None:
    """Archive a downloaded image with source and rights evidence; review remains pending."""
    project = project.resolve()
    _validate_role_details(role_id, name, role_class)
    _require_https_page(source_page, "Source page")
    _require_https_url(image_url, "Image URL")
    _require_https_page(license_url, "License page")
    if source_page == image_url:
        raise ValueError("Source page must identify the page describing the image, not its file URL")
    if not _text(license_name) or not _text(usage_rights_reason):
        raise ValueError("Online reference needs a license name and usage-rights reason")
    data = _load(project)
    existing = data["roles"].get(role_id) if append else None
    if append and (not isinstance(existing, dict) or existing.get("role_name") != name
                   or existing.get("role_class") != role_class
                   or not isinstance(existing.get("candidates"), list)
                   or any(not isinstance(candidate, dict) or candidate.get("origin") != "online"
                          for candidate in existing["candidates"])):
        raise ValueError("Append requires an existing online-reference role with the same name and class")
    archived, digest = _archive_image(project, image)
    candidate = {"note_id": f"online-{digest}", "origin": "online",
                 "source_url": source_page, "image_url": image_url,
                 "license_name": license_name, "license_url": license_url,
                 "usage_rights_reason": usage_rights_reason,
                 "title": title.strip() or image.name,
                 "local_image_paths": [archived.relative_to(project).as_posix()],
                 "review_status": "pending_review", "review_reason": "",
                 "extracted_visual_elements": {}}
    candidates = list(existing["candidates"]) if existing else []
    if any(row.get("note_id") == candidate["note_id"] for row in candidates):
        raise ValueError("Online reference image is already archived for this role")
    candidates.append(candidate)
    data["roles"][role_id] = {"role_name": name, "role_class": role_class,
                              "queries": existing.get("queries", []) if existing else [],
                              "style_reference_status": "pending_review",
                              "review_authority": "agent_review", "review_reason": "",
                              "candidates": candidates}
    _write(project, data)


def _validate_role_details(role_id: str, name: str, role_class: str) -> None:
    validate_asset_name(role_id)
    if not name.strip() or role_class not in {"lead", "important_support", "support", "extra"}:
        raise ValueError("Provide a valid role name and class")


def _archive_image(project: Path, source: Path) -> tuple[Path, str]:
    if not source.is_file():
        raise ValueError(f"Missing reference image: {source}")
    if source.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("Reference image exceeds 50 MB")
    source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    archived = Path(import_asset_image(str(project), "character", f"reference_{source_digest}", str(source)))
    return archived, hashlib.sha256(archived.read_bytes()).hexdigest()


def _require_https_url(value: str, label: str) -> None:
    if not _text(value):
        raise ValueError(f"{label} must be an HTTPS URL")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{label} must be an HTTPS URL")


def _require_https_page(value: str, label: str) -> None:
    _require_https_url(value, label)
    if Path(urlparse(value).path).suffix.lower() in VALID_EXTENSIONS:
        raise ValueError(f"{label} must identify a page, not an image file")


def _write(project: Path, data: dict) -> None:
    path = project / "asset_style_references.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_role(project: Path, role: dict) -> None:
    """Reject incomplete review records, escaped paths and changed local evidence."""
    if not isinstance(role, dict) or role.get("style_reference_status") != "approved" or not _text(role.get("review_reason")):
        raise ValueError("Reference review and traceable approval are required")
    candidates = role.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Approved reference evidence is empty")
    accepted = 0
    authority = role.get("review_authority", "user_confirmation")
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError("Invalid reference candidate")
        if candidate.get("review_status") == "rejected" and _text(candidate.get("review_reason")):
            continue
        elements = candidate.get("extracted_visual_elements")
        if (candidate.get("review_status") != "approved" or not _text(candidate.get("review_reason"))
                or not isinstance(elements, dict) or not elements or not all(_text(v) for v in elements.values())):
            raise ValueError("Each selected reference needs visual review and extracted elements")
        origin = candidate.get("origin", "user_supplied")
        if origin == "online":
            if authority != "agent_review":
                raise ValueError("Online reference needs an agent review decision")
            _require_https_page(candidate.get("source_url"), "Source page")
            _require_https_url(candidate.get("image_url"), "Image URL")
            _require_https_page(candidate.get("license_url"), "License page")
            if (candidate["source_url"] == candidate["image_url"]
                    or not _text(candidate.get("license_name"))
                    or not _text(candidate.get("usage_rights_reason"))):
                raise ValueError("Online reference lacks source-page or usage-rights evidence")
        elif origin == "user_supplied":
            if authority != "user_confirmation":
                raise ValueError("User-supplied reference needs traceable user confirmation")
        elif origin == "library":
            if authority != "user_confirmation":
                raise ValueError("Library references need traceable user confirmation")
            asset_id = candidate.get("library_asset_id")
            kind = candidate.get("library_kind")
            relative = candidate.get("source_relative_path")
            if (not isinstance(asset_id, int) or asset_id <= 0 or kind not in {"face", "body"}
                    or not _text(relative) or not relative.startswith(
                        "faces/" if kind == "face" else "fullbody/"
                    )):
                raise ValueError("Library reference asset ID, kind, or source path is incomplete")
        else:
            raise ValueError("Unknown reference origin")
        paths = candidate.get("local_image_paths")
        if not isinstance(paths, list) or not paths:
            raise ValueError("Reviewed reference needs local images")
        for value in paths:
            if not _text(value) or Path(value).is_absolute():
                raise ValueError("Reference image must be project-relative")
            path = (project / value).resolve()
            if not path.is_relative_to(project.resolve()) or not path.is_file():
                raise ValueError("Reference image is missing or escapes project")
            _verify_image(path)
            note_id = candidate.get("note_id", "")
            if not isinstance(note_id, str) or not note_id:
                raise ValueError("Reference identity is missing")
            prefix = ("online-" if origin == "online" else
                      f"library-{candidate['library_kind']}-{candidate['library_asset_id']}-"
                      if origin == "library" else "local-")
            if (origin in {"online", "library"} or note_id.startswith("local-")) and note_id != prefix + hashlib.sha256(path.read_bytes()).hexdigest():
                raise ValueError("Reference image changed; repeat review and confirmation")
        accepted += 1
    if not accepted:
        raise ValueError("No approved reference images")


def check_references(project: Path, role_id: str) -> None:
    """Check a role before its paid generation; this does not authorize payment."""
    role = _load(project).get("roles", {}).get(role_id)
    validate_role(project, role)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("role_id")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("import")
    add.add_argument("--name", required=True)
    add.add_argument("--role-class", choices=["lead", "important_support", "support", "extra"], required=True)
    add.add_argument("--image", type=Path, action="append", required=True)
    online = commands.add_parser("import-online")
    online.add_argument("--name", required=True)
    online.add_argument("--role-class", choices=["lead", "important_support", "support", "extra"], required=True)
    online.add_argument("--image", type=Path, required=True)
    online.add_argument("--source-page", required=True)
    online.add_argument("--image-url", required=True)
    online.add_argument("--license-name", required=True)
    online.add_argument("--license-url", required=True)
    online.add_argument("--usage-rights-reason", required=True)
    online.add_argument("--title", default="")
    online.add_argument("--append", action="store_true")
    library = commands.add_parser("import-library")
    library.add_argument("--name", required=True)
    library.add_argument("--role-class", choices=["lead", "important_support", "support", "extra"], required=True)
    library.add_argument("--library-root", type=Path, required=True)
    library.add_argument("--face-id", type=int, required=True)
    library.add_argument("--body-id", type=int, required=True)
    commands.add_parser("check")
    args = parser.parse_args()
    try:
        if args.command == "import":
            import_references(args.project, args.role_id, args.name, args.role_class, args.image)
        elif args.command == "import-online":
            import_online_reference(args.project, args.role_id, args.name, args.role_class,
                                    args.image, args.source_page, args.image_url,
                                    args.license_name, args.license_url,
                                    args.usage_rights_reason, title=args.title, append=args.append)
        elif args.command == "import-library":
            import_library_pair(args.project, args.role_id, args.name, args.role_class,
                                args.library_root, args.face_id, args.body_id)
        else:
            check_references(args.project, args.role_id)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"{exc}\n")
    print("pending_review" if args.command != "check" else "reference_evidence_checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

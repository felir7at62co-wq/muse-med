"""Read-only preflight for the optional anime Skill's actual image request."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


MEDIA = {
    "3d动漫", "3d国漫", "三维动漫", "3d动画", "三维动画",
    "风格化三维动画", "风格化动画", "3d动漫／风格化三维动画", "3danime", "stylizedanimation",
}
PURPOSES = {"style", "layout", "identity", "costume", "structure", "edit_source", "edit_base"}


def https_url(value):
    """Accept an upload URL, never a local path or an upload status message."""
    if not isinstance(value, str) or not value or any(char.isspace() for char in value):
        return False
    try:
        parts = urlsplit(value)
        return (parts.scheme == "https" and bool(parts.hostname) and parts.port != 0
                and parts.username is None and parts.password is None)
    except ValueError:
        return False


def validate_generation_request(record, request):
    """Check a single request against the saved prompt and complete reference plan."""
    errors = []
    if not isinstance(record, dict) or not isinstance(request, dict):
        return ["record and request must be objects"]
    generation = record.get("generation")
    if not isinstance(generation, dict):
        return ["generation must contain the saved prompt and reference plan"]
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        errors.append("request.prompt must be non-empty")
        prompt = ""
    if generation.get("final_prompt") != prompt:
        errors.append("request.prompt differs from generation.final_prompt; recheck the actual request")
    prompt_parts = generation.get("prompt_parts")
    medium = prompt_parts.get("medium") if isinstance(prompt_parts, dict) else None
    if not isinstance(medium, str) or re.sub(r"\s+", "", medium).casefold() not in MEDIA:
        errors.append("prompt_parts.medium must name a positive 3D anime or stylized animation medium")
    elif (not prompt.lstrip().casefold().startswith(medium.casefold())
          or (len(prompt.lstrip()) > len(medium)
              and prompt.lstrip()[len(medium)] not in " ，,／/。.!?！？\n")):
        errors.append("request.prompt must open with the declared positive animation medium")
    opening = re.split(r"[。\n.!?！？]", prompt, maxsplit=1)[0]
    if not re.search(r"(?<![A-Za-z0-9_])PBR(?![A-Za-z0-9_])", opening, re.IGNORECASE):
        errors.append("request.prompt opening must retain the PBR material requirement")

    references = generation.get("references")
    if not isinstance(references, list):
        errors.append("generation.references must contain the complete planned references")
        references = []
    expected = []
    styles = 0
    for index, reference in enumerate(references):
        label = f"generation.references[{index}]"
        if not isinstance(reference, dict):
            errors.append(f"{label} must be an object")
            continue
        purpose = reference.get("purpose")
        if purpose == "local_review":
            if reference.get("submitted") is not False:
                errors.append(f"{label}: local_review cannot be submitted")
            continue
        if not isinstance(purpose, str) or purpose not in PURPOSES:
            errors.append(f"{label}: unknown generation reference purpose")
        if purpose == "style":
            styles += 1
        if reference.get("upload_status") != "uploaded" or reference.get("submitted") is not True:
            errors.append(f"{label}: upload is not ready; stop instead of text-only fallback")
        url = reference.get("url")
        if not https_url(url):
            errors.append(f"{label}: uploaded reference needs a usable HTTPS URL")
        expected.append(url)
    if styles == 0:
        errors.append("at least one planned style reference must be uploaded")
    actual = request.get("references")
    if not isinstance(actual, list) or not actual or not all(https_url(url) for url in actual):
        errors.append("request.references must be non-empty uploaded HTTPS URLs")
    if actual != expected:
        errors.append("request.references differs from the complete ordered reference plan")
    return errors


def validate_batch(records, request):
    """Validate every batch item before the Skill may submit any of them."""
    if not isinstance(request, dict):
        return ["request must be the jubian_video argument object"]
    method = request.get("method")
    if method == "image_generate":
        items = [request]
    elif method == "image_generate_batch":
        items = request.get("items")
        if not isinstance(items, list) or not items:
            return ["image_generate_batch needs non-empty items"]
    else:
        return ["request.method must be image_generate or image_generate_batch"]
    if len(items) != len(records):
        return ["records must match every request item in order"]
    errors = []
    for index, (record, item) in enumerate(zip(records, items)):
        errors.extend(f"items[{index}]: {error}" for error in validate_generation_request(record, item))
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--records", required=True, nargs="+", type=Path)
    args = parser.parse_args(argv)
    try:
        request = json.loads(args.request.read_text(encoding="utf-8-sig"))
        records = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.records]
        errors = validate_batch(records, request)
    except (OSError, ValueError) as error:
        errors = [f"cannot read preflight JSON: {error}"]
    print(json.dumps({"generation_ready": not errors, "visual_review": "not_performed",
                      "errors": errors}, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

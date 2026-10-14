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


def explicit_pbr_prohibition(clause):
    """Recognize complete PBR removal instructions, not material-quality advice."""
    scope = r"(?:\s*(?:用于|应用于|加到|出现在|\b(?:for|on|in)\b)\s*[^，,。.!?！？;；\n]+)?\s*$"
    return bool(re.search(
        r"(?:禁止|禁用|不要(?:使用)?|不使用|不用|去掉|移除|取消)\s*PBR\s*(?:材质|材料|着色|渲染)?" + scope
        + r"|(?:(?:do\s+not|don't)\s+(?:use|include)|without|no)\s+(?:any\s+)?PBR"
        r"(?:\s+(?:materials?|rendering|shading))?" + scope, clause, re.IGNORECASE))


def positive_photography_instruction(clause):
    """Identify photographic medium requests while retaining local exclusions."""
    for match in re.finditer(r"真人(?:摄影|实拍)|(?<![A-Za-z0-9_])photo[- ]?realistic\s*"
                             r"(?:人物摄影|真人摄影|人像摄影|portrait\s+photography|human\s+photography|photography|photos?)(?![A-Za-z0-9_])"
                             r"|(?<![A-Za-z0-9_])live[- ]action(?:\s+(?:film|photography|footage|movie|video)\b|(?=\s*$))",
                             clause, re.IGNORECASE):
        prefix = clause[:match.start()]
        if re.search(r"(?:不要|禁止|禁用|避免|排除|不是|非|不)(?:使用|采用|生成|制作)?\s*$"
                     r"|\b(?:not|no|without|avoid|exclude|(?:do\s+not|don't|never)"
                     r"\s+(?:use|generate|make(?:\s+it)?|render|create))\s+(?:(?:a|an|the|any)\s+)?$"
                     r"|\bnon-\s*$", prefix, re.IGNORECASE):
            continue
        return True
    return False


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
    """Check one animation choice, saved prompt and complete reference plan without rewriting them."""
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
    if "image_style" in request and request["image_style"] != "anime":
        errors.append("request.image_style must be anime for the declared animation medium")
    prompt_parts = generation.get("prompt_parts")
    medium = prompt_parts.get("medium") if isinstance(prompt_parts, dict) else None
    first_line = re.split(r"[\r\n]", prompt.lstrip(), maxsplit=1)[0]
    declaration = re.sub(r"^项目风格[:：]\s*", "", first_line, count=1)
    if not isinstance(medium, str) or re.sub(r"\s+", "", medium).casefold() not in MEDIA:
        errors.append("prompt_parts.medium must name a positive 3D anime or stylized animation medium")
    elif (not declaration.casefold().startswith(medium.casefold())
          or (len(declaration) > len(medium)
              and declaration[len(medium)] not in " ，,／/。.!?！？")):
        errors.append("request.prompt must open with the declared positive animation medium")
    opening = re.split(r"[。\n.!?！？]", prompt, maxsplit=1)[0]
    if not re.search(r"(?<![A-Za-z0-9_])PBR(?![A-Za-z0-9_])", opening, re.IGNORECASE):
        errors.append("request.prompt opening must retain the PBR material requirement")
    clauses = re.split(r"[，,。.!?！？;；\n]", prompt)
    if any(explicit_pbr_prohibition(clause) for clause in clauses):
        errors.append("request.prompt explicitly prohibits PBR materials")
    if any(positive_photography_instruction(clause) for clause in clauses):
        errors.append("request.prompt positively requests live-action photography")

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
        if "image_style" in request:
            return ["image_generate_batch requires per-item image_style, not a top-level image_style"]
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

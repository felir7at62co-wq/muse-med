"""Read a completed Muse run and identify a technically valid draft delivery."""

from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path, PurePosixPath
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

from common import digest, read


class DeliveryRejected(ValueError):
    """A candidate needs inspection; its run must not be replaced or re-submitted."""


_NAMESPACE = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
_ACTIONS = {"delivery", "transcript_coverage"}
_BINDINGS = ("sessionId", "workspace", "provider", "model", "promptSha256", "extraPatchSha256")


def native_manuscript_results(lines):
    """Yield successful native results with the action from the matching SDK tool call."""
    calls = {}
    for line in lines:
        event = json.loads(line).get("payload", {}).get("event", {})
        data = event.get("data", {})
        if event.get("type") == "tool/call" and data.get("name") == "manuscript_revision":
            args = data.get("arguments", {})
            if isinstance(args, str):
                args = json.loads(args)
            action = args.get("action")
            if action in _ACTIONS:
                calls[data["callId"]] = action
        if event.get("type") != "tool/result":
            continue
        message = data.get("message", {})
        action = calls.pop(message.get("toolCallId"), None)
        if action is None or message.get("isError"):
            continue
        for block in message.get("content", []):
            if block.get("type") != "text":
                continue
            try:
                value = json.loads(block["text"])
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("state") == action:
                yield {"tool": "manuscript_revision", "method": action, "result": value}


def _read(workspace, path):
    if path.is_absolute() or ".." in path.parts:
        raise DeliveryRejected(f"file is outside the workspace: {path}")
    local = workspace.joinpath(*path.parts)
    if not local.is_file() or local.resolve(strict=True) != local:
        raise DeliveryRejected(f"missing or linked file: {path}")
    value = local.read_bytes()
    if not value:
        raise DeliveryRejected(f"empty file: {path}")
    return value


def _paragraphs(word):
    with ZipFile(BytesIO(word)) as archive:
        if archive.testzip() is not None:
            raise DeliveryRejected("damaged Word document")
        document = ET.fromstring(archive.read("word/document.xml"))
    body = document.find("w:body", _NAMESPACE)
    if body is None:
        raise DeliveryRejected("missing Word body")
    paragraphs = ("".join(t.text or "" for t in p.findall(".//w:t", _NAMESPACE)).strip()
                  for p in body.findall(".//w:p", _NAMESPACE))
    return [line for line in paragraphs if line]


def verify_delivery(workspace: Path, episode: int, expected_run: dict, run: dict, native_results):
    """Require a unique Word with current text, source dialogue comparison and native checks.

    The caller supplies the frozen run identity and checks the approved source video hash.
    A successful result remains a draft subject to independent source review.
    """
    if run.get("finishReason") != "completed" or any(
        binding not in expected_run or run.get(binding) != expected_run[binding] for binding in _BINDINGS
    ) or any(not expected_run[key] for key in _BINDINGS if key != "extraPatchSha256"):
        raise DeliveryRejected("the original Muse run did not complete or its binding changed")
    workspace = workspace.resolve(strict=True)
    remote = PurePosixPath(expected_run["workspace"])
    if not remote.is_absolute() or ".." in remote.parts or type(episode) is not int or episode < 1:
        raise DeliveryRejected("invalid episode or workspace binding")
    draft_relative = PurePosixPath(f"scripts/{episode:04d}.md")
    draft = _read(workspace, draft_relative)
    draft_sha = sha256(draft).hexdigest()
    draft_lines = [line.strip() for line in draft.decode("utf-8").splitlines() if line.strip()]
    if not draft_lines:
        raise DeliveryRejected("empty screenplay body")
    comparison = None
    deliveries = {}
    for entry in native_results:
        if entry.get("tool") != "manuscript_revision":
            continue
        result = entry["result"]
        method = entry.get("method")
        if result.get("state") != method:
            continue
        if method == "transcript_coverage":
            for item in result["episodes"]:
                if item["draft"]["path"] == str(remote / draft_relative):
                    comparison = item
        elif method == "delivery" and result.get("source_mode") == "video":
            for item in result["files"]:
                path = PurePosixPath(item["path"])
                if path.parent == remote / "final" and path.suffix == ".docx":
                    # Re-registration moves a Word to the end, so the last entry is the latest delivery.
                    deliveries.pop(path.relative_to(remote), None)
                    deliveries[path.relative_to(remote)] = item
    if comparison is None or comparison["draft"]["file_sha256"] != draft_sha:
        raise DeliveryRejected("the latest dialogue comparison does not match the current Markdown")
    asr = comparison.get("asr")
    if not asr or not PurePosixPath(asr["path"]).is_relative_to(remote):
        raise DeliveryRejected("the dialogue comparison has no workspace audio evidence")
    audio = _read(workspace, PurePosixPath(asr["path"]).relative_to(remote))
    if sha256(audio).hexdigest() != asr["sha256"]:
        raise DeliveryRejected("the dialogue comparison audio evidence changed")

    current = []
    rejected = []
    for path, receipt in deliveries.items():
        word = _read(workspace, path)
        word_sha = sha256(word).hexdigest()
        if word_sha != receipt["file_sha256"]:
            raise DeliveryRejected(f"Word bytes differ from the native delivery: {path}")
        check = receipt.get("video_check") or {}
        rows = check.get("episodes", [])
        complete = (len(rows) == 1 and rows[0].get("episode") == episode
                    and rows[0].get("frames") == "complete" and rows[0].get("frame_count", 0) > 0
                    and rows[0].get("recorded") == rows[0]["frame_count"])
        if not complete:
            row = rows[0] if len(rows) == 1 else {}
            rejected.append({"path": str(path), "reason": f"frame review {row.get('frames', 'missing')} "
                             f"({row.get('recorded', 0)}/{row.get('frame_count', 0)} recorded)"})
            continue
        if check.get("format_error_count") != 0 or rows[0].get("format_errors") != 0:
            rejected.append({"path": str(path), "reason": "format errors in the native check"})
            continue
        try:
            paragraphs = _paragraphs(word)
        except (BadZipFile, KeyError, ET.ParseError) as error:
            raise DeliveryRejected(f"invalid Word document: {path}") from error
        if paragraphs != draft_lines:
            rejected.append({"path": str(path), "reason": "Word body differs from the current Markdown"})
            continue
        current.append({"path": str(path), "sha256": word_sha, "paragraphs": len(paragraphs),
                        "recordedFrames": rows[0]["recorded"], "warnings": check.get("warnings", [])})
    if not current:
        reasons = "; ".join(dict.fromkeys(item["reason"] for item in rejected))
        raise DeliveryRejected("expected one current Word meeting all checks; found 0"
                               + (f": {reasons}" if reasons else ""))
    # Every Word left in `current` passed the frame and format checks and has the current Markdown body, so a
    # resumed Session that saved another copy delivers its latest registration instead of failing.
    superseded = [{"path": item["path"], "reason": "superseded by a later delivery of the same body"}
                  for item in current[:-1]]
    return {"episode": episode, "sessionId": run["sessionId"], "markdownSHA256": draft_sha,
            "word": current[-1], "rejected": rejected + superseded, "asrSHA256": asr["sha256"],
            "stage": "candidate-ready", "semanticAccepted": False, "published": False}


def native_source_results(path):
    """Read the original speech request and successful media results from one turn."""
    calls = {}
    starts = []
    records = []
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            event = json.loads(line).get('payload', {}).get('event', {})
            data = event.get('data', {})
            if event.get('type') == 'tool/call' and data['name'] in {'video_inspect', 'video_ocr', 'audio_transcribe', 'screenplay_export_docx'}:
                args = data.get('arguments', {})
                if isinstance(args, str):
                    args = json.loads(args)
                calls[data['callId']] = data['name']
                if data['name'] == 'audio_transcribe' and args.get('method') == 'start':
                    starts.append(data['callId'])
            elif event.get('type') == 'tool/result':
                message = data['message']
                tool = calls.pop(message.get('toolCallId'), None)
                if tool and not message.get('isError'):
                    for block in message.get('content', []):
                        if block.get('type') == 'text':
                            try:
                                value = json.loads(block.get('text', ''))
                            except json.JSONDecodeError:
                                continue
                            if isinstance(value, dict):
                                records.append((tool, value))
    return starts, records


def checked_file(path, workspace):
    """Resolve a recorded file without following links or leaving the episode workspace."""
    path = Path(path)
    if not path.is_absolute() or not path.is_relative_to(workspace) or not path.is_file() or path.resolve() != path:
        raise DeliveryRejected('native evidence path is not a regular file in the episode workspace')
    return path


def recognition_covers_source(job, duration):
    """Match the standard recognition receipt and any native parts to the source duration."""
    if job.get('purpose') != 'screenplay' or job.get('status') != 'complete' or job.get('service_version') != 'standard-v2':
        return False
    if 'parts' not in job:
        return True
    parts = job['parts']
    if not isinstance(parts, list) or not parts:
        return False
    end = 0
    ids = set()
    for part in parts:
        if (not isinstance(part, dict) or not isinstance(part.get('id'), str) or part['id'] in ids or
                part.get('purpose') != 'screenplay' or part.get('service_version') != 'standard-v2' or
                type(part.get('duration')) not in (int, float) or not math.isfinite(part['duration']) or
                part['duration'] <= 0 or part.get('offset') != end):
            return False
        ids.add(part['id'])
        end += part['duration']
    return abs(end - duration) <= 0.1


def ocr_coverage(ranges):
    """Chain OCR intervals from zero; return their end and the time they cover, or None for a gap.

    Each range is ``(start, stop, next_sample)``, where ``next_sample`` is the first planned sample after the
    interval. No source frame lies between ``stop`` and ``next_sample``, so coverage reaches the later of the two.
    """
    end = reach = 0
    for start, stop, next_sample in sorted(ranges):
        if not 0 <= start <= end + 0.001 or stop <= start:
            return None
        end = max(end, stop)
        reach = max(reach, stop, next_sample)
    return end, reach


def validate_sources(workspace, video, row, native, verification):
    """Bind complete speech, image and subtitle evidence to the current video and draft."""
    starts, results = native
    check = lambda reason: DeliveryRejected(reason)
    if digest(video) != row['sha256']:
        raise check('the original video changed during the run')
    reviews = [value for name, value in results if name == 'video_inspect'
               and value.get('review_id') and value.get('path') == str(video)]
    if not reviews:
        raise check('the run has no native video review for this source')
    latest = reviews[-1]
    if not (latest.get('scan_complete') and latest.get('complete') and latest.get('pending') == 0
            and latest.get('recorded') == latest.get('total') == verification['word']['recordedFrames']):
        raise check('native review and this Word disagree on completed frames')
    ranges = []
    ocr_paths = {}
    for tool, result in results:
        if tool != 'video_ocr':
            continue
        if result['scan_status'] != 'complete':
            continue
        coverage = result['coverage']
        if (result['path'] != str(video) or result['source_version'] != latest['source_version']
                or coverage['failed_frame_count'] != 0
                or coverage['unscanned_ranges'] or coverage['processed_frame_count'] <= 0
                or coverage['planned_frame_count'] != coverage['processed_frame_count']):
            raise check('native OCR evidence is incomplete or belongs to a different source')
        path = checked_file(result['raw_json_path'], workspace)
        if digest(path) != result['raw_json_sha256']:
            raise check('native OCR evidence bytes changed')
        ocr_paths[str(path.relative_to(workspace))] = result['raw_json_sha256']
        start, stop = result['interval']['start_seconds'], result['interval']['end_seconds']
        step = coverage.get('frame_interval_seconds')
        sampled = type(step) in (int, float) and math.isfinite(step) and step > 0
        ranges.append((start, stop, start + coverage['planned_frame_count'] * step if sampled else stop))
    covered = ocr_coverage(ranges)
    if covered is None:
        raise check('the source has a gap in native OCR')
    end, reach = covered
    if reach < row['durationSeconds'] - 0.051:
        raise check('native OCR does not reach the original ending')
    marker = workspace / '.recognition-admitted.json'
    jobs = list((workspace / 'transcript/jobs').glob('*.json'))
    if len(jobs) != 1 or not marker.is_file():
        raise check('the first recognition identity is missing or ambiguous')
    request = read(checked_file(marker, workspace))
    if request['callId'] not in starts or request['video'] != str(video):
        raise check('the admitted recognition call is not bound to this source')
    job = read(checked_file(jobs[0], workspace))
    if (not recognition_covers_source(job, row['durationSeconds']) or job['source'] != str(video)
            or job['sourceSha256'] != row['sha256']):
        raise check('the native recognition did not complete under the original approved job')
    completed = [r for name, r in results if name == 'audio_transcribe' and r.get('status') == 'complete'
                 and r.get('job_id') == job['id'] and r.get('output_json')]
    if not completed:
        raise check('the original recognition has no recorded completion')
    audio = checked_file(completed[-1]['output_json'], workspace)
    if digest(audio) != verification['asrSHA256']:
        raise check('the current draft comparison did not use this episode recognition result')
    if not any(name == 'screenplay_export_docx' for name, _ in results):
        raise check('there is no successful native Word export in this Session')
    return {'sourceSHA256': row['sha256'], 'asrJobId': job['id'], 'asrRequestsAdmitted': 1,
            'asr': str(audio.relative_to(workspace)), 'ocr': list(ocr_paths), 'ocrSHA256': ocr_paths, 'ocrEndSeconds': end,
            'recognitionStartToolCalls': len(starts), 'reviewId': latest['review_id']}

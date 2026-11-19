"""Run a Workshop episode through the same SDK and release checks as a station episode."""
import argparse
import json
import math
from pathlib import Path
import subprocess

from common import canonical_json, digest, freeze, read, under
from native import accepted, episode_workspace, transcribe_episode


def describe(path, root, kind, expected=None):
    """Describe a checked file using its relative path and SHA-256."""
    path = under(root, path)
    sha = digest(path)
    if expected is not None and sha != expected:
        raise ValueError("交付物与 Muse 校验时的内容不同")
    return {"kind": kind, "path": str(path.relative_to(root)), "sha256": sha, "bytes": path.stat().st_size}


def delivery_files(directory, row, checked):
    """Select only manuscript and source-review materials from the accepted Session."""
    n = row["index"]
    workspace = episode_workspace(directory, n)
    entries = [
        ("screenplay", f"scripts/{n:04d}.md", checked["markdownSHA256"]),
        ("word", checked["word"]["path"], checked["word"]["sha256"]),
        ("characters", "characters.json", checked["charactersSHA256"]),
        ("qa", f"qa/{n:04d}.json", checked["qaSHA256"]),
        ("asr", checked["asr"], checked["asrSHA256"]),
        *(("ocr", path, checked["ocrSHA256"][path]) for path in checked["ocr"]),
    ]
    asr = under(workspace, workspace / checked["asr"])
    subtitle = asr.with_suffix(".srt")
    if subtitle.is_file():
        entries.append(("subtitles", str(subtitle.relative_to(workspace)), None))
    for observation in sorted((workspace / ".muse/video-observations").glob("*.json")):
        entries.append(("visual-review", str(observation.relative_to(workspace)), None))
    files = []
    for kind, path, sha in entries:
        part = describe(workspace / path, workspace, kind, sha)
        part["path"] = str(workspace.relative_to(directory) / part["path"])
        files.append(part)
    return {"version": 1, "episode": n, "sourceSHA256": row["sha256"], "sessionId": checked["sessionId"],
            "recordedFrames": checked["word"]["recordedFrames"], "reviewId": checked["reviewId"], "ocrEndSeconds": checked["ocrEndSeconds"],
            "warnings": checked["word"].get("warnings", []), "files": files}


def run(config, directory):
    """Recover a single episode using the frozen native Session and source binding."""
    request = read(directory / "request.json")
    n = request["episode"]
    video = under(directory, directory / request["source"])
    row = {"index": n, "path": str(video), "sha256": request["sourceSHA256"]}
    records = directory / "records"
    records.mkdir(exist_ok=True)
    if digest(video) != row["sha256"]:
        raise ValueError("原片与任务记录不符")
    checked = accepted(directory, row)
    if not checked:
        probe = subprocess.run([config["ffprobe"], "-v", "error", "-show_entries",
                                "format=duration:stream=codec_type", "-of", "json", str(video)],
                               capture_output=True, text=True, check=True, timeout=60)
        media = json.loads(probe.stdout)
        duration = float(media["format"]["duration"])
        if not math.isfinite(duration) or duration <= 0 or not any(s["codec_type"] == "video" for s in media["streams"]):
            raise ValueError("原片缺少有效视频轨或时长")
        row["durationSeconds"] = duration
        prior, cast = records / "previous.md", records / "prior-characters.json"
        freeze(prior, request["previous"] or "本次没有前一集正文。\n")
        freeze(cast, canonical_json(request["characters"]))
        note = "只沿用参考中已确认的事实；前情未提供时按本集原片写。"
        transcribe_episode(config, directory, row, request["title"], request["total"], prior, cast, note)
        checked = accepted(directory, row)
    if not checked:
        raise ValueError("Muse 尚未交付通过来源核对的草稿")
    manifest = delivery_files(directory, row, checked)
    freeze(directory / "materials.json", canonical_json(manifest))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    run(read(args.config), args.directory.resolve(strict=True))

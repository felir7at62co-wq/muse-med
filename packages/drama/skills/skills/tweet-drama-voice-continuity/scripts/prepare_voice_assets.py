"""Extract local soundtracks and missing voice candidates without uploading or approving them."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave

from extract_voice_reference import digest, extract, NO_WINDOW


def inside(root, path, exists=True):
    requested = root / path
    resolved = requested.resolve(strict=exists)
    if not resolved.is_relative_to(root):
        raise ValueError("Audio files must remain inside the current project")
    return resolved


def load(path):
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


@contextmanager
def ledger_lock(path):
    """Use an OS-released lock; keep its inode so independent writers share one lock."""
    if path.is_symlink():
        raise ValueError("Voice lock must not be a symlink")
    with path.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            if os.fstat(lock.fileno()).st_size == 0:
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def save(path, value):
    if path.is_symlink():
        raise ValueError("Voice manifest must not be a symlink")
    staged = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".voice-", delete=False) as target:
            staged = Path(target.name)
            json.dump(value, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(staged, path)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def mixed_audio(source, target, timeout):
    """Extract the complete mix; it is never a character voice reference."""
    with tempfile.TemporaryDirectory(prefix="muse-mix-", dir=target.parent) as folder:
        prepared = Path(folder) / "mix.wav"
        if source.suffix.lower() == ".wav":
            shutil.copyfile(source, prepared)
        else:
            ffmpeg = next((os.environ[name] for name in (
                "DSH_FFMPEG_PATH", "FFMPEG_PATH", "MUSE_FFMPEG_EXECUTABLE"
            ) if os.environ.get(name)), "ffmpeg")
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                            "-protocol_whitelist", "file,pipe", "-i", str(source),
                            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
                            "-c:a", "pcm_s16le", str(prepared)],
                           check=True, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
        with wave.open(str(prepared), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
            if duration <= 0 or audio.getsampwidth() != 2 or audio.getnchannels() not in (1, 2):
                raise ValueError("No usable PCM soundtrack")
        with prepared.open("rb") as current, target.open("xb") as output:
            shutil.copyfileobj(current, output)
    return duration


def prepare(project, request_path, timeout=120):
    """Keep all approved samples; deduplicate new candidates by source, character and interval."""
    root = Path(project).resolve(strict=True)
    request_file = inside(root, request_path)
    request_bytes = request_file.read_bytes()
    request = json.loads(request_bytes.decode("utf-8-sig"))
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object")
    if request.get("version") != 1 or not isinstance(request.get("characters"), list):
        raise ValueError("Use version=1 with characters containing character_id and optional intervals")
    if not 0 < timeout <= 3600 or len(request["characters"]) > 100:
        raise ValueError("Invalid extraction timeout or character count")
    source = inside(root, request["source_path"])
    source_hash = digest(source)
    if request.get("source_sha256") != source_hash:
        raise ValueError("Generated source bytes changed")
    task = request.get("source_task_id")
    if type(task) is int and task > 0:
        task = str(task)
    if not isinstance(task, str) or not task.strip():
        raise ValueError("Retain the original generation task ID")
    config_file = inside(root, "project_config.json")
    config_bytes = config_file.read_bytes()
    config = json.loads(config_bytes.decode("utf-8-sig"))
    if not isinstance(config, dict):
        raise ValueError("Project configuration must be an object")
    script_id = config.get("jubian_script_id")
    if not isinstance(script_id, int) or isinstance(script_id, bool) or script_id <= 0:
        raise ValueError("Project must retain its real jubian_script_id")
    bible = config.get("project_bible", {})
    characters = bible.get("characters", [])
    if not isinstance(characters, list) or any(not isinstance(c, dict) for c in characters):
        raise ValueError("Project bible characters must be an array")
    directory = inside(root, "audio/voice-references", exists=False)
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = inside(root, "audio/voice-references/manifest.json", exists=False)
    results = []
    with ledger_lock(directory / ".prepare.lock"):
        ledger = load(manifest_path) if manifest_path.exists() else {"version": 1, "script_id": script_id, "samples": [], "tracks": []}
        if ledger.get("script_id", script_id) != script_id or not isinstance(ledger.get("samples"), list) or not isinstance(ledger.get("tracks", []), list):
            raise ValueError("Voice ledger project or arrays are invalid")
        ledger.setdefault("script_id", script_id)
        ledger.setdefault("tracks", [])
        if any(not isinstance(row, dict) for row in ledger["samples"] + ledger["tracks"]):
            raise ValueError("Voice records must be JSON objects")
        for row in request["characters"]:
            if not isinstance(row, dict) or not isinstance(row.get("character_id"), str):
                raise ValueError("Each speaker needs a stable character_id, never a costume or name guess")
            matches = [c for c in characters if isinstance(c, dict) and c.get("character_id") == row["character_id"]]
            if len(matches) != 1:
                raise ValueError("Speaker character_id is missing or ambiguous in the project bible")
        if len({row["character_id"] for row in request["characters"]}) != len(request["characters"]):
            raise ValueError("One character appears once per request, independent of costume versions")
        config_hash = hashlib.sha256(config_bytes).hexdigest()
        track_id = hashlib.sha256((task + "\0" + source_hash).encode()).hexdigest()
        track_path = directory / (track_id + ".mixed.wav")
        old = [r for r in ledger["tracks"] if r.get("id") == track_id]
        if len(old) > 1:
            raise ValueError("Mixed-track identity is ambiguous")
        if old:
            if digest(inside(root, old[0]["path"])) != old[0]["sha256"]:
                raise ValueError("Saved mixed track changed; do not silently replace it")
            track = old[0]
        else:
            # An interrupted unregistered output is not assumed to be a verified sample.
            if track_path.exists():
                track_path.unlink()
            duration = mixed_audio(source, track_path, timeout)
            track = {"id": track_id, "kind": "mixed_track", "path": str(track_path.relative_to(root)),
                     "sha256": digest(track_path), "duration_seconds": duration, "source_task_id": task,
                     "source_path": str(source.relative_to(root)), "source_sha256": source_hash,
                     "usable_as_voice_reference": False}
            if digest(source) != source_hash or digest(inside(root, "project_config.json")) != config_hash or request_file.read_bytes() != request_bytes:
                track_path.unlink()
                raise ValueError("Source, identity or request changed during extraction")
            ledger["tracks"].append(track)
            save(manifest_path, ledger)
        for row in request["characters"]:
            character = next(c for c in characters if c.get("character_id") == row["character_id"])
            voice = character.get("voice_profile", {})
            if not isinstance(voice, dict):
                raise ValueError("Voice profile must be an object")
            if voice.get("reference_audio"):
                # Local extraction does not decide remote validity or revoke an approved reference.
                results.append({"character_id": row["character_id"], "status": "current_voice_preserved",
                                "next": "Use match_preview to verify the approved remote voice before binding"})
                continue
            intervals = row.get("intervals", [])
            if not isinstance(intervals, list) or len(intervals) > 100:
                raise ValueError("Provide a bounded list of real speech intervals")
            if not intervals:
                results.append({"character_id": row["character_id"], "status": "needs_interval"})
            for interval in intervals:
                if not isinstance(interval, dict):
                    raise ValueError("Voice interval must be an object")
                start, duration = interval.get("start_seconds"), interval.get("duration_seconds", 2)
                if isinstance(start, bool) or isinstance(duration, bool) or not isinstance(start, (int, float)) or not isinstance(duration, (int, float)):
                    raise ValueError("Voice interval requires numeric times")
                if not math.isfinite(start) or not math.isfinite(duration) or start < 0 or not 0 < duration <= 15:
                    raise ValueError("Sample interval must be finite, nonnegative and at most 15 seconds")
                sample_id = hashlib.sha256(json.dumps([task, source_hash, row["character_id"], float(start), float(duration)], separators=(",", ":")).encode()).hexdigest()
                existing = [r for r in ledger["samples"] if r.get("id") == sample_id]
                if len(existing) > 1:
                    raise ValueError("Sample identity is ambiguous")
                if existing:
                    sample = existing[0]
                    expected = {"character_id": row["character_id"], "source_task_id": task,
                                "source_sha256": source_hash, "source_path": str(source.relative_to(root)),
                                "start_seconds": start, "duration_seconds": duration}
                    if any(sample.get(key) != value for key, value in expected.items()):
                        raise ValueError("Saved candidate identity or interval changed")
                    if digest(inside(root, sample["path"])) != sample["sha256"]:
                        raise ValueError("Saved candidate changed; do not silently replace it")
                else:
                    sample_path = directory / (sample_id + ".wav")
                    if sample_path.exists():
                        sample_path.unlink()
                    evidence = extract(source, sample_path, start, duration, timeout=timeout)
                    sample = {**evidence, "id": sample_id, "character_id": row["character_id"],
                              "version": sample_id, "status": "candidate", "source_task_id": task,
                              "path": str(sample_path.relative_to(root)), "source_path": str(source.relative_to(root))}
                    if digest(source) != source_hash or digest(inside(root, "project_config.json")) != config_hash or request_file.read_bytes() != request_bytes:
                        sample_path.unlink()
                        raise ValueError("Source, identity or request changed during extraction")
                    ledger["samples"].append(sample)
                    save(manifest_path, ledger)
                results.append({"character_id": row["character_id"], "status": sample["status"], "sample_id": sample_id, "path": sample["path"], "speaker_verified": False})
        if digest(source) != source_hash or digest(inside(root, "project_config.json")) != config_hash or request_file.read_bytes() != request_bytes:
            raise ValueError("Source, identity or request changed during extraction")
    return {"script_id": script_id, "track": track, "characters": results, "manifest": str(manifest_path),
            "paid_requests": 0, "remote_writes": 0,
            "next": "Inspect candidate speech and speaker before upload/register; mixed_track is never a voice reference"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    args = parser.parse_args()
    print(json.dumps(prepare(args.project, args.request, args.timeout_seconds), ensure_ascii=False))


if __name__ == "__main__":
    main()

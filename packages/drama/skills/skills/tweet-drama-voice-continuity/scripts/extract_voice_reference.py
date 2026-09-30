"""Extract a bounded real voice interval; never synthesize speech or replace a saved sample."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import wave

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def extract(source, target, start, duration=2):
    """Save PCM WAV for an explicit interval and return measured evidence."""
    source, target = Path(source).resolve(strict=True), Path(target).absolute()
    if not all(math.isfinite(value) for value in (start, duration)) or start < 0 or not 0 < duration <= 15:
        raise ValueError("Reference duration must be greater than zero and at most 15 seconds; start must be nonnegative")
    if target.suffix.lower() != ".wav":
        raise ValueError("Voice reference output must be .wav")
    if target.exists() or target.is_symlink() or source == target:
        raise FileExistsError("Saved voice reference already exists; reuse it or choose a reviewed new version")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="muse-voice-", dir=target.parent) as folder:
        prepared = Path(folder) / "prepared.wav"
        if source.suffix.lower() == ".wav":
            with wave.open(str(source), "rb") as original:
                rate = original.getframerate()
                offset, frames = round(start * rate), round(duration * rate)
                if frames <= 0 or offset + frames > original.getnframes():
                    raise ValueError("Selected interval extends beyond the real source audio; no silence is appended")
                original.setpos(offset)
                samples = original.readframes(frames)
                if original.getsampwidth() != 2 or original.getnchannels() not in (1, 2):
                    raise ValueError("WAV source must be 16-bit mono or stereo PCM")
                with wave.open(str(prepared), "wb") as output:
                    output.setparams(original.getparams())
                    output.writeframes(samples)
        else:
            ffmpeg = next((os.environ[name] for name in (
                "DSH_FFMPEG_PATH", "FFMPEG_PATH", "MUSE_FFMPEG_EXECUTABLE"
            ) if os.environ.get(name)), "ffmpeg")
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(source),
                            "-ss", str(start), "-t", str(duration), "-map", "0:a:0", "-vn",
                            "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(prepared)],
                           check=True, capture_output=True, creationflags=NO_WINDOW)
        with wave.open(str(prepared), "rb") as audio:
            actual = audio.getnframes() / audio.getframerate()
            if abs(actual - duration) > 1 / audio.getframerate():
                raise ValueError("Source did not contain the complete requested voice interval")
        payload = prepared.read_bytes()
        with target.open("xb") as output:
            output.write(payload)
    return {"path": str(target), "source_path": str(source), "source_sha256": digest(source),
            "sha256": hashlib.sha256(payload).hexdigest(), "duration_seconds": actual,
            "start_seconds": start, "speaker_verified": False, "paid_requests": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start-seconds", type=float, required=True,
                        help="Start of a reviewed interval containing only this character's clear speech")
    parser.add_argument("--duration-seconds", type=float, default=2,
                        help="Default 2 seconds; maximum 15 seconds")
    args = parser.parse_args()
    print(json.dumps(extract(args.source, args.output, args.start_seconds, args.duration_seconds), ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Transcribe one local media file with Muse's bundled offline speech runtime."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def model_directory(override=None):
    """Return a complete local faster-whisper model without downloading one."""
    configured = override or os.environ.get("MUSE_WHISPER_MODEL_DIR")
    if not configured:
        raise RuntimeError("缺少离线语音模型：请设置 MUSE_WHISPER_MODEL_DIR 或传入 --model-dir。")
    directory = Path(configured).expanduser().resolve()
    missing = [name for name in MODEL_FILES if not (directory / name).is_file()]
    if missing:
        raise RuntimeError(f"MUSE_WHISPER_MODEL_DIR 模型目录不完整：{directory}；缺少 {', '.join(missing)}。")
    return directory


def ffmpeg_executable():
    """Prefer Muse's configured FFmpeg and fail when its configured file is absent."""
    configured = os.environ.get("DSH_FFMPEG_PATH")
    if configured:
        executable = Path(configured).expanduser().resolve()
        if not executable.is_file():
            raise RuntimeError(f"DSH_FFMPEG_PATH 指向的 FFmpeg 不存在：{executable}")
        return str(executable)
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise RuntimeError("找不到 FFmpeg：请设置 DSH_FFMPEG_PATH 或将 ffmpeg 加入 PATH。")
    return executable


def timestamp(seconds):
    """Format segment positions with millisecond precision."""
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, fraction = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{fraction:03d}"


def staged_text(target, content):
    """Write complete content beside its target before an exclusive publication."""
    descriptor, name = tempfile.mkstemp(prefix=".muse-transcribe-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
        return Path(name)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def publish_staged(staged, target):
    """Create a new result, including on volumes that do not support hardlinks."""
    try:
        os.link(staged, target)
    except FileExistsError:
        raise
    except OSError:
        with staged.open("rb") as source:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
            descriptor = os.open(target, flags, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    shutil.copyfileobj(source, output)
            except BaseException:
                target.unlink(missing_ok=True)
                raise


def publish_pair(text_path, text, json_path, rows):
    """Publish both complete outputs without replacing existing transcript files."""
    staged = []
    published_text = False
    try:
        staged.append(staged_text(text_path, text))
        staged.append(staged_text(json_path, json.dumps(rows, ensure_ascii=False, indent=2) + "\n"))
        publish_staged(staged[0], text_path)
        published_text = True
        try:
            publish_staged(staged[1], json_path)
        except BaseException:
            if published_text:
                text_path.unlink()
            raise
    finally:
        for path in staged:
            path.unlink(missing_ok=True)


def transcribe_file(input_path, text_path, json_path, language="zh", model_dir=None):
    """Decode local media, recognize speech, and create timestamp text and JSON."""
    source = Path(input_path).expanduser().resolve()
    text_target = Path(text_path).expanduser().resolve()
    json_target = Path(json_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"输入媒体不存在：{source}")
    if source in (text_target, json_target):
        raise ValueError("output path must not refer to input media")
    if text_target == json_target:
        raise ValueError("TXT 和 JSON 必须使用不同的输出路径。")
    for target in (text_target, json_target):
        if os.path.lexists(target):
            raise FileExistsError(f"输出文件已存在，请选择新路径：{target}")
    model_path = model_directory(model_dir)
    ffmpeg = ffmpeg_executable()
    text_target.parent.mkdir(parents=True, exist_ok=True)
    json_target.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=".muse-transcribe-audio-", dir=text_target.parent) as work:
        wav = Path(work) / "audio.wav"
        command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                   "-protocol_whitelist", "file,pipe", "-i", str(source),
                   "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", "-f", "wav", str(wav)]
        try:
            subprocess.run(command, check=True, capture_output=True, creationflags=NO_WINDOW)
        except (FileNotFoundError, subprocess.CalledProcessError) as error:
            detail = (error.stderr or b"").decode("utf-8", errors="replace").strip() \
                if isinstance(error, subprocess.CalledProcessError) else str(error)
            raise RuntimeError(f"FFmpeg 无法读取输入媒体：{detail}") from error

        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise RuntimeError("缺少 faster-whisper：请使用 Muse 随包 Python 运行此脚本。") from error
        model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=1,
                             num_workers=1, local_files_only=True)
        segments, _ = model.transcribe(str(wav), language=None if language == "auto" else language,
                                       temperature=0.0, condition_on_previous_text=False)
        rows = [{"start": float(segment.start), "end": float(segment.end),
                 "text": segment.text.strip()}
                for segment in segments if segment.text.strip()]

    if not rows:
        raise RuntimeError("未识别到语音；未创建空转写文件。请确认媒体含有人声和音轨。")
    text = "".join(f"[{timestamp(row['start'])} --> {timestamp(row['end'])}] {row['text']}\n"
                   for row in rows)
    publish_pair(text_target, text, json_target, rows)


def main(argv=None):
    """Parse explicit paths and report expected runtime errors without a traceback."""
    parser = argparse.ArgumentParser(description="Muse 本地音视频语音转写")
    parser.add_argument("--input", required=True, help="已授权的本地音频或视频文件")
    parser.add_argument("--output-txt", required=True, help="时间轴文字输出路径")
    parser.add_argument("--output-json", required=True, help="逐段 JSON 输出路径")
    parser.add_argument("--language", "--lang", default="zh", help="语种代码，或 auto 自动检测")
    parser.add_argument("--model-dir", help="可选的本地 faster-whisper 模型目录")
    args = parser.parse_args(argv)
    try:
        transcribe_file(args.input, args.output_txt, args.output_json,
                        language=args.language, model_dir=args.model_dir)
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError, OSError) as error:
        print(f"转写失败：{error}", file=sys.stderr)
        return 1
    print(f"已写入：{args.output_txt}；{args.output_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

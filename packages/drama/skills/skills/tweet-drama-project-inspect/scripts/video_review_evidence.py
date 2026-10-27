"""Create source-bound motion evidence; never decide media acceptance or generate video."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def file_hash(path: Path) -> str:
    """Hash the actual bytes, including source and extracted evidence versions."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run_media(args: list[str], timeout: int) -> str:
    """Wait for a local media command and surface failures without leaving a child running."""
    env = {key: value for key, value in os.environ.items()
           if not re.search(r'KEY|SECRET|TOKEN|PASSWORD', key, re.I)}
    result = subprocess.run(args, capture_output=True, encoding='utf-8', errors='replace',
                            timeout=timeout, env=env, check=False,
                            creationflags=NO_WINDOW)
    if result.returncode:
        raise ValueError(f'{Path(args[0]).name} failed: {result.stderr[-3000:]}')
    return result.stdout


def create_evidence(project: Path, source: Path, output: Path, start: float, end: float,
                    fps: float, ffmpeg: str, ffprobe: str, timeout: int = 60) -> dict:
    """Extract an unchanged source interval into a new evidence directory, preserving source media.

    Times on contact sheets are nominal sample-bin centers, not exact action
    boundaries. The accompanying continuous clip retains audio when present.
    The output remains pending even when every extraction succeeds.
    """
    project = project.resolve(strict=True)
    source = (project / source).resolve(strict=True)
    output = (project / output).resolve()
    if not project.is_dir() or not source.is_file() or not source.is_relative_to(project):
        raise ValueError('source must be an existing local project file')
    if output == project or not output.is_relative_to(project) or output.exists():
        raise ValueError('output must be a new directory inside the project; existing evidence is never replaced')
    if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end, fps))
            or start < 0 or end <= start or fps <= 0 or type(timeout) is not int or timeout < 1):
        raise ValueError('require finite 0 <= start < end, positive fps and positive integer timeout')
    from PIL import Image, ImageDraw
    metadata = json.loads(run_media([ffprobe, '-v', 'error', '-show_entries',
                                    'format=duration:stream=codec_type,width,height', '-of', 'json', str(source)], timeout))
    duration = float(metadata['format']['duration'])
    if not math.isfinite(duration) or end > duration:
        raise ValueError('requested interval exceeds actual source duration')
    if not any(row.get('codec_type') == 'video' for row in metadata['streams']):
        raise ValueError('source has no video stream')
    source_sha256 = file_hash(source)
    output.mkdir(parents=True, exist_ok=False)
    frames = output / 'frames'
    frames.mkdir()
    clip = output / 'continuous.mp4'
    run_media([ffmpeg, '-v', 'error', '-nostdin', '-n', '-ss', str(start), '-i', str(source),
               '-t', str(end-start), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-crf', '18',
               '-c:a', 'aac', '-movflags', '+faststart', str(clip)], timeout)
    run_media([ffmpeg, '-v', 'error', '-nostdin', '-n', '-ss', str(start), '-i', str(source),
               '-t', str(end-start), '-vf', f'fps={fps}', str(frames / '%06d.png')], timeout)
    images = sorted(frames.glob('*.png'))
    if not images:
        raise ValueError('no sampled frames; inspect a longer action interval')
    samples, sheets = [], []
    for page in range(0, len(images), 6):
        group = images[page:page+6]
        with Image.open(group[0]) as first:
            width, height = first.size
        canvas = Image.new('RGB', (3*width, 2*(height+24)), 'white')
        draw = ImageDraw.Draw(canvas)
        for index, path in enumerate(group):
            x, y = (index % 3)*width, (index // 3)*(height+24)
            with Image.open(path) as frame:
                canvas.paste(frame.convert('RGB'), (x, y))
            nominal = min(end, start+(page+index+0.5)/fps)
            draw.text((x+5, y+height+5), f'source ~{nominal:.3f}s', fill='black')
            samples.append({'file': str(path.relative_to(project)), 'sha256': file_hash(path),
                            'nominal_source_seconds': nominal})
        sheet = output / f'sheet-{page//6+1:03d}.jpg'
        canvas.save(sheet, quality=95)
        sheets.append({'file': str(sheet.relative_to(project)), 'sha256': file_hash(sheet)})
    if file_hash(source) != source_sha256:
        raise ValueError('source changed during extraction; evidence must not be adopted')
    record = {'version': 1, 'source': str(source.relative_to(project)), 'source_sha256': source_sha256,
              'source_duration_seconds': duration, 'interval_seconds': [start, end], 'fps': fps,
              'continuous_clip': {'file': str(clip.relative_to(project)), 'sha256': file_hash(clip),
                                  'source_offset_seconds': start,
                                  'audio_present_in_source': any(row.get('codec_type') == 'audio' for row in metadata['streams'])},
              'samples': samples, 'sheets': sheets, 'review_status': 'pending', 'network_calls': 0, 'paid_calls': 0,
              'limitations': ['Sample times are nominal bin centers; use the continuous clip to judge actions and cuts.',
                              'Frames do not establish missing actions, physical contact, speech, lip-sync or acceptance.',
                              'Compare the source requirements and reference assets; extraction does not approve them.']}
    (output / 'evidence.json').write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--fps', type=float, default=4)
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    parser.add_argument('--timeout', type=int, default=60)
    args = parser.parse_args()
    try:
        if not args.ffmpeg or not args.ffprobe:
            raise ValueError('provide ffmpeg and ffprobe executable paths or put them on PATH')
        result = create_evidence(args.project, args.source, args.output, args.start, args.end,
                                 args.fps, args.ffmpeg, args.ffprobe, args.timeout)
    except (OSError, ValueError, KeyError, ImportError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'error': str(error), 'review_status': 'pending'}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""Prepare one source-audio draft for Muse's aa剪映 Windows CLI adapter.

The Windows adapter edits a new native project and reads it back. FFmpeg only
probes sources and extracts the optional ending image; body files stay unchanged.
"""

import hashlib
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from urllib.parse import unquote

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# This CLI's project-create protocol uses 30 fps and exposes no frame-rate setter.
NATIVE_FRAME_RATE = 30
SCRIPT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_ROOT))
CORE_SCRIPTS = SCRIPT_ROOT.parents[1] / 'tweet-drama-core' / 'scripts'
sys.path.insert(0, str(CORE_SCRIPTS))
from video_bans import check_videos, find_project
from draft_inputs import audio_gains, body_clock, draft_style, bgm_import, product_subtitle_cues, write_product_subtitles
from generate_draft_request import read_subtitle_overlay_report

_policy_spec = importlib.util.spec_from_file_location(
    'aa_delivery_policy', SCRIPT_ROOT.parents[1] / 'tweet-drama-background-render/scripts/delivery_policy.py')
_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(_policy)


def file_hash(path: Path) -> str:
    """Read the selected file's current SHA-256 without changing it."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def deadline_seconds(setting: str = 'MUSE_DRAFT_DECODE_TIMEOUT_SECONDS') -> float:
    """Resolve a positive per-process media/CLI deadline from deployment settings."""
    value = float(os.environ.get(setting, '120'))
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{setting} must be finite and positive')
    return value


def media_program(kind: str) -> str:
    """Resolve the existing packaged media executable or an explicit deployment path."""
    configured = os.environ.get(f'{kind.upper()}_BINARY') or os.environ.get(f'MEDIA_{kind.upper()}')
    if configured:
        selected = Path(configured)
        if not selected.is_absolute() or not selected.is_file():
            raise ValueError(f'{kind.upper()}_BINARY must identify an existing absolute file')
        return str(selected)
    candidate = SCRIPT_ROOT.parent / 'tools/ffmpeg' / f'{kind}.exe'
    if candidate.is_file():
        return str(candidate)
    raise ValueError(f'The packaged {kind} executable is unavailable')


def media_run(arguments: list[str]) -> subprocess.CompletedProcess:
    """Run a bounded media check without showing a Windows console."""
    result = subprocess.run(arguments, capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=deadline_seconds(), creationflags=NO_WINDOW)
    if result.returncode:
        raise ValueError(f'Media inspection failed: {result.stderr[-4000:]}')
    return result


def native_run(arguments: list[str]) -> subprocess.CompletedProcess:
    """Wait for the owned Windows process tree; a deadline kills descendants before returning."""
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', errors='replace', creationflags=NO_WINDOW)
    try:
        stdout, stderr = process.communicate(timeout=deadline_seconds('MUSE_JIANYING_TIMEOUT_SECONDS'))
    except subprocess.TimeoutExpired as error:
        taskkill = Path(os.environ['SystemRoot']) / 'System32/taskkill.exe'
        killed = subprocess.run([str(taskkill), '/PID', str(process.pid), '/T', '/F'],
                                capture_output=True, text=True, encoding='utf-8', errors='replace',
                                timeout=deadline_seconds(), creationflags=NO_WINDOW)
        stdout, stderr = process.communicate(timeout=deadline_seconds())
        if killed.returncode:
            raise ValueError(f'AA adapter timed out; process-tree termination failed: {killed.stderr[-2000:]}') from error
        raise ValueError('AA adapter timed out; its owned process tree was terminated. Preserve the original receipt and candidate.') from error
    return subprocess.CompletedProcess(arguments, process.returncode, stdout, stderr)


def probe(path: Path, *, allow_still: bool = False) -> dict:
    """Inspect stream presence and duration without rendering the source."""
    result = media_run([media_program('ffprobe'), '-v', 'error', '-show_streams', '-show_format',
                        '-of', 'json', str(path)])
    document = json.loads(result.stdout)
    duration = float(document.get('format', {}).get('duration', 0))
    if not math.isfinite(duration) or (duration <= 0 and not allow_still):
        raise ValueError(f'Media has no positive measured duration: {path}')
    video = next((row for row in document.get('streams', []) if row.get('codec_type') == 'video'), None)
    video_duration = None
    if video:
        if video.get('duration') not in (None, 'N/A'):
            video_duration = Fraction(str(video['duration']))
        elif video.get('duration_ts') is not None and video.get('time_base'):
            video_duration = Fraction(video['duration_ts']) * Fraction(video['time_base'])
        if video_duration is not None and video_duration <= 0:
            video_duration = None
    return {'duration_us': round(duration * 1_000_000),
            'video_duration_us': round(video_duration * 1_000_000) if video_duration is not None else None,
            'width': video['width'] if video else None, 'height': video['height'] if video else None,
            'video': any(row.get('codec_type') == 'video' for row in document.get('streams', [])),
            'audio': any(row.get('codec_type') == 'audio' for row in document.get('streams', []))}


def ending_image(source: Path, selected_us: int, target: Path) -> dict:
    """Extract the actual selected last frame and compare its decoded RGB hash."""
    ffmpeg = media_program('ffmpeg')
    window = f'{selected_us / 1_000_000:.6f}'
    hashes = media_run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', str(source),
                        '-t', window, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'framemd5', '-']).stdout
    rows = [row for row in hashes.splitlines() if row and not row.startswith('#')]
    if not rows:
        raise ValueError('The last body clip has no decodable frame')
    expected = rows[-1].split(',')[-1].strip()
    media_run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', str(source),
               '-map', '0:v:0', '-vf', f'select=eq(n\\,{len(rows)-1})', '-frames:v', '1', str(target)])
    actual = media_run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', str(target),
                        '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'framemd5', '-']).stdout
    measured = [row.split(',')[-1].strip() for row in actual.splitlines() if row and not row.startswith('#')]
    if measured != [expected]:
        raise ValueError('The ending image differs from the selected final decoded frame')
    return {'path': str(target), 'duration_us': 2_000_000, 'frame_rgb_md5': expected,
            'source': str(source), 'source_sha256': file_hash(source), 'image_sha256': file_hash(target)}


def parse_subtitles(path: Path, *, allow_empty: bool = False) -> list[dict]:
    """Read existing corrected SRT cues verbatim, retaining their measured times."""
    pattern = re.compile(r'^(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*'
                         r'(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*$')
    raw = path.read_text(encoding='utf-8-sig')
    if not raw.strip() and allow_empty:
        return []

    def clock(parts):
        hours, minutes, seconds, millis = map(int, parts)
        if minutes >= 60 or seconds >= 60:
            raise ValueError('Invalid subtitle timestamp')
        return ((hours * 60 + minutes) * 60 + seconds) * 1_000_000 + millis * 1000

    cues = []
    for block in re.split(r'\r?\n\s*\r?\n', raw.strip()):
        lines = block.splitlines()
        if lines and lines[0].strip().isdigit():
            lines = lines[1:]
        match = pattern.fullmatch(lines[0].strip()) if lines else None
        if match is None:
            raise ValueError('The selected subtitle file contains an invalid timed block')
        body = '\n'.join(lines[1:]).strip()
        start, end = clock(match.groups()[:4]), clock(match.groups()[4:])
        if end <= start or not body:
            raise ValueError('Subtitle cues require text and increasing timestamps')
        cues.append({'start_us': start, 'end_us': end, 'text': body})
    if not cues and not allow_empty:
        raise ValueError('The selected subtitle file has no timed cues')
    return cues


def require_file(value, field: str) -> Path:
    """Validate a model-supplied input at the JSON file boundary."""
    if not isinstance(value, str):
        raise ValueError(f'{field} must be an absolute file path')
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise ValueError(f'{field} must identify an existing absolute file: {path}')
    return path


def native_ratio(width: int, height: int) -> str:
    """Map exact dimensions to the installed CLI's named aspect ratios."""
    for ratio in ('16:9', '9:16', '4:3', '3:4', '1:1', '2:1', '2.35:1', '1.85:1',
                  '1.125:2.436', '4:5', '21:9', '128:27'):
        numerator, denominator = map(Fraction, ratio.split(':'))
        if Fraction(width, height) == numerator / denominator:
            return ratio
    raise ValueError('The installed Jianying CLI cannot configure this custom aspect ratio')


def resolve_landscape_subtitle_style() -> dict:
    """Resolve deployment choices for the 16:9 editor subtitle style."""
    size = float(os.environ.get('MUSE_JIANYING_LANDSCAPE_SUBTITLE_SIZE', '7'))
    position = float(os.environ.get('MUSE_JIANYING_LANDSCAPE_SUBTITLE_Y', '-879'))
    if not math.isfinite(size) or not 0 < size <= 100 or not math.isfinite(position) or not -16384 <= position <= 16384:
        raise ValueError('The 16:9 subtitle size or position configuration is invalid')
    return {'font_size_ui': size, 'editor_y': position}


def frame_time(frame: int) -> int:
    """Transport a native frame without the CLI flooring it to its predecessor."""
    return math.ceil(Fraction(frame * 1_000_000, NATIVE_FRAME_RATE))


def native_span(start_us, end_us) -> dict:
    """Select nearest cumulative frame boundaries and transport their exact frame count."""
    start = round(Fraction(start_us) * NATIVE_FRAME_RATE / 1_000_000)
    end = round(Fraction(end_us) * NATIVE_FRAME_RATE / 1_000_000)
    if end <= start:
        raise ValueError('A selected span is shorter than one native frame; review its measured span')
    return {'start_us': frame_time(start), 'end_us': frame_time(end),
            'duration_us': frame_time(end - start), 'start_frame': start, 'end_frame': end}


def native_cue(cue: dict) -> dict:
    """Keep cue text while selecting nearest native start and end frames."""
    return {**cue, **native_span(cue['start_us'], cue['end_us'])}


def project_native_timeline(plan: dict) -> None:
    """Map unchanged source playback onto a continuous native grid and retain original spans."""
    plan['native_videos'] = [{**row, **native_span(row['start_us'], row['start_us'] + row['duration_us'])}
                             for row in plan['videos']]
    body_frame = plan['native_videos'][-1]['end_frame']
    body_time = Fraction(body_frame * 1_000_000, NATIVE_FRAME_RATE)
    plan['native_body_end_us'] = frame_time(body_frame)

    def source_endpoint(time_us):
        for original, selected in zip(plan['videos'], plan['native_videos']):
            end = original['start_us'] + original['duration_us']
            if original['start_us'] <= time_us < end or time_us == plan['body_end_us'] == end:
                start = Fraction(selected['start_frame'] * 1_000_000, NATIVE_FRAME_RATE)
                stop = Fraction(selected['end_frame'] * 1_000_000, NATIVE_FRAME_RATE)
                # Source playback is not stretched: only the destination offset changes.
                return min(stop, start + time_us - original['start_us'])
        raise ValueError('A subtitle endpoint has no selected source interval')

    plan['native_subtitles'] = [native_cue({**cue, 'start_us': source_endpoint(cue['start_us']),
                                           'end_us': source_endpoint(cue['end_us'])})
                                for cue in plan['subtitles']]
    end_frame = body_frame
    for kind in ('ending', 'ending_audio', 'ending_effect', 'bgm'):
        if kind not in plan:
            continue
        original = plan[kind]
        if kind == 'bgm':
            span = native_span(0, min(body_time, original['duration_us']))
        else:
            span = native_span(body_time, body_time + original['duration_us'])
        selected = {**original, **span}
        if kind == 'ending_effect':
            source_frames = math.floor(Fraction(original['source_duration_us'] * NATIVE_FRAME_RATE, 1_000_000))
            if source_frames < 1:
                raise ValueError('The ending effect is shorter than one native frame')
            target_frames = span['end_frame'] - span['start_frame'] if original['speed'] != 1 else source_frames
            selected.update(source_duration_us=frame_time(source_frames),
                            end_frame=body_frame + target_frames, end_us=frame_time(body_frame + target_frames),
                            duration_us=frame_time(target_frames), speed=source_frames / target_frames)
        plan['native_' + kind] = selected
        if kind == 'ending':
            end_frame = selected['end_frame']
    plan['native_duration_us'] = frame_time(end_frame)


def prepare_plan(request: dict, drafts_dir: str) -> tuple[dict, Path]:
    """Validate an embedded-audio episode and retain byte-identical selected inputs."""
    if not isinstance(request, dict) or request.get('audio_mode') != 'embedded' or 'audio' in request:
        raise ValueError('The AA backend requires audio_mode=embedded and no independent audio input')
    project, root = Path(request['project']), Path(drafts_dir)
    if not project.is_absolute() or not project.is_dir() or not root.is_absolute() or not root.is_dir():
        raise ValueError('project and drafts_dir must be existing absolute directories')
    episode = request['episode']
    if isinstance(episode, bool) or not isinstance(episode, int) or episode < 1:
        raise ValueError('episode must be a positive integer')
    prefix = request['name_prefix']
    if (not isinstance(prefix, str) or not prefix.strip() or re.search(r'[\\/\x00-\x1f<>:"|?*]', prefix)
            or prefix.endswith((' ', '.')) or prefix in ('.', '..')):
        raise ValueError('name_prefix must be a safe, unique Windows draft name')
    name = prefix + str(episode).zfill(2)
    if re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', name):
        raise ValueError('Windows-reserved draft name')
    draft_path = root / name
    if draft_path.exists():
        raise ValueError('Draft already exists; choose a new name_prefix')
    inputs = request['videos']
    if not isinstance(inputs, list) or not inputs:
        raise ValueError('videos must contain the selected episode files in shot order')
    sources = [require_file(path, 'videos') for path in inputs]
    check_videos(find_project(project, str(project)), sources)
    timeline_path = require_file(request['timeline'], 'timeline')
    subtitle_path = require_file(request['subtitle_srt'], 'subtitle_srt')
    timeline = json.loads(timeline_path.read_text(encoding='utf-8-sig'))
    clips = timeline.get('clips') if isinstance(timeline, dict) else None
    if not isinstance(clips, list) or len(clips) != len(sources):
        raise ValueError('Timeline clips and selected videos must match one-to-one')
    shots = [row.get('shot') if isinstance(row, dict) else None for row in clips]
    if any(isinstance(shot, bool) or not isinstance(shot, int) or shot < 1 for shot in shots) or len(set(shots)) != len(shots):
        raise ValueError('Timeline shot IDs must be distinct positive integers')
    ordered = sorted(clips, key=lambda row: row.get('start_us', -1))
    cursor = 0
    for row in ordered:
        if (any(isinstance(row.get(field), bool) or not isinstance(row.get(field), int)
                for field in ('start_us', 'duration_us'))
                or row['start_us'] != cursor or row['duration_us'] <= 0):
            raise ValueError('The body timeline must be continuous with positive integer microsecond durations')
        if row.get('source_start_us', 0) != 0 or row.get('speed', 1) != 1:
            raise ValueError('This AA source-preserving mode requires unretimed clips beginning at source time zero')
        cursor += row['duration_us']
    policy = _policy.resolve_delivery(timeline, project)
    ratio = native_ratio(policy['width'], policy['height'])
    policy = {**policy, 'ending_duration_us': 2_000_000 if ratio == '9:16' else 0}
    if policy['visual_medium'] is None:
        policy['warnings'] = [
            'visual_medium is missing; retaining the legacy AI mark. Windows AA adds an ending only for 9:16.'
            if warning == _policy.LEGACY_WARNING else warning for warning in policy['warnings']]
    clock = body_clock(timeline, cursor, 200_000, 2_000_000)
    _policy.reject_animation_ending(timeline, cursor, policy)
    if clock['included']:
        raise ValueError('Embedded-audio mode requires body-only source selections; an included ending must be prepared separately')
    overlay = read_subtitle_overlay_report(request)
    empty_overlay = overlay is not None and overlay['overlay_cue_count'] == 0
    cues = parse_subtitles(subtitle_path, allow_empty=empty_overlay)
    if overlay is not None and len(cues) != overlay['overlay_cue_count']:
        raise ValueError('The selected SRT cue count differs from the subtitle overlay report')
    if empty_overlay:
        original = require_file(overlay['report'].get('original_srt'), 'original_srt')
        if (file_hash(original) != overlay['report'].get('original_srt_sha256')
                or len(parse_subtitles(original)) != overlay['report']['original_cue_count']):
            raise ValueError('Zero overlay original subtitle hash or cue count changed')
    if any(cue['start_us'] < 0 or cue['end_us'] > clock['body_end_us'] for cue in cues):
        raise ValueError('Subtitle times must remain inside the selected episode body')
    subtitle_warnings = []
    if os.environ.get('MUSE_FORCE_SUBTITLE_VISUAL') == '1':
        cues, subtitle_warnings = product_subtitle_cues(cues, str(subtitle_path))
    parent = project / 'editing/draft-materials'
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f'ep{episode:02d}-aa-', dir=parent))
    hashes = []

    def retain(source: Path, relative: str) -> Path:
        destination = stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = file_hash(source)
        shutil.copy2(source, destination)
        if file_hash(destination) != digest or file_hash(source) != digest:
            raise ValueError(f'Selected input changed during retention: {source}')
        hashes.append({'source': str(source), 'retained': str(destination), 'sha256': digest})
        return destination

    retain(timeline_path, 'timeline.json')
    retain(subtitle_path, 'subtitles.srt')
    if os.environ.get('MUSE_FORCE_SUBTITLE_VISUAL') == '1':
        write_product_subtitles(stage / 'subtitles-product.srt', cues)
    if overlay is not None:
        retain(Path(overlay['source_path']), 'subtitle-overlay-report.json')
    by_shot = dict(zip(sorted(shots), sources))
    warnings = [*policy['warnings'], *clock['warnings'], *subtitle_warnings]
    videos = []
    for row in ordered:
        original = by_shot[row['shot']]
        retained = retain(original, f'video/shot_{row["shot"]:03d}{original.suffix}')
        measured = probe(retained)
        if not measured['video']:
            raise ValueError(f'The selected body source is not a video: {original}')
        if row['duration_us'] > measured['duration_us'] + 200_000:
            raise ValueError(f'The selected source is shorter than its timeline interval: {original}')
        if not measured['audio']:
            warnings.append(f'镜头 {row["shot"]} 没有内嵌音频流；未伪造或替换声音，请核对这是否符合原片。')
        videos.append({'shot': row['shot'], 'path': str(retained), 'original': str(original),
                       'width': measured['width'], 'height': measured['height'],
                       'source_sha256': file_hash(retained), 'start_us': row['start_us'],
                       'duration_us': row['duration_us'], 'has_audio': measured['audio']})
    plan = {'schema_version': 1, 'audio_mode': 'embedded', 'name': name, 'ref': 'local://' + name,
            'ratio': ratio,
            'drafts_dir': str(root), 'draft_path': str(draft_path), 'videos': videos,
            'subtitles': cues,
            'native_frame_rate': NATIVE_FRAME_RATE, 'body_end_us': clock['body_end_us'],
            'duration_us': clock['body_end_us'] + policy['ending_duration_us'],
            'delivery': policy, 'audio': audio_gains(timeline, project),
            'draft_style': draft_style(timeline, project, enforce_product=(
                os.environ.get('MUSE_FORCE_SUBTITLE_VISUAL') == '1' and policy['height'] > policy['width'])),
            'warnings': warnings, 'materials': hashes}
    if ratio == '16:9':
        plan['draft_style']['subtitle'].update(resolve_landscape_subtitle_style())
    if overlay is not None:
        plan['subtitle_overlay'] = {key: value for key, value in overlay.items()
                                    if key not in ('source_path', 'report')}
        plan['subtitle_overlay']['report_path'] = str(stage / 'subtitle-overlay-report.json')
        warnings.extend(plan['subtitle_overlay']['warnings'])
    if plan['draft_style']['subtitle']['font_family']:
        warnings.append('AA 草稿未自动下载或选择字体资源；实际默认字族及用户指定字体需在剪映核对。')
    if request.get('bgm'):
        decision = bgm_import(request.get('bgm_role'))
        warnings.extend(decision['warnings'])
        if decision['include']:
            source = require_file(request['bgm'], 'bgm')
            retained = retain(source, 'audio/bgm' + source.suffix)
            measured = probe(retained)
            if not measured['audio']:
                raise ValueError('The selected BGM has no audio stream')
            duration = min(measured['duration_us'], clock['body_end_us'])
            if duration < clock['body_end_us']:
                warnings.append('BGM 短于正文；按所选实际区间保留，不自动循环补齐。')
            plan['bgm'] = {'path': str(retained), 'duration_us': duration}
    project_native_timeline(plan)
    if policy['ending_duration_us']:
        target = stage / 'ending.png'
        plan['ending'] = ending_image(Path(videos[-1]['path']), plan['native_videos'][-1]['duration_us'], target)
        image = probe(target, allow_still=True)
        plan['ending'].update(width=image['width'], height=image['height'])
        if request.get('ending_audio'):
            source = require_file(request['ending_audio'], 'ending_audio')
            retained = retain(source, 'audio/ending' + source.suffix)
            measured = probe(retained)
            if not measured['audio']:
                raise ValueError('The selected ending audio has no audio stream')
            plan['ending_audio'] = {'path': str(retained),
                                    'duration_us': min(measured['duration_us'], policy['ending_duration_us'])}
        if request.get('ending_effect'):
            source = require_file(request['ending_effect'], 'ending_effect')
            retained = retain(source, 'ending-effect' + source.suffix)
            measured = probe(retained)
            if not measured['video']:
                raise ValueError('The selected ending effect has no video stream')
            # The already bundled library supplies the same explicit screen resource
            # used by the existing draft writer; no new engine or font is installed.
            from pyJianYingDraft import MixModeType
            resource = MixModeType.滤色.value.resource_id
            if not isinstance(resource, str) or not resource.isdigit():
                raise ValueError('The installed screen-blend resource metadata is unavailable')
            fit = _policy.ending_effect_fit(timeline)
            video_duration = measured.get('video_duration_us')
            if video_duration is None:
                video_duration = measured['duration_us']
                warnings.append('片尾特效缺少独立视频流时长；使用容器时长准备候选，需核对实际影像终点。')
            source_duration = (video_duration if fit == 'stretch_to_window'
                               else min(video_duration, policy['ending_duration_us']))
            target_duration = policy['ending_duration_us'] if fit == 'stretch_to_window' else source_duration
            plan['ending_effect'] = {'path': str(retained), 'source_duration_us': source_duration,
                                     'width': measured['width'], 'height': measured['height'],
                                     'duration_us': target_duration, 'speed': source_duration / target_duration,
                                     'blend_resource_id': resource}
    for suffix in ('.review.txt', '.blocked'):
        note = Path(str(subtitle_path) + suffix)
        if note.is_file():
            retain(note, 'subtitles.srt' + suffix)
            warnings.append(f'所选字幕仍有待核说明：{note}')
    project_native_timeline(plan)
    (stage / 'aa-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return plan, stage


def extract_nodes(document) -> list[dict]:
    """Normalize the native extract response without treating unknown output as success."""
    if isinstance(document, dict) and isinstance(document.get('json_result'), str):
        document = json.loads(document['json_result'])
    if isinstance(document, dict) and isinstance(document.get('value'), list):
        document = document['value']
    if not isinstance(document, list) or any(not isinstance(row, dict) for row in document):
        raise ValueError('Jianying extract did not return a node array')
    return document


def native_source_path(source: str) -> Path:
    """Decode native local/file resource URIs while preserving ordinary filesystem paths."""
    for prefix in ('local:///', 'file:///'):
        if source.startswith(prefix):
            source = unquote(source[len(prefix):])
            if not re.match(r'^[A-Za-z]:[\\/]', source):
                source = '/' + source
            break
    if re.match(r'^/[A-Za-z]:[\\/]', source):
        source = source[1:]
    return Path(source)


def verify_readback(plan: dict, result: dict) -> dict:
    """Compare saved native segments with selected sources, sound and corrected cue times."""
    if not isinstance(result, dict) or result.get('ok') is not True or result.get('ref') != plan['ref']:
        raise ValueError('AA adapter did not save the requested candidate')
    nodes = extract_nodes(result['full'])
    by_id = {row['id']: row for row in nodes if isinstance(row.get('id'), str)}
    canvases = [row['attributes'] for row in nodes if row.get('type') == 'draft']
    if len(canvases) != 1 or native_ratio(canvases[0]['width'], canvases[0]['height']) != plan['ratio']:
        raise ValueError('The saved native canvas aspect ratio differs from the selected project')
    tracks = {}
    for row in extract_nodes(result['timeline']):
        if row.get('type') == 'track':
            for identifier in row.get('attributes', {}).get('segments', []):
                if identifier in tracks:
                    raise ValueError('A saved segment belongs to multiple native tracks')
                tracks[identifier] = row['id']
    body_ids = result.get('body_segment_ids')
    subtitle_ids = result.get('subtitle_segment_ids')
    if not isinstance(body_ids, list) or len(body_ids) != len(plan['videos']):
        raise ValueError('The saved body segment count differs from the selected videos')
    if not isinstance(subtitle_ids, list) or len(subtitle_ids) != len(plan['subtitles']):
        raise ValueError('The saved subtitle count differs from the corrected SRT')

    def timing(node, start, duration):
        actual = node.get('timeline', {})
        beginning, length = actual.get('start.ms'), actual.get('duration.ms')
        if (any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                for value in (beginning, length)) or beginning < 0 or length <= 0
                or abs(beginning * 1000 - start) > 1000 or abs(length * 1000 - duration) > 1000):
            raise ValueError('A saved segment moved outside its requested measured interval')

    def geometry(node, selected):
        attributes, layout = node.get('attributes', {}), node.get('layout', {})
        if (attributes.get('width') != selected['width'] or attributes.get('height') != selected['height']
                or attributes.get('crop') != [0, 0, 1, 1]
                or any(layout.get(key) != value for key, value in
                       [('position_x', 0), ('position_y', 0), ('rotation', 0), ('scale_x', 1), ('scale_y', 1)])):
            raise ValueError('A saved source changed its dimensions, crop or neutral layout')

    timeline_offsets = []

    def record_span(kind, identifier, start, duration, row):
        actual = row['timeline']
        timeline_offsets.append({'kind': kind, 'id': identifier,
                                 'requested_start_us': start, 'requested_end_us': start + duration,
                                 'saved_start_us': actual['start.ms'] * 1000,
                                 'saved_end_us': (actual['start.ms'] + actual['duration.ms']) * 1000})

    previous_end_frame = 0
    for original, selected, identifier in zip(plan['videos'], plan['native_videos'], body_ids):
        row = by_id.get(identifier, {})
        attributes = row.get('attributes', {})
        if row.get('type') != 'video' or not isinstance(attributes.get('source'), str):
            raise ValueError('A saved body segment lost its video source')
        saved_source = native_source_path(attributes['source'])
        if not saved_source.is_file() or file_hash(saved_source) != selected['source_sha256']:
            raise ValueError('A saved body source differs from the original selected bytes')
        if (not math.isclose(float(attributes.get('volume', -1)), plan['audio']['master_gain'])
                or not math.isclose(float(attributes.get('speed', -1)), 1)
                or float(attributes.get('start.ms', -1)) != 0):
            raise ValueError('A saved body segment changed source audio gain or playback speed')
        timing(row, selected['start_us'], selected['duration_us'])
        geometry(row, selected)
        actual = row['timeline']
        actual_start = round(Fraction(str(actual['start.ms'])) * NATIVE_FRAME_RATE / 1000)
        actual_end = round(Fraction(str(actual['start.ms'] + actual['duration.ms'])) * NATIVE_FRAME_RATE / 1000)
        if actual_start != previous_end_frame:
            raise ValueError('The saved native body contains a gap or overlapping source clips')
        previous_end_frame = actual_end
        record_span('body', identifier, original['start_us'], original['duration_us'], row)
    body_tracks = {tracks.get(identifier) for identifier in body_ids}
    if None in body_tracks or len(body_tracks) != 1:
        raise ValueError('The selected body videos are not on one continuous native track')
    subtitle_offsets = []
    for original, selected, identifier in zip(plan['subtitles'], plan['native_subtitles'], subtitle_ids):
        row = by_id.get(identifier, {})
        content = row.get('attributes', {}).get('content')
        if isinstance(content, str):
            content = json.loads(content).get('text')
        if row.get('type') != 'text' or content != selected['text']:
            raise ValueError('Saved subtitle text differs from the corrected SRT')
        attributes, layout = row.get('attributes', {}), row.get('layout', {})
        size, x, y = attributes.get('font_size'), layout.get('position_x'), layout.get('position_y')
        expected = plan['draft_style']['subtitle']
        expected_y = (expected['editor_y'] / canvases[0]['height']
                      if 'editor_y' in expected else expected['transform_y'])
        if (any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                for value in (size, x, y)) or not math.isclose(size, expected['font_size_ui'])
                or not math.isclose(x, 0, abs_tol=1e-6)
                or not math.isclose(y, expected_y, abs_tol=1e-6)):
            raise ValueError('Saved subtitle size or position differs from the selected draft style')
        timing(row, selected['start_us'], selected['duration_us'])
        actual = row['timeline']
        subtitle_offsets.append({'id': identifier,
                                 'requested_start_us': original['start_us'], 'requested_end_us': original['end_us'],
                                 'saved_start_us': actual['start.ms'] * 1000,
                                 'saved_end_us': (actual['start.ms'] + actual['duration.ms']) * 1000})
    expected_audio_ids = set()
    for kind, start, gain, node_type in [('bgm', 0, plan['audio']['bgm_gain'], 'audio'),
                                         ('ending_audio', plan['body_end_us'], 1, 'audio'),
                                         ('ending', plan['body_end_us'], 0, 'video'),
                                         ('ending_effect', plan['body_end_us'], 0, 'video')]:
        identifier_key = 'ending_image_segment_id' if kind == 'ending' else kind + '_segment_id'
        identifier = result.get(identifier_key)
        if kind not in plan:
            if identifier is not None:
                raise ValueError('An unselected audio or ending segment was added')
            continue
        selected = plan['native_' + kind]
        row = by_id.get(identifier, {})
        if row.get('type') != node_type or identifier not in tracks:
            raise ValueError(f'The selected {kind} segment was not saved')
        if kind != 'ending' and tracks[identifier] in body_tracks:
            raise ValueError('Independent audio was placed on the body-video track')
        attributes = row.get('attributes', {})
        if not math.isclose(float(attributes.get('volume', -1)), gain):
            raise ValueError(f'The saved {kind} volume differs from the selected gain')
        if kind == 'ending_effect':
            if tracks[identifier] in body_tracks:
                raise ValueError('The ending effect did not remain on an independent overlay track')
            if not math.isclose(float(attributes.get('speed', -1)), selected['speed']):
                raise ValueError('The ending effect speed differs from its selected fit')
            command = ['draft', 'video', 'mix-mode', '--ref', plan['ref'], '--seg-id', identifier,
                       '--resource', 'vimo://' + plan[kind]['blend_resource_id'], '--enable']
            if not any(event.get('step') == 'ending-effect-screen' and event.get('arguments') == command
                       for event in result.get('events', []) if isinstance(event, dict)):
                raise ValueError('The explicit ending screen-blend command was not recorded')
        actual_source = attributes.get('source')
        if not isinstance(actual_source, str):
            raise ValueError(f'The saved {kind} source is missing')
        actual_source = native_source_path(actual_source)
        if not actual_source.is_file() or file_hash(actual_source) != file_hash(Path(plan[kind]['path'])):
            raise ValueError(f'The saved {kind} source differs from the selected bytes')
        timing(row, selected['start_us'], selected['duration_us'])
        record_span(kind, identifier, start, plan[kind]['duration_us'], row)
        if node_type == 'video':
            geometry(row, plan[kind])
        if node_type == 'audio':
            expected_audio_ids.add(identifier)
    actual_audio_ids = {row['id'] for row in nodes if row.get('type') == 'audio'}
    if actual_audio_ids != expected_audio_ids:
        raise ValueError('The native draft contains an unselected independent audio segment')
    body_members = {identifier for identifier, track in tracks.items() if track in body_tracks}
    expected_members = set(body_ids)
    if 'ending' in plan:
        expected_members.add(result.get('ending_image_segment_id'))
    if body_members != expected_members:
        raise ValueError('The body track contains unselected clips or inserted still frames')
    actual_video_ids = {row['id'] for row in nodes if row.get('type') == 'video'}
    expected_video_ids = expected_members | ({result['ending_effect_segment_id']} if 'ending_effect' in plan else set())
    if actual_video_ids != expected_video_ids:
        raise ValueError('The native draft contains an unselected video or image segment')
    expected_text_ids = set(subtitle_ids)
    watermark_id = result.get('watermark_segment_id')
    if plan['delivery']['add_watermark']:
        notice = by_id.get(watermark_id, {})
        content = notice.get('attributes', {}).get('content')
        if not isinstance(content, str) or json.loads(content).get('text') != '内容由AI生成':
            raise ValueError('The selected editable AI notice was not saved')
        timing(notice, 0, plan['native_duration_us'])
        record_span('watermark', watermark_id, 0, plan['duration_us'], notice)
        expected_text_ids.add(watermark_id)
    elif watermark_id is not None:
        raise ValueError('An unselected AI notice was added')
    actual_text_ids = {row['id'] for row in nodes if row.get('type') == 'text'}
    if actual_text_ids != expected_text_ids:
        raise ValueError('The native draft contains an unselected text segment')
    for material in plan['materials']:
        if file_hash(Path(material['source'])) != material['sha256'] or file_hash(Path(material['retained'])) != material['sha256']:
            raise ValueError('A selected input changed while the native draft was built')
    max_offset = max((abs(row['saved_' + end + '_us'] - row['requested_' + end + '_us'])
                      for row in subtitle_offsets for end in ('start', 'end')), default=0)
    timeline_offset = max(abs(row['saved_' + end + '_us'] - row['requested_' + end + '_us'])
                          for row in timeline_offsets for end in ('start', 'end'))
    return {'saved_readback': True, 'source_bytes_preserved': True,
            'source_audio_mode': 'embedded', 'subtitle_times_preserved': max_offset == 0,
            'timeline_times_preserved': timeline_offset == 0,
            'timeline_timing': {'native_frame_rate': plan['native_frame_rate'],
                                'max_endpoint_offset_us': timeline_offset, 'segments': timeline_offsets,
                                'continuous_body_verified': True, 'source_retimed': False},
            'subtitle_timing': {'native_frame_rate': plan['native_frame_rate'],
                                'max_endpoint_offset_us': max_offset, 'cues': subtitle_offsets},
            'geometry': {'canvas': canvases[0], 'source_dimensions_and_neutral_layout_verified': True,
                         'visual_verified': False},
            'independent_bgm_verified': 'bgm' in plan,
            'ending_effect_mix_mode': ({'resource_id': plan['ending_effect']['blend_resource_id'],
                                       'command_applied': True, 'visual_verified': False}
                                      if 'ending_effect' in plan else None),
            'body_segments': len(body_ids), 'subtitle_segments': len(subtitle_ids),
            'editor_open_verified': False, 'listening_verified': False}


def generate_request(request: dict, drafts_dir: str) -> dict:
    """Build one native Windows candidate and preserve readback and recovery evidence."""
    plan, stage = prepare_plan(request, drafts_dir)
    configured = os.environ.get('MUSE_JIANYING_POWERSHELL')
    system_root = os.environ.get('SystemRoot')
    if not system_root and not configured:
        raise ValueError('SystemRoot is unavailable for the Windows draft adapter')
    powershell = Path(configured) if configured else Path(system_root) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if not powershell.is_absolute() or not powershell.is_file():
        raise ValueError('Windows PowerShell is unavailable for the AA draft adapter')
    receipt = stage / 'aa-runtime.json'
    invocation = native_run([str(powershell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                             '-File', str(SCRIPT_ROOT / 'windows/aa-draft.ps1'),
                             '-PlanPath', str(stage / 'aa-plan.json'), '-ResultPath', str(receipt)])
    if not receipt.is_file():
        raise ValueError(f'AA adapter returned no receipt: {invocation.stderr[-3000:]}')
    result = json.loads(receipt.read_text(encoding='utf-8-sig'))
    if invocation.returncode or result.get('ok') is not True:
        raise ValueError(f'AA draft failed; keep {receipt} for recovery: {result.get("error", invocation.stderr[-3000:])}')
    verification = verify_readback(plan, result)
    warnings = list(dict.fromkeys([*plan['warnings'], *result.get('warnings', [])]))
    if verification['timeline_timing']['max_endpoint_offset_us']:
        warnings.append('原视频文件保留且未变速；原生时间线按 30fps 映射连续片段，实际最大边界偏差为 '
                        f'{verification["timeline_timing"]["max_endpoint_offset_us"] / 1000:g} ms，'
                        '源片段可能发生帧边界裁取，不能视为原时长完全不变，详见回读记录。')
    if verification['subtitle_timing']['max_endpoint_offset_us']:
        warnings.append('字幕保留原始 SRT；原生草稿按 30fps 分别取最近起止帧，实际最大边界偏差为 '
                        f'{verification["subtitle_timing"]["max_endpoint_offset_us"] / 1000:g} ms，详见回读记录。')
    review_path = Path(plan['draft_path']) / 'muse-review.json'
    review = {'status': 'needs_review', 'backend': 'aa-jianying', 'warnings': warnings,
              'verification': verification, 'runtime_receipt': str(receipt),
              'materials': plan['materials'], 'runtime': result['runtime'],
              'next': '原生草稿已保存并回读；实际剪映打开、重开、字幕与声音仍需验收。'}
    if 'subtitle_overlay' in plan:
        review['subtitle_overlay'] = plan['subtitle_overlay']
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'success': True, 'backend': 'aa-jianying', 'drafts_created': 1,
            'drafts': [{'episode': str(request['episode']).zfill(2), 'name': plan['name'],
                        'path': plan['draft_path'], 'id': result['draft_id'], 'success': True, 'error': '',
                        'quality': 'needs_review', 'warnings': warnings, 'review_path': str(review_path)}],
            'materials_dir': str(stage), 'quality': 'needs_review', 'warnings': warnings,
            'library': {'name': 'aa-jianying', 'version': '1'}, 'editor_open_verified': False,
            'runtime': result['runtime'], 'verification': verification,
            **({'subtitle_overlay': plan['subtitle_overlay']} if 'subtitle_overlay' in plan else {})}


def main() -> None:
    """Accept the bounded file invocation used by the existing Muse draft tool."""
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    try:
        request_path, drafts_dir, limit = sys.argv[1:]
        path = Path(request_path)
        if path.stat().st_size > int(limit):
            raise ValueError('Draft request exceeds the configured input limit')
        request = json.loads(path.read_text(encoding='utf-8-sig'))
        print(json.dumps(generate_request(request, drafts_dir), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'success': False, 'backend': 'aa-jianying', 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1) from error


if __name__ == '__main__':
    main()

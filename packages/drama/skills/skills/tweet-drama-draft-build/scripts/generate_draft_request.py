"""Build one saved, read-back-verified draft with the packaged pyJianYingDraft library."""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)


def read_subtitle_overlay_report(request):
    """Bind an optional renderer subtitle decision to this episode's selected SRT and sources."""
    value = request.get('subtitle_overlay_report')
    if value is None:
        return None
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError('subtitle_overlay_report must be an existing absolute JSON file within 1 MiB')
    with path.open('rb') as stream:
        data = stream.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError('Subtitle overlay report exceeds 1 MiB')
    report = json.loads(data.decode('utf-8-sig'))
    if not isinstance(report, dict) or report.get('schema_version') != 1:
        raise ValueError('Unsupported subtitle overlay report')
    episode = str(request['episode']).zfill(2)
    if str(report.get('episode')).zfill(2) != episode:
        raise ValueError('Subtitle overlay report belongs to a different episode')
    subtitle = Path(request['subtitle_srt'])
    if Path(report.get('resolved_srt', '')).resolve() != subtitle.resolve():
        raise ValueError('Pass the report resolved_srt as subtitle_srt, not the original unfiltered SRT')
    with subtitle.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != report.get('resolved_srt_sha256'):
        raise ValueError('Resolved subtitle bytes changed after the overlay decision')
    timeline = json.loads(Path(request['timeline']).read_text(encoding='utf-8-sig'))
    geometry = [{field: clip[field] for field in ('shot', 'start_us', 'duration_us')} for clip in timeline['clips']]
    if report.get('timeline_clips') != geometry:
        raise ValueError('Subtitle overlay timeline changed; resolve the subtitles for the selected timeline again')
    shots = [clip['shot'] for clip in timeline['clips']]
    videos = request['videos']
    sources = report.get('sources')
    if not isinstance(sources, list) or len(shots) != len(videos) or len(sources) != len(set(shots)):
        raise ValueError('Subtitle report requires the same ordered body sources as the timeline')
    actual = {}
    for shot, video in zip(shots, videos):
        with Path(video).open('rb') as stream:
            actual[shot] = hashlib.file_digest(stream, 'sha256').hexdigest()
    for source in sources:
        if not isinstance(source, dict) or actual.get(source.get('shot')) != source.get('sha256'):
            raise ValueError('Subtitle overlay source bytes do not match the selected draft videos')
    if {row.get('shot') for row in sources} != set(actual):
        raise ValueError('Subtitle overlay report does not cover the selected draft videos')
    retained = report.get('retained_embedded')
    warnings = report.get('warnings')
    count = report.get('overlay_cue_count')
    if (not isinstance(retained, list) or any(not isinstance(row, dict) or row.get('editable') is not False for row in retained)
            or not isinstance(warnings, list) or any(not isinstance(item, str) for item in warnings)
            or isinstance(count, bool) or not isinstance(count, int) or count < 0):
        raise ValueError('Invalid subtitle editability report')
    if count == 0:
        original_count = report.get('original_cue_count')
        indexes = [row.get('cue_index') for row in retained]
        if (subtitle.read_text(encoding='utf-8-sig').strip() or isinstance(original_count, bool)
                or not isinstance(original_count, int) or original_count < 1
                or len(retained) != original_count
                or any(isinstance(index, bool) or not isinstance(index, int) for index in indexes)
                or sorted(indexes) != list(range(1, original_count + 1))
                or report.get('retained_cue_indexes') != list(range(1, original_count + 1))):
            raise ValueError('Zero overlay requires blank SRT and complete, distinct retained original cues')
    if retained:
        warnings = [*warnings, f'保留 {len(retained)} 条源画面烧录字幕：它们不可编辑，字号与位置不能由剪映字幕轨统一；'
                    '其余后加字幕可编辑。需无字素材才能实现全片统一可编辑字幕。']
    return {'source_path': str(path), 'report': report, 'overlay_cue_count': count,
            'retained_embedded_count': len(retained), 'retained_embedded': retained,
            'warnings': list(dict.fromkeys(warnings)), 'evidence_kind': 'caller_declared',
            'all_subtitles_editable': False if retained else None}


def generate_request(request, drafts_dir):
    """Stage only the explicitly selected episode; retain media referenced by its draft."""
    if not isinstance(request, dict):
        raise ValueError('Draft request must be an object')
    project = Path(request['project'])
    root = Path(drafts_dir)
    if not project.is_absolute() or not project.is_dir() or not root.is_absolute() or not root.is_dir():
        raise ValueError('project and drafts_dir must be existing absolute directories')
    episode = request['episode']
    if isinstance(episode, bool) or not isinstance(episode, int) or episode < 1:
        raise ValueError('episode must be a positive integer')
    prefix = request['name_prefix']
    if not isinstance(prefix, str) or not prefix.strip():
        raise ValueError('name_prefix must name a new candidate')
    videos = request['videos']
    if not isinstance(videos, list) or not videos:
        raise ValueError('videos must list the selected episode clips in shot order')
    paths = {}
    for field in ('audio', 'subtitle_srt', 'timeline', 'bgm', 'ending_audio', 'ending_effect'):
        if field in request:
            paths[field] = Path(request[field])
    for required in ('audio', 'subtitle_srt', 'timeline'):
        if required not in paths:
            raise ValueError(f'{required} is required')
    video_paths = [Path(path) for path in videos]
    for path in [*paths.values(), *video_paths]:
        if not path.is_absolute() or not path.is_file():
            raise ValueError(f'Input must be an existing absolute file: {path}')
    overlay = read_subtitle_overlay_report(request)
    # The generator resolves FFmpeg before importing the upstream media classes.
    from draft_generator import DraftGenerator
    generator = DraftGenerator()
    generator._setup_ffmpeg()
    from jianying_draft import generate_draft, find_project, check_videos, parse_srt_cues
    empty_overlay = overlay is not None and overlay['overlay_cue_count'] == 0
    if empty_overlay:
        original = Path(overlay['report'].get('original_srt', ''))
        if not original.is_absolute() or not original.is_file():
            raise ValueError('Zero overlay requires the original subtitle file')
        with original.open('rb') as stream:
            original_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
        if (original_hash != overlay['report'].get('original_srt_sha256')
                or len(parse_srt_cues(original)) != overlay['report']['original_cue_count']):
            raise ValueError('Zero overlay original subtitle hash or cue count changed')
    check_videos(find_project(project, str(project)), video_paths)
    seq = str(episode).zfill(2)
    if (root / f'{prefix}{seq}').exists():
        raise ValueError('Draft already exists; use a new name_prefix without overwriting it')
    parent = project / 'editing' / 'draft-materials'
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f'ep{seq}-', dir=parent))

    def retain(source, relative):
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Cross-volume inputs cannot be linked; their retained copy is still part of the project.
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)

    retain(paths['audio'], f'01_audio/{seq}{paths["audio"].suffix}')
    retain(paths['subtitle_srt'], f'03_subtitle/{seq}.srt')
    if overlay is not None:
        retain(Path(overlay['source_path']), f'03_subtitle/{seq}.overlay-report.json')
    for suffix in ('.review.txt', '.blocked'):
        note = Path(str(paths['subtitle_srt']) + suffix)
        if note.is_file():
            retain(note, f'03_subtitle/{seq}.srt{suffix}')
    retain(paths['timeline'], f'05_timeline/{seq}.timeline.json')
    for index, path in enumerate(video_paths, 1):
        retain(path, f'02_media/{seq}/shot_{index:03d}{path.suffix}')
    for field, relative in [('bgm', '04_bgm/bed'), ('ending_audio', '06_ending/ending_audio.mp3'),
                            ('ending_effect', '06_ending/ending_effect.mp4')]:
        if field in paths:
            retain(paths[field], relative + paths[field].suffix if field == 'bgm' else relative)
    result = generate_draft(str(root), str(stage), name_prefix=prefix, seq=seq, project=str(project),
                            bgm_role=request.get('bgm_role'),
                            **({'allow_empty_subtitle_seq': seq} if empty_overlay else {}))
    if overlay is not None:
        summary = {key: value for key, value in overlay.items() if key not in ('source_path', 'report')}
        summary['report_path'] = str(stage / f'03_subtitle/{seq}.overlay-report.json')
        result['subtitle_overlay'] = summary
        result['warnings'] = list(dict.fromkeys([*result.get('warnings', []), *summary['warnings']]))
        for candidate in result.get('drafts', []):
            candidate['warnings'] = list(dict.fromkeys([*candidate.get('warnings', []), *summary['warnings']]))
            review = candidate.get('review_path')
            if not candidate.get('success') or not isinstance(review, str) or not Path(review).is_file():
                continue
            review_path = Path(review)
            review = json.loads(review_path.read_text(encoding='utf-8'))
            review['subtitle_overlay'] = summary
            review['warnings'] = candidate['warnings']
            review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {**result, 'materials_dir': str(stage),
            'library': {'name': 'pyJianYingDraft', 'version': importlib.metadata.version('pyJianYingDraft')},
            'editor_open_verified': False}


def main():
    """Read one bounded JSON file and print one result; diagnostics remain on stderr."""
    try:
        request_path, drafts_dir, maximum = sys.argv[1:]
        with open(request_path, 'rb') as stream:
            data = stream.read(int(maximum) + 1)
        if len(data) > int(maximum):
            raise ValueError('Draft request exceeds the configured input limit')
        request = json.loads(data.decode('utf-8-sig'))
        with contextlib.redirect_stdout(sys.stderr):
            result = generate_request(request, drafts_dir)
    except Exception as error:
        result = {'success': False, 'drafts_created': 0, 'drafts': [], 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['success'] else 1


if __name__ == '__main__':
    sys.exit(main())

"""Build one saved, read-back-verified draft with the packaged pyJianYingDraft library."""
import contextlib
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys
import tempfile

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

EPISODE_DRAFTS = '02_剪映草稿'
EPISODE_MATERIALS = Path('制作资料') / '剪映素材'


def file_sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_independent_tracks(saved, tracks, groups, materials, master_path, videos, subtitle):
    """Require the saved master, muted ordered body videos, and selected caption timing."""
    primary = [row for row in saved['audio'] if row[0] == '主音频轨道']
    if len(primary) != 1 or primary[0][3] != master_path:
        raise ValueError('主音频轨道必须仅使用本集保留的整集原声。')
    master_hash = materials[master_path]
    if sum(materials[path] == master_hash for _, _, _, path in saved['audio']) != 1:
        raise ValueError('本集整集原声在多个片段中使用，可能叠播。')
    _, segment, material, _ = primary[0]
    duration = material.get('duration')
    windows = [segment.get(window) or {} for window in ('source_timerange', 'target_timerange')]
    if (type(duration) is not int or duration <= 0 or type(segment.get('speed')) not in (int, float)
            or segment['speed'] != 1 or any(not isinstance(window, dict) or type(window.get('start')) is not int
                                          or window['start'] != 0
                                          or type(window.get('duration')) is not int or window['duration'] != duration
                                          for window in windows)):
        raise ValueError('主音频必须从源和时间线的 0 秒开始，并按原速完整覆盖。')

    selected = set(videos)
    body = [row for row in saved['video'] if row[3] in selected]
    body.sort(key=lambda row: row[1]['target_timerange']['start'])
    if [row[3] for row in body] != videos or any(name != '视频轨道' for name, _, _, _ in body):
        raise ValueError('正文视频轨与本集保留的选片顺序不一致。')
    if any(type(segment.get('volume')) not in (int, float) or segment['volume'] != 0 for _, segment, _, _ in body):
        raise ValueError('独立原声模式的正文视频必须静音，避免对白叠播。')

    from jianying_draft import WATERMARK_TRACK, normalize_srt, subtitle_readback_findings
    captions = [segment for track in tracks if track.get('type') == 'text' and track.get('name') != WATERMARK_TRACK
                for segment in track.get('segments', [])]
    texts = {material['id']: material for material in groups.get('texts', [])}
    findings = subtitle_readback_findings(captions, texts, normalize_srt(subtitle, allow_empty=True), tolerance_us=0)
    if findings:
        raise ValueError(f'可编辑字幕与所选字幕有 {len(findings)} 项差异。' + ' '.join(findings[:5]))


def write_episode_source_receipt(draft, stage, episode, retained, timeline, subtitle, videos,
                                 master_audio=None, native_sources=None, path_decoder=Path):
    """Bind saved draft files and their relinkable local media to the retained episode inputs."""
    draft, stage = draft.resolve(strict=True), stage.resolve(strict=True)

    def local_file(path, roots):
        if not path.is_absolute() or path.is_symlink():
            raise ValueError(f'Local draft evidence is not a regular absolute file: {path}')
        path = path.resolve(strict=True)
        if not path.is_file() or not any(path.is_relative_to(root) for root in roots):
            raise ValueError(f'Draft evidence is outside the retained candidate: {path}')
        return path

    content_path = local_file(draft / 'draft_content.json', (draft,))
    meta_path = local_file(draft / 'draft_meta_info.json', (draft,))
    content_bytes, meta_bytes = content_path.read_bytes(), meta_path.read_bytes()
    content = json.loads(content_bytes.decode('utf-8-sig'))
    if not isinstance(content, dict) or not isinstance(json.loads(meta_bytes.decode('utf-8-sig')), dict):
        raise ValueError('Draft content and metadata must contain readable JSON objects')
    files = [{'path': path.name, 'sha256': hashlib.sha256(data).hexdigest()}
             for path, data in ((content_path, content_bytes), (meta_path, meta_bytes))]

    materials = {}
    for item in retained:
        source = Path(item['source'])
        target = local_file(Path(item['retained']), (stage,))
        digest = item['sha256']
        if file_sha256(target) != digest or (not source.samefile(target) and file_sha256(source) != digest):
            raise ValueError(f'Selected input changed during draft generation: {source}')
        materials[target] = digest

    def retained_hash(path):
        return materials[local_file(path, (stage,))]

    groups, tracks = content.get('materials'), content.get('tracks')
    if not isinstance(groups, dict) or not isinstance(tracks, list):
        raise ValueError('Saved draft has no readable local media tracks')
    saved = {}
    for kind in ('video', 'audio'):
        media = {row['id']: row for row in groups.get(kind + 's', [])}
        saved[kind] = []
        for track in tracks:
            if track.get('type') != kind:
                continue
            for segment in track.get('segments', []):
                material = media[segment['material_id']]
                path = local_file(path_decoder(material['path']), (stage, draft))
                saved[kind].append((track.get('name'), segment, material, path))

    def reference_hashes(paths):
        hashes = set()
        for reference in paths:
            path = local_file(reference, (stage, draft))
            if path not in materials:
                materials[path] = file_sha256(path)
            hashes.add(materials[path])
        return hashes

    references = reference_hashes(path for rows in saved.values() for _, _, _, path in rows)
    if native_sources is not None and reference_hashes(native_sources) != references:
        raise ValueError('Saved draft local media differ from the native readback')
    video_rows = [{'shot': shot, 'sha256': retained_hash(path)} for shot, path in sorted(videos.items())]
    master = retained_hash(master_audio) if master_audio is not None else None
    if any(row['sha256'] not in references for row in video_rows) or (master is not None and master not in references):
        raise ValueError('Saved draft media do not reference all selected body videos and master audio')
    if master_audio is not None:
        verify_independent_tracks(saved, tracks, groups, materials, local_file(master_audio, (stage,)),
                                  [local_file(path, (stage,)) for _, path in sorted(videos.items())], subtitle)
    font_proof = None
    review_path = draft / 'muse-review.json'
    if review_path.is_file():
        review_bytes = review_path.read_bytes()
        review = json.loads(review_bytes.decode('utf-8-sig'))
        if not isinstance(review, dict) or not isinstance(review.get('subtitle_font', {}), dict):
            raise ValueError('Saved draft font review must be an object')
        font = review.get('subtitle_font', {})
        if font.get('binding') == 'local_file':
            from jianying_draft import verify_saved_subtitle_font
            checked = verify_saved_subtitle_font(content, font)
            if not checked['delivery_ready'] or checked['status'] != 'localFileBound':
                raise ValueError('Saved local font files and subtitle references do not match')
            for key, hash_key in (('path', 'sha256'), ('license_path', 'license_sha256')):
                selected = local_file(Path(checked[key]), (draft,))
                if file_sha256(selected) != checked[hash_key]:
                    raise ValueError('Saved local font or licence changed before receipt')
                materials[selected] = checked[hash_key]
            font_proof = {key: checked[key] for key in (
                'requested', 'resolved', 'binding', 'path', 'sha256', 'license_path', 'license_sha256',
                'status', 'binding_verified', 'delivery_ready', 'resource_id')}
            font_proof.update(review_path=str(review_path), review_sha256=hashlib.sha256(review_bytes).hexdigest())
            files.append({'path': 'muse-review.json', 'sha256': font_proof['review_sha256']})
    receipt = {
        'version': 1,
        'episode': f'{episode:02d}',
        'audio_mode': 'independent' if master is not None else 'embedded',
        'timeline_sha256': retained_hash(timeline),
        'subtitle_sha256': retained_hash(subtitle),
        'videos': video_rows,
        'files': files,
        'materials': [{'path': str(path), 'sha256': digest} for path, digest in sorted(materials.items())],
        **({'subtitle_font': font_proof} if font_proof is not None else {}),
        **({'master_audio_sha256': master, 'track_verification': 'independent-v1'} if master is not None else {}),
    }
    if master is not None and draft.parent.name == EPISODE_DRAFTS and stage.parent == draft.parent.parent / EPISODE_MATERIALS:
        receipt['material_scope'] = 'episode'
    path = draft / 'muse-episode-source.json'
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=draft, prefix='.muse-episode-source-',
                                         suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return str(path)


def attach_episode_source_receipt(candidate, draft, drafts_root, stage, episode, retained, timeline, subtitle, videos,
                                  master_audio=None, native_sources=None, path_decoder=Path):
    """A legacy draft remains usable when its separate episode-delivery proof is unavailable."""
    try:
        candidate_path = Path(candidate['path'])
        if (not candidate_path.is_absolute() or candidate_path.is_symlink() or candidate_path != draft
                or candidate_path.parent.resolve(strict=True) != drafts_root.resolve(strict=True)):
            raise ValueError('Saved draft path does not match the requested candidate directory')
        candidate['episode_source_path'] = write_episode_source_receipt(
            draft, stage, episode, retained, timeline, subtitle, videos, master_audio, native_sources, path_decoder)
        return None
    except (OSError, ValueError, TypeError, KeyError) as error:
        warning = f'草稿已保存，但无法核对本集的交付凭据，暂不能归入交付目录：{error}'
        candidate['warnings'] = list(dict.fromkeys([*candidate.get('warnings', []), warning]))
        return warning


def verify_draft_subtitle_clock(request, clips, videos, overlay):
    """Recheck generated subtitles against the requested body before staging either draft backend."""
    subtitle = Path(request['subtitle_srt'])
    inputs = {subtitle: (False, None)}
    if overlay is not None:
        original = overlay['report'].get('original_srt')
        if isinstance(original, str) and Path(original).is_absolute():
            inputs[Path(original)] = (True, overlay['report'].get('original_srt_sha256'))
    clocks = []
    for path, (is_original, original_hash) in inputs.items():
        try:
            raw = Path(str(path) + '.clock.json').read_text(encoding='utf-8-sig')
        except FileNotFoundError:
            continue
        receipt = json.loads(raw)
        if (not isinstance(receipt, dict) or type(receipt.get('version')) is not int or receipt['version'] != 1
                or receipt.get('srt_sha256') != file_sha256(path)
                or (is_original and original_hash != receipt.get('srt_sha256'))):
            raise ValueError('剪映草稿的生成字幕字节与原回执不一致，请重新选择或核对字幕。')
        clocks.append(receipt)
    if not clocks:
        return

    episode = str(request['episode']).zfill(2)
    project = Path(request['project'])
    selected = dict(zip(sorted(clip['shot'] for clip in clips), videos))
    voices = {}
    if request.get('audio_mode') != 'embedded':
        source_path = project / 'editing' / f'{episode}-sources.json'
        try:
            sources = json.loads(source_path.read_text(encoding='utf-8-sig'))
        except FileNotFoundError:
            pass
        else:
            source_rows = sources.get('shots') if isinstance(sources, dict) else None
            if (not isinstance(source_rows, list) or not all(isinstance(row, dict) for row in source_rows)
                    or [row.get('shot') for row in source_rows] != sorted(selected)):
                raise ValueError('剪映草稿的逐镜声音来源不完整，请重新 prepare。')
            for row in source_rows:
                video = row.get('video')
                audio = row.get('audio', video)
                if not isinstance(video, str) or not video or not isinstance(audio, str) or not audio:
                    raise ValueError('剪映草稿的逐镜声音来源无效，请重新 prepare。')
                if audio != video:
                    voices[row['shot']] = project / audio

    cursor = 0
    clock_rows = []
    for clip in clips:
        shot, start, duration = clip['shot'], clip.get('start_us'), clip.get('duration_us')
        if (type(start) is not int or start != cursor or type(duration) is not int or duration <= 0
                or clip.get('source_start_us', 0) != 0 or clip.get('speed', 1) != 1):
            raise ValueError('剪映草稿时间线与生成字幕的原切点不一致，请重新 prepare。')
        cursor += duration
        picture_hash = file_sha256(selected[shot])
        audio_hash = file_sha256(voices[shot]) if shot in voices else picture_hash
        clock_rows.append([shot, duration, picture_hash, audio_hash])
    # Match the compact JSON array written by the renderer's subtitle-clock.ts.
    current = hashlib.sha256(json.dumps([episode, clock_rows], separators=(',', ':')).encode('utf-8')).hexdigest()
    if any(receipt.get('source_clock_sha256') != current for receipt in clocks):
        raise ValueError('剪映草稿的生成字幕与当前集、分包或切点不一致，请用同源对齐重建字幕后重新 prepare。')


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
    for shot, video in zip(sorted(shots), videos):
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
    timeline = json.loads(paths['timeline'].read_text(encoding='utf-8-sig'))
    clips = timeline.get('clips') if isinstance(timeline, dict) else None
    if not isinstance(clips, list):
        raise ValueError('timeline shots and videos must match one-to-one; clips must be an array')
    shots = [clip.get('shot') if isinstance(clip, dict) else None for clip in clips]
    if (len(shots) != len(video_paths)
            or any(isinstance(shot, bool) or not isinstance(shot, int) or shot < 1 for shot in shots)
            or len(set(shots)) != len(shots)):
        raise ValueError('timeline shots and videos must match one-to-one with distinct positive integer shot IDs')
    overlay = read_subtitle_overlay_report(request)
    verify_draft_subtitle_clock(request, clips, video_paths, overlay)
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
    actual_root = root.resolve(strict=True)
    if (root.name == actual_root.name == EPISODE_DRAFTS
            and actual_root.is_relative_to(project.resolve(strict=True))):
        parent = actual_root.parent / EPISODE_MATERIALS
        if parent.resolve() != parent:
            raise ValueError('本集剪映素材留存目录不得指向其他目录。')
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f'ep{seq}-', dir=parent))
    retained = []

    def retain(source, relative):
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = file_sha256(source)
        # Another prepare can rewrite the working media and timing files in place.
        shutil.copy2(source, target)
        if file_sha256(target) != digest or file_sha256(source) != digest:
            raise ValueError(f'Selected input changed during retention: {source}')
        retained.append({'source': str(source), 'retained': str(target), 'sha256': digest})
        return target

    staged_audio = retain(paths['audio'], f'01_audio/{seq}{paths["audio"].suffix}')
    staged_subtitle = retain(paths['subtitle_srt'], f'03_subtitle/{seq}.srt')
    if overlay is not None:
        retain(Path(overlay['source_path']), f'03_subtitle/{seq}.overlay-report.json')
    for suffix in ('.review.txt', '.blocked'):
        note = Path(str(paths['subtitle_srt']) + suffix)
        if note.is_file():
            retain(note, f'03_subtitle/{seq}.srt{suffix}')
    staged_timeline = retain(paths['timeline'], f'05_timeline/{seq}.timeline.json')
    # Request videos are in shot order; timeline rows may be in any order.
    staged_videos = {shot: retain(path, f'02_media/{seq}/shot_{shot:03d}{path.suffix}')
                     for shot, path in zip(sorted(shots), video_paths)}
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
    for candidate in result.get('drafts', []):
        if candidate.get('success'):
            warning = attach_episode_source_receipt(candidate, root / f'{prefix}{seq}', root, stage, episode, retained,
                                                     staged_timeline, staged_subtitle, staged_videos, staged_audio)
            if warning is not None:
                result['warnings'] = list(dict.fromkeys([*result.get('warnings', []), warning]))
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

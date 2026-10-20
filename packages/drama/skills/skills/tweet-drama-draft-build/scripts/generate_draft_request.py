"""Build one saved, read-back-verified draft with the packaged pyJianYingDraft library."""
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


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
    # The generator resolves FFmpeg before importing the upstream media classes.
    from draft_generator import DraftGenerator
    generator = DraftGenerator()
    generator._setup_ffmpeg()
    from jianying_draft import generate_draft, find_project, check_videos
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
    result = generate_draft(str(root), str(stage), name_prefix=prefix, seq=seq, project=str(project))
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

"""Exercise shipped Python rendering and editable drafts with explicit local media tools."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


WIDTH, HEIGHT, FPS = 640, 360, 24
CUES = [(500_000, 1_500_000, '中文字幕烧录验证'),
        (2_500_000, 3_500_000, '剪映草稿时间验证')]


def sha256(path):
    """Hash a retained input or output without loading it all into memory."""
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    """Save inspectable UTF-8 evidence with one trailing newline."""
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def verify_pixels(samples):
    """Require visible text during both cues and black frames outside their windows."""
    for sample in samples:
        expected = sample['subtitle_expected']
        count = sample['bright_pixels']
        if (expected and count < 20) or (not expected and count > 10):
            raise RuntimeError(f'Subtitle pixels disagree with cue timing: {sample}')


def verify_sources(content, expected_tracks):
    """Compare each saved segment's retained bytes with its ordered source request."""
    materials = {row['id']: Path(row['path']) for group in ('videos', 'audios')
                 for row in content['materials'][group]}
    tracks = {track['name']: track for track in content['tracks']}
    for name, sources in expected_tracks.items():
        actual = [sha256(materials[row['material_id']]) for row in tracks[name]['segments']]
        if actual != [sha256(path) for path in sources]:
            raise RuntimeError(f'Saved draft source bytes or shot order differ on {name}')


def verify_draft(content, root):
    """Verify saved editable tracks and their retained media against the selected episode."""
    root = root.resolve()
    if content['duration'] != 4_000_000 or content['fps'] != FPS:
        raise RuntimeError('Saved draft duration or frame rate differs from its timeline')
    canvas = content['canvas_config']
    if (canvas['width'], canvas['height']) != (WIDTH, HEIGHT):
        raise RuntimeError('Saved draft canvas differs from its delivery request')
    tracks = {track['name']: track for track in content['tracks']}
    video = tracks['视频轨道']['segments']
    for segments, expected in [(video, [(0, 2_000_000), (2_000_000, 2_000_000)]),
                               (tracks['主音频轨道']['segments'], [(0, 4_000_000)]),
                               (tracks['BGM轨道']['segments'], [(0, 4_000_000)])]:
        actual = [(item['target_timerange']['start'], item['target_timerange']['duration'])
                  for item in segments]
        if actual != expected:
            raise RuntimeError(f'Saved draft target times differ: {actual} != {expected}')
        for segment, (_, duration) in zip(segments, expected):
            source = segment['source_timerange']
            if source['start'] != 0 or abs(source['duration'] - duration) > 50_000:
                raise RuntimeError(f'Saved draft source selection differs: {source}')
    materials = content['materials']
    text_by_id = {row['id']: json.loads(row['content'])['text'] for row in materials['texts']}
    subtitles = tracks['字幕轨道']['segments']
    actual_cues = [(row['target_timerange']['start'],
                    row['target_timerange']['start'] + row['target_timerange']['duration'],
                    text_by_id[row['material_id']]) for row in subtitles]
    if actual_cues != CUES:
        raise RuntimeError(f'Saved draft subtitles differ from input: {actual_cues}')
    retained = []
    for group in ('videos', 'audios'):
        for item in materials[group]:
            path = Path(item['path']).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise RuntimeError(f'Draft references media outside the isolated test: {path}')
            retained.append({'type': group, 'path': str(path), 'sha256': sha256(path)})
    if len(materials['videos']) != 2 or len(materials['audios']) != 2:
        raise RuntimeError('Saved draft did not retain two shots, voice and BGM')
    return {'duration_us': content['duration'], 'video_segments': len(video),
            'subtitle_segments': len(subtitles), 'media': retained,
            'editor_open_verified': False, 'native_export_verified': False}


class Acceptance:
    """Keep every process receipt and test artifact under one newly created directory."""

    def __init__(self, args):
        self.args = args
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.logs = self.output / 'logs'
        self.logs.mkdir()
        self.commands = []
        self.env = os.environ.copy()
        self.env.update({'PYTHONUTF8': '1', 'DSH_FFMPEG_PATH': str(args.ffmpeg),
                         'FFMPEG_PATH': str(args.ffmpeg), 'FFMPEG_BINARY': str(args.ffmpeg),
                         'DSH_FFPROBE_PATH': str(args.ffprobe), 'FFPROBE_PATH': str(args.ffprobe),
                         'FFPROBE_BINARY': str(args.ffprobe), 'MUSE_FONT_FAMILY': args.font_family})
        binary = self.output / 'bin'
        binary.mkdir()
        for name in ('ffmpeg', 'ffprobe'):
            (binary / name).symlink_to(getattr(args, name))
        self.env['PATH'] = str(binary) + os.pathsep + self.env.get('PATH', '')
        fonts = self.output / 'fonts'
        fonts.mkdir()
        shutil.copyfile(args.font, fonts / args.font.name)
        self.env['MUSE_FONTS_DIR'] = str(fonts)

    def run(self, label, argv):
        """Run a bounded local process and retain stdout, stderr and exit status."""
        started = time.monotonic()
        result = subprocess.run([str(arg) for arg in argv], cwd=self.output, env=self.env,
                                capture_output=True, timeout=180)
        self.commands.append({'label': label, 'argv': [str(arg) for arg in argv],
                              'exit_code': result.returncode,
                              'seconds': round(time.monotonic() - started, 3)})
        (self.logs / f'{label}.stdout').write_bytes(result.stdout)
        (self.logs / f'{label}.stderr').write_bytes(result.stderr)
        write_json(self.output / 'commands.json', self.commands)
        if result.returncode:
            raise RuntimeError(f'{label} exited {result.returncode}: '
                               + result.stderr.decode('utf-8', errors='replace')[-3000:])
        return result.stdout

    def media(self):
        """Create two black H.264 shots, normalized voice and an independent BGM source."""
        project = self.output / 'project'
        videos = project / 'video' / '01'
        videos.mkdir(parents=True)
        audio = project / 'audio'
        audio.mkdir()
        ffmpeg = self.args.ffmpeg
        for index in (1, 2):
            self.run(f'source-shot-{index}', [ffmpeg, '-v', 'error', '-nostdin', '-y',
                     '-f', 'lavfi', '-i', f'color=c=black:s={WIDTH}x{HEIGHT}:r={FPS}:d=2',
                     '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
                     '-metadata', f'title=isolated-shot-{index}',
                     videos / f'shot_{index:03d}.mp4'])
        for name, frequency in [('01', 440), ('bgm', 110)]:
            self.run(f'source-audio-{name}', [ffmpeg, '-v', 'error', '-nostdin', '-y',
                     '-f', 'lavfi', '-i', f'sine=frequency={frequency}:duration=4',
                     '-af', 'loudnorm', '-ar', '48000', '-ac', '2', audio / f'{name}.wav'])
        srt = project / '01.srt'
        srt.write_text('1\n00:00:00,500 --> 00:00:01,500\n' + CUES[0][2]
                       + '\n\n2\n00:00:02,500 --> 00:00:03,500\n' + CUES[1][2] + '\n',
                       encoding='utf-8')
        timeline = project / '01.timeline.json'
        write_json(timeline, {'clips': [{'shot': index + 1, 'start_us': index * 2_000_000,
                                       'duration_us': 2_000_000} for index in range(2)],
                              'delivery': {'visual_medium': 'animation_3d',
                                           'width': WIDTH, 'height': HEIGHT, 'fps': FPS}})
        return project, srt, timeline

    def inspect(self, label, movie):
        """Probe, fully decode and compare frames inside and outside subtitle intervals."""
        probe = json.loads(self.run(label + '-probe', [self.args.ffprobe, '-v', 'error',
                           '-show_streams', '-show_format', '-of', 'json', movie]))
        write_json(self.output / f'{label}-probe.json', probe)
        codecs = {stream['codec_type']: stream['codec_name'] for stream in probe['streams']}
        if codecs != {'video': 'h264', 'audio': 'aac'}:
            raise RuntimeError(f'{label} is not an H264/AAC movie: {codecs}')
        video = next(stream for stream in probe['streams'] if stream['codec_type'] == 'video')
        if (video['width'], video['height'], video['avg_frame_rate']) != (WIDTH, HEIGHT, f'{FPS}/1'):
            raise RuntimeError(f'{label} dimensions or frame rate differ from the requested delivery')
        if abs(float(probe['format']['duration']) - 4) > 0.1:
            raise RuntimeError(f'{label} duration is not four seconds')
        self.run(label + '-decode', [self.args.ffmpeg, '-v', 'error', '-xerror', '-nostdin',
                 '-i', movie, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
        samples = []
        for seconds, expected in [(0.25, False), (0.9, True), (1.8, False),
                                  (2.9, True), (3.8, False)]:
            frame = self.run(f'{label}-frame-{seconds}', [self.args.ffmpeg, '-v', 'error',
                             '-nostdin', '-ss', str(seconds), '-i', movie, '-an', '-frames:v',
                             '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
            if len(frame) != WIDTH * HEIGHT * 3:
                raise RuntimeError(f'{label} did not decode a complete sampled frame')
            image = self.output / f'{label}-{seconds}.ppm'
            image.write_bytes(f'P6\n{WIDTH} {HEIGHT}\n255\n'.encode() + frame)
            samples.append({'seconds': seconds, 'subtitle_expected': expected,
                            'bright_pixels': sum(max(frame[n:n + 3]) > 80
                                                 for n in range(0, len(frame), 3)),
                            'image': str(image)})
        verify_pixels(samples)
        return {'path': str(movie), 'sha256': sha256(movie), 'codecs': codecs,
                'full_decode': True, 'samples': samples}

    def execute(self):
        """Exercise the production renderer, native SRT filter and saved-draft entry point."""
        filters = self.run('filters', [self.args.ffmpeg, '-hide_banner', '-filters']).decode()
        encoders = self.run('encoders', [self.args.ffmpeg, '-hide_banner', '-encoders']).decode()
        missing = [name for name in ('ass', 'subtitles', 'loudnorm')
                   if re.search(r'\s' + name + r'\s', filters) is None]
        missing += [name for name in ('libx264', 'aac')
                    if re.search(r'\s' + name + r'\s', encoders) is None]
        if missing:
            raise RuntimeError('Missing required bundled capabilities: ' + ', '.join(missing))
        self.run('buildconf', [self.args.ffmpeg, '-hide_banner', '-buildconf'])
        project, srt, timeline = self.media()
        original_hashes = {str(path): sha256(path) for path in [srt, timeline,
                           *sorted((project / 'video/01').glob('*.mp4')),
                           *sorted((project / 'audio').glob('*.wav'))]}
        skills = self.args.repository / 'packages/drama/skills/skills'
        renderer = skills / 'tweet-drama-background-render/scripts/render_episode.py'
        ass_movie = self.output / 'production-ass.mp4'
        renderer_result = json.loads(self.run('production-render', [sys.executable, '-B', renderer,
                                    '--project', project, '--episode', '01', '--timeline', timeline,
                                    '--subtitle-srt', srt, '--last-shot', '2', '--bgm',
                                    project / 'audio/bgm.wav', '--output', ass_movie]))
        write_json(self.output / 'render-receipt.json', renderer_result)
        if renderer_result['status'] != 'succeeded':
            raise RuntimeError('Production renderer did not report success')
        ass_source = next((project / 'exports/.render_cache/01').rglob('display.ass'))
        if f'Style: Default,{self.args.font_family},' not in ass_source.read_text(encoding='utf-8-sig'):
            raise RuntimeError('Production ASS did not preserve the configured font family')
        ass_result = self.inspect('ass', ass_movie)
        shutil.copy2(srt, self.output / 'captions.srt')
        srt_movie = self.output / 'native-srt.mp4'
        subtitle_filter = ('subtitles=captions.srt:fontsdir=fonts:force_style='
                           f"'FontName={self.args.font_family},FontSize=28,MarginV=20'")
        self.run('native-srt', [self.args.ffmpeg, '-v', 'info', '-nostdin', '-y', '-f', 'lavfi',
                 '-i', f'color=c=black:s={WIDTH}x{HEIGHT}:r={FPS}:d=4', '-i', project / 'audio/01.wav',
                 '-vf', subtitle_filter, '-t', '4', '-c:v', 'libx264', '-threads', '1',
                 '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', srt_movie])
        subtitle_log = (self.logs / 'native-srt.stderr').read_text(encoding='utf-8')
        family = re.sub(r'[^a-z0-9]', '', self.args.font_family.lower())
        selected = [line.split(' -> ', 1)[1] for line in subtitle_log.splitlines()
                    if 'fontselect:' in line and ' -> ' in line]
        if (not selected or not all(family in re.sub(r'[^a-z0-9]', '', line.lower()) for line in selected)
                or f"Loading font file 'fonts/{self.args.font.name}'" not in subtitle_log
                or re.search(r'Glyph .*not found', subtitle_log)):
            raise RuntimeError('Chinese subtitle glyphs did not resolve to an available font')
        srt_result = self.inspect('srt', srt_movie)
        drafts = self.output / 'drafts'
        drafts.mkdir()
        request = self.output / 'draft-request.json'
        write_json(request, {'project': str(project), 'episode': 1, 'name_prefix': 'Mac验收-',
                             'videos': [str(project / f'video/01/shot_{shot:03d}.mp4') for shot in (1, 2)],
                             'audio': str(project / 'audio/01.wav'), 'bgm': str(project / 'audio/bgm.wav'),
                             'subtitle_srt': str(srt), 'timeline': str(timeline)})
        generator = skills / 'tweet-drama-draft-build/scripts/generate_draft_request.py'
        receipt = json.loads(self.run('draft', [sys.executable, '-B', generator, request, drafts, '1048576']))
        write_json(self.output / 'draft-receipt.json', receipt)
        if (not receipt['success'] or receipt['drafts_created'] != 1
                or not receipt['drafts'][0]['success'] or receipt['editor_open_verified']):
            raise RuntimeError(f'Draft generator did not confirm one saved draft: {receipt}')
        content_path = Path(receipt['drafts'][0]['path']) / 'draft_content.json'
        content = json.loads(content_path.read_text(encoding='utf-8'))
        draft_result = verify_draft(content, self.output)
        verify_sources(content, {'视频轨道': [project / f'video/01/shot_{shot:03d}.mp4' for shot in (1, 2)],
                                 '主音频轨道': [project / 'audio/01.wav'],
                                 'BGM轨道': [project / 'audio/bgm.wav']})
        draft_result.update({'content': str(content_path), 'sha256': sha256(content_path),
                             'library': receipt['library']})
        if original_hashes != {name: sha256(Path(name)) for name in original_hashes}:
            raise RuntimeError('Rendering or draft generation changed an original test source')
        return {'ass': ass_result, 'srt': srt_result, 'draft': draft_result,
                'unchanged_source_hashes': original_hashes}


def main():
    """Require explicit deployment binaries, a licensed font and a fresh evidence directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('ffmpeg', 'ffprobe', 'font', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--font-family', required=True)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    for field in ('ffmpeg', 'ffprobe', 'font', 'repository'):
        value = getattr(args, field).resolve(strict=True)
        setattr(args, field, value)
    acceptance = Acceptance(args)
    result = {'python': sys.executable, 'ffmpeg': str(args.ffmpeg), 'ffprobe': str(args.ffprobe),
              'font': str(args.font), 'font_family': args.font_family,
              'inputs': {name: sha256(getattr(args, name)) for name in ('ffmpeg', 'ffprobe', 'font')},
              'network_used': False, 'paid_api_used': False, 'editor_launched': False}
    try:
        result.update(acceptance.execute(), success=True)
    except Exception as error:
        result.update(success=False, error=str(error))
    write_json(acceptance.output / 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['success'] else 1


if __name__ == '__main__':
    sys.exit(main())

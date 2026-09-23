"""Verify the paired archives and exercise their Windows executables without downloading anything."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile

from build import sha256, verify_artifacts


def main(output):
    """Require x264, libass subtitle pixels, AAC and ffprobe from this build's ZIP."""
    manifest = verify_artifacts(output)
    with tempfile.TemporaryDirectory(prefix='muse-ffmpeg-smoke-') as temporary:
        work = Path(temporary)
        with zipfile.ZipFile(output / manifest['binary_archive']) as archive:
            for name in archive.namelist():
                if not name.startswith('ffmpeg/') or '\\' in name or '..' in name.split('/'):
                    raise ValueError('Unexpected runtime archive path')
            archive.extractall(work)
        binary = work / 'ffmpeg' / 'bin'
        for name, digest in manifest['executables'].items():
            if name not in ('ffmpeg.exe', 'ffprobe.exe') or sha256(binary / name) != digest:
                raise ValueError('Executable does not match the source-paired manifest')
        ffmpeg, ffprobe = str(binary / 'ffmpeg.exe'), str(binary / 'ffprobe.exe')
        configuration = subprocess.check_output([ffmpeg, '-hide_banner', '-buildconf'], text=True, stderr=subprocess.STDOUT)
        for required in ('--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-libass'):
            if required not in configuration:
                raise RuntimeError(f'Missing {required}')
        if '--enable-nonfree' in configuration:
            raise RuntimeError('Nonfree FFmpeg cannot be released')
        for command in ('-version', '-L'):
            subprocess.run([ffmpeg, command], check=True)
        for extension, caption in [
            ('srt', '1\n00:00:00,000 --> 00:00:01,000\nmuse-med source build\n'),
            ('ass', '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n'
                    '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\n'
                    'Style: Default,Arial,24,&H00FFFFFF,2\n[Events]\n'
                    'Format: Layer, Start, End, Style, Text\n'
                    'Dialogue: 0,0:00:00.00,0:00:01.00,Default,muse-med source build\n')]:
            (work / ('captions.' + extension)).write_text(caption, encoding='utf-8')
            movie = 'smoke-' + extension + '.mp4'
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                            'color=c=black:s=320x240:r=10:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
                            '-t', '1', '-vf', 'subtitles=captions.' + extension, '-af', 'loudnorm',
                            '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', movie],
                           cwd=work, check=True)
            streams = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-show_streams', '-of', 'json',
                                                          movie], cwd=work, text=True))['streams']
            if {stream['codec_name'] for stream in streams} != {'h264', 'aac'}:
                raise RuntimeError('Expected H264/AAC output')
            frame = subprocess.check_output([ffmpeg, '-v', 'error', '-i', movie, '-frames:v', '1',
                                             '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], cwd=work)
            if len(frame) != 320 * 240 * 3 or max(frame) < 100:
                raise RuntimeError('Subtitle filter produced no visible pixels')
    print('Paired source/binary hashes, GPL build, x264/AAC, SRT/ASS pixels and ffprobe passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    main(parser.parse_args().output)

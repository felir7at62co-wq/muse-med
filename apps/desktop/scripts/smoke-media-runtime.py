"""Exercise packaged Python, native media libraries and CPU ASR without network or user media."""
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile


def main():
    """Check relocatable imports, dependency declarations, encode/subtitles, draft probing and local ASR."""
    root = Path(sys.argv[1]).resolve()
    expected = root / 'python'
    assert Path(sys.prefix).resolve() == expected
    assert Path(sys.base_prefix).resolve() == expected
    assert not (expected / 'pyvenv.cfg').exists()
    for path in sys.path:
        if path:
            assert Path(path).resolve().is_relative_to(expected), path
    def deny_network(*args, **kwargs):
        raise AssertionError('Media smoke must not use network')
    socket.create_connection = deny_network
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    from packaging.requirements import Requirement
    for dist in importlib.metadata.distributions():
        for declared in dist.requires or []:
            req = Requirement(declared)
            if req.marker and not req.marker.evaluate({'extra': ''}):
                continue
            actual = importlib.metadata.version(req.name)
            assert actual in req.specifier, (dist.metadata['Name'], declared, actual)
    for name in ['faster_whisper', 'ctranslate2', 'av', 'onnxruntime', 'docx', 'pydub', 'pymediainfo', 'pyJianYingDraft', 'requests', 'PIL', 'zhconv']:
        module = importlib.import_module(name)
        assert Path(module.__file__).resolve().is_relative_to(expected), name
    from zhconv import convert
    assert convert('繁體字幕', 'zh-cn') == '繁体字幕'
    ffmpeg = str(root / 'ffmpeg' / 'bin' / 'ffmpeg.exe')
    ffprobe = str(root / 'ffmpeg' / 'bin' / 'ffprobe.exe')
    with tempfile.TemporaryDirectory(prefix='muse-media-smoke-') as temporary:
        work = Path(temporary)
        (work / 'captions.srt').write_text('1\n00:00:00,000 --> 00:00:01,000\nMedia smoke\n', encoding='utf-8')
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-vf', 'subtitles=captions.srt', '-af', 'loudnorm', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', 'smoke.mp4'], cwd=work, check=True)
        probe = subprocess.run([ffprobe, '-v', 'error', '-show_streams', '-of', 'json', str(work / 'smoke.mp4')], capture_output=True, text=True, check=True)
        assert {s['codec_type'] for s in json.loads(probe.stdout)['streams']} == {'video', 'audio'}
        subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('smoke-cjk-font.py')),
                        '--ffmpeg', ffmpeg, '--fonts', str(root / 'fonts'), '--output', str(work / 'cjk')], check=True)
        from pymediainfo import MediaInfo
        assert any(t.track_type == 'Video' for t in MediaInfo.parse(str(work / 'smoke.mp4')).tracks)
        import pyJianYingDraft as draft
        material = draft.VideoMaterial(str(work / 'smoke.mp4'))
        assert material.duration > 0
        from faster_whisper import WhisperModel
        model = WhisperModel(str(root / 'models' / 'faster-whisper-small'), device='cpu', compute_type='int8', cpu_threads=1, num_workers=1, local_files_only=True)
        segments, _ = model.transcribe(str(work / 'smoke.mp4'), language='zh', beam_size=5, word_timestamps=True, vad_filter=False, temperature=0.0, condition_on_previous_text=False)
        list(segments)
    print('media smoke: isolated imports, locked dependencies, FFmpeg/AAC/H264/subtitles/loudnorm, MediaInfo/draft and offline CPU ASR passed')


if __name__ == '__main__':
    main()

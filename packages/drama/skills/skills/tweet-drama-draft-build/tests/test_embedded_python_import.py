import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/generate_draft_request.py'
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class EmbeddedPythonImportTests(unittest.TestCase):
    def test_request_entrypoint_imports_sibling_modules_in_isolated_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            drafts = root / 'drafts'
            drafts.mkdir()
            inputs = {}
            for name in ('audio.m4a', 'subtitles.srt', 'timeline.json', 'video.mp4'):
                file = root / name
                file.write_bytes(b'fixture')
                inputs[name] = str(file)
            request = root / 'request.json'
            request.write_text(json.dumps({
                'project': str(root), 'episode': 23, 'name_prefix': 'isolated-',
                'audio': inputs['audio.m4a'], 'subtitle_srt': inputs['subtitles.srt'],
                'timeline': inputs['timeline.json'], 'videos': [inputs['video.mp4']],
            }), encoding='utf-8')
            env = {**os.environ, 'DSH_FFMPEG_PATH': str(root / 'missing-ffmpeg.exe')}
            result = subprocess.run(
                [sys.executable, '-I', '-B', str(SCRIPT), str(request), str(drafts), '65536'],
                cwd=root, env=env, capture_output=True, text=True, check=False,
                creationflags=NO_WINDOW, timeout=30,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['error'],
                             'Configure DSH_FFMPEG_PATH or install ffmpeg on PATH')
            self.assertEqual(list(drafts.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

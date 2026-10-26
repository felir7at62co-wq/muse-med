"""The native Host's production Python CLI preserves selected timeline identities."""
import hashlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts/generate_draft_request.py'
REPO = Path(__file__).resolve().parents[5]
MANAGED_CLI = Path(__file__).resolve().parent / 'helpers/managed_cli.mjs'
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def sha256(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def run_owned(command, cwd, timeout_ms, cancel_on_stdout=None):
    """The managed owner enforces the deadline and joins its range before this returns."""
    spec = {'argv': list(command), 'cwd': str(cwd), 'timeout_ms': timeout_ms}
    if cancel_on_stdout is not None:
        spec['cancel_on_stdout'] = cancel_on_stdout
    process = subprocess.Popen([shutil.which('node'), '--import', 'tsx/esm', str(MANAGED_CLI), json.dumps(spec)],
                               cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', creationflags=NO_WINDOW)
    captured = [[], []]
    drains = []
    try:
        for stream, sink in zip((process.stdout, process.stderr), captured):
            thread = threading.Thread(target=lambda source, target: target.append(source.read()), args=(stream, sink))
            thread.start()
            drains.append(thread)
        process.wait()
    finally:
        if process.poll() is None:
            try:
                process.stdin.write('abort\n')
                process.stdin.flush()
            except BrokenPipeError as _owner_already_exited:
                pass  # Cancellation raced the managed owner's completed exit.
            finally:
                process.wait()
        process.stdin.close()
        for thread in drains:
            thread.join()
        process.stdout.close()
        process.stderr.close()
    record = json.loads(''.join(captured[0]))
    if process.returncode != 0 or not record['quiescent']:
        raise RuntimeError(f'Managed CLI did not prove quiescence: {record}; {captured[1]}')
    result = subprocess.CompletedProcess(command, record['code'] if record['code'] is not None else 1,
                                         record['stdout'], record['stderr'] + ''.join(captured[1]))
    result.ownership = record
    return result


class DraftRequestCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for binary in ('node', 'ffmpeg', 'ffprobe'):
            if shutil.which(binary) is None:  # pragma: no cover - documented media dependency
                raise unittest.SkipTest(f'{binary} is not on PATH')
        temporary = tempfile.TemporaryDirectory(prefix='draft-request-cli-media-')
        cls.addClassCleanup(temporary.cleanup)
        cls.media = Path(temporary.name)
        for index, color in enumerate(('blue', 'red'), 1):
            cls.run_media('ffmpeg', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                          f'color={color}:size=160x120:rate=24:duration=1', '-f', 'lavfi', '-i',
                          f'sine=frequency={index * 440}:duration=1', '-map', '0:v:0', '-map', '1:a:0',
                          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '1', str(cls.media / f'body-{index}.mp4'))
        for duration in (1, 2):
            cls.run_media('ffmpeg', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                          f'sine=frequency=440:duration={duration}', '-ar', '48000', '-ac', '2',
                          str(cls.media / f'dialogue-{duration}.wav'))

    @staticmethod
    def run_media(*command):
        result = run_owned(command, REPO, 30_000)
        if result.returncode != 0 or result.ownership['aborted']:
            raise AssertionError(f'Media fixture command exited {result.returncode}: {result.stderr}')

    def request(self, shots):
        temporary = tempfile.TemporaryDirectory(prefix='draft-request-cli-')
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name)
        drafts = project / 'drafts'
        drafts.mkdir()
        videos = []
        for index, _shot in enumerate(shots, 1):
            path = project / f'selected-source-{index}.mp4'
            shutil.copy2(self.media / f'body-{index}.mp4', path)
            videos.append(str(path))
        audio = project / 'independent.wav'
        shutil.copy2(self.media / f'dialogue-{len(shots)}.wav', audio)
        srt = project / 'final.srt'
        srt.write_text('\n\n'.join(f'{index + 1}\n00:00:0{index},000 --> 00:00:0{index + 1},000\n测试字幕'
                                  for index in range(len(shots))) + '\n', encoding='utf-8')
        timeline = project / 'timeline.json'
        timeline.write_text(json.dumps({'clips': [
            {'shot': shot, 'start_us': index * 1_000_000, 'duration_us': 1_000_000}
            for index, shot in enumerate(shots)], 'body_end': len(shots),
            'delivery': {'visual_medium': 'animation_3d', 'width': 480, 'height': 854, 'fps': 24},
        }), encoding='utf-8')
        return {'project': str(project), 'episode': 26, 'name_prefix': 'native-request-',
                'videos': videos, 'audio': str(audio), 'subtitle_srt': str(srt), 'timeline': str(timeline)}, drafts

    def invoke(self, request, drafts):
        project = Path(request['project'])
        request_path = project / 'request.json'
        request_path.write_text(json.dumps(request), encoding='utf-8')
        inputs = [request_path, *(Path(request[field]) for field in ('audio', 'subtitle_srt', 'timeline')
                                 if field in request), *(Path(path) for path in request['videos'])]
        before = {path: sha256(path) for path in inputs}
        result = run_owned([sys.executable, '-B', str(SCRIPT), str(request_path), str(drafts), '1048576'],
                           project, 60_000)
        self.assertFalse(result.ownership['aborted'], result.ownership)
        self.assertEqual({path: sha256(path) for path in inputs}, before)
        return result, json.loads(result.stdout)

    def assert_saved(self, shots):
        request, drafts = self.request(shots)
        outcome, result = self.invoke(request, drafts)
        self.assertEqual(outcome.returncode, 0, result)
        self.assertTrue(result['success'], result)
        self.assertEqual(result['drafts_created'], 1, result)
        self.assertFalse(result['editor_open_verified'])
        stage = Path(result['materials_dir'])
        self.assertTrue(stage.is_relative_to(Path(request['project']) / 'editing/draft-materials'))
        self.assertEqual((stage / '05_timeline/26.timeline.json').read_bytes(), Path(request['timeline']).read_bytes())
        selected = sorted((stage / '02_media/26').iterdir())
        self.assertEqual([path.name for path in selected], [f'shot_{shot:03d}.mp4' for shot in shots])
        content = json.loads((Path(result['drafts'][0]['path']) / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(content['duration'], len(shots) * 1_000_000)
        tracks = {track.get('name'): track for track in content['tracks']}
        materials = {item['id']: item for item in content['materials']['videos']}
        segments = sorted(tracks['视频轨道']['segments'], key=lambda row: row['target_timerange']['start'])
        self.assertEqual(len(segments), len(shots))
        for index, (shot, segment) in enumerate(zip(shots, segments)):
            source = Path(materials[segment['material_id']]['path'])
            self.assertEqual(source.name, f'shot_{shot:03d}.mp4')
            self.assertEqual(sha256(source), sha256(Path(request['videos'][index])))
            self.assertEqual(segment['volume'], 0)
            self.assertEqual(segment['target_timerange'], {'start': index * 1_000_000, 'duration': 1_000_000})
        self.assertEqual([segment['volume'] for segment in tracks['主音频轨道']['segments']], [1])

    def test_production_cli_preserves_non_contiguous_timeline_shots(self):
        for shots in ((6,), (6, 9)):
            with self.subTest(shots=shots):
                self.assert_saved(shots)

    def test_production_cli_keeps_existing_contiguous_shot_mapping(self):
        self.assert_saved((1, 2))

    def test_production_cli_rejects_missing_extra_and_duplicate_mapping_before_staging(self):
        for case in ('missing_video', 'extra_video', 'duplicate_shot'):
            with self.subTest(case=case):
                request, drafts = self.request((6, 9))
                if case == 'missing_video':
                    request['videos'] = request['videos'][:1]
                elif case == 'extra_video':
                    request['videos'].append(request['videos'][0])
                else:
                    path = Path(request['timeline'])
                    timeline = json.loads(path.read_text(encoding='utf-8'))
                    timeline['clips'][1]['shot'] = 6
                    path.write_text(json.dumps(timeline), encoding='utf-8')
                outcome, result = self.invoke(request, drafts)
                self.assertNotEqual(outcome.returncode, 0)
                self.assertFalse(result['success'])
                self.assertIn('timeline shots and videos must match one-to-one', result['error'])
                self.assertFalse((Path(request['project']) / 'editing/draft-materials').exists())
                self.assertEqual(list(drafts.iterdir()), [])

    def test_production_cli_still_requires_the_timeline(self):
        request, drafts = self.request((6,))
        request.pop('timeline')
        outcome, result = self.invoke(request, drafts)
        self.assertNotEqual(outcome.returncode, 0)
        self.assertFalse(result['success'])
        self.assertIn('timeline is required', result['error'])
        self.assertFalse((Path(request['project']) / 'editing/draft-materials').exists())

    def owned_descendant(self, mode):
        temporary = tempfile.TemporaryDirectory(prefix='draft-request-owned-tree-')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        child = ('import json,os,socket; listener=socket.socket(); '
                 'listener.bind(("127.0.0.1",0)); listener.listen(1); '
                 'print(json.dumps({"pid":os.getpid(),"port":listener.getsockname()[1]}),flush=True); '
                 'listener.accept()')
        parent = ('import subprocess,sys; '
                  'child=subprocess.Popen([sys.executable,"-c",sys.argv[1]],stdout=subprocess.PIPE,text=True); '
                  'print("OWNED_DESCENDANT_READY "+child.stdout.readline().strip(),flush=True); '
                  'sys.exit(7) if sys.argv[2]=="failure" else child.wait()')
        outcome = run_owned([sys.executable, '-c', parent, child, mode], directory, 60_000,
                            cancel_on_stdout='OWNED_DESCENDANT_READY' if mode == 'cancel' else None)
        ready = next(line for line in outcome.stdout.splitlines() if line.startswith('OWNED_DESCENDANT_READY '))
        address = json.loads(ready.removeprefix('OWNED_DESCENDANT_READY '))
        self.assertTrue(outcome.ownership['quiescent'])
        self.assertFalse(outcome.ownership['timed_out'])
        with self.assertRaises(OSError):
            with socket.create_connection(('127.0.0.1', address['port']), timeout=1):
                pass
        return outcome

    def test_managed_cli_cancels_the_ready_parent_and_descendant_before_returning(self):
        outcome = self.owned_descendant('cancel')
        self.assertTrue(outcome.ownership['aborted'])
        self.assertNotEqual(outcome.returncode, 0)

    def test_managed_cli_reaps_a_surviving_descendant_after_its_parent_fails(self):
        outcome = self.owned_descendant('failure')
        self.assertFalse(outcome.ownership['aborted'])
        self.assertEqual(outcome.returncode, 7)


if __name__ == '__main__':
    unittest.main()

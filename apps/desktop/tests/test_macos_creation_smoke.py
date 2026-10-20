"""Prevent blank, mistimed or stale draft evidence from passing the media smoke."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/smoke-macos-creation.py'
SPEC = importlib.util.spec_from_file_location('macos_creation_smoke', SCRIPT)
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class SubtitleEvidenceTests(unittest.TestCase):
    def test_blank_movie_cannot_pass_subtitle_timing(self):
        with self.assertRaisesRegex(RuntimeError, 'cue timing'):
            SMOKE.verify_pixels([{'seconds': 0.9, 'subtitle_expected': True, 'bright_pixels': 0}])

    def test_visible_text_outside_cue_cannot_pass_subtitle_timing(self):
        with self.assertRaisesRegex(RuntimeError, 'cue timing'):
            SMOKE.verify_pixels([{'seconds': 0.25, 'subtitle_expected': False, 'bright_pixels': 120}])

    def test_cues_and_empty_intervals_are_both_accepted(self):
        SMOKE.verify_pixels([{'seconds': 0.25, 'subtitle_expected': False, 'bright_pixels': 0},
                             {'seconds': 0.9, 'subtitle_expected': True, 'bright_pixels': 120}])


class SavedDraftEvidenceTests(unittest.TestCase):
    def fixture(self, root):
        """Represent the actual library's minimal saved track and material fields."""
        def segment(start, duration, **extra):
            return {'target_timerange': {'start': start, 'duration': duration},
                    'source_timerange': {'start': 0, 'duration': duration}, **extra}

        def material(name):
            path = root / name
            path.write_bytes(name.encode())
            return {'id': name, 'path': str(path)}

        return {'duration': 4_000_000, 'fps': 24, 'canvas_config': {'width': 640, 'height': 360},
                'materials': {'videos': [material('one.mp4'), material('two.mp4')],
                              'audios': [material('voice.wav'), material('bgm.wav')],
                              'texts': [{'id': str(index), 'content': json.dumps({'text': cue[2]})}
                                        for index, cue in enumerate(SMOKE.CUES)]},
                'tracks': [{'name': '视频轨道', 'segments': [segment(0, 2_000_000), segment(2_000_000, 2_000_000)]},
                           {'name': '主音频轨道', 'segments': [segment(0, 4_000_000)]},
                           {'name': 'BGM轨道', 'segments': [segment(0, 4_000_000)]},
                           {'name': '字幕轨道', 'segments': [segment(start, end - start, material_id=str(index))
                             for index, (start, end, _) in enumerate(SMOKE.CUES)]}]}

    def test_retained_tracks_and_cues_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = SMOKE.verify_draft(self.fixture(root), root)
            self.assertEqual(result['video_segments'], 2)
            self.assertEqual(result['subtitle_segments'], 2)
            self.assertFalse(result['editor_open_verified'])

    def test_wrong_source_interval_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            content = self.fixture(root)
            content['tracks'][0]['segments'][1]['source_timerange']['start'] = 500_000
            with self.assertRaisesRegex(RuntimeError, 'source selection'):
                SMOKE.verify_draft(content, root)

    def test_shifted_subtitle_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            content = self.fixture(root)
            content['tracks'][3]['segments'][0]['target_timerange']['start'] += 250_000
            with self.assertRaisesRegex(RuntimeError, 'subtitles differ'):
                SMOKE.verify_draft(content, root)

    def test_media_outside_isolated_project_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            content = self.fixture(root)
            content['materials']['videos'][0]['path'] = str(SCRIPT)
            with self.assertRaisesRegex(RuntimeError, 'outside the isolated test'):
                SMOKE.verify_draft(content, root)

    def test_reordered_shot_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            content = self.fixture(root)
            rows = content['materials']['videos']
            for index, row in enumerate(rows):
                row['id'] = str(index)
                content['tracks'][0]['segments'][index]['material_id'] = str(index)
            expected = [Path(row['path']) for row in rows]
            SMOKE.verify_sources(content, {'视频轨道': expected})
            content['tracks'][0]['segments'].reverse()
            with self.assertRaisesRegex(RuntimeError, 'source bytes or shot order'):
                SMOKE.verify_sources(content, {'视频轨道': expected})


if __name__ == '__main__':
    unittest.main()

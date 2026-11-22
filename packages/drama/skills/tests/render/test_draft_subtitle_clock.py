"""Drafts accept only subtitles with a matching clock receipt, or subtitles the request declares manual."""
import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills' / 'tweet-drama-draft-build' / 'scripts'
SPEC = importlib.util.spec_from_file_location('draft_subtitle_clock_test', SCRIPTS / 'generate_draft_request.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class DraftSubtitleClockTests(unittest.TestCase):
    def setUp(self):
        self.project = Path(tempfile.mkdtemp(prefix='muse-draft-clock-'))
        self.addCleanup(shutil.rmtree, self.project)
        self.videos = []
        for shot in (1, 2, 3, 4):
            video = self.project / f'shot_{shot:03d}.mp4'
            video.write_bytes(f'picture {shot}'.encode())
            self.videos.append(video)
        self.clips = [{'shot': shot, 'start_us': (shot - 1) * 1_000_000, 'duration_us': 1_000_000} for shot in (1, 2, 3, 4)]
        self.srt = self.project / '02.srt'
        self.srt.write_text('1\n00:00:00,100 --> 00:00:00,900\n台词\n', encoding='utf-8')
        self.request = {'project': str(self.project), 'episode': 2, 'subtitle_srt': str(self.srt)}

    def rows(self):
        return [[clip['shot'], clip['duration_us'], sha(video), sha(video)] for clip, video in zip(self.clips, self.videos)]

    def write_receipt(self, version):
        rows = self.rows()
        clock = hashlib.sha256(json.dumps(['02', rows], separators=(',', ':')).encode()).hexdigest()
        receipt = {'version': version, 'srt_sha256': sha(self.srt), 'source_clock_sha256': clock}
        if version == 2:
            receipt.update(producer='episode_subtitles', rules_sha256='e' * 64, episode='02', review_pending=0,
                           shots=[{'shot': s, 'duration_us': d, 'video_sha256': v, 'audio_sha256': a} for s, d, v, a in rows])
        Path(str(self.srt) + '.clock.json').write_text(json.dumps(receipt), encoding='utf-8')

    def verify(self, request=None):
        MODULE.verify_draft_subtitle_clock(request or self.request, self.clips, self.videos, None)

    def test_refuses_a_subtitle_without_receipt(self):
        with self.assertRaisesRegex(ValueError, '缺少时钟回执.*subtitle_source="manual"'):
            self.verify()

    def test_manual_subtitle_needs_no_receipt(self):
        self.verify({**self.request, 'subtitle_source': 'manual'})

    def test_rejects_other_subtitle_sources(self):
        with self.assertRaisesRegex(ValueError, 'subtitle_source'):
            self.verify({**self.request, 'subtitle_source': 'generated'})

    def test_accepts_version_1_and_version_2_receipts(self):
        for version in (1, 2):
            self.write_receipt(version)
            self.verify()

    def test_manual_declaration_does_not_skip_an_existing_receipt(self):
        self.write_receipt(2)
        self.clips[1]['duration_us'] = 900_000
        self.clips[2]['start_us'] = 1_900_000
        self.clips[3]['start_us'] = 2_900_000
        with self.assertRaises(MODULE.StaleSubtitleClock):
            self.verify({**self.request, 'subtitle_source': 'manual'})

    def test_version_2_mismatch_names_the_changed_shots(self):
        self.write_receipt(2)
        self.clips[1]['duration_us'] = 900_000
        for clip in self.clips[2:]:
            clip['start_us'] -= 100_000
        self.videos[3].write_bytes(b'picture 4 regenerated')
        with self.assertRaises(MODULE.StaleSubtitleClock) as caught:
            self.verify()
        self.assertEqual(caught.exception.changed_shots, [2, 4])
        self.assertIn('变化镜头：2、4', str(caught.exception))

    def test_version_1_mismatch_has_no_shot_list(self):
        self.write_receipt(1)
        self.videos[0].write_bytes(b'other picture')
        with self.assertRaises(MODULE.StaleSubtitleClock) as caught:
            self.verify()
        self.assertIsNone(caught.exception.changed_shots)


if __name__ == '__main__':
    unittest.main()

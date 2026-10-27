"""Motion evidence is version-bound and never substitutes for media acceptance."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-project-inspect/scripts/video_review_evidence.py'
sys.path.insert(0, str(SCRIPT.parent))
import video_review_evidence as evidence


class MotionEvidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.mp4'
        self.source.write_bytes(b'current source')

    def media(self, args, timeout):
        if args[0] == 'probe':
            return json.dumps({'format': {'duration': '7'}, 'streams': [{'codec_type': 'video'}, {'codec_type': 'audio'}]})
        path = Path(args[-1])
        if path.suffix == '.mp4':
            path.write_bytes(b'continuous local evidence')
        else:
            for index in range(1, 9):
                Image.new('RGB', (48, 86), (index, 0, 0)).save(path.parent / f'{index:06d}.png')
        return ''

    def create(self, **overrides):
        args = {'project': self.root, 'source': Path('source.mp4'), 'output': Path('qa/check'),
                'start': 3, 'end': 5, 'fps': 4, 'ffmpeg': 'ff', 'ffprobe': 'probe'}
        args.update(overrides)
        return evidence.create_evidence(**args)

    def test_motion_clip_and_small_sheets_bind_current_source_without_approving_it(self):
        with patch.object(evidence, 'run_media', side_effect=self.media):
            result = self.create()
        self.assertEqual(result['source_sha256'], hashlib.sha256(b'current source').hexdigest())
        self.assertEqual(result['review_status'], 'pending')
        self.assertTrue(result['continuous_clip']['audio_present_in_source'])
        self.assertEqual(result['continuous_clip']['source_offset_seconds'], 3)
        self.assertEqual(len(result['samples']), 8)
        self.assertEqual(len(result['sheets']), 2)
        self.assertEqual(result['network_calls'], 0)
        self.assertEqual(self.source.read_bytes(), b'current source')
        self.assertEqual(json.loads((self.root/'qa/check/evidence.json').read_text(encoding='utf-8')), result)

    def test_existing_evidence_is_not_replaced_or_reused_for_another_version(self):
        folder = self.root / 'qa/check'
        folder.mkdir(parents=True)
        marker = folder/'existing.txt'
        marker.write_text('keep', encoding='utf-8')
        with patch.object(evidence, 'run_media') as media:
            with self.assertRaisesRegex(ValueError, 'new directory'):
                self.create()
        media.assert_not_called()
        self.assertEqual(marker.read_text(encoding='utf-8'), 'keep')

    def test_bad_ranges_and_nonfinite_values_fail_before_extraction(self):
        for args in ({'start': -1}, {'start': 5, 'end': 4}, {'fps': 0}, {'fps': float('inf')},
                     {'start': float('nan')}, {'timeout': 0}):
            with self.subTest(args=args), patch.object(evidence, 'run_media') as media:
                with self.assertRaises(ValueError):
                    self.create(**args)
                media.assert_not_called()

    def test_interval_cannot_exceed_measured_duration(self):
        with patch.object(evidence, 'run_media', side_effect=self.media) as media:
            with self.assertRaisesRegex(ValueError, 'actual source duration'):
                self.create(end=8)
        self.assertEqual(media.call_count, 1)
        self.assertFalse((self.root/'qa/check').exists())

    def test_source_replacement_during_extraction_leaves_no_acceptance_record(self):
        def replace(args, timeout):
            result = self.media(args, timeout)
            if args[0] == 'ff':
                self.source.write_bytes(b'replacement')
            return result
        with patch.object(evidence, 'run_media', side_effect=replace):
            with self.assertRaisesRegex(ValueError, 'source changed'):
                self.create()
        self.assertFalse((self.root/'qa/check/evidence.json').exists())

    def test_external_output_does_not_start_a_media_process(self):
        with patch.object(evidence, 'run_media') as media:
            with self.assertRaisesRegex(ValueError, 'inside the project'):
                self.create(output=Path('../outside'))
        media.assert_not_called()


if __name__ == '__main__':
    unittest.main()

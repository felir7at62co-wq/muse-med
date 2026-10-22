"""Draft request binding for renderer-selected overlay subtitles and embedded-text disclosure."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[2] / 'skills/tweet-drama-draft-build/scripts/generate_draft_request.py'
SPEC = importlib.util.spec_from_file_location('subtitle_overlay_request', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SubtitleOverlayRequest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='muse-subtitle-request-')
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        self.drafts = self.project / 'drafts'
        self.drafts.mkdir()
        self.video = self.project / 'selected.mp4'
        self.video.write_bytes(b'selected source bytes')
        self.audio = self.project / 'dialogue.wav'
        self.audio.write_bytes(b'dialogue')
        self.srt = self.project / 'overlay.srt'
        self.srt.write_text('1\n00:00:02,000 --> 00:00:03,000\n后加字幕\n', encoding='utf-8')
        self.timeline = self.project / 'timeline.json'
        self.timeline.write_text(json.dumps({'clips': [{'shot': 1, 'start_us': 0, 'duration_us': 4000000}]}), encoding='utf-8')
        self.report_path = self.project / 'decision-report.json'
        self.report = {'schema_version': 1, 'episode': '24', 'resolved_srt': str(self.srt),
                       'resolved_srt_sha256': sha(self.srt), 'sources': [{'shot': 1, 'sha256': sha(self.video)}],
                       'timeline_clips': [{'shot': 1, 'start_us': 0, 'duration_us': 4000000}],
                       'overlay_cue_count': 1, 'retained_embedded': [{'cue_index': 1, 'shot': 1,
                           'text': '画面烧录字', 'start_seconds': 0, 'end_seconds': 1, 'editable': False}],
                       'warnings': ['预览源画面文字']}
        self.request = {'project': str(self.project), 'episode': 24, 'name_prefix': 'new-qa-',
                        'videos': [str(self.video)], 'audio': str(self.audio), 'subtitle_srt': str(self.srt),
                        'timeline': str(self.timeline), 'subtitle_overlay_report': str(self.report_path)}
        self.save_report()

    def save_report(self):
        self.report_path.write_text(json.dumps(self.report, ensure_ascii=False), encoding='utf-8')

    def all_retained(self):
        self.srt.write_text('\n', encoding='utf-8')
        self.report.update(resolved_srt_sha256=sha(self.srt), overlay_cue_count=0,
                           original_cue_count=1, retained_cue_indexes=[1])
        self.save_report()

    def test_legacy_request_does_not_require_report_or_claim_editability(self):
        self.assertIsNone(MODULE.read_subtitle_overlay_report({}))

    def test_binds_filtered_srt_and_source_without_claiming_all_text_editable(self):
        before = [sha(path) for path in (self.srt, self.video, self.timeline)]
        result = MODULE.read_subtitle_overlay_report(self.request)
        self.assertEqual(result['overlay_cue_count'], 1)
        self.assertEqual(result['retained_embedded_count'], 1)
        self.assertIs(result['all_subtitles_editable'], False)
        self.assertEqual(result['evidence_kind'], 'caller_declared')
        self.assertIn('不可编辑', '\n'.join(result['warnings']))
        self.assertEqual(before, [sha(path) for path in (self.srt, self.video, self.timeline)])

    def test_refuses_original_unfiltered_srt_or_modified_bytes(self):
        self.report['resolved_srt'] = str(self.project / 'other.srt')
        self.save_report()
        with self.assertRaisesRegex(ValueError, 'original unfiltered SRT'):
            MODULE.read_subtitle_overlay_report(self.request)
        self.report['resolved_srt'] = str(self.srt)
        self.save_report()
        self.srt.write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'bytes changed'):
            MODULE.read_subtitle_overlay_report(self.request)

    def test_refuses_a_different_episode_and_changed_video(self):
        self.report['episode'] = '23'
        self.save_report()
        with self.assertRaisesRegex(ValueError, 'different episode'):
            MODULE.read_subtitle_overlay_report(self.request)
        self.report['episode'] = '24'
        self.save_report()
        self.video.write_bytes(b'a different selection')
        with self.assertRaisesRegex(ValueError, 'source bytes'):
            MODULE.read_subtitle_overlay_report(self.request)

    def test_rejects_missing_source_or_falsely_editable_embedded_text(self):
        self.report['sources'] = []
        self.save_report()
        with self.assertRaisesRegex(ValueError, 'same ordered body sources'):
            MODULE.read_subtitle_overlay_report(self.request)

        self.report['sources'] = [{'shot': 1, 'sha256': sha(self.video)}]
        self.report['retained_embedded'][0]['editable'] = True
        self.save_report()
        with self.assertRaisesRegex(ValueError, 'editability report'):
            MODULE.read_subtitle_overlay_report(self.request)

    def test_rejects_changed_timeline_even_when_videos_and_srt_are_unchanged(self):
        self.timeline.write_text(json.dumps({'clips': [{'shot': 1, 'start_us': 1000000, 'duration_us': 4000000}]}), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'timeline changed'):
            MODULE.read_subtitle_overlay_report(self.request)

    def test_zero_overlay_accepts_only_the_complete_retained_cue_selection(self):
        self.all_retained()
        result = MODULE.read_subtitle_overlay_report(self.request)
        self.assertEqual(result['overlay_cue_count'], 0)
        self.assertEqual(result['retained_embedded_count'], 1)
        self.assertFalse(result['all_subtitles_editable'])

    def test_zero_overlay_rejects_nonblank_srt_even_when_its_hash_matches(self):
        self.all_retained()
        for text in ('not a subtitle', '1\n00:00:02,000 --> 00:00:03,000\n后加字幕\n'):
            with self.subTest(text=text):
                self.srt.write_text(text, encoding='utf-8')
                self.report['resolved_srt_sha256'] = sha(self.srt)
                self.save_report()
                with self.assertRaisesRegex(ValueError, 'Zero overlay requires blank'):
                    MODULE.read_subtitle_overlay_report(self.request)

    def test_zero_overlay_rejects_missing_mismatched_or_duplicate_retained_cues(self):
        self.all_retained()
        for count, retained, indexes in ((0, [], []), (2, self.report['retained_embedded'], [1]),
                                         (2, self.report['retained_embedded'] * 2, [1, 1])):
            with self.subTest(count=count, indexes=indexes):
                self.report.update(original_cue_count=count, retained_embedded=retained, retained_cue_indexes=indexes)
                self.save_report()
                with self.assertRaisesRegex(ValueError, 'complete, distinct retained'):
                    MODULE.read_subtitle_overlay_report(self.request)

    def test_preserves_report_in_retained_materials_review_and_result(self):
        generator = types.ModuleType('draft_generator')
        generator.DraftGenerator = type('FixtureGenerator', (), {'_setup_ffmpeg': lambda self: None})
        draft = types.ModuleType('jianying_draft')
        draft.find_project = lambda *_args: self.project
        draft.check_videos = lambda *_args: None
        draft.parse_srt_cues = lambda *_args: []

        def generate(drafts, stage, name_prefix, seq, project, bgm_role=None):
            output = Path(drafts) / f'{name_prefix}{seq}'
            output.mkdir()
            review = output / 'muse-review.json'
            review.write_text(json.dumps({'status': 'needs_review', 'warnings': []}), encoding='utf-8')
            self.assertEqual((Path(stage) / '03_subtitle/24.srt').read_bytes(), self.srt.read_bytes())
            return {'success': True, 'drafts_created': 1, 'drafts': [{'path': str(output), 'success': True, 'review_path': str(review), 'warnings': []}], 'warnings': []}

        draft.generate_draft = generate
        with patch.dict('sys.modules', {'draft_generator': generator, 'jianying_draft': draft}), \
                patch.object(MODULE.importlib.metadata, 'version', return_value='0.3.1'):
            result = MODULE.generate_request(self.request, str(self.drafts))
        saved = result['subtitle_overlay']
        self.assertEqual(Path(saved['report_path']).read_bytes(), self.report_path.read_bytes())
        review = json.loads(Path(result['drafts'][0]['review_path']).read_text(encoding='utf-8'))
        self.assertEqual(review['subtitle_overlay'], saved)
        self.assertIn('不可编辑', '\n'.join(result['warnings']))
        self.assertFalse(result['editor_open_verified'])

    def test_failed_candidate_without_saved_review_keeps_its_original_error(self):
        generator = types.ModuleType('draft_generator')
        generator.DraftGenerator = type('FixtureGenerator', (), {'_setup_ffmpeg': lambda self: None})
        draft = types.ModuleType('jianying_draft')
        draft.find_project = lambda *_args: self.project
        draft.check_videos = lambda *_args: None
        draft.parse_srt_cues = lambda *_args: []
        failure = {'success': False, 'drafts_created': 0, 'drafts': [{'episode': '24', 'name': 'new-qa-24',
                   'path': str(self.drafts / 'new-qa-24'), 'id': '', 'success': False, 'error': 'original save error'}],
                   'error': 'original save error', 'warnings': []}
        draft.generate_draft = lambda *_args, **_kwargs: failure
        with patch.dict('sys.modules', {'draft_generator': generator, 'jianying_draft': draft}), \
                patch.object(MODULE.importlib.metadata, 'version', return_value='0.3.1'):
            result = MODULE.generate_request(self.request, str(self.drafts))
        self.assertFalse(result['success'])
        self.assertEqual(result['error'], 'original save error')
        self.assertEqual(result['drafts'][0]['error'], 'original save error')
        self.assertNotIn('review_path', result['drafts'][0])
        self.assertEqual(result['subtitle_overlay']['overlay_cue_count'], 1)
        self.assertIn('不可编辑', '\n'.join(result['drafts'][0]['warnings']))


if __name__ == '__main__':
    unittest.main()

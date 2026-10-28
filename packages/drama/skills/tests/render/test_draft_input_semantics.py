"""Draft clocks and declared music roles use no media decoder or speech classifier."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = (Path(__file__).resolve().parents[2]
          / 'skills/tweet-drama-draft-build/scripts/draft_inputs.py')
SPEC = importlib.util.spec_from_file_location('draft_inputs_contract', SCRIPT)
INPUTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INPUTS)


class DraftInputSemanticsTests(unittest.TestCase):
    def test_frame_clock_recognizes_serialized_fractional_microsecond_boundaries(self):
        for time_us, frame in ((0, 0), (41_667, 1), (83_333, 2), (2_041_667, 49)):
            with self.subTest(time_us=time_us):
                self.assertEqual(INPUTS.project_frame_index(time_us, 24), frame)
                self.assertEqual(INPUTS.frame_time_us(frame, 24), time_us)
        self.assertEqual(INPUTS.project_frame_index(41_668, 24), 2)

    def test_project_clock_uses_shared_absolute_boundaries_at_supported_integer_rates(self):
        for fps in (24, 25, 30, 60, 240):
            with self.subTest(fps=fps):
                clips = {9: {'start_us': 0, 'duration_us': 1_001_000},
                         31: {'start_us': 1_001_000, 'duration_us': 1_001_000}}
                before = json.dumps(clips)
                clock = INPUTS.project_frame_clock(clips, fps, 2_002_000, 2_000_000)
                first, second = clock['clips'][9], clock['clips'][31]
                self.assertEqual(first['start_us'] + first['duration_us'], second['start_us'])
                self.assertEqual(second['start_us'] + second['duration_us'], clock['body_end_us'])
                self.assertEqual(clock['body_end_frame'], 2 * fps + 1)
                self.assertEqual(clock['total_frames'], 4 * fps + 1)
                self.assertEqual(clock['duration_us'] - clock['body_end_us'], 2_000_000)
                self.assertEqual(json.dumps(clips), before)

    def test_already_aligned_project_clock_and_animation_duration_remain_exact(self):
        clips = {6: {'start_us': 0, 'duration_us': 2_000_000}}
        for fps in (24, 25, 30, 60):
            clock = INPUTS.project_frame_clock(clips, fps, 2_000_000, 0)
            self.assertEqual(clock['delta_us'], 0)
            self.assertEqual(clock['body_end_us'], 2_000_000)
            self.assertEqual(clock['duration_us'], 2_000_000)
            self.assertEqual(clock['clips'][6]['duration_us'], 2_000_000)

    def test_project_clock_does_not_invent_a_frame_for_a_collapsed_short_shot(self):
        clips = {1: {'start_us': 0, 'duration_us': 1_000},
                 6: {'start_us': 1_000, 'duration_us': 1_000}}
        clock = INPUTS.project_frame_clock(clips, 24, 2_000, 0)
        self.assertEqual(clock['status'], 'unsupported')
        self.assertIn('镜头 6', clock['reason'])
    def test_native_bgm_ceiling_preserves_source_attenuation_without_changing_dialogue(self):
        with patch.dict('os.environ', {'DSH_BGM_MAX_GAIN': '1'}):
            self.assertEqual(INPUTS.audio_gains({'delivery': {'audio': {'master_gain': 3, 'bgm_gain': 8}}}),
                             {'master_gain': 3, 'bgm_gain': 1})

    def test_missing_audio_settings_retain_legacy_sdk_unit_gains(self):
        for timeline in ({}, {'delivery': {}}, {'delivery': {'audio': {}}}):
            with self.subTest(timeline=timeline):
                self.assertEqual(INPUTS.audio_gains(timeline), {'master_gain': 1.0, 'bgm_gain': 1.0})

    def test_project_audio_and_snapshot_section_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / 'project_config.json').write_text(json.dumps({'project_bible': {'delivery': {
                'audio': {'master_gain': 1, 'bgm_gain': 0.24}}}}), encoding='utf-8')
            self.assertEqual(INPUTS.audio_gains({}, project), {'master_gain': 1, 'bgm_gain': 0.24})
            self.assertEqual(INPUTS.audio_gains({'delivery': {'audio': {'master_gain': 0}}}, project),
                             {'master_gain': 0, 'bgm_gain': 1.0})
            self.assertEqual(INPUTS.audio_gains({'delivery': {'audio': {}}}, project),
                             {'master_gain': 1.0, 'bgm_gain': 1.0})
            self.assertEqual(INPUTS.audio_gains({'delivery': {'audio': {'bgm_gain': 8}}}, project),
                             {'master_gain': 1.0, 'bgm_gain': 8})

    def test_invalid_explicit_audio_values_are_not_silently_defaulted(self):
        for value in (None, [], 'quiet'):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, 'audio must be an object'):
                    INPUTS.audio_gains({'delivery': {'audio': value}})
        for key in ('master_gain', 'bgm_gain'):
            for value in (True, False, None, '1', -0.01, 8.01, float('inf'), float('nan')):
                with self.subTest(key=key, value=value):
                    with self.assertRaisesRegex(ValueError, key):
                        INPUTS.audio_gains({'delivery': {'audio': {key: value}}})

    def clock(self, timeline, end_us=55_264_000):
        return INPUTS.body_clock(timeline, end_us, 200_000, 2_000_000)

    def test_ep23_container_tail_uses_the_four_clip_endpoints(self):
        durations = [10_048_000, 15_072_000, 15_072_000, 15_072_000]
        clips, cursor = [], 0
        for shot, duration in enumerate(durations, 1):
            clips.append({'shot': shot, 'start_us': cursor, 'duration_us': duration})
            cursor += duration
        timeline = {'clips': clips, 'body_end': 55.296}
        plan = self.clock(timeline, max(row['start_us'] + row['duration_us'] for row in clips))
        self.assertEqual(plan['body_end_us'], 55_264_000)
        self.assertFalse(plan['included'])
        self.assertEqual(len(plan['warnings']), 1)
        self.assertIn('clips', plan['warnings'][0])
        self.assertEqual(timeline['body_end'], 55.296)

    def test_missing_or_exact_body_end_uses_clips_without_a_tail_warning(self):
        for timeline in ({}, {'body_end': 55.264}):
            with self.subTest(timeline=timeline):
                self.assertEqual(self.clock(timeline), {
                    'body_end_us': 55_264_000, 'included': False, 'warnings': []})

    def test_container_tail_normalization_uses_the_existing_tolerance_on_both_sides(self):
        for difference in (-200_000, -32_000, 32_000, 200_000):
            with self.subTest(difference=difference):
                plan = self.clock({'body_end': (55_264_000 + difference) / 1e6})
                self.assertEqual(plan['body_end_us'], 55_264_000)
                self.assertFalse(plan['included'])
                self.assertTrue(plan['warnings'])

    def test_exact_included_two_second_ending_remains_explicit(self):
        plan = self.clock({'body_end': 53.264})
        self.assertEqual(plan, {'body_end_us': 53_264_000, 'included': True, 'warnings': []})

    def test_large_body_end_disagreement_still_requires_a_new_timeline(self):
        for declared in (55.063999, 55.464001, 54.264):
            with self.subTest(declared=declared):
                with self.assertRaisesRegex(ValueError, 'body_end'):
                    self.clock({'body_end': declared})

    def test_invalid_body_end_is_not_replaced_with_an_invented_clock(self):
        for declared in (True, False, 0, -1, '55.296', None, float('nan'), float('inf')):
            with self.subTest(declared=declared):
                with self.assertRaisesRegex(ValueError, 'body_end'):
                    self.clock({'body_end': declared})

    def test_declared_dialogue_music_mix_is_not_a_separate_bgm_track(self):
        decision = INPUTS.bgm_import('dialogue_music_mix')
        self.assertFalse(decision['include'])
        self.assertFalse(decision['content_verified'])
        self.assertIn('不导入独立 BGM 轨', decision['warnings'][0])

    def test_music_only_is_a_declaration_not_acoustic_verification(self):
        self.assertEqual(INPUTS.bgm_import('music_only'), {
            'role': 'music_only', 'include': True, 'content_verified': False, 'warnings': []})

    def test_unknown_legacy_music_keeps_the_track_with_a_review_warning(self):
        for role in (None, 'unknown', 'review-mix.wav'):
            with self.subTest(role=role):
                decision = INPUTS.bgm_import(role)
                self.assertTrue(decision['include'])
                self.assertEqual(decision['role'], 'unknown')
                self.assertFalse(decision['content_verified'])
                self.assertIn('未分析或确认其不含对白', decision['warnings'][0])


if __name__ == '__main__':
    unittest.main()

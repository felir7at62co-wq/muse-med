"""AA draft planning and native readback tests; no installed editor or paid calls."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('windows_aa_draft_tests', SCRIPTS / 'windows_aa_draft.py')
aa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aa)


class AaDraftTests(unittest.TestCase):
    def test_isolated_packaged_python_loads_adjacent_helpers(self):
        with tempfile.TemporaryDirectory() as work:
            request = Path(work) / 'invalid.json'
            request.write_text('{"audio_mode":"independent"}', encoding='utf-8')
            result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPTS / 'windows_aa_draft.py'),
                                     str(request), work, '1048576'], capture_output=True,
                                    text=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn('requires audio_mode=embedded', json.loads(result.stdout)['error'])
        self.assertNotIn('ModuleNotFoundError', result.stderr)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.drafts = self.root / 'drafts'
        self.project.mkdir()
        self.drafts.mkdir()
        (self.project / 'project_config.json').write_text(json.dumps({
            'project_bible': {'visual_medium': 'animation_3d'}}), encoding='utf-8')
        self.sources = [self.project / 'p1 原片.mp4', self.project / 'p2.mp4']
        for index, path in enumerate(self.sources):
            path.write_bytes(f'original source {index}'.encode())
        self.timeline = self.project / 'timeline.json'
        self.timeline.write_text(json.dumps({'clips': [
            {'shot': 1, 'start_us': 0, 'duration_us': 1_000_000},
            {'shot': 2, 'start_us': 1_000_000, 'duration_us': 1_000_000}],
            'body_end': 2, 'delivery': {'visual_medium': 'animation_3d', 'width': 1920, 'height': 1080, 'fps': 24}}))
        self.srt = self.project / 'corrected.srt'
        self.srt.write_text('1\n00:00:00,123 --> 00:00:00,789\n程昭宁\n\n'
                            '2\n00:00:01,201 --> 00:00:01,899\n五十二\n', encoding='utf-8')
        self.request = {'audio_mode': 'embedded', 'project': str(self.project), 'episode': 2,
                        'name_prefix': 'AA-EP', 'videos': list(map(str, self.sources)),
                        'subtitle_srt': str(self.srt), 'timeline': str(self.timeline)}
        self.probe = patch.object(aa, 'probe', return_value={'duration_us': 2_000_000, 'video': True, 'audio': True,
                                                           'width': 1920, 'height': 1080})
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def plan(self):
        return aa.prepare_plan(self.request, str(self.drafts))

    def test_bgm_ceiling_keeps_embedded_source_gain_independent(self):
        timeline = json.loads(self.timeline.read_text())
        timeline['delivery']['audio'] = {'master_gain': 0.8, 'bgm_gain': 3}
        self.timeline.write_text(json.dumps(timeline))
        with patch.dict(aa.os.environ, {'DSH_BGM_MAX_GAIN': '1'}):
            plan, _ = self.plan()
        self.assertEqual(plan['audio'], {'master_gain': 0.8, 'bgm_gain': 1})

    def test_product_subtitle_policy_overrides_old_style_without_changing_audio(self):
        timeline = json.loads(self.timeline.read_text())
        timeline['delivery'].update({'width': 1080, 'height': 1920,
            'audio': {'master_gain': 0.8, 'bgm_gain': 0.35},
            'draft_style': {'subtitle': {'font_size_ui': 45, 'transform_y': 0.5},
                            'watermark': {'font_size_ui': 7}}, 'subtitle_visual': {}})
        self.timeline.write_text(json.dumps(timeline))
        visual = {'schema_version': 1, 'reference_width': 480, 'reference_height': 854,
                  'font_size_px': 48, 'outline_px': 2, 'center_y_ratio': 0.736747073,
                  'max_width_ratio': 0.9, 'font_family': 'Zhuque Fangsong (technical preview)'}
        source_srt = '1\n00:00:00,123 --> 00:00:00,789\n价格 3.14，好！\n\n'
        self.srt.write_text(source_srt, encoding='utf-8')
        def image(source, selected_us, target):
            target.write_bytes(b'portrait final frame')
            return {'path': str(target), 'duration_us': 2_000_000}
        with patch.object(aa, 'ending_image', side_effect=image), \
                patch.dict(aa.os.environ, {'MUSE_FORCE_SUBTITLE_VISUAL': '1',
                                           'MUSE_DEFAULT_SUBTITLE_VISUAL': json.dumps(visual)}):
            plan, stage = self.plan()
        subtitle = plan['draft_style']['subtitle']
        self.assertEqual((subtitle['font_size_ui'], subtitle['border_width_ui']), (11, 20))
        self.assertAlmostEqual(subtitle['transform_y'], 1 - 2 * visual['center_y_ratio'])
        self.assertFalse(subtitle['auto_wrapping'])
        self.assertEqual(plan['draft_style']['watermark'], {'font_size_ui': 7})
        self.assertEqual(plan['audio'], {'master_gain': 0.8, 'bgm_gain': 0.35})
        self.assertEqual(json.loads(self.timeline.read_text()), timeline)
        self.assertEqual(self.srt.read_text(encoding='utf-8'), source_srt)
        self.assertEqual(plan['subtitles'], [{'start_us': 123_000, 'end_us': 789_000,
                                              'text': '价格 3.14 好'}])
        self.assertEqual(aa.parse_subtitles(stage / 'subtitles-product.srt'), plan['subtitles'])

    def test_product_punctuation_only_cues_leave_no_fake_overlay_and_warn(self):
        source = '1\n00:00:00,123 --> 00:00:00,789\n？！\n'
        self.srt.write_text(source, encoding='utf-8')
        visual = {'schema_version': 1, 'reference_width': 480, 'reference_height': 854,
                  'font_size_px': 48, 'outline_px': 2, 'center_y_ratio': 0.736747073,
                  'max_width_ratio': 0.9, 'font_family': 'Zhuque Fangsong'}
        with patch.dict(aa.os.environ, {'MUSE_FORCE_SUBTITLE_VISUAL': '1',
                                       'MUSE_DEFAULT_SUBTITLE_VISUAL': json.dumps(visual)}):
            plan, stage = self.plan()
        self.assertEqual(plan['subtitles'], [])
        self.assertNotIn('subtitle_overlay', plan)
        self.assertEqual((stage / 'subtitles-product.srt').read_text(encoding='utf-8'), '')
        self.assertEqual(self.srt.read_text(encoding='utf-8'), source)
        self.assertTrue(any('123000–789000' in warning and '核听' in warning for warning in plan['warnings']))

    def saved(self, plan):
        rows = [{'id': 'draft', 'type': 'draft', 'attributes': {
            'width': plan['delivery']['width'], 'height': plan['delivery']['height']}}]
        body_ids, subtitle_ids = [], []
        for index, video in enumerate(plan['native_videos']):
            identifier = f'video-{index}'
            body_ids.append(identifier)
            rows.append({'id': identifier, 'type': 'video',
                         'attributes': {'source': Path(video['path']).as_uri(), 'volume': plan['audio']['master_gain'],
                                        'speed': 1, 'start.ms': 0, 'width': video['width'], 'height': video['height'],
                                        'crop': [0, 0, 1, 1]},
                         'layout': {'position_x': 0, 'position_y': 0, 'rotation': 0, 'scale_x': 1, 'scale_y': 1},
                         'timeline': {'start.ms': video['start_us'] / 1000, 'duration.ms': video['duration_us'] / 1000}})
        for index, cue in enumerate(plan['native_subtitles']):
            identifier = f'subtitle-{index}'
            subtitle_ids.append(identifier)
            rows.append({'id': identifier, 'type': 'text', 'attributes': {
                             'content': json.dumps({'text': cue['text']}),
                             'font_size': plan['draft_style']['subtitle']['font_size_ui']},
                         'layout': {'position_x': 0, 'position_y': (
                             plan['draft_style']['subtitle']['editor_y'] / plan['delivery']['height']
                             if 'editor_y' in plan['draft_style']['subtitle']
                             else plan['draft_style']['subtitle']['transform_y'])},
                         'timeline': {'start.ms': cue['start_us'] // 1000,
                                      'duration.ms': cue['duration_us'] // 1000}})
        rows.append({'id': 'body-track', 'type': 'track', 'attributes': {'segments': list(body_ids)}})
        rows.append({'id': 'subtitle-track', 'type': 'track', 'attributes': {'segments': list(subtitle_ids)}})
        timeline_rows = [row for row in rows if row.get('type') == 'track']
        full_rows = [row for row in rows if row.get('type') != 'track']
        result = {'ok': True, 'ref': plan['ref'], 'full': {'json_result': json.dumps(full_rows)},
                  'timeline': {'json_result': json.dumps(timeline_rows)},
                  'body_segment_ids': body_ids, 'subtitle_segment_ids': subtitle_ids,
                  'bgm_segment_id': None, 'ending_image_segment_id': None, 'ending_audio_segment_id': None}
        # The two native extract scopes have different fields. Tests may mutate
        # the node objects, but membership is never available in the full scope.
        result['timeline'] = timeline_rows
        return result, rows

    def test_canvas_dimensions_resolve_to_supported_native_ratio(self):
        self.assertEqual(aa.native_ratio(1080, 1920), '9:16')
        self.assertEqual(aa.native_ratio(2350, 1000), '2.35:1')
        with self.assertRaisesRegex(ValueError, 'custom aspect ratio'):
            aa.native_ratio(1000, 1234)

    def test_landscape_uses_size_seven_and_requested_position_even_with_old_project_style(self):
        document = json.loads(self.timeline.read_text())
        document['delivery']['draft_style'] = {'subtitle': {'font_size_ui': 11, 'transform_y': 0.6}}
        self.timeline.write_text(json.dumps(document))
        plan, _ = self.plan()
        self.assertEqual(plan['draft_style']['subtitle']['font_size_ui'], 7)
        self.assertEqual(plan['draft_style']['subtitle']['editor_y'], -879)
        with patch.dict(aa.os.environ, {'MUSE_JIANYING_LANDSCAPE_SUBTITLE_SIZE': '8',
                                       'MUSE_JIANYING_LANDSCAPE_SUBTITLE_Y': '-700'}):
            self.assertEqual(aa.resolve_landscape_subtitle_style(), {'font_size_ui': 8, 'editor_y': -700})
        with patch.dict(aa.os.environ, {'MUSE_JIANYING_LANDSCAPE_SUBTITLE_SIZE': 'NaN'}):
            with self.assertRaisesRegex(ValueError, 'configuration is invalid'):
                aa.resolve_landscape_subtitle_style()
        visual = {'schema_version': 1, 'reference_width': 480, 'reference_height': 854,
                  'font_size_px': 48, 'outline_px': 2, 'center_y_ratio': 0.736747073,
                  'max_width_ratio': 0.9}
        with patch.dict(aa.os.environ, {'MUSE_FORCE_SUBTITLE_VISUAL': '1',
                                        'MUSE_DEFAULT_SUBTITLE_VISUAL': json.dumps(visual)}):
            plan, _ = self.plan()
        self.assertEqual(plan['draft_style']['subtitle']['font_size_ui'], 7)
        self.assertEqual(plan['draft_style']['subtitle']['editor_y'], -879)
        self.assertEqual(plan['draft_style']['subtitle']['transform_y'], 0.6)

    def test_native_readback_rejects_wrong_subtitle_size_or_position(self):
        plan, _ = self.plan()
        for change in ('size', 'position'):
            result, rows = self.saved(plan)
            cue = next(row for row in rows if row.get('id') == 'subtitle-0')
            if change == 'size':
                cue['attributes']['font_size'] = 11
            else:
                cue['layout']['position_y'] = 0
            result['full'] = rows
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'size or position'):
                aa.verify_readback(plan, result)

    def test_overlay_report_retains_source_text_and_only_adds_selected_cues(self):
        selected = self.project / 'resolved.srt'
        selected.write_text('1\n00:00:01,201 --> 00:00:01,899\n五十二\n', encoding='utf-8')
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        report = {'schema_version': 1, 'episode': '02', 'resolved_srt': str(selected),
                  'resolved_srt_sha256': sha(selected),
                  'sources': [{'shot': index, 'sha256': sha(path)}
                              for index, path in enumerate(self.sources, 1)],
                  'timeline_clips': json.loads(self.timeline.read_text())['clips'],
                  'overlay_cue_count': 1,
                  'retained_embedded': [{'cue_index': 1, 'shot': 1, 'text': '程昭宁',
                                         'start_seconds': .123, 'end_seconds': .789, 'editable': False}],
                  'warnings': ['画面文字由调用方核对']}
        path = self.project / 'report.json'
        path.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
        self.request.update(subtitle_srt=str(selected), subtitle_overlay_report=str(path))
        plan, stage = self.plan()
        self.assertEqual([cue['text'] for cue in plan['subtitles']], ['五十二'])
        self.assertFalse(plan['subtitle_overlay']['all_subtitles_editable'])
        self.assertEqual(plan['subtitle_overlay']['evidence_kind'], 'caller_declared')
        self.assertEqual((stage / 'subtitle-overlay-report.json').read_bytes(), path.read_bytes())
        result, _ = self.saved(plan)
        self.assertEqual(aa.verify_readback(plan, result)['subtitle_segments'], 1)
        self.sources[0].write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'source bytes'):
            self.plan()

    def test_complete_embedded_subtitles_allow_a_blank_overlay_without_claiming_editability(self):
        selected = self.project / 'empty.srt'
        selected.write_text('', encoding='utf-8')
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        report = {'schema_version': 1, 'episode': '02', 'resolved_srt': str(selected),
                  'resolved_srt_sha256': sha(selected), 'original_srt': str(self.srt),
                  'original_srt_sha256': sha(self.srt), 'original_cue_count': 2,
                  'sources': [{'shot': index, 'sha256': sha(path)}
                              for index, path in enumerate(self.sources, 1)],
                  'timeline_clips': json.loads(self.timeline.read_text())['clips'],
                  'overlay_cue_count': 0, 'retained_cue_indexes': [1, 2],
                  'retained_embedded': [{'cue_index': index, 'editable': False} for index in (1, 2)],
                  'warnings': []}
        path = self.project / 'report.json'
        path.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
        self.request.update(subtitle_srt=str(selected), subtitle_overlay_report=str(path))
        plan, _ = self.plan()
        self.assertEqual(plan['subtitles'], [])
        self.assertFalse(plan['subtitle_overlay']['all_subtitles_editable'])
        result, _ = self.saved(plan)
        self.assertEqual(aa.verify_readback(plan, result)['subtitle_segments'], 0)
        self.srt.write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'original subtitle hash'):
            self.plan()

    def test_landscape_and_other_ratios_ignore_even_missing_ending_inputs(self):
        music = self.project / 'background.mp3'
        music.write_bytes(b'independent BGM')
        for width, height in [(1920, 1080), (1080, 1080), (1440, 1080)]:
            with self.subTest(width=width, height=height):
                self.project.joinpath('project_config.json').write_text(json.dumps({
                    'project_bible': {'visual_medium': 'photorealistic'}}))
                document = json.loads(self.timeline.read_text())
                document['delivery'].update(visual_medium='photorealistic', width=width, height=height)
                self.timeline.write_text(json.dumps(document))
                request = {**self.request, 'ending_audio': str(self.project / 'missing-ending.mp3'),
                           'ending_effect': str(self.project / 'missing-ending.mp4'),
                           'bgm': str(music), 'bgm_role': 'music_only'}
                with patch.object(aa, 'ending_image', side_effect=AssertionError('No ending extraction')):
                    plan, _ = aa.prepare_plan(request, str(self.drafts))
                self.assertEqual(plan['delivery']['ending_duration_us'], 0)
                self.assertEqual(plan['native_duration_us'], plan['native_body_end_us'])
                self.assertTrue(plan['delivery']['add_watermark'])
                self.assertEqual(plan['native_bgm']['end_us'], plan['native_body_end_us'])
                for field in ('ending', 'ending_audio', 'ending_effect',
                              'native_ending', 'native_ending_audio', 'native_ending_effect'):
                    self.assertNotIn(field, plan)

    def test_portrait_adds_two_second_ending_even_for_animation_and_preserves_source_dimensions(self):
        document = json.loads(self.timeline.read_text())
        document['delivery'].update(width=1080, height=1920, fps=60)
        self.timeline.write_text(json.dumps(document))
        def image(source, selected_us, target):
            target.write_bytes(b'portrait final frame')
            return {'path': str(target), 'duration_us': 2_000_000}
        with patch.object(aa, 'ending_image', side_effect=image), \
                patch.object(aa, 'probe', return_value={'duration_us': 74_210_975,
                    'video_duration_us': 74_166_667, 'video': True, 'audio': True, 'width': 1440, 'height': 2562}):
            plan, _ = self.plan()
            self.assertEqual(plan['ratio'], '9:16')
            self.assertEqual(plan['delivery']['ending_duration_us'], 2_000_000)
            self.assertEqual(plan['native_duration_us'] - plan['native_body_end_us'], 2_000_000)
            self.assertFalse(plan['delivery']['add_watermark'])
            self.assertEqual((plan['videos'][0]['width'], plan['videos'][0]['height']), (1440, 2562))
            with self.assertRaisesRegex(ValueError, 'existing absolute file'):
                aa.prepare_plan({**self.request, 'ending_audio': str(self.project / 'missing.mp3')}, str(self.drafts))

    def test_retains_original_video_bytes_and_cloud_cue_times_without_wav(self):
        plan, stage = self.plan()
        self.assertEqual(plan['subtitles'], [
            {'start_us': 123000, 'end_us': 789000, 'text': '程昭宁'},
            {'start_us': 1201000, 'end_us': 1899000, 'text': '五十二'}])
        self.assertEqual(plan['audio_mode'], 'embedded')
        self.assertNotIn('ending', plan)
        self.assertEqual(list(stage.rglob('*.wav')), [])
        for source, row in zip(self.sources, plan['videos']):
            self.assertEqual(source.read_bytes(), Path(row['path']).read_bytes())
        result, _ = self.saved(plan)
        verification = aa.verify_readback(plan, result)
        self.assertTrue(verification['source_bytes_preserved'])
        self.assertFalse(verification['subtitle_times_preserved'])
        self.assertLessEqual(verification['subtitle_timing']['max_endpoint_offset_us'], 18_000)
        self.assertFalse(verification['editor_open_verified'])
        self.assertFalse(verification['listening_verified'])

    def test_rejects_independent_audio_and_existing_draft_before_native_commands(self):
        for change in [{'audio': str(self.sources[0])}, {'audio_mode': 'independent'}]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'requires audio_mode=embedded'):
                aa.prepare_plan({**self.request, **change}, str(self.drafts))
        (self.drafts / 'AA-EP02').mkdir()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.plan()

    def test_rejects_retimed_or_discontinuous_body(self):
        document = json.loads(self.timeline.read_text())
        for field, value in [('speed', 1.01), ('source_start_us', 200), ('start_us', 20)]:
            changed = copy.deepcopy(document)
            changed['clips'][0][field] = value
            self.timeline.write_text(json.dumps(changed))
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.plan()

    def test_native_readback_rejects_muted_retimed_shifted_or_replaced_body(self):
        plan, _ = self.plan()
        for field, value in [('volume', 0), ('speed', 1.01), ('start.ms', 1000), ('source', str(self.srt))]:
            result, rows = self.saved(plan)
            rows[1]['attributes'][field] = value
            result['full'] = rows
            with self.subTest(field=field), self.assertRaises(ValueError):
                aa.verify_readback(plan, result)
        result, rows = self.saved(plan)
        rows[1]['timeline']['start.ms'] = 100
        result['full'] = rows
        with self.assertRaisesRegex(ValueError, 'measured interval'):
            aa.verify_readback(plan, result)

    def test_readback_rejects_detached_unselected_audio_or_inserted_still(self):
        plan, _ = self.plan()
        for kind in ['audio', 'video']:
            result, rows = self.saved(plan)
            rows.append({'id': 'extra', 'type': kind, 'attributes': {}})
            if kind == 'video':
                next(row for row in rows if row['id'] == 'body-track')['attributes']['segments'].append('extra')
            result['full'] = rows
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                aa.verify_readback(plan, result)

    def test_nonfinite_native_times_and_unselected_overlay_text_are_not_verified(self):
        plan, _ = self.plan()
        for value in [float('nan'), float('inf'), -1, '123', True]:
            result, rows = self.saved(plan)
            rows[1]['timeline']['start.ms'] = value
            result['full'] = rows
            with self.subTest(value=value), self.assertRaises(ValueError):
                aa.verify_readback(plan, result)
        for kind in ['video', 'text']:
            result, rows = self.saved(plan)
            rows.append({'id': 'extra-overlay', 'type': kind, 'attributes': {}})
            result['full'] = rows
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                aa.verify_readback(plan, result)

    def test_bgm_must_remain_an_independent_source_with_its_selected_gain(self):
        bgm = self.project / 'music.mp3'
        bgm.write_bytes(b'pure music fixture')
        self.request.update(bgm=str(bgm), bgm_role='music_only')
        plan, _ = self.plan()
        result, rows = self.saved(plan)
        with self.assertRaisesRegex(ValueError, 'bgm segment was not saved'):
            aa.verify_readback(plan, result)
        result['bgm_segment_id'] = 'bgm'
        rows.extend([{'id': 'bgm', 'type': 'audio',
                      'attributes': {'source': plan['bgm']['path'], 'volume': plan['audio']['bgm_gain']},
                      'timeline': {'start.ms': 0, 'duration.ms': plan['bgm']['duration_us'] / 1000}},
                     {'id': 'music-track', 'type': 'track', 'attributes': {'segments': ['bgm']}}])
        result['timeline'].append(rows[-1])
        result['full'] = rows
        self.assertTrue(aa.verify_readback(plan, result)['independent_bgm_verified'])

    def test_spelling_or_time_changes_in_saved_subtitle_are_detected(self):
        plan, _ = self.plan()
        for change in ['text', 'time']:
            result, rows = self.saved(plan)
            cue = next(row for row in rows if row['id'] == 'subtitle-0')
            if change == 'text':
                cue['attributes']['content'] = json.dumps({'text': '程招宁'})
            else:
                cue['timeline']['duration.ms'] += 30
            result['full'] = rows
            with self.subTest(change=change), self.assertRaises(ValueError):
                aa.verify_readback(plan, result)

    def test_ending_stays_after_body_with_explicit_screen_blend_and_selected_fit(self):
        config = self.project / 'project_config.json'
        config.write_text(json.dumps({'project_bible': {'visual_medium': 'photorealistic'}}))
        document = json.loads(self.timeline.read_text())
        document['delivery']['visual_medium'] = 'photorealistic'
        document['delivery'].update(width=1080, height=1920)
        document['ending_effect_fit'] = 'stretch_to_window'
        self.timeline.write_text(json.dumps(document))
        effect, sound = self.project / 'effect.mp4', self.project / 'tail.mp3'
        effect.write_bytes(b'effect video')
        sound.write_bytes(b'ending sound')
        self.request.update(ending_effect=str(effect), ending_audio=str(sound))

        def image(source, selected_us, target):
            target.write_bytes(b'last decoded frame fixture')
            return {'path': str(target), 'duration_us': 2_000_000}

        metadata = SimpleNamespace(MixModeType=SimpleNamespace(**{
            '滤色': SimpleNamespace(value=SimpleNamespace(resource_id='6758325170760323597'))}))
        with patch.object(aa, 'ending_image', side_effect=image), \
                patch.dict(sys.modules, {'pyJianYingDraft': metadata}), \
                patch.object(aa, 'probe', return_value={'duration_us': 3_400_000, 'video': True, 'audio': True,
                                                      'width': 1080, 'height': 1920}):
            plan, _ = self.plan()
        self.assertEqual(plan['ending_effect']['source_duration_us'], 3_400_000)
        self.assertEqual(plan['ending_effect']['duration_us'], 2_000_000)
        self.assertEqual(plan['ending_effect']['speed'], 1.7)
        result, rows = self.saved(plan)
        for kind, node_type, gain in [('ending', 'video', 0), ('ending_audio', 'audio', 1), ('ending_effect', 'video', 0)]:
            identifier = kind
            row = {'id': identifier, 'type': node_type,
                   'attributes': {'source': plan[kind]['path'], 'volume': gain,
                                  'speed': plan[kind].get('speed', 1)},
                   'timeline': {'start.ms': 2000, 'duration.ms': plan[kind]['duration_us'] / 1000}}
            if node_type == 'video':
                row['attributes'].update(width=plan[kind]['width'], height=plan[kind]['height'], crop=[0, 0, 1, 1])
                row['layout'] = {'position_x': 0, 'position_y': 0, 'rotation': 0, 'scale_x': 1, 'scale_y': 1}
            rows.append(row)
            key = 'ending_image_segment_id' if kind == 'ending' else kind + '_segment_id'
            result[key] = identifier
            if kind == 'ending':
                next(row for row in result['timeline'] if row['id'] == 'body-track')['attributes']['segments'].append(identifier)
            else:
                result['timeline'].append({'id': kind + '-track', 'type': 'track', 'attributes': {'segments': [identifier]}})
        result['watermark_segment_id'] = 'watermark'
        rows.append({'id': 'watermark', 'type': 'text', 'attributes': {'content': json.dumps({'text': '内容由AI生成'})},
                     'timeline': {'start.ms': 0, 'duration.ms': 4000}})
        result['events'] = [{'step': 'ending-effect-screen', 'arguments': [
            'draft', 'video', 'mix-mode', '--ref', plan['ref'], '--seg-id', 'ending_effect',
            '--resource', 'vimo://6758325170760323597', '--enable']}]
        result['full'] = rows
        self.assertTrue(aa.verify_readback(plan, result)['ending_effect_mix_mode']['command_applied'])
        result['events'] = []
        with self.assertRaisesRegex(ValueError, 'screen-blend command'):
            aa.verify_readback(plan, result)

    def test_readback_rejects_changed_canvas_crop_or_scale(self):
        plan, _ = self.plan()
        for change in ('canvas', 'crop', 'scale'):
            result, rows = self.saved(plan)
            if change == 'canvas':
                rows[0]['attributes'].update(width=1080, height=1920)
            elif change == 'crop':
                rows[1]['attributes']['crop'] = [.2, 0, .8, 1]
            else:
                rows[1]['layout']['scale_x'] = 12
            result['full'] = rows
            with self.subTest(change=change), self.assertRaises(ValueError):
                aa.verify_readback(plan, result)

    def test_native_subtitles_round_endpoints_instead_of_flooring_duration_twice(self):
        selected = aa.native_cue({'start_us': 3_060_000, 'end_us': 6_940_000, 'text': '原声'})
        self.assertEqual(selected['start_us'], 3_066_667)
        self.assertEqual(selected['end_us'], 6_933_334)
        self.assertEqual(selected['duration_us'], 3_866_667)
        with self.assertRaisesRegex(ValueError, 'shorter than one native frame'):
            aa.native_cue({'start_us': 1_000_000, 'end_us': 1_000_100, 'text': '啊'})

    def test_nonframe_body_boundaries_stay_continuous_and_subtitles_follow_source_offset(self):
        document = json.loads(self.timeline.read_text())
        document['clips'] = [{'shot': 1, 'start_us': 0, 'duration_us': 1_012_345},
                             {'shot': 2, 'start_us': 1_012_345, 'duration_us': 1_012_345}]
        document['body_end'] = 2.02469
        self.timeline.write_text(json.dumps(document))
        self.srt.write_text('1\n00:00:01,022 --> 00:00:01,100\n第二段原声\n', encoding='utf-8')
        originals = {p: aa.file_hash(p) for p in [self.timeline, self.srt, *self.sources]}
        plan, _ = self.plan()
        first, second = plan['native_videos']
        self.assertEqual(first['end_frame'], second['start_frame'])
        self.assertEqual((first['start_us'], first['duration_us']), (0, 1_000_000))
        self.assertEqual(second['end_frame'], 61)
        self.assertEqual(plan['native_subtitles'][0]['start_frame'], 30)
        self.assertEqual(plan['subtitles'][0]['start_us'], 1_022_000)
        result, rows = self.saved(plan)
        report = aa.verify_readback(plan, result)
        self.assertTrue(report['timeline_timing']['continuous_body_verified'])
        self.assertFalse(report['timeline_times_preserved'])
        self.assertFalse(report['timeline_timing']['source_retimed'])
        self.assertEqual(report['timeline_timing']['segments'][1]['requested_start_us'], 1_012_345)
        self.assertEqual(originals, {p: aa.file_hash(p) for p in originals})
        rows[2]['timeline']['start.ms'] += 34
        result['full'] = rows
        with self.assertRaises(ValueError):
            aa.verify_readback(plan, result)

    def test_nonframe_bgm_uses_native_span_and_reports_original_endpoint(self):
        bgm = self.project / 'music.mp3'
        bgm.write_bytes(b'music fixture')
        self.request.update(bgm=str(bgm), bgm_role='music_only')
        with patch.object(aa, 'probe', return_value={'duration_us': 1_012_345, 'video': True,
                                                   'audio': True, 'width': 1080, 'height': 1920}):
            plan, _ = self.plan()
        self.assertEqual(plan['bgm']['duration_us'], 1_012_345)
        self.assertEqual(plan['native_bgm']['duration_us'], 1_000_000)
        result, rows = self.saved(plan)
        result['bgm_segment_id'] = 'bgm'
        rows.append({'id': 'bgm', 'type': 'audio',
                     'attributes': {'source': plan['bgm']['path'], 'volume': plan['audio']['bgm_gain']},
                     'timeline': {'start.ms': 0, 'duration.ms': 1000}})
        result['timeline'].append({'id': 'music', 'type': 'track', 'attributes': {'segments': ['bgm']}})
        result['full'] = rows
        report = aa.verify_readback(plan, result)
        span = next(row for row in report['timeline_timing']['segments'] if row['kind'] == 'bgm')
        self.assertEqual((span['requested_end_us'], span['saved_end_us']), (1_012_345, 1_000_000))

    def test_muted_ending_effect_uses_video_stream_duration_without_aac_tail(self):
        self.project.joinpath('project_config.json').write_text(json.dumps({
            'project_bible': {'visual_medium': 'photorealistic'}}))
        document = json.loads(self.timeline.read_text())
        document['delivery']['visual_medium'] = 'photorealistic'
        document['delivery'].update(width=1080, height=1920)
        document['clips'] = [{'shot': 1, 'start_us': 0, 'duration_us': 1_012_345},
                             {'shot': 2, 'start_us': 1_012_345, 'duration_us': 1_012_345}]
        document['body_end'] = 2.02469
        self.timeline.write_text(json.dumps(document))
        effect = self.project / 'effect.mp4'
        effect.write_bytes(b'video with longer AAC tail')
        self.request['ending_effect'] = str(effect)
        sound = self.project / 'ending.mp3'
        sound.write_bytes(b'ending audio')
        self.request['ending_audio'] = str(sound)
        def image(source, selected_us, target):
            target.write_bytes(b'last frame')
            return {'path': str(target), 'duration_us': 2_000_000}
        metadata = SimpleNamespace(MixModeType=SimpleNamespace(**{
            '滤色': SimpleNamespace(value=SimpleNamespace(resource_id='6758325170760323597'))}))
        with patch.object(aa, 'ending_image', side_effect=image), \
                patch.dict(sys.modules, {'pyJianYingDraft': metadata}), \
                patch.object(aa, 'probe', return_value={'duration_us': 1_020_000,
                    'video_duration_us': 1_000_000, 'video': True, 'audio': True, 'width': 1080, 'height': 1920}):
            plan, _ = self.plan()
        self.assertEqual(plan['ending_effect']['source_duration_us'], 1_000_000)
        self.assertEqual(plan['native_ending_effect']['duration_us'], 1_000_000)
        self.assertEqual(plan['native_ending_effect']['start_us'], plan['native_body_end_us'])
        self.assertEqual(plan['native_ending']['start_frame'], 61)
        self.assertEqual(plan['native_ending_audio']['start_frame'], 61)
        self.assertEqual(plan['native_ending_audio']['end_frame'], 92)
        self.assertEqual(plan['native_duration_us'], 4_033_334)

    def test_probe_keeps_stream_duration_separate_from_container_duration(self):
        payload = {'format': {'duration': '1.020000'}, 'streams': [
            {'codec_type': 'video', 'width': 1920, 'height': 1080,
             'duration_ts': 30000, 'time_base': '1/30000'}, {'codec_type': 'audio'}]}
        self.probe.stop()
        with patch.object(aa, 'media_program', return_value='ffprobe'), \
                patch.object(aa, 'media_run', return_value=SimpleNamespace(stdout=json.dumps(payload))):
            measured = aa.probe(self.sources[0])
        self.assertEqual(measured['duration_us'], 1_020_000)
        self.assertEqual(measured['video_duration_us'], 1_000_000)

    def test_srt_keeps_numeric_dialogue_and_does_not_interpolate_times(self):
        self.srt.write_text('1\n00:00:00,111 --> 00:00:00,555\n123\n\n'
                            '2\n00:00:00,600 --> 00:00:01,789\n答案是\n42\n', encoding='utf-8-sig')
        self.assertEqual(aa.parse_subtitles(self.srt), [
            {'start_us': 111000, 'end_us': 555000, 'text': '123'},
            {'start_us': 600000, 'end_us': 1789000, 'text': '答案是\n42'}])

    def test_uri_decoding_preserves_unicode_spaces_and_drive_prefix(self):
        self.assertEqual(aa.native_source_path('local:///C:/dir%20one/%E5%8E%9F%E7%89%87.mp4'), Path('C:/dir one/原片.mp4'))
        self.assertEqual(aa.native_source_path(self.sources[0].as_uri()), self.sources[0])
        self.assertEqual(aa.native_source_path(str(self.sources[0])), self.sources[0])

    def test_a_native_deadline_targets_the_owned_process_tree(self):
        process = Mock(pid=1042)
        process.communicate.side_effect = [subprocess.TimeoutExpired(['powershell'], 1), ('', '')]
        with patch.dict(aa.os.environ, {'SystemRoot': str(self.root), 'MUSE_JIANYING_TIMEOUT_SECONDS': '4'}), \
                patch.object(aa.subprocess, 'Popen', return_value=process), \
                patch.object(aa.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as kill:
            with self.assertRaisesRegex(ValueError, 'owned process tree was terminated'):
                aa.native_run(['powershell'])
        self.assertEqual(kill.call_args.args[0][-4:], ['/PID', '1042', '/T', '/F'])
        self.assertEqual(process.communicate.call_count, 2)


if __name__ == '__main__':
    unittest.main()

"""Project draft styles and independent ending audio in saved Jianying candidates."""
import importlib.util
from copy import deepcopy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts'
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
LEGACY_STYLE = {
    'watermark': {'font_size_ui': 6},
    'subtitle': {'font_family': None, 'font_size_ui': 11,
                 'border_width_ui': 20, 'transform_y': -0.465625},
}
PROJECT_STYLE = {
    'watermark': {'font_size_ui': 7},
    'subtitle': {'font_family': '山海经', 'font_size_ui': 11,
                 'border_width_ui': 20, 'transform_y': -0.4},
}
VISUAL_STYLE = {
    'schema_version': 1, 'reference_width': 1280, 'reference_height': 720,
    'font_size_px': 40, 'outline_px': 2, 'center_y_ratio': 0.75,
    'max_width_ratio': 0.8,
}


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, 'path', [*sys.path]):
        spec.loader.exec_module(module)
    return module


class DraftStyleResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = load_module('project_draft_style_inputs', 'draft_inputs.py')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='draft-style-inputs-')
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name)
        (self.project / 'project_config.json').write_text(json.dumps({
            'project_bible': {'delivery': {'draft_style': PROJECT_STYLE}},
        }, ensure_ascii=False), encoding='utf-8')

    def test_project_supplies_style_when_timeline_has_no_style_snapshot(self):
        self.assertEqual(self.inputs.draft_style({'delivery': {}}, self.project), PROJECT_STYLE)

    def test_partial_snapshot_uses_legacy_defaults_instead_of_project_fields(self):
        expected = {**LEGACY_STYLE, 'watermark': {'font_size_ui': 8}}
        timeline = {'delivery': {'draft_style': {'watermark': {'font_size_ui': 8}}}}
        self.assertEqual(self.inputs.draft_style(timeline, self.project), expected)

    def test_empty_snapshot_keeps_legacy_defaults_despite_project_style(self):
        timeline = {'delivery': {'draft_style': {}}}
        self.assertEqual(self.inputs.draft_style(timeline, self.project), LEGACY_STYLE)

    def test_missing_project_style_keeps_legacy_defaults(self):
        (self.project / 'project_config.json').write_text('{}', encoding='utf-8')
        self.assertEqual(self.inputs.draft_style({}, self.project), LEGACY_STYLE)

    def test_common_center_only_replaces_the_default_editor_position(self):
        self.assertEqual(self.inputs.draft_style({}, self.project, center_y_ratio=0.75), PROJECT_STYLE)
        for snapshot in ({}, {'subtitle': {'font_size_ui': 13.2}},
                         {'watermark': {'font_size_ui': 8}}):
            with self.subTest(snapshot=snapshot):
                timeline = {'delivery': {'draft_style': snapshot}}
                resolved = self.inputs.draft_style(timeline, self.project, center_y_ratio=0.75)
                self.assertEqual(resolved['subtitle']['transform_y'], -0.5)
        saved = {'subtitle': {'font_size_ui': 13, 'transform_y': 0}}
        resolved = self.inputs.draft_style({'delivery': {'draft_style': saved}}, self.project,
                                         center_y_ratio=0.75)
        self.assertEqual(resolved['subtitle']['transform_y'], 0)
        self.assertEqual(resolved['subtitle']['font_size_ui'], 13)

    def test_invalid_numeric_style_fields_are_rejected(self):
        cases = (
            ('watermark', 'font_size_ui', (0, -1, 101, True, '7', float('inf'), float('nan'))),
            ('subtitle', 'font_size_ui', (0, -1, 101, False, '11', float('-inf'), float('nan'))),
            ('subtitle', 'border_width_ui', (-1, 101, True, '20', float('inf'), float('nan'))),
            ('subtitle', 'transform_y', (-1.1, 1.1, False, '-0.4', float('inf'), float('nan'))),
        )
        for kind, field, values in cases:
            for value in values:
                with self.subTest(kind=kind, field=field, value=value):
                    timeline = {'delivery': {'draft_style': {kind: {field: value}}}}
                    with self.assertRaisesRegex(ValueError, field):
                        self.inputs.draft_style(timeline, self.project)

    def test_blank_overlong_and_control_character_font_names_are_rejected(self):
        for name in ('', '   ', '字' * 129, '字体\n名称', '字体\x00名称',
                     '字体\x7f名称', '字体\u0085名称', None, True):
            with self.subTest(name=name):
                timeline = {'delivery': {'draft_style': {'subtitle': {'font_family': name}}}}
                with self.assertRaisesRegex(ValueError, 'font_family'):
                    self.inputs.draft_style(timeline, self.project)

    def test_font_name_limit_applies_after_trimming_surrounding_spaces(self):
        name = '字' * 128
        timeline = {'delivery': {'draft_style': {
            'subtitle': {'font_family': ' ' * 200 + name + ' ' * 200},
        }}}
        self.assertEqual(self.inputs.draft_style(timeline, self.project)['subtitle']['font_family'], name)


class SubtitleVisualResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = load_module('project_subtitle_visual_inputs', 'draft_inputs.py')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='subtitle-visual-inputs-')
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name)
        (self.project / 'project_config.json').write_text(json.dumps({
            'project_bible': {'delivery': {'subtitle_visual': VISUAL_STYLE}},
        }), encoding='utf-8')

    def test_missing_visual_snapshot_inherits_the_whole_project_section(self):
        self.assertEqual(self.inputs.subtitle_visual({'delivery': {}}, self.project), VISUAL_STYLE)
        self.assertIsNone(self.inputs.subtitle_visual({}))

    def test_saved_visual_section_wins_and_empty_section_disables_the_project_mapping(self):
        saved = {**VISUAL_STYLE, 'font_size_px': 48}
        self.assertEqual(self.inputs.subtitle_visual({'delivery': {'subtitle_visual': saved}},
                                                     self.project), saved)
        self.assertIsNone(self.inputs.subtitle_visual({'delivery': {'subtitle_visual': {}}}, self.project))
        with self.assertRaisesRegex(ValueError, 'reference_width'):
            self.inputs.subtitle_visual({'delivery': {'subtitle_visual': {'schema_version': 1}}}, self.project)

    def test_visual_fields_require_finite_numbers_and_exact_supported_version(self):
        cases = {
            'schema_version': (True, 0, 2, '1'),
            'reference_width': (True, 0, -1, 16384.1, '1280', float('inf'), float('nan')),
            'reference_height': (0, -1, 16384.1, float('inf')),
            'font_size_px': (False, 0, -1, 16384.1, float('nan')),
            'outline_px': (True, -1, 100.1, float('inf')),
            'center_y_ratio': (-0.01, 1.01, False, float('nan')),
            'max_width_ratio': (0, -0.01, 1.01, True, float('inf')),
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    saved = {**VISUAL_STYLE, field: value}
                    with self.assertRaisesRegex(ValueError, field):
                        self.inputs.subtitle_visual({'delivery': {'subtitle_visual': saved}})
        for section in (None, [], 'visual'):
            with self.subTest(section=section):
                with self.assertRaisesRegex(ValueError, 'subtitle_visual'):
                    self.inputs.subtitle_visual({'delivery': {'subtitle_visual': section}})

    def test_visual_font_is_trimmed_and_cannot_inject_ass_fields(self):
        saved = {**VISUAL_STYLE, 'font_family': ' Noto Sans CJK SC '}
        self.assertEqual(self.inputs.subtitle_visual({'delivery': {'subtitle_visual': saved}})['font_family'],
                         'Noto Sans CJK SC')
        for name in ('', '字' * 129, 'font,name', 'font\nname', 'font\u0085name', None, True):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'font_family'):
                    self.inputs.subtitle_visual({'delivery': {'subtitle_visual': {
                        **VISUAL_STYLE, 'font_family': name,
                    }}})

    def test_adapter_keeps_resolved_editor_typography_and_position(self):
        original = deepcopy(PROJECT_STYLE['subtitle'])
        mapped = self.inputs.draft_subtitle_visual(VISUAL_STYLE, original)
        self.assertEqual(mapped['subtitle'], {
            'font_family': '山海经', 'font_size_ui': 11, 'border_width_ui': 20,
            'transform_y': -0.4, 'auto_wrapping': False, 'max_line_width': 0.8,
        })
        self.assertEqual(original, PROJECT_STYLE['subtitle'])
        self.assertEqual(mapped['adapter']['typography_source'], 'delivery.draft_style.subtitle')
        self.assertEqual(mapped['adapter']['nominal_reference_font_size_px'], 40)
        self.assertEqual(mapped['adapter']['nominal_reference_outline_px'], 2)
        self.assertEqual(mapped['adapter']['status'], 'needs_preview')
        self.assertFalse(mapped['adapter']['gui_verified'])
        self.assertFalse(mapped['adapter']['pixel_equivalence_verified'])
        self.assertFalse(mapped['adapter']['line_width_is_fit_guarantee'])
        for center, position in ((0, 1), (0.5, 0), (1, -1)):
            with self.subTest(center=center):
                result = self.inputs.draft_subtitle_visual({**VISUAL_STYLE, 'center_y_ratio': center},
                                                          {key: value for key, value in LEGACY_STYLE['subtitle'].items()
                                                           if key != 'transform_y'})
                self.assertEqual(result['subtitle']['transform_y'], position)

    def test_visual_reference_typography_accepts_exact_upper_limits(self):
        saved = {**VISUAL_STYLE, 'reference_width': 16384, 'reference_height': 16384,
                 'font_size_px': 16384, 'outline_px': 100}
        self.assertEqual(self.inputs.subtitle_visual({'delivery': {'subtitle_visual': saved}}), saved)

    def test_visual_zero_outline_and_inclusive_center_width_endpoints_are_preserved(self):
        saved = {**VISUAL_STYLE, 'outline_px': 0, 'center_y_ratio': 1, 'max_width_ratio': 1}
        self.assertEqual(self.inputs.subtitle_visual({'delivery': {'subtitle_visual': saved}}), saved)

    def test_adapter_does_not_convert_reference_pixels_or_replace_the_editor_font(self):
        for width, height in ((480, 854), (720, 1280), (1440, 2560)):
            with self.subTest(width=width, height=height):
                visual = {**VISUAL_STYLE, 'reference_width': width, 'reference_height': height,
                          'font_size_px': 100, 'outline_px': 10, 'font_family': 'Reference font'}
                mapped = self.inputs.draft_subtitle_visual(visual, PROJECT_STYLE['subtitle'])
                self.assertEqual(mapped['subtitle']['font_size_ui'], 11)
                self.assertEqual(mapped['subtitle']['border_width_ui'], 20)
                self.assertEqual(mapped['subtitle']['font_family'], '山海经')
                self.assertEqual(mapped['adapter']['reference_font_family'], 'Reference font')


class DraftProjectStyleGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import pyJianYingDraft  # noqa: F401 - the generator imports the real library
        except ImportError as error:  # pragma: no cover - documented optional dependency
            raise unittest.SkipTest(f'pyJianYingDraft is not installed: {error}')
        for binary in ('ffmpeg', 'ffprobe'):
            if shutil.which(binary) is None:  # pragma: no cover - documented media dependency
                raise unittest.SkipTest(f'{binary} is not on PATH')
        cls.generator = load_module('project_style_draft_generator', 'jianying_draft.py')
        temporary = tempfile.TemporaryDirectory(prefix='draft-style-media-')
        cls.addClassCleanup(temporary.cleanup)
        cls.media = Path(temporary.name)
        cls.run_media('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                      'sine=frequency=440:duration=4', '-ar', '48000', '-ac', '2',
                      str(cls.media / 'dialogue.wav'))
        cls.run_media('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                      'testsrc=size=160x120:rate=24:duration=2', '-pix_fmt', 'yuv420p',
                      str(cls.media / 'body.mp4'))
        cls.run_media('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                      'color=c=black:size=160x120:rate=24:duration=2', '-f', 'lavfi', '-i',
                      'sine=frequency=880:duration=2', '-map', '0:v:0', '-map', '1:a:0',
                      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '2',
                      str(cls.media / 'ending-with-aac.mp4'))
        ending_audio = SCRIPTS.parents[1] / 'tweet-drama-background-render/assets/ending_audio.mp3'
        shutil.copy2(ending_audio, cls.media / 'ending-audio.mp3')
        probe = json.loads(cls.run_media('ffprobe', '-v', 'error', '-select_streams', 'a:0',
                                        '-show_entries', 'stream=codec_name', '-of', 'json',
                                        str(cls.media / 'ending-with-aac.mp4')))
        if probe['streams'] != [{'codec_name': 'aac'}]:
            raise AssertionError('The ending-effect fixture must contain a real AAC stream')

    @staticmethod
    def run_media(*command):
        result = subprocess.run(command, capture_output=True, text=True, check=False,
                                timeout=30, creationflags=NO_WINDOW)
        if result.returncode != 0:
            raise AssertionError(f'Media fixture command exited {result.returncode}: {result.stderr}')
        return result.stdout

    def make_candidate(self, style=None, medium='photorealistic', snapshot=None,
                       has_snapshot=False, ending_assets=False, geometry=None, visual=None,
                       snapshot_visual=None, has_visual_snapshot=False):
        temporary = tempfile.TemporaryDirectory(prefix='draft-project-style-')
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name)
        delivery = {'visual_medium': medium, 'width': 2560, 'height': 1440, 'fps': 30}
        delivery.update(geometry or {})
        project_delivery = {} if style is None else {'draft_style': style}
        if visual is not None:
            project_delivery['subtitle_visual'] = visual
        (project / 'project_config.json').write_text(json.dumps({
            'project_bible': {'visual_medium': medium, 'delivery': project_delivery},
        }, ensure_ascii=False), encoding='utf-8')
        materials = project / 'materials'
        for directory in ('01_audio', '02_media/03', '03_subtitle', '05_timeline'):
            (materials / directory).mkdir(parents=True)
        shutil.copy2(self.media / 'dialogue.wav', materials / '01_audio/03.wav')
        for shot in (1, 2):
            shutil.copy2(self.media / 'body.mp4', materials / f'02_media/03/p{shot}.mp4')
        (materials / '03_subtitle/03.srt').write_text(
            '1\n00:00:00,000 --> 00:00:02,000\n我们去看山\n\n'
            '2\n00:00:02,000 --> 00:00:04,000\n一起走吧\n', encoding='utf-8')
        if has_snapshot:
            delivery['draft_style'] = snapshot
        if has_visual_snapshot:
            delivery['subtitle_visual'] = snapshot_visual
        timeline = {'delivery': delivery, 'clips': [
            {'shot': 1, 'start_us': 0, 'duration_us': 2_000_000},
            {'shot': 2, 'start_us': 2_000_000, 'duration_us': 2_000_000},
        ]}
        (materials / '05_timeline/03.timeline.json').write_text(
            json.dumps(timeline, ensure_ascii=False), encoding='utf-8')
        if ending_assets:
            ending = materials / '06_ending'
            ending.mkdir()
            shutil.copy2(self.media / 'ending-with-aac.mp4', ending / 'ending_effect.mp4')
            shutil.copy2(self.media / 'ending-audio.mp3', ending / 'ending_audio.mp3')
        editor = project / 'editor'
        editor.mkdir()
        with patch.object(sys, 'path', [*sys.path]):
            result = self.generator.generate_draft(str(editor), str(materials),
                                                    name_prefix='样式候选-', project=str(project))
        self.assertTrue(result['success'], result)
        self.assertEqual(result['drafts_created'], 1, result)
        draft_path = Path(result['drafts'][0]['path'])
        content = json.loads((draft_path / 'draft_content.json').read_text(encoding='utf-8'))
        review = json.loads((draft_path / 'muse-review.json').read_text(encoding='utf-8'))
        timeline_path = materials / '05_timeline/03.timeline.json'
        clips = self.generator.load_edit_timeline(timeline_path)
        self.verification = {
            'clips': clips, 'audio_duration_us': 4_000_000,
            'normalized_cues': self.generator.normalize_srt(materials / '03_subtitle/03.srt'),
            'ending': self.generator.draft_ending_plan(timeline_path, clips, project),
        }
        return content, result, review

    @staticmethod
    def text_rows(content, watermark=False):
        materials = {item['id']: item for item in content['materials']['texts']}
        return [(segment, materials[segment['material_id']],
                 json.loads(materials[segment['material_id']]['content']))
                for track in content['tracks'] if track['type'] == 'text'
                and (track.get('name') == 'AI内容标识') == watermark
                for segment in track['segments']]

    def assert_subtitle_style(self, content, size=11, transform_y=-0.465625, stroke_width=0.04):
        rows = self.text_rows(content)
        self.assertEqual(len(rows), 2)
        for segment, material, text in rows:
            style = text['styles'][0]
            self.assertEqual(style['size'], size)
            self.assertNotIn('font', style)
            self.assertAlmostEqual(style['strokes'][0]['width'], stroke_width, places=6)
            self.assertEqual(style['strokes'][0]['content']['solid']['color'], [0.0, 0.0, 0.0])
            self.assertEqual(material['letter_spacing'], 0.0)
            self.assertEqual(segment['clip']['transform']['y'], transform_y)

    def test_project_style_is_saved_with_missing_font_fallback(self):
        content, result, review = self.make_candidate(style=PROJECT_STYLE)
        marks = self.text_rows(content, watermark=True)
        self.assertEqual(len(marks), 1)
        self.assertEqual(marks[0][2]['styles'][0]['size'], 7)
        self.assert_subtitle_style(content, transform_y=-0.4)
        self.assertEqual(review['draft_style'], PROJECT_STYLE)
        self.assertEqual(review['subtitle_font']['requested'], '山海经')
        self.assertEqual(review['subtitle_font']['resolved'], '剪映系统默认字体')
        self.assertEqual(review['subtitle_font']['status'], 'fallback')
        self.assertIsNone(review['subtitle_font']['resource_id'])
        for warnings in (result['warnings'], review['warnings']):
            self.assertTrue(any('山海经' in warning and '回退剪映系统默认字体' in warning
                                 for warning in warnings), warnings)

    def test_visual_adapter_serializes_a_fixed_size_single_line_without_editor_auto_wrapping(self):
        inputs = load_module('serialized_subtitle_visual_inputs', 'draft_inputs.py')
        mapped = inputs.draft_subtitle_visual(VISUAL_STYLE, LEGACY_STYLE['subtitle'])
        subtitle = mapped['subtitle']
        from pyJianYingDraft.segment import ClipSettings
        from pyJianYingDraft.text_segment import TextBorder, TextSegment, TextStyle
        from pyJianYingDraft.time_util import Timerange
        segment = TextSegment(
            '今天我们一起去看远处的大山 TEST', Timerange(0, 1_000_000),
            style=TextStyle(size=subtitle['font_size_ui'], align=1,
                            auto_wrapping=subtitle['auto_wrapping'],
                            max_line_width=subtitle['max_line_width']),
            border=TextBorder(width=subtitle['border_width_ui']),
            clip_settings=ClipSettings(transform_y=subtitle['transform_y']),
        )
        material = segment.export_material()
        content = json.loads(material['content'])
        self.assertEqual(content['styles'][0]['size'], 11)
        self.assertNotIn('font', content['styles'][0])
        self.assertAlmostEqual(content['styles'][0]['strokes'][0]['width'], 0.04)
        self.assertEqual(material['type'], 'text')
        self.assertEqual(material['line_max_width'], 0.8)
        self.assertEqual(content['text'], '今天我们一起去看远处的大山 TEST')
        self.assertNotIn('\n', content['text'])
        self.assertEqual(segment.clip_settings.transform_y, LEGACY_STYLE['subtitle']['transform_y'])

    def test_project_visual_style_overrides_only_subtitles_and_reports_unverified_adapter(self):
        content, result, review = self.make_candidate(style=PROJECT_STYLE, visual=VISUAL_STYLE)
        self.assertEqual(self.text_rows(content, watermark=True)[0][2]['styles'][0]['size'], 7)
        self.assertEqual(review['subtitle_visual'], VISUAL_STYLE)
        self.assertEqual(review['subtitle_visual_adapter']['status'], 'needs_preview')
        self.assertFalse(review['subtitle_visual_adapter']['gui_verified'])
        self.assertEqual(review['subtitle_visual_adapter']['typography_source'], 'delivery.draft_style.subtitle')
        self.assertEqual(review['subtitle_visual_adapter']['nominal_reference_font_size_px'], 40)
        self.assertEqual(review['subtitle_font']['requested'], '山海经')
        for segment, material, text in self.text_rows(content):
            self.assertNotIn('font', text['styles'][0])
            self.assertEqual(text['styles'][0]['size'], 11)
            self.assertEqual(segment['clip']['transform']['y'], -0.4)
            self.assertEqual(material['type'], 'text')
            self.assertEqual(material['line_max_width'], 0.8)
        self.assertTrue(any('山海经' in warning for warning in result['warnings']))
        self.assertTrue(any('字幕视觉适配' in warning and '未确认' in warning
                            for warning in result['warnings']), result['warnings'])
        self.assertTrue(any('不保证' in warning and '裁切' in warning for warning in result['warnings']))

    def test_empty_visual_snapshot_keeps_the_existing_draft_style(self):
        content, result, review = self.make_candidate(style=PROJECT_STYLE, visual=VISUAL_STYLE,
                                                       snapshot_visual={}, has_visual_snapshot=True)
        self.assertEqual(review['draft_style'], PROJECT_STYLE)
        self.assertNotIn('subtitle_visual_adapter', review)
        self.assert_subtitle_style(content, transform_y=-0.4)
        self.assertTrue(any('山海经' in warning for warning in result['warnings']))

    def test_saved_visual_snapshot_does_not_replace_editor_typography_with_reference_font(self):
        project = {**VISUAL_STYLE, 'font_family': 'Project reference font'}
        saved = {**VISUAL_STYLE, 'center_y_ratio': 0.6, 'max_width_ratio': 0.9,
                 'font_family': 'Saved reference font'}
        content, result, review = self.make_candidate(style=PROJECT_STYLE, visual=project,
                                                     snapshot_visual=saved, has_visual_snapshot=True)
        self.assertEqual(review['subtitle_visual'], saved)
        self.assertEqual(review['subtitle_font']['requested'], '山海经')
        self.assertEqual(review['subtitle_visual_adapter']['reference_font_family'], 'Saved reference font')
        for segment, material, text in self.text_rows(content):
            self.assertNotIn('font', text['styles'][0])
            self.assertEqual(segment['clip']['transform']['y'], -0.4)
            self.assertEqual(material['line_max_width'], 0.9)
        self.assertTrue(any('山海经' in warning for warning in result['warnings']))

    def test_visual_position_uses_the_selected_whole_draft_style_snapshot(self):
        cases = (
            ({'subtitle': {'font_size_ui': 13, 'transform_y': 0}}, 13, 0),
            ({'watermark': {'font_size_ui': 8}}, 11, -0.5),
            ({}, 11, -0.5),
        )
        for snapshot, size, position in cases:
            with self.subTest(snapshot=snapshot):
                content, _result, review = self.make_candidate(style=PROJECT_STYLE, visual=VISUAL_STYLE,
                                                               snapshot=snapshot, has_snapshot=True)
                self.assert_subtitle_style(content, size=size, transform_y=position)
                self.assertEqual(review['draft_style']['subtitle']['transform_y'], position)
                self.generator.verify_draft_delivery(content, **self.verification)

    def test_visual_style_does_not_multiply_editor_ui_by_the_actual_canvas_height(self):
        style = {'subtitle': {'font_size_ui': 13, 'border_width_ui': 25}}
        for width, height in ((480, 854), (720, 1280), (1440, 2560)):
            with self.subTest(width=width, height=height):
                content, _result, review = self.make_candidate(style=style, visual=VISUAL_STYLE,
                                                              geometry={'width': width, 'height': height})
                self.assert_subtitle_style(content, size=13, transform_y=-0.5, stroke_width=0.05)
                self.assertFalse(review['subtitle_visual_adapter']['pixel_equivalence_verified'])

    def test_unconfigured_editor_typography_keeps_legacy_ui_and_only_warns(self):
        content, result, review = self.make_candidate(visual=VISUAL_STYLE)
        self.assertTrue(result['success'])
        self.assert_subtitle_style(content, transform_y=-0.5)
        self.assertEqual(review['subtitle_font']['status'], 'default')
        self.assertTrue(any('旧默认' in warning and '预览' in warning for warning in result['warnings']))

    def test_no_visual_section_keeps_the_complete_legacy_subtitle_path(self):
        content, result, review = self.make_candidate()
        self.assertEqual(review['draft_style'], LEGACY_STYLE)
        self.assertNotIn('subtitle_visual', review)
        self.assertNotIn('subtitle_visual_adapter', review)
        self.assert_subtitle_style(content)
        for _segment, material, _text in self.text_rows(content):
            self.assertEqual(material['type'], 'subtitle')
            self.assertEqual(material['line_max_width'], 0.82)
        self.assertFalse(any('字幕视觉适配' in warning for warning in result['warnings']))

    def test_visual_readback_observes_editor_wrapping_and_available_width(self):
        content, _result, _review = self.make_candidate(visual=VISUAL_STYLE)
        self.generator.verify_draft_delivery(content, **self.verification)
        for field, value, message in (('type', 'subtitle', '自动换行'),
                                      ('line_max_width', 1, '最大行宽')):
            with self.subTest(field=field):
                changed = deepcopy(content)
                _segment, material, _text = self.text_rows(changed)[0]
                material[field] = value
                with self.assertRaisesRegex(self.generator.DraftInputError, message):
                    self.generator.verify_draft_delivery(changed, **self.verification)

    def test_empty_snapshot_preserves_legacy_style_and_ignores_project_font(self):
        content, result, _review = self.make_candidate(style=PROJECT_STYLE,
                                                       snapshot={}, has_snapshot=True)
        self.assertEqual(self.text_rows(content, watermark=True)[0][2]['styles'][0]['size'], 6)
        self.assert_subtitle_style(content)
        self.assertFalse(any('山海经' in warning for warning in result['warnings']))

    def test_animation_keeps_body_only_and_applies_its_subtitle_style(self):
        style = {'watermark': {'font_size_ui': 7},
                 'subtitle': {'font_size_ui': 13, 'border_width_ui': 25}}
        content, _result, _review = self.make_candidate(style=style, medium='animation_3d',
                                                       ending_assets=True)
        self.assertEqual(content['duration'], 4_000_000)
        self.assertFalse({'AI内容标识', '片尾音', '片尾特效'} &
                         {track.get('name') for track in content['tracks']})
        self.assert_subtitle_style(content, size=13, stroke_width=0.05)

    def test_aac_ending_video_is_muted_and_independent_ending_audio_is_unity(self):
        content, _result, _review = self.make_candidate(ending_assets=True)
        tracks = {track.get('name'): track for track in content['tracks']}
        effect = tracks['片尾特效']['segments']
        audio = tracks['片尾音']['segments']
        self.assertEqual(len(effect), 1)
        self.assertEqual(len(audio), 1)
        self.assertEqual(effect[0]['volume'], 0.0)
        self.assertEqual(audio[0]['volume'], 1.0)
        self.assertEqual(effect[0]['target_timerange']['start'], 4_000_000)
        self.assertEqual(audio[0]['target_timerange']['start'], 4_000_000)
        self.assertGreater(effect[0]['target_timerange']['duration'], 0)
        self.assertGreater(audio[0]['target_timerange']['duration'], 0)
        self.generator.verify_draft_delivery(content, **self.verification)
        effect[0]['volume'] = 1
        with self.assertRaisesRegex(self.generator.DraftInputError, '片尾覆盖视频须静音'):
            self.generator.verify_draft_delivery(content, **self.verification)

    def test_style_verification_observes_changed_font_id_subtitle_size_and_watermark(self):
        font = next(item for item in self.generator.draft.FontType if not item.value.is_vip)
        content, _result, review = self.make_candidate(style={'subtitle': {'font_family': font.name}})
        self.assertEqual(review['subtitle_font']['status'], 'reference_unverified')
        self.assertEqual(review['subtitle_font']['resource_id'], font.value.resource_id)
        self.generator.verify_draft_delivery(content, **self.verification)
        cases = ((False, 'font_id', '字体资源引用'),
                 (False, 'size', '字幕字号'),
                 (True, 'size', 'AI 内容标识'))
        for watermark, field, message in cases:
            with self.subTest(field=field, watermark=watermark):
                changed = deepcopy(content)
                _segment, material, text = self.text_rows(changed, watermark=watermark)[0]
                if field == 'font_id':
                    text['styles'][0]['font']['id'] = 'different-font-resource'
                else:
                    text['styles'][0]['size'] = 99
                material['content'] = json.dumps(text, ensure_ascii=False)
                with self.assertRaisesRegex(self.generator.DraftInputError, message):
                    self.generator.verify_draft_delivery(changed, **self.verification)

    def test_font_choice_reports_default_unknown_vip_and_free_resource_evidence(self):
        default = self.generator.draft_font_choice(None)
        self.assertEqual(default, {'requested': None, 'resolved': '剪映系统默认字体',
                                   'resource_id': None, 'status': 'default', 'warnings': []})
        vip = next(item for item in self.generator.draft.FontType if item.value.is_vip)
        for name, reason in (('山海经', '不在当前打包字体目录'), (vip.name, '会员资源')):
            with self.subTest(font=name):
                choice = self.generator.draft_font_choice(name)
                self.assertEqual(choice['requested'], name)
                self.assertEqual(choice['resolved'], '剪映系统默认字体')
                self.assertEqual(choice['status'], 'fallback')
                self.assertIsNone(choice['resource_id'])
                self.assertTrue(any(reason in warning and '回退剪映系统默认字体' in warning
                                    for warning in choice['warnings']), choice)
        free = next(item for item in self.generator.draft.FontType if not item.value.is_vip)
        choice = self.generator.draft_font_choice(free.name)
        self.assertEqual(choice['requested'], free.name)
        self.assertEqual(choice['resolved'], free.value.name)
        self.assertEqual(choice['resource_id'], free.value.resource_id)
        self.assertEqual(choice['status'], 'reference_unverified')
        self.assertTrue(any('尚未验证本机资源可用性或使用许可' in warning and '未下载字体' in warning
                            for warning in choice['warnings']), choice)

    def test_ui7_watermark_uses_estimated_safe_layout_on_landscape_and_portrait_canvases(self):
        for width, height in ((2560, 1440), (1440, 2560)):
            with self.subTest(width=width, height=height):
                content, result, _review = self.make_candidate(
                    style={'watermark': {'font_size_ui': 7}},
                    geometry={'width': width, 'height': height})
                segment, _material, text = self.text_rows(content, watermark=True)[0]
                self.assertEqual(content['canvas_config']['width'], width)
                self.assertEqual(content['canvas_config']['height'], height)
                self.assertEqual(text['styles'][0]['size'], 7)
                transform = segment['clip']['transform']
                estimated_width = len(text['text']) * 44 * height / 1920 * 7 / 6
                self.assertGreater(transform['x'], 0)
                self.assertLessEqual(transform['x'] + estimated_width / width, 0.900001)
                self.assertGreaterEqual(transform['x'] - estimated_width / width, -0.9)
                self.assertEqual(transform['y'], -0.8625)
                self.assertFalse(any('估算宽度超过画布安全区域' in warning
                                     for warning in result['warnings']))

    def test_oversized_watermark_is_retained_with_a_review_warning(self):
        content, result, review = self.make_candidate(
            style={'watermark': {'font_size_ui': 100}},
            geometry={'width': 1440, 'height': 2560})
        segment, _material, text = self.text_rows(content, watermark=True)[0]
        self.assertEqual(text['styles'][0]['size'], 100)
        self.assertEqual(review['draft_style']['watermark']['font_size_ui'], 100)
        self.assertEqual(segment['clip']['transform']['x'], 0.0)
        self.assertEqual(result['quality'], 'needs_review')
        self.assertEqual(review['status'], 'needs_review')
        for warnings in (result['warnings'], review['warnings']):
            self.assertTrue(any('估算宽度超过画布安全区域' in warning and '保留项目字号' in warning
                                for warning in warnings), warnings)


if __name__ == '__main__':
    unittest.main()

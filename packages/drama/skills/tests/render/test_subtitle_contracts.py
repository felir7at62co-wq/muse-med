"""The two subtitle contracts: the burned ASS and the Jianying draft, plus their watermarks.

Offline checks; all synthetic files stay in a temporary directory.
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[2]
SKILLS = PACKAGE / 'skills'
DRAFT = SKILLS / 'tweet-drama-draft-build'
RENDER = SKILLS / 'tweet-drama-background-render'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BurnedSubtitleContractTests(unittest.TestCase):
    """`render_episode.py` burns the delivery style; these are the values it writes."""

    def setUp(self):
        self.render = load('render_contract_test', RENDER / 'scripts/render_episode.py')

    def style_line(self, text):
        return next(line for line in text.splitlines() if line.startswith('Style: Default,'))

    def write_ass(self, srt_text='1\n00:00:00,000 --> 00:00:01,000\n简体字幕\n'):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        srt, ass = Path(temporary.name) / 'a.srt', Path(temporary.name) / 'a.ass'
        srt.write_text(srt_text, encoding='utf-8')
        self.render.write_ass(srt, ass)
        return ass.read_text(encoding='utf-8-sig')

    def test_outline_is_derived_from_the_delivered_width_not_fixed(self):
        # The style line carries an ASS field in canvas units; the delivered width is
        # what the picture must show, and libass scales one into the other.
        self.assertEqual(self.render.SUBTITLE_OUTLINE_TARGET_PX, 7)
        self.assertEqual(self.render.ass_outline(7, 1920, 2560), 5)
        self.assertEqual(self.render.ass_outline(7, 1920, 1920), 7)
        self.assertEqual(self.render.ass_outline(7, 1920, 3840), 4)
        fields = self.style_line(self.write_ass()).split(',')
        self.assertEqual(fields[16], str(self.render.ass_outline(7, 1920, 2560)))

    def test_header_scales_the_outline_so_the_derivation_holds(self):
        text = self.write_ass()
        self.assertIn('ScaledBorderAndShadow: yes', text)
        self.assertIn('PlayResX: 1080', text)
        self.assertIn('PlayResY: 1920', text)
        self.assertIn(',1,5,0,2,40,40,520,1', self.style_line(text))

    def test_burn_chain_regularizes_the_rate_after_the_subtitles(self):
        chain = self.render.subtitle_filter(Path('display.ass'))
        burn = chain.index('ass=')
        self.assertGreater(chain.index('fps=60'), burn)
        self.assertGreater(chain.index('setpts=N/(60*TB)'), chain.index('fps=60'))
        self.assertTrue(chain.endswith('scale=1440:2560:flags=lanczos,fps=60,setpts=N/(60*TB)'))

    def test_ai_mark_is_written_once_in_the_bottom_right_and_nothing_top_right(self):
        text = self.write_ass()
        marks = [line for line in text.splitlines()
                 if line.startswith('Dialogue:') and '内容由AI生成' in line]
        self.assertEqual(len(marks), 1)
        self.assertIn('{\\an3\\pos(1025,1810)}', marks[0])
        x, y = 1025, 1810
        self.assertGreater(x, self.render.DESIGN_WIDTH / 2)
        self.assertGreater(y, self.render.DESIGN_HEIGHT / 2)
        self.assertNotIn('内容纯属虚构', text)
        self.assertNotIn('请勿带入现实', text)
        self.assertNotIn('drawtext', self.render.subtitle_filter(Path('display.ass')))

    def test_decode_probe_counts_decoded_frames_not_the_exit_code(self):
        outcome = type('Outcome', (), {'returncode': 0, 'stderr': '[Parsed_showinfo_0 @ 0x1] n:   0 pts: 0\n'})()
        with patch.object(self.render.subprocess, 'run', return_value=outcome) as run:
            self.assertEqual(self.render.decode_frames_at(Path('out.mp4'), 116.633), 1)
        self.assertIn('-ss', run.call_args.args[0])
        self.assertIn('showinfo', run.call_args.args[0])

    def test_a_delivery_with_no_decodable_tail_is_refused(self):
        with patch.object(self.render, 'decode_frames_at', side_effect=[2, 2, 0]):
            with self.assertRaisesRegex(RuntimeError, 'decoded no frame at 尾'):
                self.render.assert_decodes_throughout(Path('out.mp4'), 116.733332)

    def test_a_delivery_that_decodes_throughout_passes(self):
        with patch.object(self.render, 'decode_frames_at', side_effect=[2, 2, 2]) as probe:
            self.render.assert_decodes_throughout(Path('out.mp4'), 116.733332)
        self.assertEqual([round(call.args[1], 3) for call in probe.call_args_list], [0.05, 58.367, 116.633])


class DraftSubtitleContractTests(unittest.TestCase):
    """`jianying_draft.py` authors the draft style in Jianying UI units."""

    def setUp(self):
        self.draft = load('draft_contract_test', DRAFT / 'scripts/jianying_draft.py')

    def test_authored_values_are_the_ui_units_the_style_spec_states(self):
        self.assertEqual(self.draft.SUBTITLE_FONT_SIZE, 11.0)
        self.assertEqual(self.draft.SUBTITLE_LETTER_SPACING, 0)
        self.assertEqual(self.draft.SUBTITLE_BORDER_UI_WIDTH, 20.0)
        self.assertEqual(self.draft.SUBTITLE_BORDER_COLOR, (0.0, 0.0, 0.0))
        # The draft and the FFmpeg delivery are separate contracts: neither side may
        # borrow the other's numbers.
        self.assertNotEqual(self.draft.SUBTITLE_FONT_SIZE, 68)
        self.assertNotIn('SUBTITLE_OUTLINE', dir(self.draft))

    def test_the_draft_file_values_are_the_ui_values_pyjianyingdraft_writes(self):
        try:
            from pyJianYingDraft.segment import ClipSettings
            from pyJianYingDraft.text_segment import TextBorder, TextSegment, TextStyle
            from pyJianYingDraft.time_util import Timerange
        except ImportError as error:  # pragma: no cover - the library is optional
            self.skipTest(f'pyJianYingDraft is not installed: {error}')
        reference = TextSegment(
            '字幕样式', Timerange(0, 500000),
            style=TextStyle(size=self.draft.SUBTITLE_FONT_SIZE, bold=False,
                            letter_spacing=self.draft.SUBTITLE_LETTER_SPACING,
                            color=(1.0, 1.0, 1.0), align=1, auto_wrapping=True),
            clip_settings=ClipSettings(transform_y=self.draft.SUBTITLE_TRANSFORM_Y),
            border=TextBorder(alpha=1.0, color=self.draft.SUBTITLE_BORDER_COLOR,
                              width=self.draft.SUBTITLE_BORDER_UI_WIDTH),
        )
        material = reference.export_material()
        style = json.loads(material['content'])['styles'][0]
        self.assertEqual(style['size'], 11.0)
        # 20 UI units / 100 * 0.2 = 0.04 in draft_content.json (the float lands on
        # 0.04000000000000001): the unit the checked-in drafts carry, and the same
        # parameter as the style spec's "20".
        self.assertAlmostEqual(style['strokes'][0]['width'], 0.04, places=6)
        self.assertEqual(style['strokes'][0]['content']['solid']['color'], [0.0, 0.0, 0.0])
        self.assertEqual(material['letter_spacing'], 0.0)
        self.assertEqual(material['line_spacing'], 0.02)
        # No font field means the draft renders in Jianying's own default font.
        self.assertNotIn('font', style)

    def test_the_draft_adds_no_watermark_track(self):
        source = (DRAFT / 'scripts/jianying_draft.py').read_text(encoding='utf-8')
        for notice in ('内容由AI生成', '内容纯属虚构', '请勿带入现实', '水印'):
            self.assertNotIn(notice, source)
        self.assertEqual(source.count('add_track'), 0)
        self.assertEqual(source.count('字幕轨道'), 1)


class BothConsumersTests(unittest.TestCase):
    """The two subtitle styles are separate contracts; neither may borrow the other."""

    def test_draft_and_burn_styles_share_no_value(self):
        draft = load('draft_cross_test', DRAFT / 'scripts/jianying_draft.py')
        render = load('render_cross_test', RENDER / 'scripts/render_episode.py')
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        srt, ass = Path(temporary.name) / 'a.srt', Path(temporary.name) / 'a.ass'
        srt.write_text('1\n00:00:00,000 --> 00:00:01,000\n简体字幕\n', encoding='utf-8')
        render.write_ass(srt, ass)
        burned = next(line for line in ass.read_text(encoding='utf-8-sig').splitlines()
                      if line.startswith('Style: Default,'))
        fields = burned.split(',')
        # Burned subtitle: size 68 with the derived outline. Draft subtitle: size 11 in
        # Jianying UI units with its own outline parameter. Changing one side's numbers
        # must not move the other's.
        self.assertEqual(fields[2], '68')
        self.assertNotEqual(fields[2], str(int(draft.SUBTITLE_FONT_SIZE)))
        self.assertEqual(fields[16], str(render.ass_outline()))
        self.assertNotEqual(int(fields[16]), int(draft.SUBTITLE_BORDER_UI_WIDTH))
        self.assertEqual(fields[13], '-2')
        self.assertNotEqual(int(fields[13]), draft.SUBTITLE_LETTER_SPACING)


if __name__ == '__main__':
    unittest.main()

"""Offline source-to-shot checks used before free card preparation."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-core/scripts'
sys.path.insert(0, str(SCRIPTS))
from episode_coverage import speech_preflight


def shot(number, speaker, text, voice='dialogue'):
    return f'【镜头{number}】\n说话人：{speaker}\n发声类型：{voice}\n台词：{text}\n'


class SpeechPreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'episodes').mkdir()

    def run_check(self, source, authored):
        original = self.root / 'episodes/12.txt'
        script = self.root / 'authored.txt'
        original.write_text(source, encoding='utf-8')
        script.write_text(authored, encoding='utf-8')
        before = original.read_bytes(), script.read_bytes()
        result = speech_preflight(self.root, '12', script)
        self.assertEqual(before, (original.read_bytes(), script.read_bytes()))
        self.assertFalse(result['coverage_acceptance'])
        return result

    def test_preserves_vo_tail_and_rejects_omitted_sentence(self):
        result = self.run_check('12-1 院子 日 外\n人物：刘福贵\n刘福贵 VO：他认真劈完。这是一种干完活后的踏实。',
                                shot(1, '刘福贵', '他认真劈完。', 'vo'))
        self.assertEqual('failed', result['status'])
        self.assertIn('踏实', ''.join(x['source'] for x in result['changes']))

    def test_accepts_split_utterance_without_losing_identity(self):
        result = self.run_check('人物：沈天赐\n沈天赐：原来茧是这样的，从没想过。',
                                shot(1, '沈天赐', '原来茧是这样的，') + shot(2, '沈天赐', '从没想过。'))
        self.assertEqual('passed', result['status'])

    def test_accepts_performance_annotation_only_for_a_listed_character(self):
        result = self.run_check('人物：沈天赐\n沈天赐（犹豫了一下，小心翼翼地探头，紧张地问他）：多少？',
                                shot(1, '沈天赐', '多少？'))
        self.assertEqual('passed', result['status'])

    def test_emotion_speech_delivery_and_object_handling_preserve_annotated_speakers(self):
        for cue in ('不服气地辩解', '陶醉地喃喃自语', '得意忘形', '手忙脚乱地把小半块肉挂回去',
                    '压低声音嘀咕', '慌张地取下帽子', '把信递给对方后解释'):
            for brackets in (('（', '）'), ('(', ')')):
                prefix = f'沈天赐{brackets[0]}{cue}{brackets[1]}'
                with self.subTest(cue=cue, brackets=brackets):
                    result = self.run_check(f'人物：沈天赐\n{prefix}：不能吃了！',
                                            shot(1, prefix, prefix + '：不能吃了！'))
                    self.assertEqual('passed', result['status'], result)
                    self.assertEqual(result['source_speech'][0]['speaker'], '沈天赐')
                    self.assertEqual(result['source_speech'][0]['text'], '不能吃了！')

    def test_delivery_cues_do_not_override_identity_voice_or_unknown_annotation(self):
        for cue in ('少年时期，得意忘形', '假扮刘福贵，喃喃自语', 'VO，得意忘形', '未知备注',
                    '辩解“我没有”', "得意地念着'原文'", '喃喃「不要」', '笑着说“别吃”'):
            with self.subTest(cue=cue):
                result = self.run_check(f'人物：沈天赐\n沈天赐（{cue}）：不能吃了！',
                                        shot(1, '沈天赐', '不能吃了！'))
                self.assertNotEqual('passed', result['status'])
                self.assertTrue(result['pending'])

    def test_leaves_unlisted_annotation_for_review(self):
        result = self.run_check('未知身份（提醒）：等等。', shot(1, '未知身份', '等等。'))
        self.assertEqual('failed', result['status'])
        self.assertTrue(result['pending'])

    def test_explicit_voice_and_performance_normalize_source_and_shot_together(self):
        for voice in ('OS', 'VO'):
            for prefix in (f'甲 {voice}（声音发颤）', f'甲（眼眶通红）{voice}', f'甲（{voice}）（难以置信）'):
                with self.subTest(prefix=prefix):
                    result = self.run_check(f'人物：甲\n{prefix}：原文不能漏。',
                                            shot(1, prefix, f'{prefix}：原文不能漏。', voice.lower()))
                    self.assertEqual(result['status'], 'passed', result)
        with self.assertRaisesRegex(ValueError, 'OS/VO'):
            self.run_check('人物：甲\n甲 VO（声音发颤）：原文不能漏。',
                           '【镜头1】\n说话人：甲 OS（声音发颤）\n发声类型：vo\nVO：原文不能漏。')

    def test_conflicting_explicit_voice_labels_do_not_override_each_other(self):
        source = '人物：甲\n甲 OS：原文不能漏。'
        for authored in ('【镜头1】\n说话人：甲\n发声类型：os\nVO：原文不能漏。',
                         '【镜头1】\n说话人：甲\n发声类型：dialogue\nOS：原文不能漏。'):
            with self.subTest(authored=authored):
                with self.assertRaisesRegex(ValueError, 'OS/VO'):
                    self.run_check(source, authored)

    def test_rejects_speaker_replacement(self):
        result = self.run_check('刘福贵：砍完再吃。', shot(1, '沈天赐', '砍完再吃。'))
        self.assertEqual('failed', result['status'])

    def test_rejects_offscreen_speech_changed_into_dialogue(self):
        result = self.run_check('刘福贵 VO：七天过去了。', shot(1, '刘福贵', '七天过去了。'))
        self.assertEqual('failed', result['status'])

    def test_requires_review_for_ambiguous_action_speech(self):
        result = self.run_check('▲他一边铺纸一边说。', '【镜头1】\n发声类型：action\n')
        self.assertEqual('pending', result['status'])

    def test_annotated_speech_and_its_preceding_direction_are_read_without_source_edits(self):
        source = ('人物：沈天赐、刘福贵\n'
                  '▲沈天赐瘫坐在矮凳上，气喘吁吁地质问刘福贵。\n\n'
                  '沈天赐（捂着红肿发紫的肩膀吸气）：怎么会这么疼啊？\n'
                  '刘福贵（舀了一瓢水洗菜，头也不回）：今天还要挑。')
        authored = ('【镜头1】\n发声类型：dialogue\n台词：沈天赐（捂着肩膀吸气）：怎么会这么疼啊？\n'
                    '【镜头2】\n发声类型：dialogue\n台词：刘福贵：今天还要挑。')
        result = self.run_check(source, authored)
        self.assertEqual('passed', result['status'], result)
        self.assertEqual(len(result['source_speech']), 2)

    def test_normalized_annotations_do_not_hide_missing_words_or_changed_voice(self):
        source = '人物：沈天赐\n沈天赐（抹了一把汗水自言自语）：满桶跟半桶根本不是一回事。'
        for authored in (shot(1, '沈天赐', '不是一回事。'),
                         shot(1, '刘福贵', '满桶跟半桶根本不是一回事。'),
                         shot(1, '沈天赐', '满桶跟半桶根本不是一回事。', 'vo')):
            with self.subTest(authored=authored):
                self.assertEqual(self.run_check(source, authored)['status'], 'failed')

    def test_long_ascii_annotation_and_annotated_speaker_field_share_normalization(self):
        prefix = '沈天赐(捂着红肿发紫的肩膀吸气，抹了一把额头的汗水，再次缓缓扬起下巴)'
        result = self.run_check('人物：沈天赐\n' + prefix + '：今天还要挑吗？',
                                shot(1, prefix, prefix + '：今天还要挑吗？'))
        self.assertEqual(result['status'], 'passed', result)

    def test_scene_boundaries_and_embedded_speech_cannot_use_following_dialogue_as_an_override(self):
        for direction in ('▲沈天赐质问刘福贵。\n12-2 院子 日 外',
                          '▲沈天赐质问刘福贵“你骗我”。',
                          '▲沈天赐说明来路。', '▲陌生人质问刘福贵。'):
            with self.subTest(direction=direction):
                result = self.run_check('人物：沈天赐、刘福贵\n' + direction + '\n沈天赐：等等。',
                                        shot(1, '沈天赐', '等等。'))
                self.assertEqual(result['status'], 'pending', result)

    def test_does_not_pass_an_empty_source_for_a_silent_shot(self):
        with self.assertRaisesRegex(ValueError, '原文为空'):
            self.run_check('', '【镜头1】\n发声类型：action\n')

    def test_cli_fails_for_missing_text_and_never_signs_acceptance(self):
        self.run_check('刘福贵：等等。', shot(1, '刘福贵', '走吧。'))
        process = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(SCRIPTS / 'episode_coverage.py'),
                                  str(self.root), 'preflight', '12', '--script', 'authored.txt'],
                                 capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(1, process.returncode, process.stderr)
        self.assertEqual('failed', json.loads(process.stdout)['status'])
        self.assertFalse((self.root / 'shots_and_matches').exists())

    def test_cli_reports_unreadable_inputs_as_failed_json(self):
        process = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(SCRIPTS / 'episode_coverage.py'),
                                  str(self.root), 'preflight', '12', '--script', 'missing.txt'],
                                 capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(1, process.returncode, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual('failed', result['status'])
        self.assertTrue(result['reasons'])
        self.assertFalse(result['coverage_acceptance'])


if __name__ == '__main__':
    unittest.main()

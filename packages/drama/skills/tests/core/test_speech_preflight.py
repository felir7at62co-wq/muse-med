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

    def test_package_summary_and_coverage_table_are_not_a_shot_script(self):
        source = '人物：甲\n甲：刘福贵！刘福贵！'
        authored = ('## 覆盖\n| 原文行 | 落镜 |\n| 甲：刘福贵！刘福贵！ | 镜1 |\n'
                    '## 包 EP12-P1\n1. 甲转身喊。\n'
                    '## 台词落位\n| 包 | 台词 |\n| P1 | 甲：刘福贵！刘福贵！ |\n')
        with self.assertRaisesRegex(ValueError, '覆盖表和按包汇总不能代替逐镜内容'):
            self.run_check(source, authored)

    def test_markdown_shots_report_missing_repeated_short_utterance(self):
        source = '人物：甲、乙\n甲：柴劈好了。\n乙：嗯。\n甲：水挑好了。\n乙：嗯。\n甲：别老嗯。'
        authored = ('## 包 EP29-P1\n### 镜头1）\n- 台词：甲：柴劈好了。\n- 发声类型：dialogue\n'
                    '### 镜头2）\n- 台词：乙：嗯。\n- 发声类型：dialogue\n'
                    '## 包 EP29-P2\n### 镜头1）\n- 台词：甲：水挑好了。\n- 发声类型：dialogue\n'
                    '### 镜头2）\n- 台词：甲：别老嗯。\n- 发声类型：dialogue\n')
        result = self.run_check(source, authored)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual('嗯', ''.join(x['source'] for x in result['changes']))

    def test_markdown_shots_detect_repeated_vo_and_allow_split_vo(self):
        source = '人物：乙\n乙 VO：日子过去了。生活发生了变化。'
        def segment(text):
            return f'### 镜头1）\n- 台词：乙（画外音）：{text}\n- 发声类型：vo\n'
        repeated = segment('日子过去了。生活发生了变化。') * 3
        self.assertEqual(self.run_check(source, repeated)['status'], 'failed')
        split = segment('日子过去了。') + segment('生活发生了变化。')
        self.assertEqual(self.run_check(source, split)['status'], 'passed')

    def test_markdown_unnumbered_offscreen_shot_keeps_speech_separate(self):
        source = '人物：甲、接警员（VO）\n甲：喂。\n接警员 VO：收到。'
        authored = ('### 镜头1）\n- 台词：甲：喂。\n- 发声类型：dialogue\n'
                    '### 画外音镜）\n- 台词：接警员（画外音）：收到。\n- 发声类型：vo\n')
        self.assertEqual(self.run_check(source, authored)['status'], 'passed')

    def test_markdown_offscreen_reply_order_matches_source(self):
        source = '人物：甲、接警员（VO）\n接警员 VO：家里有药吗？\n甲：我回去找。'
        reply = '### 镜头1）\n- 台词：甲：我回去找。\n- 发声类型：dialogue\n'
        voice = '### 画外音镜）\n- 台词：接警员（画外音）：家里有药吗？\n- 发声类型：vo\n'
        self.assertEqual(self.run_check(source, reply + voice)['status'], 'failed')
        self.assertEqual(self.run_check(source, voice + reply)['status'], 'passed')

    def test_cli_accepts_explicit_source_file_without_project_manifest(self):
        source = self.root / 'source.txt'
        source.write_text('人物：甲\n甲：好。', encoding='utf-8')
        script = self.root / 'authored.txt'
        script.write_text(shot(1, '甲', '好。'), encoding='utf-8')
        process = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(SCRIPTS / 'episode_coverage.py'),
                                  str(self.root), 'preflight', '12', '--script', str(script), '--source', str(source)],
                                 capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)['status'], 'passed')

    def test_markdown_shots_reject_conflicting_speaker_and_voice(self):
        source = '人物：甲、乙\n甲 VO：记住。'
        for body in ('- 台词：乙（画外音）：记住。\n- 发声类型：vo',
                     '- 台词：甲：记住。\n- 发声类型：dialogue'):
            with self.subTest(body=body):
                result = self.run_check(source, '### 镜头1）\n' + body + '\n')
                self.assertEqual(result['status'], 'failed')

    def test_preflight_rejects_mixed_shot_notation(self):
        with self.assertRaisesRegex(ValueError, '混用'):
            self.run_check('人物：甲\n甲：好。', shot(1, '甲', '好。') + '### 镜头2）\n- 发声类型：action\n')

    def test_explicit_source_episode_header_must_match(self):
        source = self.root / 'source.txt'
        source.write_text('第13集\n人物：甲\n甲：好。', encoding='utf-8')
        script = self.root / 'authored.txt'
        script.write_text(shot(1, '甲', '好。'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '集号'):
            speech_preflight(self.root, '12', script, source_file=source)

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

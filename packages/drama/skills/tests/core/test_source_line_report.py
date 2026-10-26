"""Mapping authors use the same contextual classification as coverage checks."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-core/scripts'
sys.path.insert(0, str(SCRIPTS))
from episode_coverage import classify_source_lines, paid_ready, source_line_report, write_pass_records

SOURCE = ('14-1 灶房 日 内\n人物：沈天赐、刘福贵\n'
          '▲沈天赐瘫坐在矮凳上，气喘吁吁地质问刘福贵。\n'
          '沈天赐（捂着肩膀吸气）：怎么会这么疼啊？')

PERFORMANCE_CUES = ('头也不回，冷声开口', '强撑着狡辩', '转过身直视他', '嗫嚅道', '慌忙掏口袋',
                    '急得抓耳挠腮', '傻眼', '指了指灶台的大铁锅', '握住锄柄，眼神严厉')
SOUND_ACTION = '▲沈天赐举起锄头砸向泥土，“铛”的一声脆响，锄刃擦出白痕，双手震得发麻。'


class SourceLineReport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'episodes').mkdir()
        (self.root / 'shots').mkdir()
        (self.root / 'shots_and_matches').mkdir()
        self.source = self.root / 'episodes/14.txt'
        self.source.write_text(SOURCE, encoding='utf-8')
        (self.root / 'shots/EP14-9x16.md').write_text(
            '【镜头1】\n发声类型：dialogue\n台词：沈天赐：怎么会这么疼啊？\n', encoding='utf-8')
        self.write_json('episodes/manifest.json', {
            'version': 1, 'expected_episode_count': 46, 'work_scope': {'episode_ids': ['14']},
            'episodes': {'14': {'sha256': hashlib.sha256(SOURCE.encode()).hexdigest(), 'char_count': len(SOURCE)}}})

    def write_json(self, name, data):
        (self.root / name).write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

    def cli(self, *args):
        return subprocess.run([sys.executable, '-X', 'utf8', '-B', str(SCRIPTS / 'episode_coverage.py'),
                               str(self.root), *args], capture_output=True, encoding='utf-8', timeout=30, check=False)

    def files(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def mapping(self, entries):
        for row in entries:
            row['shots'] = [1]
        self.write_json('shots_and_matches/ep14-source-map.json', {
            'version': 1, 'episode': '14', 'source_sha256': hashlib.sha256(SOURCE.encode()).hexdigest(),
            'shot_script': 'shots/EP14-9x16.md', 'entries': entries})

    def test_cli_mapping_rows_can_be_accepted_without_dropping_the_contextual_direction(self):
        before = self.files()
        result = self.cli('source-lines', '14')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(before, self.files())
        self.assertFalse(report['coverage_acceptance'])
        self.assertEqual([r['source_line'] for r in report['entries']], [1, 2, 3, 4])
        self.assertEqual(report['entries'][2]['kind'], 'action')
        self.assertEqual(report['entries'][3]['speaker'], '沈天赐')
        self.mapping(report['entries'])
        accepted = self.cli('accept', '14', '--episode-only')
        self.assertEqual(accepted.returncode, 0, accepted.stderr + accepted.stdout)
        self.assertEqual(paid_ready(self.root, ['14'], episode_only=True)['status'], 'passed')

    def test_reclassification_does_not_rewrite_an_existing_map_or_acceptance(self):
        self.mapping(source_line_report(self.root, '14')['entries'])
        self.assertEqual(write_pass_records(self.root, ['14'], episode_only=True)['accept_status'], 'passed')
        before = self.files()
        self.assertEqual(self.cli('source-lines', '14').returncode, 0)
        self.assertEqual(before, self.files())

    def test_cli_performance_cues_reach_gate_without_source_edits_and_reject_a_later_speaker_change(self):
        cues = ('不服气地辩解', '陶醉地喃喃自语', '得意忘形', '手忙脚乱地把小半块肉挂回去')
        source = '14-1 灶房 日 内\n人物：沈天赐、刘福贵\n' + '\n'.join(
            f'沈天赐（{cue}）：原文第{number}句。' for number, cue in enumerate(cues, 1))
        self.source.write_text(source, encoding='utf-8')
        shot_path = self.root / 'shots/EP14-9x16.md'
        authored = '\n'.join(f'【镜头{number}】\n发声类型：dialogue\n台词：沈天赐：原文第{number}句。'
                             for number in range(1, 5))
        shot_path.write_text(authored, encoding='utf-8')
        digest = hashlib.sha256(source.encode()).hexdigest()
        self.write_json('episodes/manifest.json', {
            'version': 1, 'expected_episode_count': 46, 'work_scope': {'episode_ids': ['14']},
            'episodes': {'14': {'sha256': digest, 'char_count': len(source)}}})
        original = self.source.read_bytes()
        classified = self.cli('source-lines', '14')
        self.assertEqual(classified.returncode, 0, classified.stdout + classified.stderr)
        report = json.loads(classified.stdout)
        self.assertEqual(report['pending_lines'], [])
        self.assertEqual([row['source_text'] for row in report['entries']], source.splitlines())
        for row in report['entries']:
            row['shots'] = [max(1, row['source_line'] - 2)]
        self.write_json('shots_and_matches/ep14-source-map.json', {
            'version': 1, 'episode': '14', 'source_sha256': digest,
            'shot_script': 'shots/EP14-9x16.md', 'entries': report['entries']})
        self.assertEqual(self.cli('preflight', '14', '--script', 'shots/EP14-9x16.md').returncode, 0)
        accepted = self.cli('accept', '14', '--episode-only')
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        self.assertEqual(self.cli('gate', '14', '--episode-only').returncode, 0)
        shot_path.write_text(authored.replace('台词：沈天赐：原文第1句。', '台词：刘福贵：原文第1句。'), encoding='utf-8')
        self.assertEqual(self.cli('preflight', '14', '--script', 'shots/EP14-9x16.md').returncode, 1)
        self.assertEqual(self.cli('gate', '14', '--episode-only').returncode, 1)
        self.assertEqual(self.source.read_bytes(), original)

    def test_pending_annotated_identity_is_explained_without_recommending_source_rewrites(self):
        for cue, reason in (('未知备注', '括注尚未识别'), ('少年时期，得意忘形', '身份'), ('辩解“我没有”', '引语')):
            with self.subTest(cue=cue):
                self.source.write_text(f'人物：沈天赐\n沈天赐（{cue}）：等等。', encoding='utf-8')
                before = self.files()
                result = self.cli('source-lines', '14')
                self.assertEqual(result.returncode, 1)
                report = json.loads(result.stdout)
                self.assertIn(reason, report['entries'][1]['reason'])
                self.assertIn('不改原文凑格式', report['next'])
                self.assertEqual(before, self.files())

    def test_cli_delivery_gaze_gesture_and_quoted_impact_sound_reach_gate_with_source_intact(self):
        source = '14-1 后坡 日 外\n人物：沈天赐、刘福贵\n' + '\n'.join(
            f'沈天赐（{cue}）：原文第{number}句。' for number, cue in enumerate(PERFORMANCE_CUES, 1))
        source += '\n' + SOUND_ACTION
        self.source.write_text(source, encoding='utf-8')
        script = self.root / 'shots/EP14-9x16.md'
        script.write_text('\n'.join(
            f'【镜头{number}】\n说话人：沈天赐（{cue}）\n发声类型：dialogue\n台词：沈天赐：原文第{number}句。'
            for number, cue in enumerate(PERFORMANCE_CUES, 1)) +
            '\n【镜头10】\n发声类型：action\n动作：锄刃砸地擦出白痕，双手震麻。', encoding='utf-8')
        digest = hashlib.sha256(source.encode()).hexdigest()
        self.write_json('episodes/manifest.json', {
            'version': 1, 'expected_episode_count': 46, 'work_scope': {'episode_ids': ['14']},
            'episodes': {'14': {'sha256': digest, 'char_count': len(source)}}})
        before = self.files()
        original = self.source.read_bytes()
        classified = self.cli('source-lines', '14')
        self.assertEqual(classified.returncode, 0, classified.stdout + classified.stderr)
        report = json.loads(classified.stdout)
        self.assertEqual(report['pending_lines'], [])
        self.assertEqual([row['source_text'] for row in report['entries']], source.splitlines())
        self.assertEqual(report['entries'][-1]['kind'], 'action')
        self.assertEqual(before, self.files())
        for row in report['entries']:
            row['shots'] = [max(1, row['source_line'] - 2)]
        self.write_json('shots_and_matches/ep14-source-map.json', {
            'version': 1, 'episode': '14', 'source_sha256': digest,
            'shot_script': 'shots/EP14-9x16.md', 'entries': report['entries']})
        for args in (('preflight', '14', '--script', 'shots/EP14-9x16.md'),
                     ('accept', '14', '--episode-only'), ('gate', '14', '--episode-only')):
            result = self.cli(*args)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.source.read_bytes(), original)
        accepted = (self.root / 'shots_and_matches/ep14-coverage-acceptance.json').read_bytes()
        changed = source + '\n▲沈天赐敲出“铛”的一声，低语“别动”。'
        self.source.write_text(changed, encoding='utf-8')
        self.assertEqual(self.cli('source-lines', '14').returncode, 1)
        self.assertEqual(self.cli('gate', '14', '--episode-only').returncode, 1)
        self.assertEqual((self.root / 'shots_and_matches/ep14-coverage-acceptance.json').read_bytes(), accepted)
        self.assertEqual(self.source.read_text(encoding='utf-8'), changed)

    def test_cli_does_not_accept_a_mixed_sound_and_speech_line_mapped_as_action(self):
        source = '14-1 后坡 日 外\n人物：甲\n▲甲敲出“铛”的一声，低语“别动”。\n甲：收到。'
        self.source.write_text(source, encoding='utf-8')
        (self.root / 'shots/EP14-9x16.md').write_text(
            '【镜头1】\n发声类型：action\n动作：甲敲击泥土。\n【镜头2】\n发声类型：dialogue\n台词：甲：收到。', encoding='utf-8')
        digest = hashlib.sha256(source.encode()).hexdigest()
        self.write_json('episodes/manifest.json', {
            'version': 1, 'expected_episode_count': 46, 'work_scope': {'episode_ids': ['14']},
            'episodes': {'14': {'sha256': digest, 'char_count': len(source)}}})
        entries = classify_source_lines(source)
        entries[2]['kind'] = 'action'
        for row in entries:
            row['shots'] = [2 if row['source_line'] == 4 else 1]
        self.write_json('shots_and_matches/ep14-source-map.json', {
            'version': 1, 'episode': '14', 'source_sha256': digest,
            'shot_script': 'shots/EP14-9x16.md', 'entries': entries})
        before = self.files()
        for args in (('source-lines', '14'), ('preflight', '14', '--script', 'shots/EP14-9x16.md'),
                     ('accept', '14', '--episode-only'), ('gate', '14', '--episode-only')):
            with self.subTest(args=args):
                result = self.cli(*args)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse((self.root / 'shots_and_matches/ep14-coverage-acceptance.json').exists())
        self.assertEqual(self.files(), before)

    def test_quoted_object_sounds_preserve_action_text_for_all_supported_quote_pairs(self):
        for left, right in (('“', '”'), ('‘', '’'), ('"', '"'), ("'", "'"), ('「', '」'), ('『', '』')):
            for sound, suffix in (('铛', '的一声脆响'), ('咔嚓', '地一声'), ('砰砰', '两声')):
                text = f'▲锄刃砸向泥土，{left}{sound}{right}{suffix}，双手震得发麻。'
                with self.subTest(text=text):
                    row = classify_source_lines(text)[0]
                    self.assertEqual(row['kind'], 'action', row)
                    self.assertEqual(row['source_text'], text)
        self.assertEqual(classify_source_lines('动作：木门“砰”的一声关上，窗户“啪”地一声震响。')[0]['kind'], 'action')

    def test_sound_recognition_does_not_hide_dialogue_unknown_quotes_or_mixed_clauses(self):
        for text in ('▲甲敲出“铛”的一声，低语“别动”。', '▲甲敲出“铛”的一声，低语。',
                     '▲甲敲出“铛”的一声，乙：别动。', '▲甲敲出“铛”的一声，乙低语：别动。',
                     '▲木门砰的一声关上，甲说：别动。', '▲甲喊“砰”的一声。',
                     '▲甲张口，“啊”的一声。', '▲甲砸下去，“别动”的一声。',
                     '▲甲举起“锄头”。', "▲甲举起'锄头'。", '▲甲举起『锄头』。',
                     '▲甲砸下去，“铛”。', '▲甲砸下去，“铛\'的一声。', '▲甲敲出“未知音”的一声。',
                     "▲甲低语'别动'。", '▲甲低语『别动』。'):
            with self.subTest(text=text):
                self.assertIsNone(classify_source_lines('人物：甲、乙\n' + text)[1]['kind'])

    def test_new_performance_cues_do_not_override_voice_identity_quotes_or_unknown_actors(self):
        for prefix in ('沈天赐（少年时期，握住锄头）', '沈天赐（VO，冷声开口）', '沈天赐（假扮刘福贵，傻眼）',
                       '沈天赐（嗫嚅“我没有”）', '沈天赐（未知备注）', '陌生人（慌忙掏口袋）'):
            with self.subTest(prefix=prefix):
                self.assertIsNone(classify_source_lines(f'人物：沈天赐、刘福贵\n{prefix}：等等。')[1]['kind'])

    def test_dropping_a_classified_row_invalidates_existing_acceptance(self):
        entries = source_line_report(self.root, '14')['entries']
        self.mapping(entries)
        self.assertEqual(write_pass_records(self.root, ['14'], episode_only=True)['accept_status'], 'passed')
        self.mapping([row for row in entries if row['source_line'] != 3])
        gate = paid_ready(self.root, ['14'], episode_only=True)
        self.assertEqual(gate['status'], 'blocked')
        self.assertTrue(any('来源行 3 缺少镜头来源映射' in reason for reason in gate['reasons']))

    def test_screenplay_notation_reaches_cli_gate_and_voice_mutation_invalidates_it(self):
        source = ('14-1 小院 日 外\n人物：甲、乙\n▲甲二话不说，推开院门大喊。\n'
                  '甲（脚步不停）：我回来了！\n▲木棍砸断木板！“砰！砰！”碎屑四溅。\n'
                  '乙 VO（声音发颤）：别碰那块板。\n【下集钩子】\n乙（难以置信）OS：又弄坏了。\n【全剧终】')
        # The silent idiom is an independent physical direction; a terminal cue
        # requires its own unambiguous sentence subject.
        source = source.replace('▲甲二话不说，推开院门大喊。', '▲甲二话不说，推开院门。\n▲甲朝乙大喊。')
        self.source.write_text(source, encoding='utf-8')
        script = self.root / 'shots/EP14-9x16.md'
        authored = ('【镜头1】\n发声类型：dialogue\n台词：甲（脚步不停）：我回来了！\n'
                    '【镜头2】\n说话人：乙\n发声类型：vo\n台词：别碰那块板。\n'
                    '【镜头3】\n说话人：乙（难以置信）OS\n发声类型：os\n台词：又弄坏了。')
        script.write_text(authored, encoding='utf-8')
        digest = hashlib.sha256(source.encode()).hexdigest()
        self.write_json('episodes/manifest.json', {
            'version': 1, 'expected_episode_count': 46, 'work_scope': {'episode_ids': ['14']},
            'episodes': {'14': {'sha256': digest, 'char_count': len(source)}}})
        classified = self.cli('source-lines', '14')
        self.assertEqual(classified.returncode, 0, classified.stdout + classified.stderr)
        entries = json.loads(classified.stdout)['entries']
        for row in entries:
            row['shots'] = [1 if row['source_line'] < 7 else 2 if row['source_line'] < 9 else 3]
        self.write_json('shots_and_matches/ep14-source-map.json', {
            'version': 1, 'episode': '14', 'source_sha256': digest,
            'shot_script': 'shots/EP14-9x16.md', 'entries': entries})
        for args in (('preflight', '14', '--script', 'shots/EP14-9x16.md'),
                     ('accept', '14', '--episode-only'), ('gate', '14', '--episode-only')):
            result = self.cli(*args)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.source.read_text(encoding='utf-8'), source)
        script.write_text(authored.replace('发声类型：os', '发声类型：vo').replace('乙（难以置信）OS', '乙（难以置信）VO'), encoding='utf-8')
        before = self.files()
        for args in (('accept', '14', '--episode-only'), ('gate', '14', '--episode-only')):
            self.assertEqual(self.cli(*args).returncode, 1)
        self.assertEqual(self.files(), before)

    def test_unknown_rows_are_retained_with_pending_status_and_no_acceptance(self):
        self.source.write_text(SOURCE.replace('质问刘福贵', '说明来路'), encoding='utf-8')
        before = self.files()
        result = self.cli('source-lines', '14')
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report['pending_lines'], [3])
        self.assertEqual(len(report['entries']), 4)
        self.assertIsNone(report['entries'][2]['kind'])
        self.assertIn('reason', report['entries'][2])
        self.assertEqual(before, self.files())

    def test_blank_lines_preserve_numbering_and_exact_source_text(self):
        source = '人物：甲\n\n  ▲甲抬头。  \n甲：收到。'
        rows = classify_source_lines(source)
        self.assertEqual([row['source_line'] for row in rows], [1, 3, 4])
        self.assertEqual(rows[1]['source_text'], '  ▲甲抬头。  ')
        self.assertEqual(rows[1]['kind'], 'action')

    def test_embedded_speech_is_classified_as_speech_and_generic_offscreen_stays_pending(self):
        rows = classify_source_lines('人物：甲\n▲甲说：收到。')
        self.assertEqual((rows[1]['kind'], rows[1]['speech_text']), ('dialogue', '收到。'))
        self.source.write_text('人物：甲\n甲（画外音）：收到。', encoding='utf-8')
        report = source_line_report(self.root, '14')
        self.assertEqual(report['status'], 'pending')
        self.assertEqual(report['entries'][1]['kind'], 'offscreen')
        self.assertEqual(report['pending_lines'], [2])

    def test_source_scan_checks_the_entire_declared_assignment_without_writes(self):
        before = self.files()
        result = self.cli('source-scan')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(list(report['episodes']), ['14'])
        self.assertEqual(report['episodes']['14']['source_line_count'], 4)
        self.assertNotIn('entries', report['episodes']['14'])
        self.assertEqual(report['pending'], [])
        self.assertFalse(report['coverage_acceptance'])
        self.assertEqual(before, self.files())
        later_source = '19-1 山谷 日 外\n角色：云昭\n发声归属未标明的文字。'
        (self.root / 'episodes/19.txt').write_text(later_source, encoding='utf-8')
        manifest = json.loads((self.root / 'episodes/manifest.json').read_text(encoding='utf-8'))
        manifest['work_scope']['episode_ids'].append('19')
        manifest['episodes']['19'] = {'sha256': hashlib.sha256(later_source.encode()).hexdigest()}
        self.write_json('episodes/manifest.json', manifest)
        before = self.files()
        result = self.cli('source-scan')
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['status'], 'pending')
        self.assertEqual(list(report['episodes']), ['14', '19'])
        self.assertEqual(report['pending'][0]['episode'], '19')
        self.assertEqual(self.files(), before)
        self.source.write_text(SOURCE + '\n发声归属未标明的文字。', encoding='utf-8')
        result = self.cli('source-scan')
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['status'], 'failed')
        self.assertFalse(report['source_integrity'])
        self.assertEqual(report['pending'][0]['episode'], '14')
        self.assertEqual(report['pending'][0]['source_text'], '发声归属未标明的文字。')

    def test_structural_performance_notation_reaches_gate_across_genres(self):
        for roster, prefix in (('出场人物：云昭、陆宁', '云昭（攥紧绢帕）'),
                               ('角色：林澈、陈律', '陈律（神色肃穆）'),
                               ('登场人物：舰长、导航员', '导航员（蜷拢触须，尾鳍泛出银辉）'),
                               ('人物：Mira、Noah', 'Mira(with a weary smile)'),
                               ('人物：阿岚、守卫', '阿岚（敛去锋芒（并未拔剑））')):
            with self.subTest(prefix=prefix):
                source = f'14-1 场景 日 内\n{roster}\n{prefix}：原文不能漏。'
                self.source.write_text(source, encoding='utf-8')
                (self.root / 'shots/EP14-9x16.md').write_text(
                    f'【镜头1】\n发声类型：dialogue\n台词：{prefix}：原文不能漏。', encoding='utf-8')
                digest = hashlib.sha256(source.encode()).hexdigest()
                self.write_json('episodes/manifest.json', {
                    'version': 1, 'expected_episode_count': 46, 'work_scope': {'episode_ids': ['14']},
                    'episodes': {'14': {'sha256': digest}}})
                report = json.loads(self.cli('source-lines', '14').stdout)
                for row in report['entries']:
                    row['shots'] = [1]
                self.write_json('shots_and_matches/ep14-source-map.json', {
                    'version': 1, 'episode': '14', 'source_sha256': digest,
                    'shot_script': 'shots/EP14-9x16.md', 'entries': report['entries']})
                for args in (('preflight', '14', '--script', 'shots/EP14-9x16.md'),
                             ('accept', '14', '--episode-only'), ('gate', '14', '--episode-only')):
                    result = self.cli(*args)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.source.read_text(encoding='utf-8'), source)

    def test_cli_rejects_unsupported_arguments(self):
        for args in (('source-lines',), ('source-lines', '14', '15'),
                     ('source-lines', '14', '--episode-only'), ('source-lines', '14', '--script', 'shots.txt')):
            with self.subTest(args=args):
                self.assertEqual(self.cli(*args).returncode, 2)

    def test_cli_input_failures_are_failed_json(self):
        for content in (None, ''):
            with self.subTest(content=content):
                if content is None:
                    self.source.unlink()
                else:
                    self.source.write_text(content, encoding='utf-8')
                result = self.cli('source-lines', '14')
                self.assertEqual(result.returncode, 1)
                report = json.loads(result.stdout)
                self.assertEqual(report['status'], 'failed')
                self.assertFalse(report['coverage_acceptance'])


if __name__ == '__main__':
    unittest.main()

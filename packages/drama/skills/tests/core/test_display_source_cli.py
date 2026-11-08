"""The public coverage CLI preserves visual text and rejects unresolved speech."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-core/scripts/episode_coverage.py'
SOURCE = ('第03集\n3-1 大厅 日 内\n人物：甲、乙\n▲光幕亮起。\n【余额：20元】\n'
          '▲面板上显示“就绪”。\n甲（OS）：不能漏。\n乙（VO）：往前走。\n'
          '【3-2 走廊 日 内】\n▲光幕在走廊亮起。\n【余额：30元】\n甲：收到。\n')
SHOTS = ('【镜头1】\n画面：大厅光幕显示余额20元，面板显示就绪。\n发声类型：action\n'
         '【镜头2】\n发声类型：vo\n说话人：甲\nOS：不能漏。\n'
         '【镜头3】\n发声类型：vo\n说话人：乙\nVO：往前走。\n'
         '【镜头4】\n画面：走廊光幕亮起，显示余额30元。\n发声类型：action\n'
         '【镜头5】\n发声类型：dialogue\n台词：甲：收到。\n')


def digest(value):
    return hashlib.sha256(value).hexdigest()


class DisplaySourceCLI(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ('episodes', 'shots', 'shots_and_matches'):
            (self.root / name).mkdir()
        self.source = self.root / 'episodes/03.txt'
        self.shots = self.root / 'shots/EP03-9x16.md'
        self.mapping = self.root / 'shots_and_matches/ep03-source-map.json'
        self.acceptance = self.root / 'shots_and_matches/ep03-coverage-acceptance.json'

    def write_json(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')

    def prepare(self, source, shots):
        self.source.write_bytes(source.encode('utf-8'))
        self.shots.write_text(shots, encoding='utf-8')
        self.write_json(self.root / 'episodes/manifest.json', {
            'version': 1, 'expected_episode_count': 3, 'work_scope': {'episode_ids': ['03']},
            'episodes': {'03': {'sha256': digest(source.encode('utf-8')), 'char_count': len(source)}}})

    def files(self):
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob('*') if path.is_file()}

    def cli(self, expected_exit, *arguments):
        result = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(SCRIPT),
                                 str(self.root), *arguments], capture_output=True,
                                encoding='utf-8', timeout=30, check=False)
        self.assertEqual(result.returncode, expected_exit, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def map_rows(self, rows):
        self.write_json(self.mapping, {
            'version': 1, 'episode': '03', 'source_sha256': digest(self.source.read_bytes()),
            'shot_script': 'shots/EP03-9x16.md', 'entries': rows})

    def accept_visual_source(self):
        self.prepare(SOURCE, SHOTS)
        original = self.files()
        report = self.cli(0, 'source-lines', '03')
        self.assertEqual(self.files(), original)
        self.assertFalse(report['coverage_acceptance'])
        self.assertEqual(report['source_sha256'], digest(original['episodes/03.txt']))
        self.assertEqual([row['source_text'] for row in report['entries']], SOURCE.splitlines())
        self.assertEqual([row['source_line'] for row in report['entries']], list(range(1, 13)))
        self.assertEqual([row['kind'] for row in report['entries']],
                         ['heading', 'scene', 'scene', 'action', 'state', 'action',
                          'os', 'vo', 'scene', 'action', 'state', 'dialogue'])
        self.assertEqual([(row['speaker'], row['speech_text']) for row in report['entries']
                          if row['kind'] in {'os', 'vo', 'dialogue'}],
                         [('甲', '不能漏。'), ('乙', '往前走。'), ('甲', '收到。')])
        memberships = {7: 2, 8: 3, 12: 5}
        rows = [{**row, 'shots': [memberships.get(row['source_line'],
                                                4 if row['source_line'] >= 9 else 1)]}
                for row in report['entries']]
        self.map_rows(rows)
        self.assertEqual(self.cli(0, 'audit')['episodes']['03']['status'], 'passed')
        self.assertEqual(self.cli(0, 'accept', '03')['accept_status'], 'passed')
        self.assertEqual(self.cli(0, 'gate', '03')['status'], 'passed')
        record = json.loads(self.acceptance.read_text(encoding='utf-8'))
        self.assertEqual(record['source_sha256'], digest(original['episodes/03.txt']))
        self.assertEqual(record['source_file_sha256'], digest(original['episodes/03.txt']))
        self.assertEqual(record['mapping_sha256'], digest(self.mapping.read_bytes()))
        self.assertEqual(record['shot_sha256'], digest(self.shots.read_bytes()))
        self.assertEqual(record['source_line_count'], 12)
        self.assertEqual(record['speech_count'], 3)
        self.assertEqual(self.source.read_bytes(), original['episodes/03.txt'])
        self.assertEqual((self.root / 'episodes/manifest.json').read_bytes(),
                         original['episodes/manifest.json'])

    def test_public_cli_accepts_visual_rows_and_retains_explicit_os_vo(self):
        self.accept_visual_source()

    def test_later_speech_subtype_speaker_or_omission_invalidates_the_existing_record(self):
        self.accept_visual_source()
        original_source = self.source.read_bytes()
        accepted = self.acceptance.read_bytes()
        for changed in (SHOTS.replace('OS：不能漏。', 'VO：不能漏。'),
                        SHOTS.replace('说话人：甲\nOS：不能漏。', '说话人：乙\nOS：不能漏。'),
                        SHOTS.replace('VO：往前走。', 'VO：前进。')):
            with self.subTest(changed=changed):
                self.shots.write_text(changed, encoding='utf-8')
                self.assertEqual(self.cli(1, 'audit')['episodes']['03']['status'], 'failed')
                self.assertEqual(self.cli(1, 'accept', '03')['accept_status'], 'blocked')
                self.assertEqual(self.cli(1, 'gate', '03')['status'], 'blocked')
                self.assertEqual(self.acceptance.read_bytes(), accepted)
                self.assertEqual(self.source.read_bytes(), original_source)

    def test_bracketed_scene_blocks_prior_panel_context_at_the_exact_following_row(self):
        source = '3-1 主厅 日 内\n人物：甲\n▲光幕亮起。\n【余额：20元】\n【3-2 走廊 日 内】\n【余额：30元】\n'
        self.prepare(source, '【镜头1】\n画面：大厅光幕显示20元，随后转至走廊。\n发声类型：action\n')
        before = self.files()
        report = self.cli(1, 'source-lines', '03')
        self.assertEqual(self.files(), before)
        self.assertEqual(report['entries'][3]['kind'], 'state')
        self.assertEqual(report['entries'][4]['kind'], 'scene')
        self.assertIsNone(report['entries'][5]['kind'])
        self.assertTrue(report['entries'][5]['reason'])
        self.assertEqual(report['entries'][5]['source_text'], '【余额：30元】')
        self.assertEqual(report['pending_lines'], [6])
        rows = [{**row, 'kind': row['kind'] or 'state', 'shots': [1]}
                for row in report['entries']]
        self.map_rows(rows)
        self.assert_refused_without_writes(source)

    def assert_refused_without_writes(self, source):
        before = self.files()
        self.assertEqual(self.cli(1, 'audit')['episodes']['03']['status'], 'pending')
        self.assertEqual(self.cli(1, 'accept', '03')['accept_status'], 'blocked')
        self.assertEqual(self.cli(1, 'gate', '03')['status'], 'blocked')
        self.assertFalse(self.acceptance.exists())
        self.assertEqual(self.files(), before)
        self.assertEqual(self.source.read_bytes(), source.encode('utf-8'))

    def test_voice_unknown_fields_and_mixed_written_and_spoken_text_cannot_be_mapped_away(self):
        for unresolved, misleading_kind in (
                ('【甲（OS）：不能走。】', 'state'), ('【VO：甲：不能走。】', 'state'),
                ('【陌生人：快走。】', 'state'), ('【画外音：回来。】', 'state'),
                ('【李红大喊快跑】', 'state'), ('【“奖励已到账】', 'state'),
                ('▲屏幕上显示“出口”，甲喊道“快走”。', 'action')):
            with self.subTest(unresolved=unresolved):
                source = ('3-1 主厅 日 内\n人物：甲\n▲光幕亮起。\n' + unresolved + '\n'
                          '甲（OS）：我听见了。\n甲（VO）：继续。\n')
                self.prepare(source, '【镜头1】\n画面：光幕亮起。\n发声类型：action\n'
                             '【镜头2】\n发声类型：vo\n说话人：甲\nOS：我听见了。\n'
                             '【镜头3】\n发声类型：vo\n说话人：甲\nVO：继续。\n')
                before = self.files()
                report = self.cli(1, 'source-lines', '03')
                self.assertEqual(self.files(), before)
                self.assertEqual(report['source_sha256'], digest(source.encode('utf-8')))
                self.assertIsNone(report['entries'][3]['kind'])
                self.assertTrue(report['entries'][3]['reason'])
                self.assertEqual([row['kind'] for row in report['entries'][-2:]], ['os', 'vo'])
                rows = [{**row, 'kind': row['kind'] or misleading_kind,
                         'shots': [row['source_line'] - 3 if row['source_line'] >= 5 else 1]}
                        for row in report['entries']]
                self.map_rows(rows)
                self.assert_refused_without_writes(source)

    def test_voice_word_in_numeric_metric_and_bound_written_literal_remain_display_fields(self):
        source = ('3-1 主厅 日 内\n人物：甲\n画面：屏幕亮起。\n'
                  '【声音值：20】\n【屏幕上显示“奖励已到账”】\n')
        self.prepare(source, '【镜头1】\n画面：屏幕显示声音值20和奖励已到账。\n发声类型：action\n')
        original = self.files()
        report = self.cli(0, 'source-lines', '03')
        self.assertEqual([row['kind'] for row in report['entries']],
                         ['scene', 'scene', 'action', 'state', 'state'])
        self.assertEqual(self.files(), original)
        self.map_rows([{**row, 'shots': [1]} for row in report['entries']])
        self.assertEqual(self.cli(0, 'audit')['episodes']['03']['status'], 'passed')
        self.assertEqual(self.cli(0, 'accept', '03')['accept_status'], 'passed')
        self.assertEqual(self.cli(0, 'gate', '03')['status'], 'passed')
        self.assertEqual(self.source.read_bytes(), source.encode('utf-8'))


if __name__ == '__main__':
    unittest.main()

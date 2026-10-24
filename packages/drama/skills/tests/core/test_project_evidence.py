"""Read-only inspection distinguishes reusable evidence from final acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-project-inspect/scripts/inspect_evidence.py'
sys.path.insert(0, str(SCRIPT.parent))
from inspect_evidence import inspect_project


class EvidenceInspection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('transcript/jobs', 'transcript/raw', 'media/13', 'qa'):
            (self.root / name).mkdir(parents=True)

    def write(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return path

    def receipt(self, status='complete'):
        source = self.root / 'media/13/EP13-P2b.mp4'
        source.write_bytes(b'current source fixture')
        data = {'id': 'fixture', 'source': str(source), 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'sha256': 'a' * 64, 'stem': 'EP13-P2b', 'version': 1, 'status': status}
        self.write('transcript/jobs/EP13-P2b-v1.json', data)
        for ext in ('txt', 'srt'):
            (self.root / f'transcript/raw/EP13-P2b-v1.{ext}').write_text('fixture output', encoding='utf-8')
        self.write('transcript/raw/EP13-P2b-v1.json', [{'words': [{'text': '台词', 'start': 0, 'end': 1}]}])
        return data

    def row(self):
        return inspect_project(self.root)['transcription_receipts'][0]

    def test_matching_complete_outputs_are_candidates_without_writes(self):
        self.receipt()
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        row = self.row()
        self.assertEqual(row['next_action'], 'review_for_active_sources')
        self.assertEqual(row['timed_word_candidates'], 1)
        self.assertTrue(row['source_matches'])
        self.assertEqual(before, {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_replaced_source_does_not_reuse_completed_transcript(self):
        self.receipt()
        (self.root / 'media/13/EP13-P2b.mp4').write_bytes(b'replacement')
        self.assertEqual(self.row()['next_action'], 'stale_for_current_source')

    def test_audio_hash_does_not_substitute_for_source_hash(self):
        data = self.receipt()
        data['sha256'] = data.pop('sourceSha256')
        self.write('transcript/jobs/EP13-P2b-v1.json', data)
        self.assertEqual(self.row()['next_action'], 'inspect_receipt_format')
        self.assertIn('sourceSha256', self.row()['error'])

    def test_pending_and_unpublished_results_require_original_receipt_inspection(self):
        self.receipt('processing')
        self.assertEqual(self.row()['next_action'], 'inspect_original_receipt')
        self.receipt()
        (self.root / 'transcript/raw/EP13-P2b-v1.srt').unlink()
        self.assertEqual(self.row()['next_action'], 'inspect_original_receipt')

    def test_external_sources_and_output_paths_are_not_adopted(self):
        data = self.receipt()
        data['source'] = str(self.root.parent / 'external.mp4')
        self.write('transcript/jobs/EP13-P2b-v1.json', data)
        self.assertEqual(self.row()['next_action'], 'review_external_source')
        data = self.receipt()
        data['stem'] = '../../outside'
        self.write('transcript/jobs/EP13-P2b-v1.json', data)
        self.assertEqual(self.row()['next_action'], 'inspect_receipt_format')

    def test_missing_or_invalid_word_times_do_not_establish_a_candidate(self):
        self.receipt()
        for words in ([], [{'text': '台词', 'start': True, 'end': 1}], [{'text': '台词', 'start': 2, 'end': 1}]):
            with self.subTest(words=words):
                self.write('transcript/raw/EP13-P2b-v1.json', [{'words': words}])
                self.assertEqual(self.row()['next_action'], 'review_output_format')

    def test_malformed_receipt_does_not_hide_other_evidence(self):
        self.receipt()
        (self.root / 'transcript/jobs/broken.json').write_text('{', encoding='utf-8')
        rows = inspect_project(self.root)['transcription_receipts']
        self.assertEqual(len(rows), 2)
        self.assertTrue(any(row.get('next_action') == 'review_for_active_sources' for row in rows))
        self.assertTrue(any('error' in row for row in rows))

    def test_latest_claim_with_unchecked_voice_is_reported_without_rewriting_it(self):
        review = self.root / 'qa/EP13-review.md'
        content = '# EP13\n\n## 最新审核\n整集可交付（VO 逐字仍未听校，ASR 不可用）。\n'
        review.write_text(content, encoding='utf-8')
        issues = inspect_project(self.root)['review_issues']
        self.assertEqual([row['code'] for row in issues], ['delivery_claim_with_unchecked_audio'])
        self.assertEqual(review.read_text(encoding='utf-8'), content)
        review.write_text(content + '\n## 更正\n整集不可交付，VO 仍未听校。\n', encoding='utf-8')
        self.assertEqual(inspect_project(self.root)['review_issues'], [])

    def test_visual_pass_with_pending_voice_is_not_a_final_claim(self):
        (self.root / 'qa/EP13-review.md').write_text('## 复核\n局部画面通过，VO仍未听校，整集待验。', encoding='utf-8')
        self.assertEqual(inspect_project(self.root)['review_issues'], [])

    def test_cli_reports_findings_without_turning_them_into_a_quality_gate(self):
        (self.root / 'qa/EP13-review.md').write_text('整集可交付（VO仍未听校）。', encoding='utf-8')
        result = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(SCRIPT), str(self.root)],
                                capture_output=True, encoding='utf-8', timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['review_issues'])
        invalid = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(SCRIPT), str(self.root / 'missing')],
                                 capture_output=True, encoding='utf-8', timeout=30, check=False)
        self.assertEqual(invalid.returncode, 1)
        self.assertIn('error', json.loads(invalid.stdout))


if __name__ == '__main__':
    unittest.main()

"""The subtitle rules runner applies the vendored Jingliu rules to the shared vectors and refuses partial rules."""
import importlib.metadata
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]
RULES = PACKAGE / 'skills' / 'tweet-drama-draft-build' / 'scripts' / 'subtitle_rules'
VECTORS = json.loads((PACKAGE / 'tests' / 'fixtures' / 'subtitle_rules_vectors.json').read_text(encoding='utf-8'))


def pinned_pypinyin():
    try:
        return importlib.metadata.version('pypinyin') == '0.55.0'
    except importlib.metadata.PackageNotFoundError:
        return False


def run(directory, request):
    completed = subprocess.run([sys.executable, '-B', '-I', str(directory / 'run.py')], input=json.dumps(request).encode(),
                               capture_output=True, check=False, timeout=120)
    return completed.returncode, json.loads(completed.stdout.decode('utf-8'))


def shot(case):
    return {'key': case['name'], 'audio_sha256': case['audio_sha'], 'words': case['words'], 'lines': case['lines'],
            'names': case['names'], 'decisions': case['decisions'], 'flags': case['flags']}


class SubtitleRulesRunnerTests(unittest.TestCase):
    @unittest.skipUnless(pinned_pypinyin(), 'requires pypinyin==0.55.0')
    def test_shared_vectors_produce_the_expected_cues_and_items(self):
        for case in VECTORS['cases']:
            with self.subTest(case['name']):
                code, result = run(RULES, {'max_chars': case['max_chars'], 'space_width': VECTORS['space_width'],
                                           'shots': [shot(case)]})
                self.assertEqual(code, 0, result)
                out = result['shots'][0]
                expect = case['expect']
                self.assertEqual(out['cues'], [{key: cue[key] for key in ('start', 'end', 'text')} for cue in expect['cues']])
                self.assertEqual(out['items'], expect['items'])
                self.assertEqual(out['pending'], expect['pending'])
                for key, value in out['stats'].items():
                    self.assertEqual(value, expect['stats'][key], key)

    @unittest.skipUnless(pinned_pypinyin(), 'requires pypinyin==0.55.0')
    def test_rules_digest_covers_every_rule_file(self):
        directory = Path(tempfile.mkdtemp(prefix='muse-subtitle-rules-'))
        self.addCleanup(shutil.rmtree, directory)
        for name in ('run.py', 'subtitle_align.py', 'subtitle_cues.py'):
            shutil.copy2(RULES / name, directory / name)
        request = {'max_chars': 14, 'shots': []}
        first = run(directory, request)[1]['rules_sha256']
        self.assertRegex(first, '^[0-9a-f]{64}$')
        with (directory / 'subtitle_cues.py').open('a', encoding='utf-8') as stream:
            stream.write('\n')
        self.assertNotEqual(run(directory, request)[1]['rules_sha256'], first)

    def test_missing_rule_module_refuses_instead_of_producing_subtitles(self):
        directory = Path(tempfile.mkdtemp(prefix='muse-subtitle-rules-'))
        self.addCleanup(shutil.rmtree, directory)
        for name in ('run.py', 'subtitle_align.py'):
            shutil.copy2(RULES / name, directory / name)
        code, result = run(directory, {'max_chars': 14, 'shots': []})
        self.assertEqual(code, 3)
        self.assertEqual(result['error']['code'], 'rules_missing')
        self.assertIn('subtitle_cues.py', result['error']['message'])
        self.assertEqual(result['error']['python'], sys.executable)

    @unittest.skipIf(pinned_pypinyin(), 'requires an interpreter without the pinned pypinyin')
    def test_missing_pypinyin_names_the_interpreter(self):
        code, result = run(RULES, {'max_chars': 14, 'shots': []})
        self.assertEqual(code, 3)
        self.assertIn(result['error']['code'], ('pypinyin_missing', 'pypinyin_version'))
        self.assertEqual(result['error']['python'], sys.executable)


if __name__ == '__main__':
    unittest.main()

"""The subtitle rules runner moves JSON between Muse and the vendored Jingliu modules and refuses partial rules."""
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
REPOSITORY = PACKAGE.parents[2]


def pinned_pypinyin():
    try:
        return importlib.metadata.version('pypinyin') == '0.55.0'
    except importlib.metadata.PackageNotFoundError:
        return False


STUB_CUES = '''
def correct_words(words, lines, names):
    return [dict(word) for word in words], {"similarity": 1.0, "lines": lines, "names": list(names)}

def review_items(stats, words, audio_sha256, transcript_sha256, lines_sha256):
    return [{"id": audio_sha256[:6] + lines_sha256[:6], "kind": "doubt", "heard": words[0]["text"],
             "script": stats["lines"][0], "start": words[0]["start"], "end": words[0]["end"]}]

def apply_decisions(words, items, decisions):
    dropped = {row["id"] for row in decisions if row["action"] == "drop"}
    return [] if any(item["id"] in dropped for item in items) else words

def layout_cues(words, max_chars, space_width=1):
    return [{"start": word["start"], "end": word["end"], "text": word["text"][:max_chars]} for word in words]
'''


def run(directory, request):
    completed = subprocess.run([sys.executable, '-B', '-I', str(directory / 'run.py')], input=json.dumps(request).encode(),
                               capture_output=True, check=False, timeout=60)
    return completed.returncode, json.loads(completed.stdout.decode('utf-8'))


def request(decisions=()):
    return {'layout': {'max_chars': 14, 'space_width': 0.5}, 'shots': [{
        'key': 's1', 'identity': {'audio_sha256': 'a' * 64, 'transcript_sha256': 'b' * 64, 'lines_sha256': 'c' * 64},
        'words': [{'start': 0.1, 'end': 0.5, 'text': '林辰，', 'seg': 0}], 'lines': ['林晨'], 'names': ['林晨'],
        'decisions': list(decisions)}]}


class SubtitleRulesRunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='muse-subtitle-rules-'))
        self.addCleanup(shutil.rmtree, self.directory)
        for name in ('run.py', 'subtitle_align.py'):
            shutil.copy2(RULES / name, self.directory / name)

    def test_vendored_align_module_is_the_jingliu_bytes(self):
        source = REPOSITORY / 'services' / 'jingliu' / 'backend' / 'app' / 'subtitle_align.py'
        self.assertEqual((RULES / 'subtitle_align.py').read_bytes(), source.read_bytes())

    @unittest.skipUnless(pinned_pypinyin(), 'requires pypinyin==0.55.0')
    def test_missing_cue_module_refuses_instead_of_producing_subtitles(self):
        code, result = run(self.directory, request())
        self.assertEqual(code, 3)
        self.assertEqual(result['error']['code'], 'rules_missing')
        self.assertIn('subtitle_cues.py', result['error']['message'])
        self.assertEqual(result['error']['python'], sys.executable)

    @unittest.skipIf(pinned_pypinyin(), 'requires an interpreter without the pinned pypinyin')
    def test_missing_pypinyin_names_the_interpreter(self):
        code, result = run(self.directory, request())
        self.assertEqual(code, 3)
        self.assertIn(result['error']['code'], ('pypinyin_missing', 'pypinyin_version'))
        self.assertEqual(result['error']['python'], sys.executable)

    @unittest.skipUnless(pinned_pypinyin(), 'requires pypinyin==0.55.0')
    def test_passes_identity_decisions_and_layout_through_the_rule_modules(self):
        (self.directory / 'subtitle_cues.py').write_text(STUB_CUES, encoding='utf-8')
        code, result = run(self.directory, request())
        self.assertEqual(code, 0)
        self.assertRegex(result['rules_sha256'], '^[0-9a-f]{64}$')
        shot = result['shots'][0]
        self.assertEqual(shot['cues'], [{'start': 0.1, 'end': 0.5, 'text': '林辰，'}])
        self.assertEqual(shot['items'], [{'id': 'aaaaaacccccc', 'kind': 'doubt', 'heard': '林辰，', 'script': '林晨',
                                          'start': 0.1, 'end': 0.5, 'decided': False}])
        code, decided = run(self.directory, request([{'id': 'aaaaaacccccc', 'action': 'drop'}, {'id': 'x', 'action': 'rewrite'}]))
        self.assertEqual(code, 0)
        self.assertEqual(decided['shots'][0]['cues'], [])
        self.assertTrue(decided['shots'][0]['items'][0]['decided'])
        (self.directory / 'subtitle_cues.py').write_text(STUB_CUES + '\n', encoding='utf-8')
        self.assertNotEqual(run(self.directory, request())[1]['rules_sha256'], result['rules_sha256'])


if __name__ == '__main__':
    unittest.main()

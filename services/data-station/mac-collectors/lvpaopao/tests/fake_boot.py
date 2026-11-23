"""Fake `boot.py --prepare`: prints the prepared-helper JSON line for fake_helper.py, or a scripted error.

`scenario.json` key `prepare` is a list of outcomes consumed one per invocation (`ok` or an error code); afterwards `ok`.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
for name in ('--home', '--resources', '--lifetime-ms', '--max-callbacks'):
    parser.add_argument(name, required=True)
parser.add_argument('--prepare', action='store_true', required=True)
parser.parse_args()
scenario = json.loads((ROOT / 'scenario.json').read_text()) if (ROOT / 'scenario.json').exists() else {}
counter = ROOT / 'prepare-count'
index = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(index + 1))
outcomes = scenario.get('prepare', [])
outcome = outcomes[index] if index < len(outcomes) else 'ok'
if outcome != 'ok':
    print(json.dumps({'error': {'code': outcome}}))
    sys.exit(1)
helper = ROOT / 'fake_helper.py'
print(json.dumps({'transport': 'local', 'localPython': sys.executable, 'localHelper': str(helper),
                  'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(), 'cwd': str(ROOT), 'downloadEnabled': True}))

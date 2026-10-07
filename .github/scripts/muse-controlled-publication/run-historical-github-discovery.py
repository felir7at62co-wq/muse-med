"""Run read-only historical provider checks against the already verified final stage."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


FIXTURE_DIGESTS = {
    'stable-1.0.1/app-update.yml': '15dedb4666b379092d6a5ea3c8f6525baee53fb8061efe77d78f1b085bf1b39c',
    'stable-1.0.1/receipt.json': 'e3b2156ea1d2ce0ea6da2511ea5d8e2e26b12b0d69801dd8b51c5c7081daf7f1',
    'legacy-0.1.7-rc.8.20260930.1/app-update.yml': 'fe5cca6c84b417c8bbaab3ab0d908a383bb830690c5c300828a62b7865a13952',
    'legacy-0.1.7-rc.8.20260930.1/receipt.json': 'c0cb41011c343800f8a0ff6b7c4a6c7c8b43a51437de013f167037bb6c4cdd5e',
}


def verify_historical_fixtures(utilities):
    """Require the exact original config and receipt bytes before parsing or running Node."""
    for name, expected_digest in FIXTURE_DIGESTS.items():
        if hashlib.sha256((utilities / name).read_bytes()).hexdigest() != expected_digest:
            raise RuntimeError(f'Original historical fixture SHA-256 differs: {name}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--staged', type=Path, required=True)
    parser.add_argument('--utilities', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    utilities = arguments.utilities.resolve()
    staged = arguments.staged.resolve()
    verify_historical_fixtures(utilities)
    arguments.output.mkdir(parents=True, exist_ok=False)
    installer = staged / 'muse-med-1.0.3-win-x64.exe'
    metadata = staged / 'latest.yml'
    if not installer.is_file() or not metadata.is_file():
        raise RuntimeError('The existing exact final stage must contain Windows EXE and original latest.yml')
    with (arguments.output / 'offline-discovery-checks.log').open('w', encoding='utf-8') as stream:
        subprocess.run(['node', str(utilities / 'test-historical-update-discovery-checks.mjs')],
                       stdout=stream, stderr=subprocess.STDOUT, check=True)
    results = []
    for label in ('stable-1.0.1', 'legacy-0.1.7-rc.8.20260930.1'):
        logfile = arguments.output / f'{label}-live.log'
        with logfile.open('w', encoding='utf-8') as stream:
            result = subprocess.run([
                'node', str(utilities / 'verify-original-stable-discovery.mjs'),
                '--config', str(utilities / label / 'app-update.yml'),
                '--receipt', str(utilities / label / 'receipt.json'),
                '--metadata', str(metadata), '--installer', str(installer),
                '--expected-version', '1.0.3',
            ], stdout=stream, stderr=subprocess.STDOUT, check=False)
        results.append({'scenario': label, 'exitCode': result.returncode, 'log': logfile.name})
        print(logfile.read_text(encoding='utf-8'), end='', flush=True)
        if result.returncode:
            raise RuntimeError(f'Actual historical public discovery failed: {label}')
    receipt = {'status': 'actual-historical-provider-live-checks-passed', 'scenarios': results,
               'installersExecuted': False, 'remoteReleaseWrites': False}
    (arguments.output / 'historical-provider-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print('PASS both actual historical policies discovered genuine public Muse 1.0.3 with strict nightly controls')


if __name__ == '__main__':
    main()

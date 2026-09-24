"""Collect and verify the BGM native notice texts recorded in lock.json.

check  re-hashes this directory and compares it with lock.json; no network, no wheel cache.
fetch  re-collects every file from its recorded source (vendor HTTPS, or a locked wheel member)
       and then verifies the same bytes, so a stale or edited notice file cannot pass silently.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

RECIPE = pathlib.Path(__file__).resolve().parent
CACHE = RECIPE.parents[3] / '.local' / 'bgmprep' / 'cache'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(url):
    """Fetch a vendor text, retrying because some vendor hosts answer 403 or drop TLS per request."""
    last = None
    curl = shutil.which('curl')
    for attempt in range(3):
        request = urllib.request.Request(url, headers={'User-Agent': UA})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except (urllib.error.URLError, OSError) as error:
            last = error
            if attempt == 0:
                print(f'  urllib refused {url} ({error}); falling back to curl', file=sys.stderr)
        if curl is None:
            continue
        with tempfile.TemporaryDirectory() as work:
            target = pathlib.Path(work) / 'text'
            done = subprocess.run([curl, '-fsSL', '-A', UA, '--max-time', '120', '-o', str(target), url])
            if done.returncode == 0:
                return target.read_bytes()
            last = f'curl exit {done.returncode}'
    raise RuntimeError(f'{url}: {last}')


def read_wheel(source):
    wheel = CACHE / source['wheel']
    if not wheel.exists():
        raise RuntimeError(f'{wheel} is missing; the wheel cache is required for kind=wheel entries')
    actual = digest(wheel.read_bytes())
    if actual != source['wheel_sha256']:
        raise RuntimeError(f'{source["wheel"]} sha256 {actual} does not match the locked {source["wheel_sha256"]}')
    with zipfile.ZipFile(wheel) as archive:
        return archive.read(source['member'])


def collect(entry):
    source = entry['source']
    return download(source['url']) if source['kind'] == 'https' else read_wheel(source)


def compare(entry, data):
    problems = []
    if len(data) != entry['bytes']:
        problems.append(f'bytes {len(data)} != locked {entry["bytes"]}')
    if digest(data) != entry['sha256']:
        problems.append(f'sha256 {digest(data)} != locked {entry["sha256"]}')
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'fetch'], nargs='?', default='check')
    mode = parser.parse_args().mode
    lock = json.loads((RECIPE / 'lock.json').read_text('utf-8'))

    failures = 0
    for entry in lock['files']:
        path = RECIPE / entry['path']
        if mode == 'fetch':
            try:
                data = collect(entry)
            except Exception as error:  # vendor hosts rate-limit, redirect or refuse TLS per request
                failures += 1
                print(f'FAIL {entry["path"]}: collection failed: {error}')
                continue
            problems = compare(entry, data)
            if not problems:
                path.write_bytes(data)
        else:
            data = path.read_bytes() if path.exists() else None
            problems = ['missing file'] if data is None else compare(entry, data)
        if problems:
            failures += 1
            print(f'FAIL {entry["path"]}: {"; ".join(problems)}')
        else:
            print(f'ok   {entry["path"]}  {entry["bytes"]} bytes  {entry["sha256"]}')

    print(f'{len(lock["files"]) - failures}/{len(lock["files"])} notice files verified'
          f' ({mode}); {len(lock["not_obtained"])} vendor texts remain unobtained, see lock.json')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())

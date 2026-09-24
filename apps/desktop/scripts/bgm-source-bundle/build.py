"""Collect the pinned BGM native corresponding sources; never execute downloaded build scripts."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import urllib.parse
import urllib.request

RECIPE = Path(__file__).resolve().parent
ARCHIVE = 'muse-bgm-native-corresponding-source.tar.gz'
MAX_DOWNLOAD = 64 * 1024 * 1024
BUILD_TREE = re.compile(r'buildtrees[\\/][^\\/]+[\\/]src[\\/]([0-9a-f]{10})-')


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sha512_prefix(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha512').hexdigest()[:10]


def validate_source(item):
    name = item['name']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', name) or '..' in name:
        raise ValueError(f'Unsafe source name: {name}')
    if not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
        raise ValueError(f'Unpinned source: {name}')
    if not isinstance(item['bytes'], int) or item['bytes'] <= 0:
        raise ValueError(f'Unpinned source size: {name}')
    url = urllib.parse.urlsplit(item['url'])
    if url.scheme != 'https' or url.username or url.password:
        raise ValueError(f'Source must use anonymous HTTPS: {name}')


def read_url(url):
    """Public downloads carry no credentials or caller-provided headers."""
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'muse-source-bundle'}), timeout=90)


def build_tree_prefix(item):
    """vcpkg extracts a port into buildtrees/<port>/src/<first 10 of the source SHA-512>-<port hash>.clean."""
    recorded = item.get('build_tree_path')
    if not recorded:
        return None
    match = BUILD_TREE.search(recorded)
    if match is None:
        raise ValueError(f'Unreadable vcpkg build tree path: {item["name"]}')
    return match.group(1)


def check_source(item, path, origin):
    """Refuse a file whose bytes differ from the lock, or from the build tree the shipped DLL names."""
    path = Path(path)
    if path.stat().st_size != item['bytes'] or sha256(path) != item['sha256']:
        raise ValueError(f'{origin} checksum or size mismatch: {path}')
    prefix = build_tree_prefix(item)
    if prefix is not None and sha512_prefix(path) != prefix:
        raise ValueError(f'{origin} is not the source of the build tree in the shipped binary: {path}')


def download(item, path, inputs=None):
    """Reuse the byte-verified held copy, otherwise download once; a mismatch never publishes."""
    validate_source(item)
    path = Path(path)
    if path.exists():
        check_source(item, path, 'Cached source')
        return
    retained = Path(inputs) / item['name'] if inputs else None
    if retained is not None and retained.is_file():
        check_source(item, retained, 'Retained local copy')
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(retained, path)
        print('Reuse', item['name'], flush=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + '.partial')
    print('Download', item['name'], flush=True)
    try:
        with read_url(item['url']) as source, partial.open('wb') as target:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_DOWNLOAD:
                    raise ValueError(f'Source exceeds the {MAX_DOWNLOAD // (1024 * 1024)} MiB download limit')
                target.write(chunk)
        check_source(item, partial, 'Downloaded source')
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def collect_licenses(path, destination):
    """Copy regular license texts only; no archive links or paths escape the destination."""
    count = 0
    with tarfile.open(path) as archive:
        for member in archive:
            member_path = PurePosixPath(member.name)
            if member_path.is_absolute() or '..' in member_path.parts or '\\' in member.name or ':' in member.name:
                raise ValueError(f'Unsafe archive member: {member.name}')
            named_license = re.fullmatch(r'(COPYING|LICENSE|LICENCE|NOTICE|COPYRIGHT|AUTHORS)([._-].*)?', member_path.name, re.I)
            if not member.isfile() or not named_license:
                continue
            if member.size > 1024 * 1024:
                raise ValueError('Unexpected license size')
            target = destination / str(member_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            count += 1
    if not count:
        raise ValueError(f'No license text in source archive: {Path(path).name}')


def package(output):
    source = output / 'source'
    inventory = {p.relative_to(source).as_posix(): sha256(p) for p in sorted(source.rglob('*')) if p.is_file()}
    path = output / ARCHIVE
    with path.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name in inventory:
                info = archive.gettarinfo(source / name, arcname='source/' + name)
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mode = 0o644
                with (source / name).open('rb') as stream:
                    archive.addfile(info, stream)
    manifest = {'archive': ARCHIVE, 'sha256': sha256(path), 'files': inventory}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (output / 'SHA256SUMS').write_text(f'{sha256(path)}  {ARCHIVE}\n{sha256(output / "manifest.json")}  manifest.json\n', encoding='utf-8')


def verify(output):
    manifest = json.loads((output / 'manifest.json').read_text())
    if manifest['archive'] != ARCHIVE or sha256(output / ARCHIVE) != manifest['sha256']:
        raise ValueError('Archive checksum mismatch')
    expected = f'{manifest["sha256"]}  {ARCHIVE}\n{sha256(output / "manifest.json")}  manifest.json\n'
    if (output / 'SHA256SUMS').read_text() != expected:
        raise ValueError('Manifest checksum mismatch')
    with tarfile.open(output / ARCHIVE) as archive:
        actual = {}
        for member in archive:
            name = member.name.removeprefix('source/')
            if not member.isfile() or name not in manifest['files'] or name in actual:
                raise ValueError('Unexpected source archive member')
            actual[name] = hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest()
        if actual != manifest['files']:
            raise ValueError('Source archive inventory mismatch')
    if (output / 'source').exists():
        actual = {p.relative_to(output / 'source').as_posix(): sha256(p) for p in (output / 'source').rglob('*') if p.is_file()}
        if actual != manifest['files']:
            raise ValueError('Working source inventory mismatch')
    print('Verified', len(manifest['files']), 'source files', flush=True)


def load_lock(path=RECIPE / 'lock.json'):
    """Refuse a lock that is unpinned, duplicated, or silent about a component with no license file."""
    lock = json.loads(Path(path).read_text(encoding='utf-8'))
    if lock.get('version') != 1:
        raise ValueError('Unsupported lock version')
    names, ids = set(), set()
    for item in lock['components']:
        validate_source(item)
        if item['name'] in names or item['id'] in ids:
            raise ValueError(f'Duplicate component: {item["name"]}')
        names.add(item['name'])
        ids.add(item['id'])
        if item.get('license_files') is False and not item.get('license_reason'):
            raise ValueError(f'Component without license files records no reason: {item["name"]}')
    return lock


def retained_inputs(lock, override):
    """The held copies this checkout already verified, unless the caller names another directory."""
    directory = Path(override) if override else RECIPE / lock['retained_input_origins']['directory']
    return directory if directory.is_dir() else None


def build(output, inputs=None):
    lock = load_lock()
    output = Path(output)
    source = output / 'source'
    source.mkdir(parents=True, exist_ok=True)
    held = retained_inputs(lock, inputs)
    print('Held inputs', held if held else 'none; every component is downloaded', flush=True)
    for item in lock['components']:
        path = source / 'archives' / item['name']
        download(item, path, held)
        if item.get('license_files', True):
            collect_licenses(path, source / 'licenses' / item['id'])
    (source / 'sources.json').write_text(json.dumps(lock['components'], indent=2) + '\n', encoding='utf-8')
    shutil.copytree(RECIPE, source / 'recipe', dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    shutil.copyfile(RECIPE / 'SOURCE-NOTICES.txt', source / 'SOURCE-NOTICES.txt')
    package(output)
    verify(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['build', 'verify'])
    parser.add_argument('output', type=Path)
    parser.add_argument('--inputs', type=Path, help='Directory holding already-verified copies of the locked archives')
    args = parser.parse_args()
    if args.command == 'build':
        build(args.output.resolve(), args.inputs)
    else:
        verify(args.output.resolve())

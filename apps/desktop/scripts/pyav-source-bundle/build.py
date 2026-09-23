"""Collect pinned PyAV vendor sources; never execute downloaded build scripts."""
import argparse
import ast
import hashlib
import gzip
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import urllib.parse
import urllib.request

RECIPE = Path(__file__).resolve().parent
ARCHIVE = 'pyav-18.1.0-windows-vendor-sources.tar.gz'
MAX_DOWNLOAD = 512 * 1024 * 1024


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_source(item):
    name = item['name']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', name) or '..' in name:
        raise ValueError(f'Unsafe source name: {name}')
    if not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
        raise ValueError(f'Unpinned source: {name}')
    if urllib.parse.urlsplit(item['url']).scheme != 'https':
        raise ValueError(f'Source must use HTTPS: {name}')


def read_url(url):
    """Public downloads carry no credentials or caller-provided headers."""
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'muse-source-bundle'}), timeout=90)


def download(item, path):
    validate_source(item)
    if path.exists():
        if sha256(path) != item['sha256']:
            raise ValueError(f'Cached source checksum mismatch: {path}')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    retained = RECIPE / 'inputs' / item['name']
    if retained.exists():
        if sha256(retained) != item['sha256']:
            raise ValueError(f'Retained upstream input checksum mismatch: {retained}')
        shutil.copyfile(retained, path)
        return
    partial = path.with_name(path.name + '.partial')
    print('Download', item['name'], flush=True)
    try:
        with read_url(item['url']) as source, partial.open('wb') as target:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_DOWNLOAD:
                    raise ValueError('Source exceeds 512 MiB download limit')
                target.write(chunk)
        if sha256(partial) != item['sha256']:
            raise ValueError(f'Source checksum mismatch: {item["name"]}')
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def vendor_sources(text):
    """Read literal source descriptors from the pinned Python AST, not its executable code."""
    found = []
    for node in ast.walk(ast.parse(text)):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != 'Package':
            continue
        values = {kw.arg: ast.literal_eval(kw.value) for kw in node.keywords
                  if kw.arg in ('source_url', 'source_filename', 'sha256')}
        url = values['source_url'].replace('http://deb.debian.org/', 'https://deb.debian.org/')
        item = {'name': values.get('source_filename') or url.rsplit('/', 1)[-1],
                'url': url, 'sha256': values['sha256']}
        validate_source(item)
        found.append(item)
    if not found or len({item['name'] for item in found}) != len(found):
        raise ValueError('Empty or duplicate vendor source inventory')
    return found


def archive_text(path, suffix):
    with tarfile.open(path) as archive:
        matches = [m for m in archive if m.isfile() and m.name.endswith('/' + suffix)]
        if len(matches) != 1 or matches[0].size > 1024 * 1024:
            raise ValueError(f'Expected one small archive file: {suffix}')
        return archive.extractfile(matches[0]).read().decode('utf-8')


def collect_licenses(path, destination, embedded_suffix=None):
    """Copy regular license texts only; no archive links or paths escape the destination."""
    count = 0
    with tarfile.open(path) as archive:
        for member in archive:
            p = PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or '\\' in member.name or ':' in member.name:
                raise ValueError(f'Unsafe archive member: {member.name}')
            named_license = re.fullmatch(r'(COPYING|LICENSE|LICENCE|NOTICE|COPYRIGHT|AUTHORS)([._-].*)?', p.name, re.I)
            if not member.isfile() or not (named_license or (embedded_suffix and p.suffix == embedded_suffix)):
                continue
            if member.size > 1024 * 1024:
                raise ValueError('Unexpected license size')
            target = destination / str(p)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            count += 1
    if not count:
        raise ValueError(f'No license text in source archive: {path.name}')


def recipe_files(item, destination):
    """Keep each exact MSYS2 package directory, verifying the Git blob identities."""
    if not re.fullmatch(r'[a-f0-9]{40}', item['commit']) or not re.fullmatch(r'mingw-w64-[a-z0-9-]+', item['name']):
        raise ValueError('Invalid MSYS2 recipe identity')
    destination.mkdir(parents=True, exist_ok=True)
    index = destination / 'git-files.json'
    if index.exists():
        rows = json.loads(index.read_text())
    else:
        url = f'https://api.github.com/repos/msys2/MINGW-packages/contents/{item["name"]}?ref={item["commit"]}'
        with read_url(url) as response:
            rows = [{'name': r['name'], 'sha': r['sha'], 'type': r['type']} for r in json.load(response)]
        index.write_text(json.dumps(rows, indent=2) + '\n', encoding='utf-8')
    for row in rows:
        name = row['name']
        if row['type'] != 'file' or Path(name).name != name or '\\' in name or ':' in name:
            raise ValueError('Unsupported MSYS recipe directory member')
        path = destination / name
        if path.exists():
            data = path.read_bytes()
        else:
            url = f'https://raw.githubusercontent.com/msys2/MINGW-packages/{item["commit"]}/{item["name"]}/{name}'
            with read_url(url) as response:
                data = response.read(2 * 1024 * 1024)
        if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != row['sha']:
            raise ValueError(f'MSYS recipe Git blob mismatch: {name}')
        path.write_bytes(data)
    text = (destination / 'PKGBUILD').read_text()
    version = re.search(r'^pkgver=(.+)$', text, re.M)
    if item['name'] == 'mingw-w64-gcc':
        version = re.search(r'^_pkgver=(.+)$', text, re.M)
    release = re.search(r'^pkgrel=(.+)$', text, re.M)
    if not version or not release or version[1] + '-' + release[1] != item['version']:
        raise ValueError(f'MSYS recipe version differs from upstream build log: {item["name"]}')


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


def build(output):
    lock = json.loads((RECIPE / 'lock.json').read_text())
    source = output / 'source'
    source.mkdir(parents=True, exist_ok=True)
    for item in lock['repositories']:
        download(item, source / 'archives' / (item['name'] + '.tar.gz'))
    collect_licenses(source / 'archives/pyav.tar.gz', source / 'licenses/pyav')
    vendor = source / 'archives/pyav-ffmpeg.tar.gz'
    inputs = vendor_sources(archive_text(vendor, 'scripts/pkg.py')) + lock['additional_sources']
    for item in inputs:
        path = source / 'archives' / item['name']
        download(item, path)
        if tarfile.is_tarfile(path):
            collect_licenses(path, source / 'licenses' / item['name'], lock.get('embedded_license_suffixes', {}).get(item['name']))
    for item in lock['msys_recipes']:
        recipe_files(item, source / 'msys-recipes' / item['name'])
    shutil.copytree(RECIPE, source / 'recipe', dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    (source / 'sources.json').write_text(json.dumps(inputs, indent=2) + '\n', encoding='utf-8')
    shutil.copyfile(RECIPE / 'SOURCE-NOTICES.txt', source / 'SOURCE-NOTICES.txt')
    package(output)
    verify(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['build', 'verify'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    (build if args.command == 'build' else verify)(args.output.resolve())

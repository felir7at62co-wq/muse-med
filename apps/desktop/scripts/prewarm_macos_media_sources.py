"""Seed Mac CI raw-source caches from a pinned release archive and current resource locks."""

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import tempfile
from urllib.request import urlopen
from uuid import uuid4


@dataclass(frozen=True)
class Resource:
    """A regular source file accepted only at its exact size and SHA-256."""

    filename: str
    bytes: int
    sha256: str


BUNDLE = Resource('muse-macos-media-9.0.2-locked-source-inputs.tar.gz', 38198363,
                  '1ac5db98e7c89fc766a9341fb1ef319cad9b735225b00176579058c9db925b3b')
BUNDLE_URL = f'https://github.com/felir7at62co-wq/muse-med/releases/download/v1.2.0/{BUNDLE.filename}'
SCRIPTS = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def current_sources(scripts):
    """Read source identities from both current Mac resource locks before creating outputs."""
    media = json.loads((scripts / 'macos-media-lock.json').read_bytes())
    subtitles = json.loads((scripts / 'macos-subtitle-lock.json').read_bytes())
    resources = []
    for entry in [media['source']] + [library['source'] for library in subtitles['libraries']]:
        resource = Resource(entry['filename'], entry['bytes'], entry['sha256'])
        require(isinstance(resource.filename, str)
                and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', resource.filename) is not None
                and resource.filename not in {'.', '..'}, 'Mac source cache: unsafe locked filename')
        require(type(resource.bytes) is int and resource.bytes > 0
                and isinstance(resource.sha256, str) and re.fullmatch(r'[a-f0-9]{64}', resource.sha256),
                f'Mac source cache: invalid locked identity: {resource.filename}')
        require(all(previous.filename != resource.filename for previous in resources),
                f'Mac source cache: duplicate locked filename: {resource.filename}')
        resources.append(resource)
    return resources


def verify_file(path, resource):
    """Reject missing, nonregular or changed bytes without replacing the file."""
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode), f'Mac source cache: regular file required: {path}')
    require(info.st_size == resource.bytes, f'Mac source cache: size mismatch: {path}')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    require(digest.hexdigest() == resource.sha256, f'Mac source cache: SHA-256 mismatch: {path}')


def download_bundle(destination, resource=BUNDLE, opener=urlopen):
    """Bound one public download and remove its owned partial file on every failure."""
    created = False
    try:
        with opener(BUNDLE_URL, timeout=60) as response, destination.open('xb') as output:
            created = True
            size = 0
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                size += len(chunk)
                require(size <= resource.bytes, 'Mac source cache: release archive exceeds locked size')
                output.write(chunk)
        verify_file(destination, resource)
    except BaseException:
        if created:
            destination.unlink()
        raise


def read_sources(archive, resources, bundle):
    """Read only exact regular members after checking the complete release archive."""
    verify_file(archive, bundle)
    selected = {f'source/source-archives/{resource.filename}': resource for resource in resources}
    payloads, seen = {}, set()
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            parts = member.name.rstrip('/').split('/')
            require(not member.name.startswith('/') and '\\' not in member.name and ':' not in member.name
                    and all(part not in {'', '.', '..'} for part in parts),
                    f'Mac source cache: unsafe archive member: {member.name}')
            require(member.name not in seen, f'Mac source cache: duplicate archive member: {member.name}')
            seen.add(member.name)
            require(member.isfile() or member.isdir(), f'Mac source cache: archive links/special files refused: {member.name}')
            if member.name not in selected:
                continue
            resource = selected[member.name]
            require(member.isfile() and member.size == resource.bytes,
                    f'Mac source cache: invalid source member: {member.name}')
            with source.extractfile(member) as stream:
                data = stream.read(resource.bytes + 1)
            require(len(data) == resource.bytes and hashlib.sha256(data).hexdigest() == resource.sha256,
                    f'Mac source cache: current source lock mismatch: {member.name}')
            payloads[resource.filename] = data
    require(len(payloads) == len(resources), 'Mac source cache: release archive lacks a current locked source')
    return payloads


def check_directory(path, create=False):
    """Keep cache ancestors as real directories; never follow a cache symlink."""
    for parent in list(reversed(path.parents)) + [path]:
        try:
            info = parent.lstat()
        except FileNotFoundError:
            if not create:
                continue
            try:
                parent.mkdir()
            except FileExistsError:
                pass  # A concurrent preparer may have created this directory.
            info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode), f'Mac source cache: real directory required: {parent}')


def prewarm(archive, cache, resources, bundle=BUNDLE):
    """Validate every source and existing cache before publishing complete files without overwrite."""
    payloads = read_sources(archive, resources, bundle)
    cache = cache.absolute()
    nested = cache / 'macos-media'
    check_directory(nested)
    destinations = [(cache / resource.filename, resource) for resource in resources]
    destinations.append((nested / resources[0].filename, resources[0]))
    for path, resource in destinations:
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        verify_file(path, resource)
    check_directory(nested, create=True)
    created, rows = [], []
    with tempfile.TemporaryDirectory(prefix='.mac-source-prewarm-', dir=cache) as temporary:
        try:
            for index, (path, resource) in enumerate(destinations):
                staged = Path(temporary) / str(index)
                staged.write_bytes(payloads[resource.filename])
                try:
                    os.link(staged, path)
                except FileExistsError:
                    verify_file(path, resource)
                    status = 'verified-existing'
                else:
                    created.append((path, staged))
                    status = 'seeded'
                rows.append({'path': str(path), **asdict(resource), 'status': status})
        except BaseException:
            for path, staged in reversed(created):
                if path.exists() and os.path.samestat(path.lstat(), staged.lstat()):
                    path.unlink()
            raise
    return {'schemaVersion': 1, 'success': True, 'archive': {**asdict(bundle), 'url': BUNDLE_URL},
            'sources': [asdict(resource) for resource in resources], 'cacheFiles': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=SCRIPTS.parent / '.desktop-build/downloads')
    parser.add_argument('--archive', type=Path, help='Existing original release archive; still checks its pinned bytes')
    args = parser.parse_args()
    resources = current_sources(SCRIPTS)
    with tempfile.TemporaryDirectory(prefix='muse-mac-source-download-') as temporary:
        archive = args.archive
        if archive is None:
            archive = Path(temporary) / BUNDLE.filename
            download_bundle(archive)
        result = prewarm(archive, args.cache, resources)
    receipts = args.cache.absolute().parent / 'packaging-runs'
    check_directory(receipts, create=True)
    receipt = receipts / f'mac-source-prewarm-{uuid4().hex}.json'
    with receipt.open('x', encoding='utf-8') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print(json.dumps({'receipt': str(receipt), **result}))


if __name__ == '__main__':
    main()

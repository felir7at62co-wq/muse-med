"""Build and verify the independent studio release payload without touching a service or database."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile


BACKEND_TREES = ('src', 'migrations', 'skills')
REQUIRED = {
    'backend-node/package.json',
    'backend-node/package-lock.json',
    'backend-node/src/server.js',
    'frontweb/dist/index.html',
}
PRIVATE_PARTS = {'node_modules', 'configs', 'test', 'tests', '__pycache__', '.git', 'tools'}
PRIVATE_SUFFIXES = {'.exe', '.dll', '.pdb', '.node', '.key', '.pem', '.p12', '.pfx', '.sqlite', '.db'}
MAX_FILES = 50_000
MAX_BYTES = 1024 ** 3
MAX_FILE_BYTES = 256 * 1024 ** 2
MAX_MANIFEST_BYTES = 16 * 1024 ** 2
SHA256 = re.compile(r'[0-9a-f]{64}\Z')


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(stream):
    return hashlib.file_digest(stream, 'sha256').hexdigest()


def payload_name(name):
    path = PurePosixPath(name)
    parts = path.parts
    require(parts and not path.is_absolute() and str(path) == name and '..' not in parts
            and not re.search(r'[\\:\x00-\x1f\x7f]', name), 'unsafe_payload_path')
    require(not any(part.casefold() in PRIVATE_PARTS or part.casefold().startswith('.env') for part in parts)
            and path.suffix.casefold() not in PRIVATE_SUFFIXES, 'excluded_payload_path')
    require(
        name in REQUIRED
        or (len(parts) > 2 and parts[0] == 'backend-node' and parts[1] in BACKEND_TREES)
        or (len(parts) > 2 and parts[:2] == ('frontweb', 'dist')),
        'unexpected_payload_path',
    )
    return path


def inspect_members(archive):
    files = {}
    casefolded = set()
    total_bytes = 0
    for entry in archive:
        require(entry.isfile() and not entry.issparse(), 'non_regular_payload_member')
        if entry.name != 'manifest.json':
            payload_name(entry.name)
        folded = entry.name.casefold()
        require(folded not in casefolded, 'duplicate_payload_path')
        casefolded.add(folded)
        require(entry.size <= (MAX_MANIFEST_BYTES if entry.name == 'manifest.json' else MAX_FILE_BYTES),
                'payload_member_too_large')
        total_bytes += entry.size
        require(len(files) < MAX_FILES and total_bytes <= MAX_BYTES, 'payload_too_large')
        with archive.extractfile(entry) as stream:
            if entry.name == 'manifest.json':
                files[entry.name] = json.load(stream)
            else:
                files[entry.name] = {'bytes': entry.size, 'sha256': digest(stream)}
    recorded = files.pop('manifest.json', None)
    require(REQUIRED.issubset(files), 'incomplete_payload')
    require(isinstance(recorded, dict) and recorded.get('version') == 1
            and recorded.get('kind') == 'muse-standalone-platform'
            and recorded.get('generationBackend') == 'unconfigured'
            and recorded.get('backgroundGeneration') is False
            and recorded.get('platformNativeDependenciesIncluded') is False,
            'invalid_payload_manifest')
    require(
        recorded.get('files') == files
        and recorded.get('packageSha256') == files['backend-node/package.json']['sha256']
        and recorded.get('lockSha256') == files['backend-node/package-lock.json']['sha256'],
        'payload_manifest_mismatch',
    )
    return {'fileCount': len(files) + 1, 'unpackedBytes': total_bytes}


def verify(payload, expected=None):
    """Read the archive and check its inventory, individual hashes, and optional full checksum."""
    with payload.open('rb') as source:
        checksum = digest(source)
        require(expected is None or SHA256.fullmatch(expected) and checksum == expected,
                'payload_sha256_mismatch')
        source.seek(0)
        with tarfile.open(fileobj=source, mode='r|gz') as archive:
            return {'sha256': checksum, **inspect_members(archive)}


def selected_files(source):
    for dirname in [*('backend-node/' + tree for tree in BACKEND_TREES), 'frontweb/dist']:
        directory = source / dirname
        require(directory.is_dir() and not directory.is_symlink() and not directory.parent.is_symlink(),
                'payload_source_directory_missing')
        for parent, directories, files in os.walk(directory, followlinks=False):
            for part in directories:
                require(not Path(parent, part).is_symlink(), 'payload_source_symlink')
            for part in files:
                path = Path(parent, part)
                name = path.relative_to(source).as_posix()
                payload_name(name)
                require(not path.is_symlink() and path.is_file(), 'payload_source_not_regular')
                yield name, path
    for name in ('backend-node/package.json', 'backend-node/package-lock.json'):
        path = source / name
        require(not path.is_symlink() and path.is_file(), 'payload_source_not_regular')
        yield name, path


def add_file(archive, name, stream, length):
    header = tarfile.TarInfo(name)
    header.size = length
    header.mode = 0o644
    archive.addfile(header, stream)


def build(source, output):
    """Atomically create a new deterministic release from a patched checkout and its Web build."""
    source = source.resolve(strict=True)
    parent = output.parent.resolve(strict=True)
    require(not parent.is_relative_to(source), 'output_directory_must_be_outside_checkout')
    output = parent / output.name
    require(not os.path.lexists(output), 'output_already_exists')
    items = sorted(selected_files(source))
    require(REQUIRED.issubset(name for name, _ in items), 'incomplete_payload_source')
    require(len(items) < MAX_FILES, 'payload_too_large')
    inventory = {}
    unpacked_bytes = 0
    for name, path in items:
        size = path.stat().st_size
        unpacked_bytes += size
        require(size <= MAX_FILE_BYTES and unpacked_bytes <= MAX_BYTES, 'payload_too_large')
        with path.open('rb') as stream:
            inventory[name] = {'bytes': size, 'sha256': digest(stream)}
    manifest = json.dumps({
        'version': 1,
        'kind': 'muse-standalone-platform',
        'generationBackend': 'unconfigured',
        'backgroundGeneration': False,
        'entrypoint': 'backend-node/src/server.js',
        'platformNativeDependenciesIncluded': False,
        'packageSha256': inventory['backend-node/package.json']['sha256'],
        'lockSha256': inventory['backend-node/package-lock.json']['sha256'],
        'files': inventory,
    }, sort_keys=True, ensure_ascii=False).encode('utf-8')
    require(len(manifest) <= MAX_MANIFEST_BYTES and unpacked_bytes + len(manifest) <= MAX_BYTES,
            'payload_too_large')
    with tempfile.TemporaryDirectory(dir=parent) as temporary:
        staged = Path(temporary) / 'payload.tgz'
        with staged.open('xb') as file, gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|') as archive:
                for name, path in items:
                    with path.open('rb') as stream:
                        add_file(archive, name, stream, inventory[name]['bytes'])
                add_file(archive, 'manifest.json', io.BytesIO(manifest), len(manifest))
        result = verify(staged)
        os.link(staged, output)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    pack = commands.add_parser('build')
    pack.add_argument('source', type=Path)
    pack.add_argument('output', type=Path)
    check = commands.add_parser('verify')
    check.add_argument('payload', type=Path)
    check.add_argument('--sha256')
    args = parser.parse_args()
    try:
        result = build(args.source, args.output) if args.command == 'build' else verify(args.payload, args.sha256)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f'Payload {args.command} failed: {error}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()

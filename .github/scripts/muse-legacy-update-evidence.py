"""Read old public installers without executing them and retain their exact updater settings."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess


REPOSITORY = 'felir7at62co-wq/muse-med'
RELEASES = (
    {
        'label': 'stable-1.0.1',
        'tag': 'v1.0.1',
        'version': '1.0.1',
        'assetId': 607808314,
        'filename': 'muse-med-1.0.1-win-x64.exe',
        'size': 562121395,
        'sha256': '7fc7333d52573041aa65e6d7be9f28f8542f3f544a19d7fb2683ba8e28855086',
    },
    {
        'label': 'legacy-0.1.7-rc.8.20260930.1',
        'tag': 'v0.1.7-rc.8.20260930.1',
        'version': '0.1.7-rc.8.20260930.1',
        'assetId': 600923776,
        'filename': 'muse-med-0.1.7-rc.8.20260930.1-win-x64.exe',
        'size': 556751188,
        'sha256': '9f50869596c7c94aaac2cfb0d60fa7113fc0ced70a6ce668691559baa720e28a',
    },
)


def api_json(route):
    """Read JSON using the workflow's read-only GitHub token."""
    result = subprocess.run(['gh', 'api', route], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(f'GitHub GET failed with exit {result.returncode}: {route}')
    return json.loads(result.stdout)


def download_asset(asset_id, destination):
    """Download an immutable asset through its recorded API ID."""
    with destination.open('wb') as stream:
        result = subprocess.run([
            'gh', 'api', f'repos/{REPOSITORY}/releases/assets/{asset_id}',
            '-H', 'Accept: application/octet-stream',
        ], stdout=stream, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(f'GitHub asset GET failed with exit {result.returncode}: {asset_id}')


def digest(path):
    """Hash complete local bytes, including installers."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def seven_zip(executable, *arguments):
    """Read or extract an archive; never execute installer contents."""
    result = subprocess.run([str(executable), *map(str, arguments)], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(f'7-Zip archive operation failed with exit {result.returncode}')
    return result.stdout.decode('utf-8', errors='replace')


def archive_entries(executable, archive):
    """List archive members using 7-Zip's structured listing."""
    listing = seven_zip(executable, 'l', '-slt', '-sccUTF-8', '--', archive)
    members = listing.partition('----------')[2]
    return [entry.strip() for entry in re.findall(r'^Path = (.+)$', members, flags=re.MULTILINE)]


def member(entries, suffix):
    """Select exactly one member by its normalized suffix."""
    matches = [entry for entry in entries if entry.replace('\\', '/').endswith(suffix)]
    if len(matches) != 1:
        raise RuntimeError(f'Expected exactly one archive member {suffix}; received {len(matches)}')
    return matches[0]


def packaged_manifest(archive):
    """Read the application's package.json directly from ASAR bytes."""
    with archive.open('rb') as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise RuntimeError('ASAR header is truncated')
        header_size = struct.unpack_from('<I', prefix, 4)[0]
        json_size = struct.unpack_from('<I', prefix, 12)[0]
        if not 8 <= header_size <= 32 * 1024 * 1024 or not 0 < json_size <= header_size - 8:
            raise RuntimeError('ASAR header size is invalid')
        header = json.loads(stream.read(json_size))
        entry = header['files']['package.json']
        size = entry['size']
        if not isinstance(size, int) or not 0 < size <= 1024 * 1024:
            raise RuntimeError('Packaged manifest size is invalid')
        stream.seek(8 + header_size + int(entry['offset']))
        package_bytes = stream.read(size)
        if len(package_bytes) != size:
            raise RuntimeError('Packaged manifest is truncated')
        return json.loads(package_bytes), hashlib.sha256(package_bytes).hexdigest()


def extract_release(executable, expected, work, evidence):
    """Verify a released installer and retain only config and identity evidence."""
    release = api_json(f'repos/{REPOSITORY}/releases/tags/{expected["tag"]}')
    if release['draft'] or release['tag_name'] != expected['tag']:
        raise RuntimeError('Expected release is not public')
    matches = [asset for asset in release['assets'] if asset['id'] == expected['assetId']]
    if len(matches) != 1:
        raise RuntimeError('Expected installer asset is absent')
    asset = matches[0]
    if (asset['name'], asset['size'], asset['digest'], asset['state']) != (
        expected['filename'], expected['size'], 'sha256:' + expected['sha256'], 'uploaded',
    ):
        raise RuntimeError('Public installer metadata differs from the reviewed immutable asset')
    release_work = work / expected['label']
    release_evidence = evidence / expected['label']
    release_work.mkdir()
    release_evidence.mkdir()
    installer = release_work / expected['filename']
    print(f'Downloading public {expected["tag"]} installer {expected["assetId"]}', flush=True)
    download_asset(asset['id'], installer)
    installer_hash = digest(installer)
    if installer.stat().st_size != expected['size'] or installer_hash != expected['sha256']:
        raise RuntimeError('Downloaded installer size or complete SHA-256 is invalid')
    payload_member = member(archive_entries(executable, installer), 'app-64.7z')
    payload_directory = release_work / 'payload'
    payload_directory.mkdir()
    seven_zip(executable, 'e', '-y', f'-o{payload_directory}', '--', installer, payload_member)
    payload = payload_directory / 'app-64.7z'
    entries = archive_entries(executable, payload)
    config_member = member(entries, 'resources/app-update.yml')
    asar_member = member(entries, 'resources/app.asar')
    extracted = release_work / 'extracted'
    extracted.mkdir()
    seven_zip(executable, 'e', '-y', f'-o{extracted}', '--', payload, config_member, asar_member)
    config = extracted / 'app-update.yml'
    manifest, manifest_hash = packaged_manifest(extracted / 'app.asar')
    shutil.copyfile(config, release_evidence / 'app-update.yml')
    record = {
        'repository': REPOSITORY,
        'release': {key: release[key] for key in (
            'id', 'tag_name', 'name', 'draft', 'prerelease', 'created_at', 'published_at', 'html_url',
        )},
        'asset': {key: asset[key] for key in (
            'id', 'name', 'size', 'digest', 'state', 'browser_download_url', 'created_at', 'updated_at',
        )},
        'installerSha256': installer_hash,
        'installerSize': installer.stat().st_size,
        'releaseVersion': expected['version'],
        'packagedVersion': manifest['version'],
        'packagedName': manifest['name'],
        'manifestSha256': manifest_hash,
        'updaterConfigSha256': digest(config),
        'updaterConfigSize': config.stat().st_size,
        'archiveMembers': {'payload': payload_member, 'config': config_member, 'manifestContainer': asar_member},
        'installerExecuted': False,
    }
    (release_evidence / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    if manifest['version'] != expected['version']:
        raise RuntimeError(f'Actual packaged version differs from released filename: {manifest["version"]}')
    print(f'PASS exact original config extracted from {expected["tag"]}; manifest {manifest["version"]}', flush=True)
    return record


def main():
    """Verify the frozen source and extract both public historical installers."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    arguments = parser.parse_args()
    source = os.environ.get('MUSE_CI_TRANSFER_SOURCE_COMMIT', '')
    if re.fullmatch('[0-9a-f]{40}', source) is None:
        raise RuntimeError('Exact source repository variable is required')
    actual_source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    main_source = api_json(f'repos/{REPOSITORY}/git/ref/heads/main')['object']['sha']
    if actual_source != source or main_source != source:
        raise RuntimeError('Source checkout and public main must equal the reviewed source variable')
    executable = shutil.which('7z') or Path(r'C:\Program Files\7-Zip\7z.exe')
    if not Path(executable).is_file():
        raise RuntimeError('The runner must provide 7-Zip archive support')
    arguments.output.mkdir(parents=True, exist_ok=False)
    arguments.work.mkdir(parents=True, exist_ok=False)
    records = [extract_release(executable, release, arguments.work, arguments.output) for release in RELEASES]
    result = {
        'status': 'actual-historical-configs-extracted',
        'sourceCommit': source,
        'releaseRecords': records,
        'remoteMutations': False,
        'installersExecuted': False,
    }
    (arguments.output / 'evidence.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('PASS both exact historical updater configurations retained; public discovery remains a separate check')


if __name__ == '__main__':
    main()

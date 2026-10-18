"""Transfer the sealed Muse 1.1.6 build; never rebuild, retag, or publish a release."""
import argparse
import base64
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import ssl
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

HERE = Path(__file__).resolve().parent
REPO = 'felir7at62co-wq/muse-med'
SOURCE = '0064a968241e80645892ee7268167cc7f4a7cd4c'
RUN = 39141984760
MANIFEST_SHA = 'b919499215f77bbecbb7dfc4f5da17a11bfd9b1ff0ffbafef1a067e6f979cf15'
DRAFTS = (('v1.1.6', 416563912, False), ('v1.1.6-rc.muse-stable', 416563941, True))
TARGETS = ('mac-arm64', 'win-x64')
LARGE = {'muse-med-1.1.6-mac-arm64.dmg', 'muse-med-1.1.6-mac-arm64.zip', 'muse-med-1.1.6-win-x64.exe'}
PRINT_LOCK = threading.Lock()


class TransportError(RuntimeError):
    """A diagnostic containing neither authentication nor signed resource URLs."""


def require(condition, message):
    if not condition:
        raise TransportError(message)


def emit(stage, **fields):
    with PRINT_LOCK:
        print(json.dumps({'at': datetime.now(timezone.utc).isoformat(), 'stage': stage, **fields}), flush=True)


def load(path):
    return json.loads(path.read_text())


def receipt(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('x') as file:
        os.chmod(path, 0o600)
        json.dump(value, file, indent=2)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())


def hash_file(path, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def identity():
    require(hash_file(HERE / 'manifest.json') == MANIFEST_SHA, 'sealed manifest bytes differ')
    manifest, seal = load(HERE / 'manifest.json'), load(HERE / 'seal.json')
    require(seal.get('sourceCommit') == SOURCE and seal.get('version') == '1.1.6'
            and seal.get('manifestSha256') == MANIFEST_SHA and seal.get('schemaVersion') == 1, 'seal identity differs')
    require(manifest.get('sourceCommit') == SOURCE and manifest.get('version') == '1.1.6'
            and manifest.get('schemaVersion') == 1 and manifest.get('assetCount') == 12, 'manifest identity differs')
    assets = manifest.get('assets', [])
    require(len(assets) == 12 and len({a['filename'] for a in assets}) == 12, 'twelve unique assets required')
    for asset in assets:
        require(re.fullmatch(r'[A-Za-z0-9._-]+', asset['filename']) is not None
                and isinstance(asset['size'], int) and asset['size'] > 0
                and re.fullmatch(r'[a-f0-9]{64}', asset['sha256']) is not None
                and re.fullmatch(r'[A-Za-z0-9+/]{86}==', asset.get('sha512', '')) is not None, 'invalid sealed asset')
    return manifest


def release_ok(release, draft):
    tag, release_id, prerelease = draft
    require(release.get('id') == release_id and release.get('tag_name') == tag
            and release.get('target_commitish') == SOURCE and release.get('draft') is True
            and release.get('published_at') is None and release.get('prerelease') is prerelease, 'release is not the expected unpublished draft')


def asset_ok(asset, expected):
    return (asset.get('name') == expected['filename'] and asset.get('state') == 'uploaded'
            and asset.get('size') == expected['size'] and asset.get('digest') == 'sha256:' + expected['sha256'])


def artifact_ok(artifact, name):
    require(type(artifact.get('id')) is int and artifact['id'] > 0
            and artifact.get('name') == name and artifact.get('expired') is False
            and artifact.get('workflow_run', {}).get('id') == RUN
            and artifact.get('workflow_run', {}).get('head_sha') == SOURCE
            and isinstance(artifact.get('size_in_bytes'), int) and artifact['size_in_bytes'] > 0
            and re.fullmatch(r'sha256:[a-f0-9]{64}', artifact.get('digest') or '') is not None,
            'Actions artifact identity or digest differs')


def resource_url(url):
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
            and not parsed.fragment and (parsed.hostname.endswith('.blob.core.windows.net')
            or parsed.hostname.endswith('.actions.githubusercontent.com') or parsed.hostname == 'release-assets.githubusercontent.com'),
            'unexpected signed-resource origin')
    return url


def members(archive, target, kind):
    seen = set()
    files = []
    for item in archive.infolist():
        path = PurePosixPath(item.filename)
        require(item.filename and '\\' not in item.filename and ':' not in item.filename and not path.is_absolute()
                and '..' not in path.parts and '.' not in path.parts and str(path) == item.filename.rstrip('/')
                and item.filename.casefold() not in seen and not item.flag_bits & 1
                and stat.S_IFMT(item.external_attr >> 16) != stat.S_IFLNK, 'unsafe ZIP member')
        seen.add(item.filename.casefold())
        if not item.is_dir():
            files.append(item)
    names = {item.filename for item in files}
    if kind == 'build':
        expected = {'unsigned-build.json', 'builder-debug.yml'}
        if target == 'mac-arm64':
            expected |= {'muse-med-1.1.6-mac-arm64.dmg', 'muse-med-1.1.6-mac-arm64.zip',
                         'muse-med-1.1.6-mac-arm64.zip.blockmap', 'latest-mac.yml'}
        else:
            expected |= {'muse-med-1.1.6-win-x64.exe', 'muse-med-1.1.6-win-x64.exe.blockmap', 'latest.yml'}
        require(names == expected, 'Actions build ZIP inventory differs')
    else:
        reports = [name for name in names if name.endswith('/acceptance.json')]
        require(len(reports) == 1, 'exactly one native acceptance report required')
        prefix = str(PurePosixPath(reports[0]).parent)
        require('/' not in prefix and prefix.startswith('muse-installer-acceptance-')
                and all(name == reports[0] or name.startswith(prefix + '/processes/') for name in names), 'acceptance ZIP inventory differs')
    return files


def native_ok(build, acceptance, target, sealed_installer):
    for report in (build, acceptance):
        require(report.get('sourceCommit') == SOURCE and report.get('version') == '1.1.6'
                and report.get('target') == target, 'native report source differs')
    require(build.get('unsigned') is True and acceptance.get('success') is True
            and acceptance.get('completeInstalledPayload', {}).get('passed') is True
            and acceptance['completeInstalledPayload'].get('comparedFiles', 0) > 0, 'native payload acceptance missing')
    require(all(acceptance.get('installedRuntimeSmoke', {}).get(key) is True for key in
                ['passed', 'archiveInventory', 'nativePayload', 'packagedHost', 'productPresetsAndSkills', 'officeConversions', 'teardown']),
            'native runtime smoke incomplete')
    require(acceptance.get('dmgMountedReadOnly' if target == 'mac-arm64' else 'silentInstallerExecuted') is True,
            'genuine installer acceptance missing')
    name = 'muse-med-1.1.6-' + target + ('.dmg' if target == 'mac-arm64' else '.exe')
    require(re.fullmatch(r'[a-f0-9]{64}', acceptance.get('installerSha256') or '') is not None
            and sealed_installer.get('filename') == name
            and sealed_installer.get('sha256') == acceptance['installerSha256']
            and build.get('artifacts', {}).get(name, {}).get('sha256') == acceptance['installerSha256'], 'native installer hash differs')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


class GitHub:
    def __init__(self, token):
        require(bool(token), 'GITHUB_TOKEN is required')
        self.token = token
        self.tls = ssl.create_default_context()
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=self.tls))

    def headers(self):
        return {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Muse-116-sealed-transport'}

    def api(self, path, method='GET', missing=False):
        require(path.startswith(f'/repos/{REPO}/'), 'unexpected API repository')
        require(method == 'GET' or method == 'DELETE' and re.fullmatch(f'/repos/{REPO}/releases/assets/[0-9]+', path),
                'only reads and failed-asset deletion are allowed on the JSON API')
        connection = http.client.HTTPSConnection('api.github.com', context=self.tls, timeout=120)
        try:
            connection.request(method, path, headers=self.headers())
            response = connection.getresponse()
            body = response.read()
            if missing and response.status == 404:
                return None
            require(response.status == (204 if method == 'DELETE' else 200), f'GitHub API HTTP {response.status}')
            return None if method == 'DELETE' else json.loads(body)
        finally:
            connection.close()

    def assets(self, draft):
        release_ok(self.api(f'/repos/{REPO}/releases/{draft[1]}'), draft)
        assets = self.api(f'/repos/{REPO}/releases/{draft[1]}/assets?per_page=100')
        require(len(assets) < 100, 'asset pagination required')
        return assets

    def download(self, path, destination, expected_size, expected_hash):
        if destination.exists():
            require(destination.is_file() and destination.stat().st_size == expected_size
                    and hash_file(destination) == expected_hash, 'existing downloaded file differs')
            return
        request = urllib.request.Request('https://api.github.com' + path,
                headers={**self.headers(), 'Accept': 'application/octet-stream', 'Accept-Encoding': 'identity'})
        try:
            response = self.opener.open(request, timeout=180)
        except urllib.error.HTTPError as error:
            try:
                require(error.code == 302, f'GitHub download API HTTP {error.code}')
                url = resource_url(error.headers.get('Location', ''))
            finally:
                error.close()
            response = self.opener.open(urllib.request.Request(url, headers={'Accept-Encoding': 'identity'}), timeout=180)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.partial')
        measured = hashlib.sha256()
        count = 0
        try:
            with response, temporary.open('xb') as output:
                os.chmod(temporary, 0o600)
                require(response.status == 200 and response.headers.get('Content-Encoding') in (None, 'identity'), 'encoded or incomplete resource')
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    count += len(chunk)
                    require(count <= expected_size, 'resource exceeds its declared size')
                    measured.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            require(count == expected_size and measured.hexdigest() == expected_hash, 'complete resource size or SHA256 differs')
            temporary.rename(destination)
        finally:
            if temporary.exists():
                temporary.unlink()

    def upload(self, draft, expected, path, receipts):
        names = [asset for asset in self.assets(draft) if asset['name'] == expected['filename']]
        require(len(names) <= 1, 'duplicate remote filename')
        if names:
            require(asset_ok(names[0], expected), 'remote asset needs reconciliation before upload')
            return names[0]
        attempt = receipts / f'{draft[1]}-{expected["filename"]}.attempt.json'
        receipt(attempt, {'sourceCommit': SOURCE, 'releaseId': draft[1], 'manifestSha256': MANIFEST_SHA, 'expected': expected})
        connection = http.client.HTTPSConnection('uploads.github.com', context=self.tls, timeout=180)
        sent = 0
        started = last = time.monotonic()
        digest = hashlib.sha256()
        try:
            connection.putrequest('POST', f'/repos/{REPO}/releases/{draft[1]}/assets?name={urllib.parse.quote(expected["filename"], safe="")}')
            for key, value in {**self.headers(), 'Content-Type': 'application/octet-stream', 'Content-Length': str(expected['size'])}.items():
                connection.putheader(key, value)
            connection.endheaders()
            with path.open('rb') as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b''):
                    connection.send(chunk)
                    sent += len(chunk)
                    digest.update(chunk)
                    if time.monotonic() - last >= 15:
                        emit('github-stream', tag=draft[0], name=expected['filename'], sentBytes=sent,
                             totalBytes=expected['size'], elapsedSeconds=round(time.monotonic()-started, 3))
                        last = time.monotonic()
            require(sent == expected['size'] and digest.hexdigest() == expected['sha256'], 'local bytes changed while streaming')
            response = connection.getresponse()
            body = response.read()
            require(response.status == 201, f'GitHub asset upload HTTP {response.status}')
            asset = json.loads(body)
        except Exception:
            matches = [asset for asset in self.assets(draft) if asset['name'] == expected['filename']]
            require(len(matches) == 1 and asset_ok(matches[0], expected), 'upload uncertain; no automatic POST retry')
            asset = matches[0]
        finally:
            connection.close()
        require(asset_ok(asset, expected), 'uploaded asset digest differs')
        observed = self.api(f'/repos/{REPO}/releases/assets/{asset["id"]}')
        require(asset_ok(observed, expected), 'uploaded asset API readback differs')
        receipt(receipts / f'{draft[1]}-{asset["id"]}.verified.json',
                {'releaseId': draft[1], 'sourceCommit': SOURCE, 'asset': compact_asset(observed), 'expected': expected})
        emit('github-asset-verified', tag=draft[0], name=expected['filename'], assetId=asset['id'], size=asset['size'])
        return observed


def compact_asset(asset):
    return {key: asset.get(key) for key in ['id', 'name', 'state', 'size', 'digest']}


def verify_files(directory, manifest):
    require({path.name for path in directory.iterdir()} == {asset['filename'] for asset in manifest['assets']}, 'public asset whitelist differs')
    for asset in manifest['assets']:
        path = directory / asset['filename']
        require(not path.is_symlink() and path.is_file() and path.stat().st_size == asset['size']
                and hash_file(path) == asset['sha256']
                and base64.b64encode(bytes.fromhex(hash_file(path, 'sha512'))).decode() == asset['sha512'], 'public sealed bytes differ')


def prepare(client, work, manifest):
    run = client.api(f'/repos/{REPO}/actions/runs/{RUN}')
    require(run.get('head_sha') == SOURCE and run.get('event') == 'workflow_dispatch'
            and run.get('path', '').split('@')[0] == '.github/workflows/muse-desktop.yml'
            and run.get('conclusion') == 'success', 'source Actions run was not accepted')
    jobs = client.api(f'/repos/{REPO}/actions/runs/{RUN}/jobs?per_page=100')['jobs']
    for target in TARGETS:
        matching = [job for job in jobs if job['name'] == target + ' unsigned installer']
        require(len(matching) == 1 and matching[0]['status'] == 'completed' and matching[0]['conclusion'] == 'success', 'native target job failed')
    available = client.api(f'/repos/{REPO}/actions/runs/{RUN}/artifacts?per_page=100')
    require(available['total_count'] <= 100, 'artifact pagination required')
    downloaded = []
    for target in TARGETS:
        for kind in ('build', 'acceptance'):
            name = f'muse-{target}' + ('-installed-acceptance' if kind == 'acceptance' else '') + '-' + SOURCE
            matches = [artifact for artifact in available['artifacts'] if artifact['name'] == name]
            require(len(matches) == 1, 'exact source artifact missing')
            artifact = client.api(f'/repos/{REPO}/actions/artifacts/{matches[0]["id"]}')
            artifact_ok(artifact, name)
            archive_path = work / 'archives' / f'{artifact["id"]}.zip'
            client.download(f'/repos/{REPO}/actions/artifacts/{artifact["id"]}/zip', archive_path,
                            artifact['size_in_bytes'], artifact['digest'][7:])
            destination = work / 'source' / f'{target}-{kind}'
            destination.mkdir(parents=True, mode=0o700)
            with zipfile.ZipFile(archive_path) as archive:
                files = members(archive, target, kind)
                require(sum(item.file_size for item in files) <= artifact['size_in_bytes'] * 100 + 64 * 1024 * 1024, 'ZIP inflation exceeds limit')
                for item in files:
                    path = destination / item.filename
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with archive.open(item) as input_file, path.open('xb') as output:
                        os.chmod(path, 0o600)
                        shutil.copyfileobj(input_file, output, 1024 * 1024)
            downloaded.append({'id': artifact['id'], 'name': name, 'size': artifact['size_in_bytes'], 'sha256': artifact['digest'][7:]})
            archive_path.unlink()
    native = []
    for target in TARGETS:
        build = load(work / 'source' / f'{target}-build' / 'unsigned-build.json')
        report_paths = list((work / 'source' / f'{target}-acceptance').rglob('acceptance.json'))
        require(len(report_paths) == 1, 'native acceptance report missing')
        acceptance = load(report_paths[0])
        installer_name = 'muse-med-1.1.6-' + target + ('.dmg' if target == 'mac-arm64' else '.exe')
        sealed_installer = next(asset for asset in manifest['assets'] if asset['filename'] == installer_name)
        native_ok(build, acceptance, target, sealed_installer)
        native.append({'target': target, 'installerSha256': acceptance['installerSha256'],
                       'comparedFiles': acceptance['completeInstalledPayload']['comparedFiles'],
                       'installedRuntimeSmoke': acceptance['installedRuntimeSmoke'], 'success': True})
    assets = work / 'assets'
    assets.mkdir(mode=0o700)
    stable = client.assets(DRAFTS[0])
    for expected in manifest['assets']:
        path = assets / expected['filename']
        if expected['filename'] in LARGE:
            target = 'win-x64' if expected['filename'].endswith('.exe') else 'mac-arm64'
            source = work / 'source' / f'{target}-build' / expected['filename']
            require(source.stat().st_size == expected['size'] and hash_file(source) == expected['sha256'], 'source CI binary differs from seal')
            os.link(source, path)
        else:
            matches = [asset for asset in stable if asset['name'] == expected['filename']]
            require(len(matches) == 1 and asset_ok(matches[0], expected), 'sealed small draft asset missing')
            client.download(f'/repos/{REPO}/releases/assets/{matches[0]["id"]}', path, expected['size'], expected['sha256'])
    verify_files(assets, manifest)
    receipt(work / 'receipts' / 'prepared.json', {'sourceCommit': SOURCE, 'manifestSha256': MANIFEST_SHA,
            'sourceWorkflowRunId': RUN, 'artifactCount': 4, 'artifacts': downloaded, 'nativeAcceptance': native, 'assetCount': 12})
    emit('sealed-twelve-files-prepared', sourceCommit=SOURCE, artifacts=4, assets=12)


def upload_github(client, work, manifest, workers):
    verify_files(work / 'assets', manifest)
    expected = {asset['filename']: asset for asset in manifest['assets']}
    receipts = work / 'receipts'
    for draft in DRAFTS:
        for asset in client.assets(draft):
            require(asset['name'] in expected, 'unexpected draft asset')
            if asset_ok(asset, expected[asset['name']]):
                continue
            require(asset['name'] in LARGE and asset.get('state') == 'starter' and asset.get('digest') is None
                    and asset.get('size') in (0, expected[asset['name']]['size']), 'unknown draft asset state; refuse deletion')
            receipt(receipts / f'cleanup-{asset["id"]}.before.json', {'releaseId': draft[1], 'sourceCommit': SOURCE, 'asset': compact_asset(asset)})
            fresh = client.api(f'/repos/{REPO}/releases/assets/{asset["id"]}', missing=True)
            if fresh is not None and asset_ok(fresh, expected[asset['name']]):
                continue
            if fresh is not None:
                require(fresh.get('size') in (0, expected[asset['name']]['size']) and fresh.get('state') == 'starter' and fresh.get('digest') is None
                        and fresh.get('name') == asset['name'], 'starter changed before cleanup')
                client.api(f'/repos/{REPO}/releases/assets/{asset["id"]}', method='DELETE')
            require(client.api(f'/repos/{REPO}/releases/assets/{asset["id"]}', missing=True) is None, 'starter deletion unconfirmed')
            receipt(receipts / f'cleanup-{asset["id"]}.confirmed.json', {'assetId': asset['id'], 'absent': True})
    tasks = []
    for draft in DRAFTS:
        for asset in manifest['assets']:
            tasks.append((draft, asset))
    stop = threading.Event()
    def transfer(task):
        if stop.is_set():
            raise TransportError('new uploads stopped after a failed transfer')
        draft, expected_asset = task
        try:
            return client.upload(draft, expected_asset, work / 'assets' / expected_asset['filename'], receipts)
        except Exception:
            stop.set()
            raise
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(transfer, sorted(tasks, key=lambda task: task[1]['size'])))
    releases = []
    for draft in DRAFTS:
        assets = client.assets(draft)
        require(len(assets) == 12 and {asset['name'] for asset in assets} == set(expected), 'final draft whitelist differs')
        require(all(asset_ok(asset, expected[asset['name']]) for asset in assets), 'final GitHub asset digest differs')
        releases.append({'tag': draft[0], 'id': draft[1], 'draft': True, 'prerelease': draft[2],
                         'assets': [compact_asset(asset) for asset in assets]})
    receipt(receipts / 'github-24-assets-verified.json', {'sourceCommit': SOURCE, 'manifestSha256': MANIFEST_SHA,
            'assetCount': 24, 'published': False, 'releases': releases})
    emit('github-drafts-ready', assets=24, published=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['prepare', 'github'], required=True)
    parser.add_argument('--work-directory', type=Path, required=True)
    parser.add_argument('--workers', type=int, choices=range(1, 5), default=4)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        print('No transfer performed; --execute is required.')
        return
    require(os.environ.get('GITHUB_REPOSITORY') == REPO, 'unexpected runner repository')
    manifest = identity()
    work = args.work_directory.resolve()
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    client = GitHub(os.environ.get('GITHUB_TOKEN'))
    if args.phase == 'prepare':
        prepare(client, work, manifest)
    else:
        prepared = load(work / 'receipts' / 'prepared.json')
        require(prepared.get('sourceCommit') == SOURCE and prepared.get('manifestSha256') == MANIFEST_SHA,
                'prepared source receipt differs')
        upload_github(client, work, manifest, args.workers)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit('transport-failed', errorType=type(error).__name__,
             diagnostic=str(error) if isinstance(error, TransportError) else 'See sanitized receipts; no automatic write retry or publish.')
        raise SystemExit(1) from None

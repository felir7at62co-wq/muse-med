#!/usr/bin/env python3
"""Prepare fixed original Muse artifacts; remote writes require an explicit root-controlled gate."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import zipfile

PRIVATE = Path(__file__).resolve().parent
REPO_ROOT = PRIVATE.parent.parent
sys.path.insert(0, str(PRIVATE / 'publication-relay-utils'))
import ci_transfer_runner as relay
import artifact_range_download as transfer
import root_tos_proof as rootproof

REPOSITORY = 'felir7at62co-wq/muse-med'
SOURCE = os.environ.get('MUSE_CI_TRANSFER_SOURCE_COMMIT')
if not isinstance(SOURCE, str) or re.fullmatch(r'[0-9a-f]{40}', SOURCE) is None:
    raise ValueError('MUSE_CI_TRANSFER_SOURCE_COMMIT must contain the exact final 40-character source commit')
OPS_BRANCH = 'ops/muse-release-recovery-20261007'
PRIOR_OPS_BRANCH = 'ops/muse-ci-transfer-20261007-0b6d47532eb3b9ba'
AUTHORIZED = 'FINAL_INSTALLED_ACCEPTANCE_' + SOURCE
BUILD_RUN = 37567499544
CI_RUN = 37567447058
TAGS = ('v1.0.3', 'v1.0.3-rc.muse-stable')
TARGETS = ('mac-arm64', 'win-x64')
BUILD_DIAGNOSTICS = {
    'mac-arm64': {'size': 1287, 'sha256': 'bf5668c64be777075e7237c2d4180e0699175c8ff05a8f83648b7a8273bac908'},
    'win-x64': {'size': 7902, 'sha256': 'e959fb106c8946f04d42697e9c96b25d90ef50cef404e8e257081d6736d000ea'},
}


class PublicationError(Exception):
    """Safe failure whose message never contains credentials or signed addresses."""


def command(argv, *, json_result=False, allow_missing=False, environment=None):
    """Capture private subprocess output; expose only explicit safe failure messages."""
    result = subprocess.run(argv, cwd=REPO_ROOT, env=environment, capture_output=True, text=True, check=False)
    if result.returncode:
        if allow_missing and '(HTTP 404)' in result.stderr:
            return None
        raise PublicationError('Command failed: ' + Path(argv[0]).name + '; exit ' + str(result.returncode))
    if json_result:
        try:
            return json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise PublicationError('Command returned invalid JSON') from None
    return result.stdout


def api(path, *, method='GET', data=None, missing=False):
    """Call only this fixed repository; credentials remain managed by GitHub CLI."""
    argv = ['gh', 'api', f'repos/{REPOSITORY}/{path}', '--method', method]
    for name, value in (data or {}).items():
        argv += ['-f', name + '=' + value]
    return command(argv, json_result=True, allow_missing=missing)


def release_for_tag(tag, *, missing=False):
    """Resolve drafts by release ID when GitHub's published-tag endpoint returns 404."""
    release = api('releases/tags/' + tag, missing=True)
    if release is not None:
        return release
    matches = []
    for page in range(1, 21):
        releases = api(f'releases?per_page=100&page={page}')
        if not isinstance(releases, list):
            raise PublicationError('Release listing returned invalid JSON')
        matches.extend(item for item in releases if item.get('tag_name') == tag)
        if len(matches) > 1:
            raise PublicationError('Multiple releases identify the same required tag')
        if len(releases) < 100:
            break
    else:
        raise PublicationError('Release listing exceeds the bounded reconciliation inventory')
    if not matches:
        if missing:
            return None
        raise PublicationError('Required draft or public release is absent')
    release_id = matches[0].get('id')
    if type(release_id) is not int or release_id < 1:
        raise PublicationError('Draft release identifier is invalid')
    release = api('releases/' + str(release_id))
    if release.get('id') != release_id or release.get('tag_name') != tag:
        raise PublicationError('Draft release lookup returned another release')
    return release


def require_authorization(mode):
    """Default preparation cannot write remotely; the root must explicitly commit the publishing gate."""
    if mode in ('prepare', 'verify-public'):
        return
    if (os.environ.get('MUSE_RELEASE_AUTHORIZATION') != AUTHORIZED
            or os.environ.get('GITHUB_EVENT_NAME') != 'push'
            or os.environ.get('GITHUB_REF') != 'refs/heads/' + OPS_BRANCH
            or os.environ.get('GITHUB_REPOSITORY') != REPOSITORY):
        raise PublicationError('Remote writes require the explicit final-installed acceptance gate on the fixed operations push')


def validate_remote_build():
    """Require actual successful final source/build runs and their exact original archives."""
    if relay.SOURCE != SOURCE or relay.REPOSITORY != REPOSITORY:
        raise PublicationError('Relay and publication source settings differ')
    if command(['git', 'rev-parse', 'HEAD']).strip() != SOURCE:
        raise PublicationError('Source checkout is not the final tested commit')
    if api('branches/main')['commit']['sha'] != SOURCE:
        raise PublicationError('Main no longer identifies the final tested commit')
    for run_id, expected_event in ((BUILD_RUN, 'workflow_dispatch'), (CI_RUN, 'pull_request')):
        run = api('actions/runs/' + str(run_id))
        if (run['head_sha'] != SOURCE or run['event'] != expected_event
                or run['status'] != 'completed' or run['conclusion'] != 'success'):
            raise PublicationError('A required final workflow run is not complete and successful')
        jobs = api(f'actions/runs/{run_id}/jobs?per_page=100')
        expected_count = 2 if run_id == BUILD_RUN else 16
        if jobs['total_count'] != expected_count or len(jobs['jobs']) != expected_count:
            raise PublicationError('Final workflow job inventory differs')
        if any(job['status'] != 'completed' or job['conclusion'] != 'success' for job in jobs['jobs']):
            raise PublicationError('A real final workflow job has not passed')
    for artifact, target in zip(relay.ARTIFACTS, TARGETS, strict=True):
        metadata = api('actions/artifacts/' + str(artifact['id']))
        if (metadata.get('expired') is not False or metadata.get('id') != artifact['id']
                or metadata.get('name') != 'muse-' + target + '-' + SOURCE
                or metadata.get('size_in_bytes') != artifact['size']
                or metadata.get('digest') != 'sha256:' + artifact['sha256']
                or metadata.get('workflow_run', {}).get('id') != BUILD_RUN
                or metadata.get('workflow_run', {}).get('head_sha') != SOURCE):
            raise PublicationError('An original final Actions archive differs')


def expected_members(target):
    """Accept only original release files, updater metadata, the identity and fixed builder diagnostic."""
    base = 'muse-med-1.0.3-' + target
    names = ([base + '.dmg', base + '.zip', base + '.zip.blockmap', 'latest-mac.yml']
             if target == 'mac-arm64' else [base + '.exe', base + '.exe.blockmap', 'latest.yml'])
    return set(names + ['unsigned-build.json', 'builder-debug.yml'])


def extract_original(path, target, destination):
    """Reject archive traversal, symlinks, duplicate names and unexpected extra files."""
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if (len(entries) != len(expected_members(target))
                or {entry.filename for entry in entries} != expected_members(target)
                or any(entry.is_dir() or entry.file_size < 1 or entry.flag_bits & 1
                       or (entry.external_attr >> 16) & 0o170000 == 0o120000
                       for entry in entries)):
            raise PublicationError('Original artifact ZIP members differ')
        diagnostic = archive.read('builder-debug.yml')
        expected_diagnostic = BUILD_DIAGNOSTICS[target]
        if (len(diagnostic) != expected_diagnostic['size']
                or hashlib.sha256(diagnostic).hexdigest() != expected_diagnostic['sha256']):
            raise PublicationError('Original builder diagnostic differs from the fixed archive')
        destination.mkdir(mode=0o700)
        for entry in entries:
            with archive.open(entry) as source, (destination / entry.filename).open('xb') as output:
                shutil.copyfileobj(source, output, length=8 * 1024**2)


def prepare():
    """Download or reconcile original archives, then use the existing exact-byte staging script."""
    work = PRIVATE / ('controlled-work-' + os.environ.get('GITHUB_RUN_ID', 'local'))
    if work.exists():
        raise PublicationError('Private work destination already exists; preserve and reconcile it before a fresh run')
    work.mkdir(mode=0o700)
    for artifact in relay.ARTIFACTS:
        path = relay.archive_path(artifact)
        if path.exists():
            transfer.verify_archive(path, artifact['size'], artifact['sha256'])
        else:
            relay.download_one(artifact)
    for artifact, target in zip(relay.ARTIFACTS, TARGETS, strict=True):
        extract_original(relay.archive_path(artifact), target, work / target)
    output = work / 'publication'
    result = command(['node', str(PRIVATE / 'stage-muse-1.0.3.mjs'), '--commit', SOURCE,
        '--mac-arm64', str(work / 'mac-arm64'), '--win-x64', str(work / 'win-x64'), '--output', str(output)], json_result=True)
    if result['files'] != 11 or result['sourceCommit'] != SOURCE:
        raise PublicationError('Staging receipt differs')
    inventory = json.loads(Path(result['inventory']).read_text())
    command(['node', 'apps/desktop/scripts/publish-muse-tos.mjs', '--version', '1.0.3', '--commit', SOURCE,
             '--mac-arm64', str(work / 'mac-arm64'), '--win-x64', str(work / 'win-x64'), '--dry-run'])
    return work, inventory


def tag_commit(tag):
    """Dereference existing tags without moving or replacing them."""
    reference = api('git/ref/tags/' + tag, missing=True)
    if reference is None:
        return None
    obj = reference['object']
    for _ in range(4):
        if obj['type'] != 'tag':
            break
        obj = api('git/tags/' + obj['sha'])['object']
    if obj.get('type') != 'commit' or obj.get('sha') != SOURCE:
        raise PublicationError('An existing release tag points to another commit')
    return SOURCE


def check_assets(release, inventory, *, complete=False):
    """Reject extra, duplicate, incomplete or mismatching remote assets; never clobber them."""
    expected = {file['filename']: file for file in inventory['files']}
    assets = release['assets']
    names = [asset['name'] for asset in assets]
    if len(names) != len(set(names)) or not set(names) <= expected.keys():
        raise PublicationError('Existing release has extra or duplicate assets')
    for asset in assets:
        file = expected[asset['name']]
        if (asset['state'] != 'uploaded' or asset['size'] != file['size']
                or asset.get('digest') != 'sha256:' + file['sha256']):
            raise PublicationError('Existing uploaded asset differs; preserve it for explicit reconciliation')
    if complete and set(names) != expected.keys():
        raise PublicationError('Completed release does not contain exactly eleven assets')
    return set(names)


def reconcile_release(tag, inventory):
    """Inspect both destinations before any remote creation."""
    tag_commit(tag)
    release = release_for_tag(tag, missing=True)
    if release is not None:
        if release['tag_name'] != tag or release['prerelease'] != (tag != TAGS[0]):
            raise PublicationError('Existing release identity or channel differs')
        check_assets(release, inventory)
    return release


def upload_draft(tag, inventory, existing):
    """Create only missing exact tags/drafts/assets after root authorization; preserve prior bytes."""
    if tag_commit(tag) is None:
        api('git/refs', method='POST', data={'ref': 'refs/tags/' + tag, 'sha': SOURCE})
    if existing is None:
        argv = ['gh', 'release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--draft', '--latest=false',
                '--title', 'Muse 1.0.3' if tag == TAGS[0] else 'Muse 1.0.3 — 旧版更新入口',
                '--notes-file', str(PRIVATE / 'release-notes-1.0.3.zh.md')]
        if tag != TAGS[0]:
            argv += ['--prerelease']
        command(argv)
    for file in inventory['files']:
        for attempt in range(3):
            release = release_for_tag(tag)
            if file['filename'] in check_assets(release, inventory):
                break
            if release['draft'] is not True:
                raise PublicationError('A public release is incomplete; no live asset replacement is permitted')
            try:
                command(['gh', 'release', 'upload', tag, str(Path(inventory['output']) / file['filename']), '--repo', REPOSITORY])
            except PublicationError:
                # A lost upload response may still have committed the exact asset.
                if file['filename'] in check_assets(release_for_tag(tag), inventory):
                    break
                if attempt == 2:
                    raise
                time.sleep(2 ** (attempt + 1))
        check_assets(release_for_tag(tag), inventory)
    check_assets(release_for_tag(tag), inventory, complete=True)
    print(json.dumps({'stage': 'completed-assets-verified', 'tag': tag, 'files': 11}), flush=True)


def logged_node(argv, log):
    """Preserve sanitized public verifier output privately without exposing failed network details."""
    result = subprocess.run(['node', *argv], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    log.write_text(result.stdout + result.stderr)
    log.chmod(0o600)
    if result.returncode:
        raise PublicationError('Public publishing or full-body verification failed; inspect the private receipt')


def verify_root_tos_receipt(work, inventory):
    """Bind root's actual complete reads to the stopped runner and current public object identities."""
    proof = rootproof.parse_proof(os.environ.get('MUSE_RELEASE_ROOT_TOS_PROOF'),
        os.environ.get('MUSE_RELEASE_ROOT_TOS_PROOF_SHA256'), SOURCE, inventory)
    previous = api('actions/runs/' + str(rootproof.FAILED_RUN))
    if (previous['status'] != 'completed' or previous['conclusion'] != 'failure'
            or previous['head_sha'] != proof['priorControllerHead']
            or previous['head_branch'] != PRIOR_OPS_BRANCH or previous['event'] != 'push'
            or datetime.fromisoformat(proof['rootCompletedAt'].replace('Z', '+00:00'))
            < datetime.fromisoformat(previous['updated_at'].replace('Z', '+00:00'))):
        raise PublicationError('Root TOS proof does not follow the completely stopped original controller')
    receipt = rootproof.verify_current(proof)
    receipt['proofSha256'] = os.environ['MUSE_RELEASE_ROOT_TOS_PROOF_SHA256']
    log = work / 'tos-root-proof-current.log'
    log.write_text(json.dumps(receipt) + '\n')
    log.chmod(0o600)
    print(json.dumps(receipt), flush=True)


def publish(work, inventory, tos_mode):
    """Verify immutable TOS bytes before feeds, then stable Latest, RC last and both full GitHub readbacks."""
    if tos_mode == 'runner':
        logged_node(['apps/desktop/scripts/publish-muse-tos.mjs', '--version', '1.0.3', '--commit', SOURCE,
                     '--mac-arm64', str(work / 'mac-arm64'), '--win-x64', str(work / 'win-x64')], work / 'tos-publication.log')
    verifier = str(PRIVATE / 'verify-muse-1.0.3-readback.mjs')
    inventory_path = str(work / 'publication.inventory.json')
    if tos_mode != 'root-verified':
        logged_node([verifier, '--inventory', inventory_path, '--tos'], work / 'tos-full-readback.log')
    for tag in TAGS:
        check_assets(release_for_tag(tag), inventory, complete=True)
        argv = ['gh', 'release', 'edit', tag, '--repo', REPOSITORY, '--draft=false',
                '--prerelease=false' if tag == TAGS[0] else '--prerelease', '--latest' if tag == TAGS[0] else '--latest=false']
        command(argv)
    verify_github_public(work, inventory)


def verify_github_public(work, inventory):
    """Fully read both public eleven-file app releases without changing remote state."""
    verifier = str(PRIVATE / 'verify-muse-1.0.3-readback.mjs')
    inventory_path = str(work / 'publication.inventory.json')
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(logged_node, [verifier, '--inventory', inventory_path, '--github-tag', tag],
                               work / ('github-' + tag + '-full-readback.log')) for tag in TAGS]
        for result in results:
            result.result()


def verify_historical_providers(work):
    """Use the verified final stage for both actual historical read-only updater policies."""
    result = subprocess.run([sys.executable, str(PRIVATE / 'run-historical-github-discovery.py'),
        '--staged', str(work / 'publication'), '--utilities', str(PRIVATE),
        '--output', str(work / 'historical-provider-qa')], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    log = work / 'historical-provider-qa.log'
    log.write_text(result.stdout + result.stderr)
    log.chmod(0o600)
    if result.returncode:
        raise PublicationError('Actual historical public discovery failed; inspect the private receipt')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('prepare', 'draft', 'publish', 'verify-public'), default='prepare')
    parser.add_argument('--tos-mode', choices=('runner', 'already-published', 'root-verified'), default='runner')
    args = parser.parse_args()
    require_authorization(args.mode)
    if args.mode == 'verify-public' and args.tos_mode != 'root-verified':
        raise PublicationError('Read-only public verification requires root-verified TOS proof')
    if args.tos_mode == 'root-verified':
        if args.mode not in ('publish', 'verify-public'):
            raise PublicationError('Root proof recovery requires publishing or public verification mode')
        rootproof.require_wire_hash(os.environ.get('MUSE_RELEASE_ROOT_TOS_PROOF'),
            os.environ.get('MUSE_RELEASE_ROOT_TOS_PROOF_SHA256'))
    validate_remote_build()
    work, inventory = prepare()
    if args.tos_mode == 'root-verified':
        verify_root_tos_receipt(work, inventory)
    if args.mode != 'prepare':
        existing = {tag: reconcile_release(tag, inventory) for tag in TAGS}
        if args.tos_mode == 'root-verified':
            for tag in TAGS:
                if existing[tag] is None or tag_commit(tag) != SOURCE:
                    raise PublicationError('Root proof recovery requires both original completed releases and exact tags')
                check_assets(existing[tag], inventory, complete=True)
                if args.mode == 'verify-public' and existing[tag]['draft'] is not False:
                    raise PublicationError('Read-only public verification requires both releases already public')
        else:
            # Tag/draft creation is sequential; upload retries only reconcile, never replace.
            for tag in TAGS:
                upload_draft(tag, inventory, existing[tag])
    if args.mode == 'publish':
        publish(work, inventory, args.tos_mode)
    elif args.mode == 'verify-public':
        verify_github_public(work, inventory)
        verify_historical_providers(work)
    receipt = {'stage': 'controlled-' + args.mode + '-complete', 'sourceCommit': SOURCE, 'version': '1.0.3',
               'files': inventory['files'], 'tosFeeds': inventory['tosFeeds'], 'remoteWritesAuthorized': args.mode in ('draft', 'publish'),
               'tosMode': args.tos_mode, 'rootTosProofSha256': os.environ.get('MUSE_RELEASE_ROOT_TOS_PROOF_SHA256')
               if args.tos_mode == 'root-verified' else None}
    (work / 'controlled-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'stage': receipt['stage'], 'sourceCommit': SOURCE, 'files': 11}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (PublicationError, transfer.DownloadError, rootproof.ProofError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Controlled publication failed (' + type(error).__name__ + '); private details suppressed', file=sys.stderr)
        sys.exit(1)

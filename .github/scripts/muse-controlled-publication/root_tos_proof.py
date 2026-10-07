"""Reuse root-reviewed complete TOS reads only while their public objects remain unchanged."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime, parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import re
import ssl
import urllib.error
import urllib.request

BASE = 'https://muse.tos-cn-beijing.volces.com/'
FAILED_RUN = 37583226972
PROOF_STAGE = 'root-tos-publication-and-full-readback-complete'
RETAINED_PROOFS = {
    'original-controller': '6f9a21a5691400479cc2f079dec53c465f3817ef716e0e7dbe2e04d4b08e9f6a',
    'root-windows-first': '471bb55e63dddc5177ee4e8355e23fafdf11fc693a0ed40a40213caf87f45a06',
}


class ProofError(Exception):
    """A safe verification failure that never contains credentials or network response bodies."""


def _unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProofError('Root proof JSON contains duplicate fields')
        result[key] = value
    return result


def require_wire_hash(text, expected_sha256):
    """Reject a missing or modified proof before any remote operation or JSON interpretation."""
    if (not isinstance(text, str) or not isinstance(expected_sha256, str)
            or re.fullmatch(r'[a-f0-9]{64}', expected_sha256) is None
            or hashlib.sha256(text.encode('utf-8')).hexdigest() != expected_sha256):
        raise ProofError('Root TOS proof does not match the reviewed literal SHA-256')


def parse_proof(text, expected_sha256, source, inventory, *, now=None):
    """Verify exact UTF-8 bytes against the reviewed literal, then bind all nine reads to staging."""
    require_wire_hash(text, expected_sha256)
    try:
        proof = json.loads(text, object_pairs_hook=_unique_json)
    except (ValueError, UnicodeError):
        raise ProofError('Root TOS proof JSON is invalid') from None
    top_fields = {'schemaVersion', 'version', 'sourceCommit', 'stage', 'rootCompletedAt',
                  'priorControllerRunId', 'priorControllerHead', 'binaryChecksCompleteBeforeFeeds', 'files', 'objects'}
    if (not isinstance(proof, dict) or set(proof) != top_fields
            or type(proof['schemaVersion']) is not int or proof['schemaVersion'] != 1
            or proof['version'] != '1.0.3' or proof['sourceCommit'] != source
            or proof['stage'] != PROOF_STAGE or proof['binaryChecksCompleteBeforeFeeds'] is not True
            or type(proof['priorControllerRunId']) is not int or proof['priorControllerRunId'] != FAILED_RUN
            or not isinstance(proof['priorControllerHead'], str)
            or re.fullmatch(r'[a-f0-9]{40}', proof['priorControllerHead']) is None):
        raise ProofError('Root TOS proof source, completion or prior controller differs')
    try:
        completed = datetime.fromisoformat(proof['rootCompletedAt'].replace('Z', '+00:00'))
    except (ValueError, TypeError, AttributeError):
        raise ProofError('Root proof completion time is invalid') from None
    current = now or datetime.now(timezone.utc)
    if (completed.tzinfo is None or completed.utcoffset() != timedelta(0)
            or completed < current - timedelta(hours=4) or completed > current + timedelta(minutes=5)):
        raise ProofError('Root proof completion time is stale or outside the permitted clock interval')
    expected_files = {f['filename']: {'name': f['filename'], 'size': f['size'], 'sha256': f['sha256']}
                      for f in inventory['files']}
    files = proof['files']
    if (len(expected_files) != 11 or not isinstance(files, list) or len(files) != 11
            or any(not isinstance(f, dict) or set(f) != {'name', 'size', 'sha256'}
                   or not isinstance(f['name'], str) or type(f['size']) is not int
                   for f in files)
            or len({f['name'] for f in files}) != 11
            or {f['name']: f for f in files} != expected_files):
        raise ProofError('Root proof does not match all eleven staged files')
    expected = {f['tosKey']: {'kind': 'binary', 'size': f['size'], 'sha256': f['sha256']}
                for f in inventory['files'] if 'tosKey' in f}
    expected.update({f['key']: {'kind': 'feed', 'size': f['size'], 'sha256': f['sha256']}
                     for f in inventory['tosFeeds']})
    if len(expected) != 9 or sum(f['kind'] == 'binary' for f in expected.values()) != 5:
        raise ProofError('Staged TOS inventory differs from the fixed five binaries and four feeds')
    objects = proof['objects']
    fields = {'kind', 'key', 'url', 'size', 'sha256', 'etag', 'lastModified', 'fullBodyVerified',
              'proofOrigin', 'proofSha256', 'identityProofOrigin'}
    seen = set()
    if not isinstance(objects, list) or len(objects) != 9:
        raise ProofError('Root proof must contain exactly nine complete public body reads')
    for obj in objects:
        if (not isinstance(obj, dict) or set(obj) != fields or not isinstance(obj['key'], str)
                or obj['key'] in seen or obj['key'] not in expected):
            raise ProofError('Root proof has an extra, duplicate or incomplete object')
        seen.add(obj['key'])
        spec = expected[obj['key']]
        expected_origin = ('original-controller' if obj['key'].endswith('.dmg') else
                           'root-windows-first' if obj['key'].endswith('.exe') else 'root-local-recovery')
        expected_identity = ('root-full-body-get' if expected_origin == 'root-local-recovery'
                             else 'root-current-head-and-local-md5')
        if (obj['kind'] != spec['kind'] or obj['url'] != BASE + obj['key']
                or type(obj['size']) is not int or obj['size'] != spec['size']
                or obj['sha256'] != spec['sha256'] or obj['fullBodyVerified'] is not True
                or obj['proofOrigin'] != expected_origin or obj['identityProofOrigin'] != expected_identity
                or not isinstance(obj['proofSha256'], str)
                or re.fullmatch(r'[a-f0-9]{64}', obj['proofSha256']) is None
                or not isinstance(obj['etag'], str) or re.fullmatch(r'"[a-fA-F0-9]{32}"', obj['etag']) is None):
            raise ProofError('Root proof body, URL, hash or verification source differs')
        if expected_origin in RETAINED_PROOFS and obj['proofSha256'] != RETAINED_PROOFS[expected_origin]:
            raise ProofError('Retained full-read proof differs from the actual controller or Windows receipt')
        try:
            modified = parsedate_to_datetime(obj['lastModified'])
            if format_datetime(modified, usegmt=True) != obj['lastModified']:
                raise ValueError('Noncanonical public date')
        except (ValueError, TypeError, AttributeError):
            raise ProofError('Root proof public modification time is invalid') from None
    if seen != set(expected):
        raise ProofError('Root proof omits a required TOS object')
    return proof


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def request_object(method, url, etag, limit):
    """Read only exact public URLs with TLS and If-Match; never send authorization or follow redirects."""
    ca_file = '/etc/ssl/cert.pem' if Path('/etc/ssl/cert.pem').is_file() else None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)))
    request = urllib.request.Request(url, method=method,
        headers={'If-Match': etag, 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
    try:
        with opener.open(request, timeout=30) as response:
            return {'status': response.status, 'etag': response.headers.get('ETag'),
                    'lastModified': response.headers.get('Last-Modified'),
                    'size': response.headers.get('Content-Length'),
                    'body': response.read(limit + 1) if method == 'GET' else b''}
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ProofError('Current public TOS object could not be checked') from None


def verify_current(proof, *, request=request_object):
    """Require current metadata for nine proven bodies and freshly hash all four small mutable feeds."""
    def check(response, obj):
        try:
            size = int(response['size'])
        except (ValueError, TypeError, KeyError):
            raise ProofError('Current public TOS size is invalid') from None
        if (response['status'] != 200 or size != obj['size']
                or response['etag'] != obj['etag'] or response['lastModified'] != obj['lastModified']):
            raise ProofError('Current public TOS object changed after its complete verified read')
    for obj in proof['objects']:
        check(request('HEAD', obj['url'], obj['etag'], 0), obj)
    for obj in proof['objects']:
        if obj['kind'] != 'feed':
            continue
        response = request('GET', obj['url'], obj['etag'], obj['size'])
        check(response, obj)
        body = response['body']
        if len(body) != obj['size'] or hashlib.sha256(body).hexdigest() != obj['sha256']:
            raise ProofError('Current public TOS feed bytes differ from the proven body')
    return {'stage': 'root-tos-proof-current-verified', 'priorFullBodyReads': 9,
            'currentMetadataMatches': 9, 'currentFeedFullHashMatches': 4,
            'sourceCommit': proof['sourceCommit']}

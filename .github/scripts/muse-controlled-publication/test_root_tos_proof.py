"""Offline checks for trusted root body evidence and conditional current public reads."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
import hashlib
import json
import unittest
from unittest.mock import patch

import root_tos_proof as proof

SOURCE = 'f' * 40


def fixture():
    files = []
    bodies = {}
    for target, names in (('mac-arm64', ('.dmg', '.zip', '.zip.blockmap')),
                          ('win-x64', ('.exe', '.exe.blockmap'))):
        for suffix in names:
            name = 'muse-med-1.0.3-' + target + suffix
            body = ('synthetic:' + name).encode()
            key = 'releases/1.0.3/' + target + '/' + name
            bodies[key] = body
            files.append({'filename': name, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'tosKey': key})
    for name in ('latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml', 'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt'):
        body = ('synthetic:' + name).encode()
        files.append({'filename': name, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    feeds = []
    for target, names in (('mac-arm64', ('latest-mac.yml', 'rc-mac.yml')), ('win-x64', ('latest.yml', 'rc.yml'))):
        for name in names:
            key = 'releases/feeds/' + target + '/' + name
            body = ('version: 1.0.3\n# synthetic ' + key).encode()
            bodies[key] = body
            feeds.append({'key': key, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    now = datetime.now(timezone.utc)
    objects = []
    for file in [*files[:5], *feeds]:
        key = file.get('tosKey', file.get('key'))
        origin = ('original-controller' if key.endswith('.dmg') else
                  'root-windows-first' if key.endswith('.exe') else 'root-local-recovery')
        objects.append({'kind': 'binary' if 'tosKey' in file else 'feed', 'key': key,
            'url': proof.BASE + key, 'size': file['size'], 'sha256': file['sha256'],
            'etag': '"' + hashlib.md5(bodies[key]).hexdigest() + '"',
            'lastModified': format_datetime(now.replace(microsecond=0), usegmt=True),
            'fullBodyVerified': True, 'proofOrigin': origin,
            'proofSha256': proof.RETAINED_PROOFS.get(origin, 'a' * 64),
            'identityProofOrigin': 'root-full-body-get' if origin == 'root-local-recovery' else 'root-current-head-and-local-md5'})
    receipt = {'schemaVersion': 1, 'version': '1.0.3', 'sourceCommit': SOURCE, 'stage': proof.PROOF_STAGE,
        'rootCompletedAt': now.isoformat(), 'priorControllerRunId': proof.FAILED_RUN,
        'priorControllerHead': 'e' * 40, 'binaryChecksCompleteBeforeFeeds': True,
        'files': [{'name': f['filename'], 'size': f['size'], 'sha256': f['sha256']} for f in files], 'objects': objects}
    return receipt, {'files': files, 'tosFeeds': feeds}, bodies, now


def parse(receipt, inventory, now):
    text = json.dumps(receipt, indent=2) + '\n'
    return proof.parse_proof(text, hashlib.sha256(text.encode()).hexdigest(), SOURCE, inventory, now=now)


class ProofTests(unittest.TestCase):
    def test_literal_hash_rejects_missing_different_or_appended_wire_bytes(self):
        receipt, inventory, _, now = fixture()
        text = json.dumps(receipt)
        sha = hashlib.sha256(text.encode()).hexdigest()
        for wire, digest in ((None, sha), (text, 'ROOT_PROOF_PENDING'), (text, '0' * 64), (text + '\n', sha)):
            with self.assertRaises(proof.ProofError):
                proof.parse_proof(wire, digest, SOURCE, inventory, now=now)

    def test_valid_root_proof_binds_nine_bodies_and_eleven_files(self):
        receipt, inventory, _, now = fixture()
        self.assertEqual(parse(receipt, inventory, now), receipt)

    def test_source_completion_failure_binding_and_partial_stage_are_rejected(self):
        receipt, inventory, _, now = fixture()
        for field, wrong in (('schemaVersion', True), ('version', '1.0.2'), ('sourceCommit', 'd' * 40),
                             ('stage', 'pending'), ('binaryChecksCompleteBeforeFeeds', False),
                             ('priorControllerRunId', 1), ('priorControllerHead', 'wrong'),
                             ('rootCompletedAt', (now - timedelta(hours=5)).isoformat()),
                             ('rootCompletedAt', (now + timedelta(hours=1)).isoformat()), ('rootCompletedAt', 'bad')):
            changed = deepcopy(receipt); changed[field] = wrong
            with self.subTest(field=field), self.assertRaises(proof.ProofError):
                parse(changed, inventory, now)

    def test_file_inventory_rejects_changed_duplicate_extra_or_missing_files(self):
        receipt, inventory, _, now = fixture()
        variants = []
        changed = deepcopy(receipt); changed['files'][0]['sha256'] = '0' * 64; variants.append(changed)
        changed = deepcopy(receipt); changed['files'][0] = changed['files'][1]; variants.append(changed)
        changed = deepcopy(receipt); changed['files'].append(changed['files'][0]); variants.append(changed)
        changed = deepcopy(receipt); changed['files'].pop(); variants.append(changed)
        for changed in variants:
            with self.assertRaises(proof.ProofError): parse(changed, inventory, now)

    def test_objects_reject_duplicates_missing_extra_or_wrong_body_identity(self):
        receipt, inventory, _, now = fixture()
        for field, wrong in (('key', 'unexpected'), ('url', proof.BASE + 'wrong'), ('size', 1), ('size', True),
                             ('sha256', '0' * 64), ('kind', 'feed'), ('fullBodyVerified', False),
                             ('proofOrigin', 'root-local-recovery'), ('identityProofOrigin', 'root-full-body-get'),
                             ('proofSha256', '0' * 64), ('etag', 'W/"' + 'a' * 32 + '"'),
                             ('lastModified', 'yesterday')):
            changed = deepcopy(receipt); changed['objects'][0][field] = wrong
            with self.subTest(field=field), self.assertRaises(proof.ProofError): parse(changed, inventory, now)
        for change in ('missing', 'extra', 'duplicate'):
            changed = deepcopy(receipt)
            if change == 'missing': changed['objects'].pop()
            elif change == 'extra': changed['objects'].append(changed['objects'][0])
            else: changed['objects'][0] = changed['objects'][1]
            with self.assertRaises(proof.ProofError): parse(changed, inventory, now)

    def test_duplicate_json_fields_are_rejected_even_when_literal_hash_matches(self):
        receipt, inventory, _, now = fixture()
        text = json.dumps(receipt).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')
        with self.assertRaises(proof.ProofError):
            proof.parse_proof(text, hashlib.sha256(text.encode()).hexdigest(), SOURCE, inventory, now=now)

    def test_current_reads_use_nine_conditional_heads_and_only_four_small_feed_gets(self):
        receipt, inventory, bodies, now = fixture(); receipt = parse(receipt, inventory, now)
        observed = []
        def request(method, url, etag, limit):
            obj = next(x for x in receipt['objects'] if x['url'] == url)
            observed.append((method, obj['kind'], etag, limit))
            return {'status': 200, 'etag': obj['etag'], 'lastModified': obj['lastModified'],
                    'size': str(obj['size']), 'body': bodies[obj['key']] if method == 'GET' else b''}
        result = proof.verify_current(receipt, request=request)
        self.assertEqual(result['currentMetadataMatches'], 9)
        self.assertEqual(result['currentFeedFullHashMatches'], 4)
        self.assertEqual([x[0] for x in observed], ['HEAD'] * 9 + ['GET'] * 4)
        self.assertTrue(all(kind == 'feed' for method, kind, _, _ in observed if method == 'GET'))
        self.assertTrue(all(limit < 1024 for method, _, _, limit in observed if method == 'GET'))

    def test_changed_or_ignored_conditional_metadata_prevents_acceptance(self):
        receipt, _, _, _ = fixture()
        obj = receipt['objects'][0]
        valid = {'status': 200, 'etag': obj['etag'], 'lastModified': obj['lastModified'], 'size': str(obj['size']), 'body': b''}
        for field, wrong in (('status', 412), ('status', 302), ('etag', '"' + '0' * 32 + '"'),
                             ('lastModified', 'different'), ('size', '0')):
            with self.subTest(field=field), self.assertRaises(proof.ProofError):
                proof.verify_current(receipt, request=lambda *args: {**valid, field: wrong})

    def test_changed_truncated_or_extra_feed_body_prevents_acceptance(self):
        receipt, _, bodies, _ = fixture()
        for change in ('different', 'short', 'extra'):
            def request(method, url, etag, limit):
                obj = next(x for x in receipt['objects'] if x['url'] == url)
                body = bodies[obj['key']]
                if method == 'GET':
                    body = (b'x' * len(body) if change == 'different' else body[:-1] if change == 'short' else body + b'x')
                return {'status': 200, 'etag': obj['etag'], 'lastModified': obj['lastModified'], 'size': str(obj['size']), 'body': body}
            with self.subTest(change=change), self.assertRaises(proof.ProofError):
                proof.verify_current(receipt, request=request)


if __name__ == '__main__': unittest.main()

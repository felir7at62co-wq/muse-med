"""Deterministic artifacts and independent systemd review timing without installing host units."""

from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from build import build
import deploy


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name).resolve()
        self.config=json.loads(Path(__file__).with_name('policy.example.json').read_text())

    def unpack(self,path,target):
        target.mkdir()
        with tarfile.open(path) as archive:
            for item in archive:
                self.assertEqual(Path(item.name).name,item.name)
                with archive.extractfile(item) as handle:(target/item.name).write_bytes(handle.read())

    def test_build_is_reproducible_and_every_packaged_file_is_verified(self):
        first=build(self.root/'first.tgz');second=build(self.root/'second.tgz')
        self.assertEqual(first['sha256'],second['sha256'])
        target=self.root/'release';self.unpack(first['archive'],target)
        self.assertEqual(deploy.verify_bundle(target)['code'],first['code'])
        rebuilt=subprocess.run([sys.executable,str(target/'build.py'),'--output',str(self.root/'rebuilt.tgz')],capture_output=True,text=True,timeout=10,check=True)
        self.assertEqual(json.loads(rebuilt.stdout)['sha256'],first['sha256'])
        with (target/'policy.py').open('ab') as handle:handle.write(b'\n# changed\n')
        with self.assertRaises(ValueError):deploy.verify_bundle(target)

    def test_extra_code_and_symbolic_links_in_a_release_are_rejected(self):
        artifact=build(self.root/'release.tgz');target=self.root/'release';self.unpack(artifact['archive'],target)
        extra=target/'extra.py';extra.write_text('unexpected')
        with self.assertRaises(ValueError):deploy.verify_bundle(target)
        extra.unlink()
        source=target/'inventory.py';outside=self.root/'other.py';source.rename(outside);source.symlink_to(outside)
        with self.assertRaises(ValueError):deploy.verify_bundle(target)

    def test_review_waits_a_full_day_and_gap_allowance_and_does_not_change_media_units(self):
        due,files=deploy.units('/opt/muse/host-retention/releases/'+'a'*16,'/etc/muse/host-retention/policy.json','/var/lib/muse-host-retention/qualification.json',100000,self.config)
        self.assertEqual(datetime.fromisoformat(due).timestamp(),100000+86400+600)
        self.assertEqual(set(files),{'observe.service','observe.timer','review.service','review.timer'})
        self.assertIn('OnUnitActiveSec=300s',files['observe.timer'])
        self.assertIn('Persistent=true',files['review.timer'])
        self.assertTrue(all('media-retention' not in value for value in files.values()))
        self.assertIn('promote --policy',files['review.service'])

    def test_unit_arguments_cannot_add_systemd_lines_or_expansions(self):
        for path in ('relative','/opt/bad path','/opt/bad%path','/opt/bad\nExecStart=other'):
            with self.assertRaises(ValueError):deploy.units(path,'/policy','/qualification',100000,self.config)

    def test_existing_policy_is_never_reset_by_install(self):
        fake='/opt/muse/host-retention/releases/'+'a'*16+'/deploy.py'
        with patch.object(deploy.os,'geteuid',return_value=0),patch.object(deploy,'__file__',fake),patch.object(Path,'exists',return_value=True),patch.object(deploy.subprocess,'run') as execute:
            with self.assertRaisesRegex(ValueError,'preview-already-prepared'):deploy.install()
            execute.assert_not_called()

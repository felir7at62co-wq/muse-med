"""Seal the explicitly configured local helper; never connect or start native work."""
from pathlib import Path
import hashlib
import json
import re

ROOT=Path(__file__).resolve().parent
FILES=('config.json','enable-target-debug.js','remote_wire.py','native_rpc.py','run-native-identity.py',
    'operations/__init__.py','operations/fixed_operations.py','operations/fixed-operation.js',
    '../run-observation.py','../config.json','../windows-observation-attempt2.receipt.json',
    'windows-launch-diagnostic.receipt.json','persistent_media.py','download_media.py','secure_media_receipt.py','post_upgrade_peer.py')

def main():
    manifest={'version':1,'files':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in FILES}}
    raw=(json.dumps(manifest,indent=2)+'\n').encode()
    target=ROOT/'helper-manifest.json';target.write_bytes(raw);target.chmod(0o600)
    host=ROOT/'run-persistent-host.py'
    text,count=re.subn(r"EXPECTED_MODULE_MANIFEST_SHA256='[^']+'",'EXPECTED_MODULE_MANIFEST_SHA256='+repr(hashlib.sha256(raw).hexdigest()),host.read_text())
    if count!=1:raise RuntimeError('host-manifest-marker-invalid')
    host.write_text(text);digest=hashlib.sha256(host.read_bytes()).hexdigest()
    private=ROOT/'adapter-test.private.json'
    if private.exists():
        config=json.loads(private.read_text());config['helperSha256']=digest
        private.write_text(json.dumps(config,indent=2)+'\n');private.chmod(0o600)
    print(json.dumps({'sealedModules':len(FILES),'helperSHA256':digest}))

if __name__=='__main__':main()

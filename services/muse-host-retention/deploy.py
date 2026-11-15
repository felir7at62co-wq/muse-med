"""Qualify an immutable release and install independent host preview and review timers."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from engine import Engine, atomic, code_hash
from policy import load


def verify_bundle(release):
    """Reject changed files, extra code and links before runtime qualification."""
    release=Path(release)
    manifest=json.loads((release/'bundle-inputs.json').read_text())
    actual={p.name for p in release.iterdir() if p.is_file() and p.suffix in ('.py','.json','.md','.yaml') and p.name!='bundle-inputs.json'}
    if actual!=set(manifest['files']) or manifest['code']!=code_hash():
        raise ValueError('bundle-file-set-or-code-changed')
    for name,expected in manifest['files'].items():
        if Path(name).name!=name or (release/name).is_symlink() or hashlib.sha256((release/name).read_bytes()).hexdigest()!=expected:
            raise ValueError('bundle-file-changed')
    return manifest


def units(release,policy,qualification,first,config):
    """Schedule review after the first real observation; observation gaps still prevent activation."""
    for path in (release,policy,qualification):
        if not Path(path).is_absolute() or any(char in str(path) for char in '\n\r%"\\ '):
            raise ValueError('unsafe-systemd-path')
    due=datetime.fromtimestamp(first+config['preview_seconds']+config['maximum_gap_seconds'],timezone.utc)
    common=f'''[Service]
Type=oneshot
UMask=0077
NoNewPrivileges=true
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=240
WorkingDirectory={release}
'''
    observe=f'''[Unit]
Description=Inventory Muse host releases and archived logs
After=docker.service nginx.service

{common}ExecStart=/usr/bin/python3 {release}/cli.py observe --policy {policy}
'''
    timer=f'''[Unit]
Description=Periodic Muse host retention observation

[Timer]
OnBootSec=1min
OnUnitActiveSec={config['interval_seconds']}s
AccuracySec=1s
Unit=muse-host-retention-observe.service

[Install]
WantedBy=timers.target
'''
    review=f'''[Unit]
Description=Qualify 24-hour Muse host preview before enabling cleanup
After=docker.service nginx.service

{common}ExecStart=/usr/bin/python3 {release}/cli.py promote --policy {policy} --qualification {qualification}
'''
    review_timer=f'''[Unit]
Description=One-time Muse host retention review

[Timer]
OnCalendar={due.strftime('%Y-%m-%d %H:%M:%S')} UTC
AccuracySec=1s
Persistent=true
Unit=muse-host-retention-review.service

[Install]
WantedBy=timers.target
'''
    return due.isoformat(),{'observe.service':observe,'observe.timer':timer,'review.service':review,'review.timer':review_timer}


def install():
    """A fresh deployment never replaces an existing policy or resets its preview history."""
    if os.geteuid()!=0:raise ValueError('root-required')
    release=Path(__file__).resolve().parent
    if release.parent!=Path('/opt/muse/host-retention/releases') or not re.fullmatch('[a-f0-9]{16}',release.name):
        raise ValueError('immutable-release-required')
    policy_file=Path('/etc/muse/host-retention/policy.json')
    state=Path('/var/lib/muse-host-retention')
    if policy_file.exists() or (state/'audit.sqlite3').exists():
        raise ValueError('preview-already-prepared-inspect-before-resuming')
    manifest=verify_bundle(release)
    result=subprocess.run([sys.executable,'-m','unittest','discover','-s',str(release),'-p','test_*.py'],capture_output=True,text=True,timeout=120)
    count=re.search(r'Ran ([0-9]+) tests?\b',result.stderr)
    if result.returncode or not count or int(count.group(1))<=0:
        raise ValueError('server-isolation-tests-failed')
    config=load(release/'policy.example.json')
    if config['mode']!='dry-run' or config['state_dir']!=str(state):raise ValueError('fresh-dry-run-required')
    atomic(policy_file,config)
    qualification=state/'qualification.json'
    atomic(qualification,{'code':manifest['code'],'passed':True,'tests':int(count.group(1)),'files':manifest['files']})
    engine=Engine(policy_file)
    try:
        first_result=engine.tick()
        if first_result.get('error'):raise ValueError('initial-reference-scan-failed')
        first=engine.db.execute('SELECT MIN(at) FROM observations').fetchone()[0]
    finally:engine.close()
    due,generated=units(release,policy_file,qualification,first,config)
    paths=[]
    for suffix,body in generated.items():
        path=Path('/etc/systemd/system')/('muse-host-retention-'+suffix)
        if path.exists():raise ValueError('host-timer-already-installed')
        path.write_text(body);paths.append(str(path))
    subprocess.run(['systemd-analyze','verify',*paths],check=True,capture_output=True,text=True)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','muse-host-retention-observe.timer','muse-host-retention-review.timer'],check=True,capture_output=True)
    receipt={'state':'dry-run','code':manifest['code'],'tests':int(count.group(1)),'first_observed':first,'review_due':due,'release':str(release),'initial':first_result}
    atomic(state/'deployment.json',receipt)
    return receipt


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('install',))
    parser.parse_args()
    result=install()
    print(json.dumps({key:value for key,value in result.items() if key!='initial'}))

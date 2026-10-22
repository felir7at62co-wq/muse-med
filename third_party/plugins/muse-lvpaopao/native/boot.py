"""Prepare one exact supported local native helper without user-written process configuration."""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import shutil
import stat
import struct
import subprocess
import sys
import threading
import time

EXPECTED_APP_ID='wx404dde55fb12df78'
MIN_LIFETIME_MS=60000
MAX_LIFETIME_MS=14400000
DEPENDENCIES={'frida':'17.24.2','protobuf':'7.36.2','websockets':'17.2'}
PROFILE={'expectedAppId':EXPECTED_APP_ID,'executableSHA256':'cea46b7485ff64dbd802da32811318a8844e55ce6cb3bb49325f31ebdb50f0ae','moduleSHA256':'60630cc1ba346b0e485fbf1981a07a650d1566e004c5b2b84933544860e2b3cf','loadStartRva':47086832,'expectedEntryBytes':'415741565657534881ec9001000089d34889ce833d469bf00a020f8ff9010000','cdpFilterRva':60262864,'expectedFilterEntryBytes':'5657534881ec900000004889ce488b05dc57110a4831e048898424880000000f','maxCallbacks':4096,'expectedScenes':[1183,1256],'allowDefaultIdentityRead':True,'postUpgradeAuthorization':True,'downloadEnabled':True}
RUNTIME_FILES=('passive-probe/run-observation.py','passive-probe/observe-launch.js','passive-probe/next-stage/enable-target-debug.js','passive-probe/next-stage/enable-target-debug-25799.js','passive-probe/next-stage/runtime_profiles.py','passive-probe/next-stage/remote_wire.py','passive-probe/next-stage/native_rpc.py','passive-probe/next-stage/run-native-identity.py','passive-probe/next-stage/run-persistent-host.py','passive-probe/next-stage/operations/__init__.py','passive-probe/next-stage/operations/fixed_operations.py','passive-probe/next-stage/operations/fixed-operation.js','passive-probe/next-stage/persistent_media.py','passive-probe/next-stage/download_media.py','passive-probe/next-stage/secure_media_receipt.py','passive-probe/next-stage/mac_media_protector.py','passive-probe/next-stage/mac_runtime.py','passive-probe/next-stage/enable-target-debug-mac-269602.js','passive-probe/next-stage/post_upgrade_peer.py')
STOP=threading.Event()


class SetupFailure(RuntimeError):
    """A fixed code only; subprocess text, command lines and private paths stay private."""


def _regular(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or getattr(info,'st_file_attributes',0)&0x400:
        raise SetupFailure('setup-resource-invalid')
    return info


def _directory(path):
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
        raise SetupFailure('setup-directory-invalid')


def _owned_path(path):
    value=Path(path)
    if not value.is_absolute():raise SetupFailure('setup-directory-invalid')
    for part in (value,*value.parents):
        if part.exists() or part.is_symlink():_directory(part)
    return value


def _write(path,raw):
    if path.exists() or path.is_symlink():_regular(path)
    temporary=path.with_name('.pending-'+secrets.token_hex(12))
    try:
        descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def check_dependencies():
    """Reject missing or unqualified instrumentation packages before discovery or staging."""
    for name,version in DEPENDENCIES.items():
        try:actual=importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:raise SetupFailure('setup-dependency-missing') from None
        if actual!=version:raise SetupFailure('setup-dependency-version-mismatch')
    check_media_tools()


def check_media_tools():
    """Use trusted Host media paths when supplied, otherwise native executable lookup."""
    for environment,name in (('DSH_FFMPEG_PATH','ffmpeg.exe' if sys.platform=='win32' else 'ffmpeg'),('DSH_FFPROBE_PATH','ffprobe.exe' if sys.platform=='win32' else 'ffprobe')):
        explicit=os.environ.get(environment)
        resolved=explicit if explicit else shutil.which(name)
        if not resolved or not Path(resolved).is_absolute() or not Path(resolved).is_file() or not os.access(resolved,os.X_OK):
            raise SetupFailure('setup-media-tools-missing')


def _stop_child(process):
    if process.poll() is not None:return
    try:process.terminate()
    except OSError:pass
    try:process.communicate(timeout=2)
    except (OSError,subprocess.TimeoutExpired):
        try:process.kill()
        except OSError:pass
        try:process.communicate(timeout=5)
        except (OSError,subprocess.TimeoutExpired):raise SetupFailure('setup-child-cleanup-failed') from None


def powershell(script):
    """Read bounded process metadata and reap the owned PowerShell child before returning."""
    encoded=base64.b64encode(script.encode('utf-16le')).decode()
    executable=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32'/'WindowsPowerShell'/'v1.0'/'powershell.exe'
    if not executable.is_absolute():raise SetupFailure('setup-powershell-unavailable')
    try:process=subprocess.Popen([str(executable),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    except OSError:raise SetupFailure('setup-powershell-unavailable') from None
    deadline=time.monotonic()+20
    try:
        while True:
            if STOP.is_set():raise SetupFailure('setup-cancelled')
            remaining=deadline-time.monotonic()
            if remaining<=0:raise SetupFailure('setup-discovery-timeout')
            try:stdout,_stderr=process.communicate(timeout=min(0.2,remaining))
            except subprocess.TimeoutExpired:continue
            if process.returncode!=0 or len(stdout)>1024*1024:raise SetupFailure('setup-discovery-failed')
            try:return json.loads(stdout.decode('utf-8-sig'))
            except (UnicodeError,ValueError):raise SetupFailure('setup-discovery-invalid') from None
    finally:_stop_child(process)


def discover_target():
    """Select a verified active root; target identity is still required at launch and RPC."""
    script=r"""$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$all=@(Get-CimInstance Win32_Process -Filter "Name='WeChatAppEx.exe'");
$rows=@(); $unsupported=0;
$profiles=ConvertFrom-Json -InputObject 'PROFILE_ROWS';
$roots=@($all | Where-Object { ([string]$_.CommandLine) -notmatch '--type=' });
foreach ($root in $roots) {
 $children=@($all | Where-Object { $_.ParentProcessId -eq $root.ProcessId });
 $renderers=@($children | Where-Object { ([string]$_.CommandLine) -match '--type=renderer' });
 if ($renderers.Count -eq 0) { continue };
 $owner=Invoke-CimMethod -InputObject $root -MethodName GetOwnerSid;
 if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue };
 $matches=@($children | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('TARGET_APP_ID') });
 $foreign=0;
 foreach ($candidate in $children) { foreach ($match in [regex]::Matches([string]$candidate.CommandLine,'wx[a-f0-9]{16}')) { if ($match.Value -ne 'TARGET_APP_ID') { $foreign++ } } };
 if ($matches.Count -gt 1 -or $foreign -ne 0) { continue };
 $modules=@((Get-Process -Id $root.ProcessId -ErrorAction Stop).Modules | Where-Object { $_.ModuleName -ieq 'flue.dll' });
 if ($modules.Count -ne 1) { continue };
 $exeHash=(Get-FileHash -LiteralPath $root.ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant();
 $moduleHash=(Get-FileHash -LiteralPath $modules[0].FileName -Algorithm SHA256).Hash.ToLowerInvariant();
 $profile=@($profiles | Where-Object { $_.executableSHA256 -eq $exeHash -and $_.moduleSHA256 -eq $moduleHash });
 if ($profile.Count -ne 1) { $unsupported++; continue };
 $row=[pscustomobject]@{ rootPid=[int]$root.ProcessId;rootCreatedUtc=$root.CreationDate.ToUniversalTime().ToString('o');sessionId=[int]$root.SessionId;executablePath=$root.ExecutablePath;modulePath=$modules[0].FileName;targetRendererCount=$matches.Count;foreignAppIdCount=$foreign;sameUser=$true;runtimeProfile=$profile[0].name };
 if ($matches.Count -eq 0) { $row | Add-Member -NotePropertyName targetLaunchCandidate -NotePropertyValue $true };
 $rows += $row;
};
$exact=@($rows | Where-Object { $_.targetRendererCount -eq 1 });
if ($exact.Count -eq 1) { $rows=$exact };
[pscustomobject]@{candidates=@($rows);unsupportedRootCount=$unsupported}|ConvertTo-Json -Compress -Depth 5
""".replace('TARGET_APP_ID',EXPECTED_APP_ID).replace('PROFILE_ROWS',json.dumps([{'name':name,'executableSHA256':p['executableSHA256'],'moduleSHA256':p['moduleSHA256']} for name,p in _profiles().items()],separators=(',',':')))
    result=powershell(script)
    if not isinstance(result,dict) or set(result)!={'candidates','unsupportedRootCount'} or type(result['unsupportedRootCount']) is not int or result['unsupportedRootCount']<0:
        raise SetupFailure('setup-discovery-invalid')
    if not result['candidates'] and result['unsupportedRootCount']>0:raise SetupFailure('setup-wechat-version-unsupported')
    return select_target(result['candidates'])


def select_target(rows):
    """Accept one exact observed target; ambiguous roots are never selected implicitly."""
    if not isinstance(rows,list):raise SetupFailure('setup-discovery-invalid')
    if not rows:return None
    if len(rows)!=1:raise SetupFailure('setup-target-ambiguous')
    row=rows[0]
    keys={'rootPid','rootCreatedUtc','sessionId','executablePath','modulePath','targetRendererCount','foreignAppIdCount','sameUser'}
    if (not isinstance(row,dict) or set(row) - {'targetLaunchCandidate','runtimeProfile'} != keys or type(row['rootPid']) is not int or row['rootPid']<1 or type(row['sessionId']) is not int or row['sessionId']<0
            or not isinstance(row['rootCreatedUtc'],str) or re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z',row['rootCreatedUtc']) is None
            or row['sameUser'] is not True or type(row['targetRendererCount']) is not int or row['targetRendererCount'] not in (0,1)
            or (row['targetRendererCount']==0) != (row.get('targetLaunchCandidate') is True) or 'targetLaunchCandidate' in row and row['targetLaunchCandidate'] is not True or type(row['foreignAppIdCount']) is not int or row['foreignAppIdCount']!=0
            or any(not isinstance(row[key],str) or re.fullmatch(r'[A-Za-z]:[\\/][^\x00\r\n]+',row[key]) is None for key in ('executablePath','modulePath'))
            or not row['executablePath'].lower().endswith('\\wechatappex.exe') and not row['executablePath'].lower().endswith('/wechatappex.exe')
            or not row['modulePath'].lower().endswith('\\flue.dll') and not row['modulePath'].lower().endswith('/flue.dll')):
        raise SetupFailure('setup-discovery-invalid')
    if 'runtimeProfile' in row and (not isinstance(row['runtimeProfile'],str) or row['runtimeProfile'] not in _profiles()):raise SetupFailure('setup-discovery-invalid')
    target={key:row[key] for key in ('rootPid','rootCreatedUtc','sessionId','executablePath','modulePath')}
    if 'runtimeProfile' in row:target['runtimeProfile']=row['runtimeProfile']
    if row.get('targetLaunchCandidate') is True:target['targetLaunchCandidate']=True
    return target


def _digest(path):
    _regular(path)
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def verify_runtime(target):
    """Pin the observed executable and DLL to the already qualified Windows build."""
    profile=_target_profile(target)
    for field,digest in (('executablePath',profile['executableSHA256']),('modulePath',profile['moduleSHA256'])):
        if _digest(Path(target[field]))!=digest:raise SetupFailure('setup-wechat-version-unsupported')


def _load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def _profiles():
    return _load(Path(__file__).parent/'passive-probe'/'next-stage'/'runtime_profiles.py','muse_lvpaopao_profiles').PROFILES


def _target_profile(target):
    name=target.get('runtimeProfile','wmpf-25560')
    if name=='macos-269602-isolated':return _mac_runtime().PROFILE
    profiles=_profiles()
    if not isinstance(name,str) or name not in profiles:raise SetupFailure('setup-wechat-version-unsupported')
    return profiles[name]


def _mac_runtime():
    return _load(Path(__file__).parent/'passive-probe'/'next-stage'/'mac_runtime.py','muse_lvpaopao_mac_runtime')


def stage_runtime(resources,home,target,lifetime_ms,*,max_callbacks=4096):
    """Seal a private source copy while preserving prior per-key download directories."""
    if type(lifetime_ms) is not int or not MIN_LIFETIME_MS<=lifetime_ms<=MAX_LIFETIME_MS:raise SetupFailure('setup-lifetime-invalid')
    if type(max_callbacks) is not int or not 1<=max_callbacks<=16384:raise SetupFailure('setup-callback-limit-invalid')
    resources=_owned_path(resources);home=_owned_path(home)
    if resources==home or resources.is_relative_to(home) or home.is_relative_to(resources):raise SetupFailure('setup-directory-invalid')
    for relative in RUNTIME_FILES:
        source=resources/relative;_owned_path(source.parent);_regular(source)
        if source.stat().st_size>1024*1024:raise SetupFailure('setup-resource-invalid')
    home.mkdir(mode=0o700,parents=True,exist_ok=True)
    mac=target.get('runtimeProfile')=='macos-269602-isolated'
    if mac:
        if home.stat().st_uid!=os.getuid():raise SetupFailure('setup-directory-invalid')
        home.chmod(0o700)
    else:
        protector=_load(resources/'passive-probe'/'next-stage'/'secure_media_receipt.py','muse_lvpaopao_boot_receipt').WindowsCurrentUserDpapi()
        protector.secure_directory(home)
    for relative in RUNTIME_FILES:
        source=resources/relative;destination=home/relative
        _owned_path(destination.parent)
        destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        _owned_path(destination.parent);_write(destination,source.read_bytes())
    root=home/'passive-probe'/'next-stage'
    config={**_target_profile(target),**target,'durationMs':lifetime_ms,'maxCallbacks':max_callbacks}
    if mac:_mac_runtime().verify(config)
    else:
        guard=_load(home/'passive-probe'/'run-observation.py','muse_lvpaopao_boot_guard')
        # Candidate roots retain PID/time/session/file checks. The launch hook requires
        # both exact target IDs before writes; PeerGate and RPC recheck target identity.
        guard.require_target(config,allow_missing_renderer=config.get('targetLaunchCandidate',False))
    _write(root/'config.json',(json.dumps(config,indent=2)+'\n').encode())
    relative_names=[os.path.relpath(home/name,root).replace('\\','/') for name in RUNTIME_FILES if not name.endswith('run-persistent-host.py')]
    relative_names.append('config.json')
    manifest={'version':1,'files':{name:_digest((root/name).resolve()) for name in relative_names}}
    raw=(json.dumps(manifest,indent=2)+'\n').encode();_write(root/'helper-manifest.json',raw)
    host=root/'run-persistent-host.py'
    text,count=re.subn(r"EXPECTED_MODULE_MANIFEST_SHA256='[^']+'",'EXPECTED_MODULE_MANIFEST_SHA256='+repr(hashlib.sha256(raw).hexdigest()),host.read_text())
    if count!=1:raise SetupFailure('setup-resource-invalid')
    _write(host,text.encode())
    # No cold-launch or scene attestation is fabricated for candidate roots.
    # Resolving a virtual-environment symlink would discard its installed dependencies.
    return {'transport':'local','localPython':str(Path(sys.executable).absolute()),'localHelper':str(host),'helperSha256':_digest(host),'cwd':str(root),'downloadEnabled':True}


def prepare(resources,home,lifetime_ms,*,discover=discover_target,verify=verify_runtime,stage=stage_runtime,wait=STOP.wait,emit_wait=None,max_callbacks=4096):
    """Wait for a genuine current target, then prepare its private exact-build helper."""
    if type(lifetime_ms) is not int or not MIN_LIFETIME_MS<=lifetime_ms<=MAX_LIFETIME_MS:raise SetupFailure('setup-lifetime-invalid')
    if type(max_callbacks) is not int or not 1<=max_callbacks<=16384:raise SetupFailure('setup-callback-limit-invalid')
    check_dependencies();next_notice=0
    while not STOP.is_set():
        target=discover()
        if target is not None:
            verify(target)
            return stage(resources,home,target,lifetime_ms,max_callbacks=max_callbacks)
        now=time.monotonic()
        if now>=next_notice:
            if emit_wait is not None:emit_wait({'event':'waiting_target'})
            next_notice=now+5
        if wait(1):break
    raise SetupFailure('setup-cancelled')


def prepare_mac(resources,home,lifetime_ms,*,emit_wait=None,max_callbacks=4096):
    """Prepare an already isolated, logged-in Mac copy; never modify or launch ordinary WeChat."""
    runtime=_mac_runtime()
    def discover():
        try:target=runtime.discover()
        except runtime.MacRuntimeFailure as error:
            code=str(error)
            raise SetupFailure(code if code in ('mac-runtime-build-unsupported','mac-runtime-home-invalid') else 'setup-required') from None
        if target is None:raise SetupFailure('mac-isolated-wechat-required')
        return target
    return prepare(resources,home,lifetime_ms,discover=discover,verify=runtime.verify,emit_wait=emit_wait,max_callbacks=max_callbacks)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepare',action='store_true',required=True);parser.add_argument('--home',required=True);parser.add_argument('--resources',required=True);parser.add_argument('--lifetime-ms',type=int,default=3600000);parser.add_argument('--max-callbacks',type=int,default=4096)
    args=parser.parse_args()
    supported=(sys.platform=='win32' and platform.machine().lower() in ('amd64','x86_64')) or (sys.platform=='darwin' and platform.machine().lower()=='arm64')
    if not supported or struct.calcsize('P')!=8:raise SetupFailure('setup-platform-unsupported')
    if sys.version_info<(3,11):raise SetupFailure('setup-python-version-unsupported')
    for name in ('SIGINT','SIGTERM','SIGBREAK'):
        if hasattr(signal,name):signal.signal(getattr(signal,name),lambda *_args:STOP.set())
    preparation=prepare_mac if sys.platform=='darwin' else prepare
    result=preparation(Path(args.resources),Path(args.home),args.lifetime_ms,emit_wait=lambda value:print(json.dumps(value,separators=(',',':')),file=sys.stderr,flush=True),max_callbacks=args.max_callbacks)
    print(json.dumps(result,separators=(',',':')),flush=True)


if __name__=='__main__':
    try:main()
    except SetupFailure as error:
        print(json.dumps({'error':{'code':str(error)}},separators=(',',':')),flush=True);raise SystemExit(1)
    except Exception:
        print('{"error":{"code":"setup-failed"}}',flush=True);raise SystemExit(1)

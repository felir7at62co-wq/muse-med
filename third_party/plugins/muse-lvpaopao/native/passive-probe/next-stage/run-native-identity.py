"""Prepared, target-bound native debug identity probe. Never imports Frida at import time.

Only the fixed identity getter may be evaluated. This is not a business transport,
plugin, downloader, or license to execute arbitrary code received from the peer.
"""
from __future__ import annotations

import asyncio
import base64
from collections import Counter
import importlib.util
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

import remote_wire as wire
from runtime_profiles import select_profile
from websockets.asyncio.server import serve

HOST = '127.0.0.1'
PORT = 9421
MAX_FRAME = 4 * 1024 * 1024
MAX_CANDIDATES = 4
HOOK_KEYS = ('expectedAppId','modulePath','loadStartRva','expectedEntryBytes',
             'cdpFilterRva','expectedFilterEntryBytes','durationMs','maxCallbacks','expectedScenes')
KNOWN_CATEGORIES = {wire.CATEGORY_CHROME_DEVTOOLS,wire.CATEGORY_CHROME_DEVTOOLS_RESULT,
                    wire.CATEGORY_ADD_JS_CONTEXT,wire.CATEGORY_REMOVE_JS_CONTEXT,
                    wire.CATEGORY_CONNECT_JS_CONTEXT,wire.CATEGORY_SETUP_CONTEXT}
def valid_context_id(value):
    return isinstance(value,str) and bool(value) and len(value.encode('utf8'))<=wire.MAX_CONTEXT_ID_BYTES


def context_hash(value):
    return hashlib.sha256(value.encode('utf8')).hexdigest() if value else None


class ProbeFailure(RuntimeError):
    """A fixed, non-sensitive local failure code."""
    def __init__(self, code, details=None):
        super().__init__(code)
        self.details={}
        if details is None:return
        if not isinstance(details,dict):raise ValueError('peer-diagnostics-invalid')
        for key,value in details.items():
            if key=='stage' and isinstance(value,str) and value in {'hash','preflight-powershell','predicate'}:self.details[key]=value
            elif key=='errorClass' and isinstance(value,str) and value in {'CalledProcessError','TimeoutExpired'}:self.details[key]=value
            elif key=='proofStatus' and isinstance(value,str) and value in {'peer-connection-unavailable','root-unavailable'}:self.details[key]=value
            elif key in {'elapsedMs','currentRootPid','currentRootSessionId','currentOwnerPid','currentOwnerSessionId'} and type(value) is int and -1<=value<=(1<<32)-1:self.details[key]=value
            elif key in {'connectionCount','rootCount'} and type(value) is int and 0<=value<=(1<<31)-1:self.details[key]=value
            elif key=='returnCode' and type(value) is int and -(1<<31)<=value<=(1<<31)-1:self.details[key]=value
            elif key=='checks' and isinstance(value,dict) and all(name in PEER_CHECKS and type(check) is bool for name,check in value.items()):self.details[key]=dict(value)
            else:raise ValueError('peer-diagnostics-invalid')


PEER_CHECKS={'loopbackAddress','targetEnabled','peerAlreadyClaimed','executableHashMatched','moduleHashMatched','metadataValid','connectionUnique','rootUnique','rootPidMatches','rootCreatedUtcMatches','rootSessionMatches','rootExecutableMatches','belongsToSelectedRoot','ownerIsAppEx','ownerSessionMatches','ownerExecutableMatches','ownerPidValid'}
PEER_REJECTION_REASONS={'stopping','addressRejected','waitTargetTimeout','alreadyClaimed','rootPredicate','PowerShellFailed','openTimeout','peerCheckFailed','peer-connection-unavailable','root-unavailable'}


def elapsed_ms(started):
    """Return bounded elapsed metadata without affecting a timeout or admission decision."""
    return min((1<<32)-1,max(0,round((time.monotonic()-started)*1000)))


def load_target_guard():
    """Reuse the prior exact PID/time/file-hash gate without executing its main."""
    path = Path(__file__).resolve().parent.parent / 'run-observation.py'
    spec = importlib.util.spec_from_file_location('muse_native_identity_target_guard',path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_preflight(config, guard, root):
    """Cold launch is an explicit, hash-bound exception to current renderer presence."""
    candidate=config.get('targetLaunchCandidate',False)
    if type(candidate) is not bool:raise ProbeFailure('target-candidate-flag-invalid')
    if candidate:
        if 'coldLaunchAttestation' in config:raise ProbeFailure('target-candidate-attestation-conflict')
        target=guard.require_target(config,allow_missing_renderer=True)
        return {**target,'preflightMode':'target-launch-candidate'}
    if 'coldLaunchAttestation' not in config:
        return guard.require_target(config)
    attestation=config['coldLaunchAttestation']
    keys={'receiptPath','receiptSHA256','configPath','configSHA256'}
    if not isinstance(attestation,dict) or set(attestation)!=keys:
        raise ProbeFailure('cold-attestation-fields-invalid')
    def read_pinned(path_key,digest_key):
        value=attestation[path_key]
        digest=attestation[digest_key]
        if (not isinstance(value,str) or not value or not isinstance(digest,str)
                or re.fullmatch(r'[0-9a-f]{64}',digest) is None):
            raise ProbeFailure('cold-attestation-pin-invalid')
        path=(root/value).resolve()
        if not path.is_relative_to(root.parent.resolve()) or not path.is_file() or path.stat().st_size>65536:
            raise ProbeFailure('cold-attestation-path-invalid')
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=digest:
            raise ProbeFailure('cold-attestation-hash-mismatch')
        return json.loads(raw.decode('utf8'))
    previous=read_pinned('configPath','configSHA256')
    receipt=read_pinned('receiptPath','receiptSHA256')
    if not isinstance(previous,dict) or not isinstance(receipt,dict):
        raise ProbeFailure('cold-attestation-record-invalid')
    direct=['rootPid','rootCreatedUtc','sessionId','expectedAppId','executableSHA256','moduleSHA256','loadStartRva','expectedEntryBytes']
    if any(previous.get(key)!=config.get(key) for key in direct):
        raise ProbeFailure('cold-attestation-root-or-runtime-mismatch')
    if any(guard.normal_path(previous.get(key,''))!=guard.normal_path(config[key]) for key in ['executablePath','modulePath']):
        raise ProbeFailure('cold-attestation-root-or-runtime-mismatch')
    lines=receipt.get('stdoutLines')
    if type(receipt.get('exitCode')) is not int or receipt['exitCode']!=0 or receipt.get('stderr')!='' or not isinstance(lines,list) or len(lines)>64:
        raise ProbeFailure('cold-attestation-result-invalid')
    try:events=[json.loads(line) for line in lines]
    except (TypeError,ValueError):raise ProbeFailure('cold-attestation-events-invalid') from None
    if any(not isinstance(event,dict) for event in events):
        raise ProbeFailure('cold-attestation-events-invalid')
    ready=[event for event in events if event.get('type')=='ready']
    launches=[event for event in events if event.get('type')=='target-launch']
    finished=[event for event in events if event.get('type')=='observation-finished']
    if (len(ready)!=1 or ready[0].get('passive') is not True
            or ready[0].get('entryBytesVerified') is not True or ready[0].get('modulePathMatched') is not True
            or len(launches)!=1 or launches[0].get('inlineOffsets')!=[152,184] or launches[0].get('scene')!=1183
            or len(finished)!=1 or finished[0].get('status')!='target-observed'
            or not isinstance(finished[0].get('cleanup'),dict)
            or any(finished[0]['cleanup'].get(key) is not True for key in ['dispose','unload','detach'])):
        raise ProbeFailure('cold-attestation-proof-invalid')
    target=guard.require_target(config,allow_missing_renderer=True)
    return {**target,'preflightMode':'cold-launch-attested','passiveReceiptSHA256':attestation['receiptSHA256'],'passiveConfigSHA256':attestation['configSHA256']}


def require_peer(config, source_port, guard, on_stage=None):
    """Prove current loopback TCP ownership by this exact root or its AppEx descendants."""
    started=time.monotonic();stage='hash';checks={}
    def mark(value):
        nonlocal stage
        stage=value
        if on_stage is not None:
            try:on_stage(value)
            except Exception as error:
                # A diagnostic observer cannot change the existing admission decision.
                pass
    def fail(code,extra=None):
        raise ProbeFailure(code,{'stage':stage,'elapsedMs':elapsed_ms(started),'checks':dict(checks),**(extra or {})}) from None
    mark('hash')
    if type(source_port) is not int or not 1 <= source_port <= 65535:
        fail('peer-port-invalid')
    for key,digest_key in [('executablePath','executableSHA256'),('modulePath','moduleSHA256')]:
        check='executableHashMatched' if key=='executablePath' else 'moduleHashMatched'
        try:matched=guard.file_digest(config[key])==config[digest_key]
        except Exception as error:
            checks[check]=False
            fail('peer-runtime-file-unavailable')
        checks[check]=matched
        if not matched:fail('peer-runtime-file-changed')
    script = r"""$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$connections=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort SOURCE_PORT -RemoteAddress '127.0.0.1' -RemotePort 9421 -State Established -ErrorAction SilentlyContinue);
if ($connections.Count -ne 1) { [pscustomobject]@{ProofStatus='peer-connection-unavailable';ConnectionCount=$connections.Count} | ConvertTo-Json -Compress; exit 0 };
$all=@(Get-CimInstance Win32_Process -Filter "Name='WeChatAppEx.exe'");
$root=@($all | Where-Object { $_.ProcessId -eq ROOT_ID });
if ($root.Count -ne 1) { [pscustomobject]@{ProofStatus='root-unavailable';ConnectionCount=$connections.Count;RootCount=$root.Count} | ConvertTo-Json -Compress; exit 0 };
$ownerId=[int]$connections[0].OwningProcess;
$owner=@($all | Where-Object { $_.ProcessId -eq $ownerId });
$belongs=$false;
if ($owner.Count -eq 1) {
    $current=$owner[0];
    for ($i=0;$i -lt 32;$i++) {
        if ($current.ProcessId -eq ROOT_ID) { $belongs=$true; break };
        $parentId=[int]$current.ParentProcessId;
        $parents=@($all | Where-Object { $_.ProcessId -eq $parentId });
        if ($parents.Count -ne 1) { break };
        $current=$parents[0];
    }
};
[pscustomobject]@{
 RootPid=$root[0].ProcessId;
 CreatedUtc=$root[0].CreationDate.ToUniversalTime().ToString('o');
 RootExecutablePath=$root[0].ExecutablePath;
 RootSessionId=$root[0].SessionId;
 OwnerPid=$ownerId;
 OwnerName=if($owner.Count -eq 1){$owner[0].Name}else{''};
 OwnerSessionId=if($owner.Count -eq 1){$owner[0].SessionId}else{-1};
 OwnerExecutablePath=if($owner.Count -eq 1){$owner[0].ExecutablePath}else{''};
 BelongsToSelectedRoot=$belongs;
} | ConvertTo-Json -Compress
""".replace('SOURCE_PORT',str(source_port)).replace('ROOT_ID',str(int(config['rootPid'])))
    encoded = base64.b64encode(script.encode('utf-16le')).decode()
    mark('preflight-powershell')
    try:
        result = subprocess.run(['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],capture_output=True,timeout=20,check=True)
    except subprocess.CalledProcessError as error:
        extra={'errorClass':'CalledProcessError'}
        if type(error.returncode) is int and -(1<<31)<=error.returncode<=(1<<31)-1:extra['returnCode']=error.returncode
        fail('peer-powershell-failed',extra)
    except subprocess.TimeoutExpired:
        fail('peer-powershell-failed',{'errorClass':'TimeoutExpired'})
    except Exception as error:
        fail('peer-powershell-failed')
    mark('predicate')
    try:value = json.loads(result.stdout.decode('utf-8-sig'))
    except (ValueError,TypeError,UnicodeError):
        checks['metadataValid']=False
        fail('peer-metadata-invalid')
    if not isinstance(value,dict):
        checks['metadataValid']=False
        fail('peer-metadata-invalid')
    checks['metadataValid']=True
    if 'ProofStatus' in value:
        mark('preflight-powershell')
        status=value['ProofStatus']
        fields={'ProofStatus','ConnectionCount'} if status=='peer-connection-unavailable' else {'ProofStatus','ConnectionCount','RootCount'}
        count=value.get('ConnectionCount');root_count=value.get('RootCount')
        if (status not in ('peer-connection-unavailable','root-unavailable') or set(value)!=fields
                or type(count) is not int or not 0<=count<=(1<<31)-1
                or status=='peer-connection-unavailable' and count==1
                or status=='root-unavailable' and (count!=1 or type(root_count) is not int or not 0<=root_count<=(1<<31)-1 or root_count==1)):
            checks['metadataValid']=False
            fail('peer-metadata-invalid')
        checks['connectionUnique']=count==1
        extra={'proofStatus':status,'connectionCount':count}
        if status=='root-unavailable':
            checks['rootUnique']=False;extra['rootCount']=root_count
        fail(status,extra)
    def path_matches(key):
        actual=value.get(key)
        return isinstance(actual,str) and guard.normal_path(actual)==guard.normal_path(config['executablePath'])
    checks.update({
        'rootPidMatches':value.get('RootPid')==config['rootPid'],
        'rootCreatedUtcMatches':value.get('CreatedUtc')==config['rootCreatedUtc'],
        'rootSessionMatches':value.get('RootSessionId')==config['sessionId'],
        'rootExecutableMatches':path_matches('RootExecutablePath'),
        'belongsToSelectedRoot':value.get('BelongsToSelectedRoot') is True,
        'ownerIsAppEx':value.get('OwnerName')=='WeChatAppEx.exe',
        'ownerSessionMatches':value.get('OwnerSessionId')==config['sessionId'],
        'ownerExecutableMatches':path_matches('OwnerExecutablePath'),
        'ownerPidValid':type(value.get('OwnerPid')) is int and value['OwnerPid']>0,
    })
    if not all(checks.values()):
        observed={}
        for raw,key in [('RootPid','currentRootPid'),('RootSessionId','currentRootSessionId'),('OwnerPid','currentOwnerPid'),('OwnerSessionId','currentOwnerSessionId')]:
            number=value.get(raw)
            if type(number) is int and -1<=number<=(1<<32)-1:observed[key]=number
        fail('peer-owner-rejected',observed)
    return {'rootPid':value['RootPid'],'ownerPid':value['OwnerPid'],'sourcePort':source_port}


def identity_expression(expected_app_id):
    """Return one fixed getter; no caller-provided JavaScript is accepted."""
    if not isinstance(expected_app_id,str) or re.fullmatch(r'wx[0-9a-f]{16}',expected_app_id) is None:
        raise ProbeFailure('expected-app-id-invalid')
    return ('(()=>{let matchesExpected=false;let hasOperateWXData=false;'
            'try{matchesExpected=typeof wx!=="undefined"&&typeof wx.getAccountInfoSync==="function"&&'
            'wx.getAccountInfoSync().miniProgram.appId==='+json.dumps(expected_app_id)+';'
            'hasOperateWXData=typeof wx!=="undefined"&&typeof wx.operateWXData==="function";}catch(_){}'
            'return {matchesExpected,hasOperateWXData};})()')


class IdentityProtocol:
    """Bounded metadata discovery and four fixed identity reads, without business calls."""
    def __init__(self,config,send_frame):
        self.config=config
        self.send_frame=send_frame
        self.done=asyncio.Event()
        self.hook_enabled=asyncio.Event()
        self.category_counts=Counter()
        self.protocol_errors=Counter()
        self.native_ids=set()
        self.enabled_routes=set()
        self.candidates=[]
        self.candidate_pairs=set()
        self.pending={}
        self.command_receipts=[]
        self.identity=None
        self.peer=None
        self.status='prepared'
        self.stopping=False
        self.ready_emitted=False
        self.seq=0
        self.op_id=1000
        self.cdp_id=2000
        self.last_incoming_seq=0
        self.explicit_events=0
        self.default_attempted=False
        self.fallback_task=None
        self.hook_counts=Counter()
        self.hook_error=False
        self.peer_rejection_counts=Counter()
        self.peer_rejections=[]
        self.peer_rejections_dropped=0

    async def command(self,method,native_id='',context_id=None):
        if method not in {'Runtime.enable','Runtime.evaluate'}:
            raise ProbeFailure('command-not-allowed')
        if self.stopping or self.done.is_set():
            raise ProbeFailure('probe-stopping')
        if native_id and not valid_context_id(native_id):
            raise ProbeFailure('native-context-id-invalid')
        params={}
        if method=='Runtime.evaluate':
            params={'expression':identity_expression(self.config['expectedAppId']),'returnByValue':True,'silent':True,'awaitPromise':False,'userGesture':False,'includeCommandLineAPI':False}
            if context_id is not None:
                if type(context_id) is not int or not 0 <= context_id <= (1<<53)-1:
                    raise ProbeFailure('execution-context-id-invalid')
                params['contextId']=context_id
            elif not self.config.get('allowDefaultIdentityRead',False):
                raise ProbeFailure('default-identity-disabled')
        self.seq+=1
        self.op_id+=1
        self.cdp_id+=1
        cdp={'id':self.cdp_id,'method':method,'params':params}
        frame=wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS,{'opId':self.op_id,'payload':json.dumps(cdp,separators=(',',':')),'jscontextId':native_id},seq=self.seq,after=0,compress_algo=wire.COMPRESSION_NONE)
        self.pending[self.cdp_id]={'method':method,'opId':self.op_id,'nativeId':native_id,'contextId':context_id}
        self.command_receipts.append({'method':method,'outerSeq':self.seq,'after':0,'opId':self.op_id,'cdpId':self.cdp_id,'nativeContextIdHash':context_hash(native_id),'executionContextId':context_id})
        await self.send_frame(frame)

    async def enable_route(self,native_id=''):
        if native_id in self.enabled_routes or len(self.enabled_routes)>=MAX_CANDIDATES+1:
            return
        self.enabled_routes.add(native_id)
        await self.command('Runtime.enable',native_id)

    async def evaluate_candidate(self,native_id,context_id):
        pair=(native_id,context_id)
        if pair in self.candidate_pairs or len(self.candidates)>=MAX_CANDIDATES:
            return
        self.candidate_pairs.add(pair)
        self.candidates.append({'nativeContextIdHash':context_hash(native_id),'executionContextId':context_id})
        await self.command('Runtime.evaluate',native_id,context_id)

    async def fallback_identity(self):
        # Disabled by default. A successful Runtime.enable and metadata grace
        # period do not themselves prove AppID; the sole read is still the getter.
        await asyncio.sleep(1)
        if not self.done.is_set() and self.explicit_events==0 and not self.default_attempted:
            self.default_attempted=True
            await self.evaluate_candidate('',None)

    async def accept_frame(self,raw):
        if self.stopping or self.done.is_set():return
        if not isinstance(raw,bytes) or len(raw)>MAX_FRAME:
            self.protocol_errors['frame-type-or-size']+=1
            self.status='protocol-error';self.done.set();return
        try:
            outer=wire.decode_outer(raw)
        except wire.WireError:
            self.protocol_errors['outer-invalid']+=1
            self.status='protocol-error';self.done.set();return
        self.last_incoming_seq=outer.seq
        category=outer.category if outer.category in KNOWN_CATEGORIES else 'unknown'
        self.category_counts[category]+=1
        if category=='unknown':
            return
        try:
            frame=wire.decode_frame(raw)
        except wire.WireError:
            self.protocol_errors['payload-invalid']+=1
            self.status='protocol-error';self.done.set();return
        if category==wire.CATEGORY_ADD_JS_CONTEXT:
            metadata=wire.get_context_metadata(frame)
            if metadata and valid_context_id(metadata.context_id) and len(self.native_ids)<MAX_CANDIDATES:
                self.native_ids.add(metadata.context_id)
                await self.enable_route(metadata.context_id)
            return
        if category==wire.CATEGORY_REMOVE_JS_CONTEXT:
            metadata=wire.get_context_metadata(frame)
            if metadata:
                self.native_ids.discard(metadata.context_id)
                self.pending={key:item for key,item in self.pending.items() if item['nativeId']!=metadata.context_id}
            return
        if category not in {wire.CATEGORY_CHROME_DEVTOOLS,wire.CATEGORY_CHROME_DEVTOOLS_RESULT}:
            return
        try:
            cdp=json.loads(frame.payload.payload)
        except (ValueError,TypeError):
            self.protocol_errors['cdp-json-invalid']+=1
            self.status='protocol-error';self.done.set();return
        if not isinstance(cdp,dict):
            self.protocol_errors['cdp-object-invalid']+=1
            self.status='protocol-error';self.done.set();return
        native_id=frame.payload.jscontextId
        if native_id and not valid_context_id(native_id):
            self.protocol_errors['context-id-not-whitelisted']+=1
            return
        params=cdp.get('params')
        params=params if isinstance(params,dict) else {}
        if cdp.get('method')=='Runtime.executionContextDestroyed':
            context_id=params.get('executionContextId')
            self.pending={key:item for key,item in self.pending.items() if not (item['nativeId']==native_id and item['contextId']==context_id)}
            return
        if cdp.get('method')=='Runtime.executionContextCreated':
            value=params.get('context',{})
            context_id=value.get('id') if isinstance(value,dict) else None
            if type(context_id) is int and 0 <= context_id <= (1<<53)-1:
                self.explicit_events+=1
                if self.native_ids and native_id not in self.native_ids:
                    self.protocol_errors['context-route-unannounced']+=1
                    return
                await self.evaluate_candidate(native_id,context_id)
            return
        response_id=cdp.get('id')
        if type(response_id) is not int or response_id not in self.pending:
            return
        pending=self.pending[response_id]
        if native_id!=pending['nativeId']:
            self.protocol_errors['response-correlation']+=1
            return
        self.pending.pop(response_id)
        if pending['method']=='Runtime.enable':
            if ('error' not in cdp and pending['nativeId']=='' and self.config.get('allowDefaultIdentityRead',False)
                    and self.fallback_task is None):
                self.fallback_task=asyncio.create_task(self.fallback_identity())
            return
        result_container=cdp.get('result')
        result_container=result_container if isinstance(result_container,dict) else {}
        if 'error' in cdp or 'exceptionDetails' in result_container:
            self.protocol_errors['identity-read-rejected']+=1
            return
        result=result_container.get('result',{})
        value=result.get('value') if isinstance(result,dict) else None
        if (not isinstance(value,dict) or set(value)!={'matchesExpected','hasOperateWXData'}
                or any(type(value[key]) is not bool for key in value)):
            self.protocol_errors['identity-result-not-boolean-pair']+=1
            return
        if value['matchesExpected']:
            self.identity={'matchesExpected':True,'hasOperateWXData':value['hasOperateWXData'],'nativeContextIdHash':context_hash(native_id),'executionContextId':pending['contextId'],'requestIds':{'opId':pending['opId'],'cdpId':response_id},'responseIds':{'outerSeq':frame.outer.seq,'opId':frame.payload.opId,'cdpId':response_id}}
            await self.identity_matched()

    async def identity_matched(self):
        self.status='identity-matched';self.done.set()

    def receipt(self):
        return {'status':self.status,'peer':self.peer,'identity':self.identity,'categoryCounts':dict(self.category_counts),'protocolErrors':dict(self.protocol_errors),'contexts':self.candidates,'commands':self.command_receipts,'hookEventCounts':dict(self.hook_counts),'businessCalls':0,'peerRejectionCounts':dict(self.peer_rejection_counts),'peerRejections':list(self.peer_rejections),'peerRejectionsDropped':self.peer_rejections_dropped}


class PeerGate:
    """One current OS-verified loopback client, checked before protocol commands."""
    def __init__(self,config,guard,state):
        self.config=config;self.guard=guard;self.state=state
        self.claimed=False;self.closed=False;self.lock=asyncio.Lock()
        self.rejected=0
    def reject(self,reason,details=None):
        if reason not in PEER_REJECTION_REASONS:reason='peerCheckFailed'
        safe=ProbeFailure('peer-rejected',details).details
        self.rejected+=1;self.state.peer_rejection_counts[reason]+=1
        if len(self.state.peer_rejections)<16:self.state.peer_rejections.append({'reason':reason,**safe})
        else:self.state.peer_rejections_dropped+=1
    async def process_request(self,connection,_request):
        progress={'started':time.monotonic(),'stage':None}
        try:return await self._process_request(connection,progress)
        except asyncio.CancelledError:
            details={'elapsedMs':elapsed_ms(progress['started'])}
            if progress['stage'] is not None:details['stage']=progress['stage']
            self.reject('stopping' if self.closed or self.state.stopping else 'openTimeout',details)
            raise
    async def _process_request(self,connection,progress):
        if self.closed:
            self.reject('stopping')
            return connection.respond(503,'Probe stopping')
        address=connection.remote_address
        if not isinstance(address,tuple) or len(address)<2 or address[0]!=HOST:
            self.reject('addressRejected',{'checks':{'loopbackAddress':False}})
            return connection.respond(403,'Peer rejected')
        async with self.lock:
            if self.closed:
                self.reject('stopping')
                return connection.respond(503,'Probe stopping')
            try:
                await asyncio.wait_for(self.state.hook_enabled.wait(),5)
            except TimeoutError:
                self.reject('waitTargetTimeout',{'elapsedMs':elapsed_ms(progress['started']),'checks':{'targetEnabled':False}})
                return connection.respond(403,'Target proof unavailable')
            if self.claimed:
                self.reject('alreadyClaimed',{'checks':{'peerAlreadyClaimed':True}})
                return connection.respond(409,'Peer already selected')
            try:
                progress['started']=time.monotonic();progress['stage']='hash'
                def on_stage(stage):progress['stage']=stage
                proof=await asyncio.to_thread(require_peer,self.config,address[1],self.guard,on_stage)
            except ProbeFailure as error:
                reason='PowerShellFailed' if str(error)=='peer-powershell-failed' else str(error) if str(error) in {'peer-connection-unavailable','root-unavailable'} else 'rootPredicate'
                self.reject(reason,error.details)
                return connection.respond(403,'Peer rejected')
            except Exception as error:
                self.reject('peerCheckFailed',{'stage':progress['stage'],'elapsedMs':elapsed_ms(progress['started'])})
                return connection.respond(403,'Peer rejected')
            if self.closed:
                self.reject('stopping',{'stage':progress['stage'],'elapsedMs':elapsed_ms(progress['started'])})
                return connection.respond(503,'Probe stopping')
            self.state.peer=proof;self.claimed=True
            return None


def bounded_call(frida,callback,seconds):
    """Apply the pinned Frida Cancellable to setup and cleanup calls."""
    cancellation=frida.Cancellable()
    timer=threading.Timer(seconds,cancellation.cancel);timer.daemon=True;timer.start()
    try:
        with cancellation:return callback()
    finally:timer.cancel()


async def cleanup_resources(frida,script,session,server,state):
    """Attempt every owned cleanup and return only a bounded, filtered summary."""
    cleanup={'dispose':script is None,'unload':script is None,'detach':session is None,'serverClosed':server is None}
    if state.fallback_task:
        state.fallback_task.cancel()
        await asyncio.gather(state.fallback_task,return_exceptions=True)
    if script is not None:
        try:
            summary=await asyncio.to_thread(bounded_call,frida,script.exports_sync.dispose,5)
            cleanup['dispose']=isinstance(summary,dict) and summary.get('detached') is True and summary.get('flushed') is True
            keys={'callbacks','rejected','eligibleLaunches','sceneWriteAttempted','argumentWriteAttempted','sceneWrites','argumentWrites','filterCallbacks','filterWriteAttempts','filterPatches','writeOutcomeUnknown','detached','flushed'}
            cleanup['hookSummary']={k:v for k,v in summary.items() if k in keys and (type(v) is bool or type(v) is int)} if isinstance(summary,dict) else {}
        except Exception as error:cleanup['disposeError']=type(error).__name__
        try:
            await asyncio.to_thread(bounded_call,frida,script.unload,5);cleanup['unload']=True
        except Exception as error:cleanup['unloadError']=type(error).__name__
    if session is not None:
        try:
            await asyncio.to_thread(bounded_call,frida,session.detach,5);cleanup['detach']=True
        except Exception as error:cleanup['detachError']=type(error).__name__
    if server is not None:
        try:
            server.close(close_connections=True)
            await asyncio.wait_for(server.wait_closed(),5);cleanup['serverClosed']=True
        except Exception as error:cleanup['serverError']=type(error).__name__
    return cleanup


async def main():
    root=Path(__file__).resolve().parent
    config=json.loads((root/'config.json').read_text(encoding='utf8'))
    if sys.platform=='darwin' and config.get('runtimePlatform')=='darwin':
        from mac_runtime import run
        return await run(root,config,IdentityProtocol,cleanup_resources,bounded_call,ProbeFailure,print)
    if os.name!='nt':raise ProbeFailure('windows-required')
    if type(config.get('durationMs')) is not int or not 60000<=config['durationMs']<=14400000:
        raise ProbeFailure('duration-invalid')
    if type(config.get('allowDefaultIdentityRead',False)) is not bool:
        raise ProbeFailure('default-identity-flag-invalid')
    if type(config.get('postUpgradeAuthorization',False)) is not bool:
        raise ProbeFailure('peer-authorization-config-invalid')
    guard=load_target_guard()
    identity_expression(config['expectedAppId'])
    started=time.monotonic();deadline=started+config['durationMs']/1000
    target=await asyncio.to_thread(require_preflight,config,guard,root)
    try:hook_file,attach_options=select_profile(config)
    except ValueError as error:raise ProbeFailure(str(error)) from None
    hook=(root/hook_file).read_text(encoding='utf8')
    if hook.count('@@CONFIG@@')!=1:raise ProbeFailure('hook-placeholder-invalid')
    hook=hook.replace('@@CONFIG@@',json.dumps({k:config[k] for k in HOOK_KEYS},separators=(',',':')))
    connection_ref={};tasks=set();server=None;script=None;session=None;frida=None
    async def send_frame(frame):
        connection=connection_ref.get('peer')
        if connection is None:raise ProbeFailure('peer-not-ready')
        await connection.send(frame)
    state=IdentityProtocol(config,send_frame)
    if config.get('postUpgradeAuthorization',False):
        from post_upgrade_peer import make_post_upgrade_gate
        gate=make_post_upgrade_gate(PeerGate,require_peer,ProbeFailure,HOST)(config,guard,state,deadline)
    else:gate=PeerGate(config,guard,state)
    loop=asyncio.get_running_loop()
    def hook_message(message,binary):
        if binary is not None:return
        def apply():
            payload=message.get('payload') if message.get('type')=='send' else None
            kind=payload.get('type') if isinstance(payload,dict) else 'script-error'
            known={'ready','target-enabled','launch-rejected','launch-hook-disabled','cdp-filter-patched','observation-error','disposed'}
            state.hook_counts[kind if kind in known else 'other']+=1
            if state.stopping or state.done.is_set():return
            if (kind=='ready' and payload.get('active') is True and payload.get('guardsVerified') is True
                    and server is not None and not state.ready_emitted):
                state.ready_emitted=True
                print(json.dumps({'type':'identity-probe-ready','durationMs':config['durationMs']}),flush=True)
            if kind=='target-enabled':state.hook_enabled.set()
            if kind=='disposed':
                if hasattr(state,'ready'):state.ready=False
                state.status='hook-disposed';state.done.set()
            if kind in {'script-error','observation-error'}:
                state.hook_error=True;state.status='hook-error';state.done.set()
        loop.call_soon_threadsafe(apply)
    async def handler(connection):
        task=asyncio.current_task();tasks.add(task);authorized=False
        try:
            if config.get('postUpgradeAuthorization',False) and not await gate.authorize(connection):return
            authorized=True;connection_ref['peer']=connection
            await asyncio.wait_for(state.hook_enabled.wait(),max(0.01,deadline-time.monotonic()))
            if state.done.is_set():return
            await state.enable_route('')
            async for raw in connection:
                await state.accept_frame(raw)
                if state.done.is_set():break
            if not state.stopping and not state.done.is_set():
                if hasattr(state,'ready'):state.ready=False
                state.status='peer-ended';state.done.set()
        except asyncio.CancelledError:raise
        except Exception:
            if authorized:
                state.protocol_errors['peer-transport-stopped']+=1
                if not state.done.is_set():state.status='peer-stopped';state.done.set()
            else:gate.reject('peerCheckFailed')
        finally:tasks.discard(task)
    quiet_logger=logging.getLogger('muse-native-identity-private')
    quiet_logger.handlers=[logging.NullHandler()];quiet_logger.propagate=False
    previous_handlers={}
    def stop(_number,_frame):
        def apply():state.status='cancelled';state.done.set()
        loop.call_soon_threadsafe(apply)
    for sig in (signal.SIGINT,signal.SIGTERM):
        previous_handlers[sig]=signal.getsignal(sig);signal.signal(sig,stop)
    try:
        server=await serve(handler,HOST,PORT,max_size=MAX_FRAME,compression=None,max_queue=4,process_request=gate.process_request,open_timeout=10,close_timeout=2,logger=quiet_logger)
        # The listener is live and loopback-bound before any Frida import/attach.
        import frida as frida_module
        frida=frida_module
        session=await asyncio.to_thread(bounded_call,frida,lambda:frida.get_local_device().attach(config['rootPid'],persist_timeout=0,**attach_options),10)
        script=await asyncio.to_thread(bounded_call,frida,lambda:session.create_script(hook,name='muse-lvpaopao-native-identity'),10)
        script.on('message',hook_message)
        await asyncio.to_thread(bounded_call,frida,script.load,10)
        if not state.done.is_set():state.status='awaiting-target-peer'
        try:
            await asyncio.wait_for(state.done.wait(),max(0.01,deadline-time.monotonic()))
        except TimeoutError:state.status='deadline'
    except Exception as error:
        state.status='failed-'+type(error).__name__
    finally:
        gate.closed=True;state.stopping=True;state.done.set()
        for task in list(tasks):task.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
        cleanup=await cleanup_resources(frida,script,session,server,state)
        for sig,old in previous_handlers.items():signal.signal(sig,old)
        receipt={**state.receipt(),'target':target,'rejectedPeerCount':gate.rejected,'cleanup':cleanup,'elapsedSeconds':round(time.monotonic()-started,3),'scope':state.receipt().get('scope','fixed-identity-only; no business requests')}
        path=root/'native-identity.receipt.json'
        path.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        if os.name!='nt':path.chmod(0o600)
        print(json.dumps({'type':'identity-probe-finished','status':state.status,'identityMatched':state.identity is not None,'cleanup':{k:cleanup[k] for k in ['dispose','unload','detach','serverClosed']}}),flush=True)
    if not all(cleanup[k] for k in ['dispose','unload','detach','serverClosed']):
        raise ProbeFailure('cleanup-incomplete')
    if state.identity is None:raise ProbeFailure('identity-not-established')


if __name__=='__main__':
    try:asyncio.run(main())
    except Exception as error:
        print(json.dumps({'type':'identity-controller-failed','errorType':type(error).__name__}),flush=True)
        sys.exit(1)

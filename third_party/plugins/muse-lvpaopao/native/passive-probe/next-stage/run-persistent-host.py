"""Private persistent stdio host for fixed, target-bound Lvpaopao operations."""
from __future__ import annotations
import argparse
import asyncio
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import threading

ROOT=Path(__file__).resolve().parent
EXPECTED_MODULE_MANIFEST_SHA256='4c685566ead5f2256760ba2064e1773c503fc7e074fbf7a98f774c0c80c84998'

def verify_modules():
    raw=(ROOT/'helper-manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=EXPECTED_MODULE_MANIFEST_SHA256:raise RuntimeError('module-manifest-changed')
    manifest=json.loads(raw)
    if not isinstance(manifest,dict) or manifest.get('version')!=1 or not isinstance(manifest.get('files'),dict):raise RuntimeError('module-manifest-invalid')
    for name,digest in manifest['files'].items():
        path=(ROOT/name).resolve()
        if not path.is_relative_to(ROOT.parent) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise RuntimeError('module-file-changed')


def emit(value):
    print(json.dumps(value,ensure_ascii=True,separators=(',',':')),flush=True)


def load_shared():
    spec=importlib.util.spec_from_file_location('muse_persistent_native_identity',ROOT/'run-native-identity.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def make_protocol(shared,operations,NativeRpc,call_operation):
    class PersistentProtocol(shared.IdentityProtocol):
        current=None
        def __init__(self,config,send_frame):
            super().__init__(config,send_frame)
            PersistentProtocol.current=self
            self.rpc=None;self.ready=False;self.request_tasks={};self.counts=Counter();self.stdio_queue=asyncio.Queue(maxsize=16)
            self.owned=[];self.closing=False;self.request_seen=set();self.settled=set();self.media_lock=asyncio.Lock()
            loop=asyncio.get_running_loop()
            def reader():
                try:
                    while True:
                        line=sys.stdin.buffer.readline(16385)
                        if not line:
                            loop.call_soon_threadsafe(self.enqueue,None);return
                        loop.call_soon_threadsafe(self.enqueue,line)
                        if len(line)>16384:return
                        # A valid close ends admission before the daemon can block on another read.
                        try:control=json.loads(line)
                        except (ValueError,UnicodeError):control=None
                        if control=={'protocol':1,'type':'close'}:return
                except Exception:
                    loop.call_soon_threadsafe(self.enqueue,None)
            self.reader_thread=threading.Thread(target=reader,daemon=True,name='lvpaopao-private-stdio')
            self.reader_thread.start();self.owned.append(asyncio.create_task(self.control()))
        def enqueue(self,line):
            if self.closing:return
            try:self.stdio_queue.put_nowait(line)
            except asyncio.QueueFull:self.status='control-overflow';self.done.set()
        async def control(self):
            while not self.closing:
                line=await self.stdio_queue.get()
                if line is None:self.status='control-eof';self.done.set();return
                try:
                    if len(line)>16384:raise ValueError()
                    value=json.loads(line)
                    if not isinstance(value,dict) or type(value.get('protocol')) is not int or value.get('protocol')!=1:raise ValueError()
                    kind=value.get('type')
                    if kind=='close' and set(value)=={'protocol','type'}:
                        self.status='control-close';self.done.set();return
                    identifier=value.get('id')
                    if not isinstance(identifier,str) or re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',identifier) is None:raise ValueError()
                    if kind=='cancel' and set(value)=={'protocol','type','id'}:
                        task=self.request_tasks.get(identifier)
                        if task:task.cancel()
                        continue
                    if kind!='request' or set(value)!={'protocol','type','id','method','params'} or not isinstance(value['params'],dict):raise ValueError()
                    if identifier in self.request_seen:
                        self.counts['duplicateRequests']+=1;continue
                    if len(self.request_seen)>=1024:
                        self.status='control-request-limit';self.done.set();return
                    self.request_seen.add(identifier)
                    if len(self.request_tasks)>=8:
                        self.error(identifier,'request-conflict');continue
                    task=asyncio.create_task(self.handle(identifier,value['method'],value['params']))
                    self.request_tasks[identifier]=task
                    task.add_done_callback(lambda task,key=identifier:self.finished(key,task))
                except (ValueError,TypeError,UnicodeError):
                    self.status='control-protocol-invalid';self.done.set();return
        def finished(self,identifier,task):
            self.request_tasks.pop(identifier,None)
            if task.cancelled():self.error(identifier,'cancelled')
            elif task.exception() is not None:self.error(identifier,'operation-unconfirmed')
        def error(self,identifier,code):
            if identifier in self.settled:return
            self.settled.add(identifier)
            emit({'protocol':1,'type':'error','id':identifier,'error':{'code':code,'message':code}})
        async def handle(self,identifier,method,params):
            try:
                if self.closing:self.error(identifier,'closed');return
                if method=='hello':
                    if set(params)!={'expected_app_id','helper_sha256'} or params['expected_app_id']!=self.config['expectedAppId'] or params['helper_sha256']!=hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
                        self.error(identifier,'helper-identity-mismatch');return
                    result={'protocol_version':1,'helper_sha256':params['helper_sha256'],'expected_app_id':self.config['expectedAppId'],'actions':['status','search','detail','episodes','download_first_episode','download_episode','download_status','rankings','engagement'],'ready':self.ready}
                elif method=='status' and not self.ready:
                    if params:self.error(identifier,'parameters-invalid');return
                    result={'status':'waiting_target','ready':False,'expectedAppId':self.config['expectedAppId']}
                elif method in ('download_first_episode','download_episode','download_status') and 'download_first_episode' not in operations:
                    self.error(identifier,'capability-not-ready');return
                elif method=='download_status':
                    from persistent_media import episode_download_status
                    async with self.media_lock:
                        task=asyncio.create_task(asyncio.to_thread(episode_download_status,params,ROOT))
                        try:result=await asyncio.shield(task)
                        except asyncio.CancelledError:
                            while not task.done():
                                try:await asyncio.shield(task)
                                except asyncio.CancelledError:continue
                                except Exception:break
                            if not task.cancelled():task.exception()
                            raise
                elif method not in operations:
                    self.error(identifier,'operation-not-supported');return
                elif not self.ready or self.rpc is None:
                    self.error(identifier,'target-not-ready');return
                else:
                    if method in ('download_first_episode','download_episode'):
                        from persistent_media import perform_download
                        async with self.media_lock:
                            pair={'srcAppId':params.get('srcAppId'),'dramaId':params.get('dramaId')}
                            cached=ROOT if self.config.get('reuseSavedMediaFor')==pair and (method=='download_first_episode' or params.get('episodeNo')==1) else None
                            if method=='download_episode':
                                from persistent_media import perform_episode_download
                                result=await perform_episode_download(self.rpc,params,ROOT,cached_receipt_directory=cached)
                            else:result=await perform_download(self.rpc,params,ROOT,identifier,cached_receipt_directory=cached)
                    else:result=await call_operation(self.rpc,method,params)
                    self.counts[method]+=1
                if identifier not in self.settled:
                    self.settled.add(identifier)
                    emit({'protocol':1,'type':'result','id':identifier,'value':result})
            except asyncio.CancelledError:
                self.error(identifier,'cancelled')
            except Exception as error:
                # Only registered host error codes are exposed, never target text.
                allowed={'parameters-invalid','parameters-too-large','operation-not-registered','verified-context-required','identity-unconfirmed','context-invalidated','context-removed','closed','deadline','cancelled','evaluation-rejected','result-not-by-value','transport-failed','protocol-invalid','result-invalid','transfer-failed','output-already-exists','download-cancelled','media-process-cleanup-failed','outcome-unconfirmed','request-binding-conflict','resume-state-invalid','resume-response-invalid','resume-resource-changed','resume-validator-missing'}
                code=str(error) if str(error) in allowed else 'operation-unconfirmed'
                self.error(identifier,code)
        async def identity_matched(self):
            self.pending.clear()
            native_hash=self.identity['nativeContextIdHash']
            routes=[value for value in self.native_ids if shared.context_hash(value)==native_hash] if native_hash else ['']
            if len(routes)!=1 or type(self.identity['executionContextId']) is not int:
                self.status='host-route-unavailable';self.done.set();return
            self.rpc=NativeRpc(self.send_frame,self.config['expectedAppId'],operations,initial_sequence=self.seq,initial_op_id=self.op_id,initial_cdp_id=self.cdp_id)
            async def establish():
                try:
                    await self.rpc.verify_context(routes[0],self.identity['executionContextId'])
                    if self.closing or self.done.is_set():return
                    self.ready=True;self.status='host-ready'
                    emit({'protocol':1,'type':'event','event':'ready','details':{'expectedAppId':self.config['expectedAppId']}})
                except Exception:
                    self.status='host-context-unconfirmed';self.done.set()
            self.owned.append(asyncio.create_task(establish()))
        async def accept_frame(self,raw):
            if self.rpc is not None:
                await self.rpc.accept_frame(raw)
                if self.ready and self.rpc.receipt()['lease'] is None:
                    self.ready=False;self.status='host-context-ended';self.done.set()
            else:await super().accept_frame(raw)
        async def shutdown(self):
            if self.closing:return
            self.closing=True;self.ready=False
            if self.rpc:self.rpc.close()
            for task in list(self.request_tasks.values())+self.owned:task.cancel()
            await asyncio.gather(*list(self.request_tasks.values()),*self.owned,return_exceptions=True)
        def receipt(self):
            return {**super().receipt(),'scope':'persistent fixed-operation host; no raw parameters/results/URLs in receipt','operationCounts':dict(self.counts),'rpc':self.rpc.receipt() if self.rpc else None}
    return PersistentProtocol


async def main():
    verify_modules()
    from native_rpc import NativeRpc
    from operations.fixed_operations import fixed_operations,call_operation
    deployment=json.loads((ROOT/'config.json').read_text(encoding='utf8'))
    if type(deployment.get('downloadEnabled',False)) is not bool:raise RuntimeError('download-config-invalid')
    cached=deployment.get('reuseSavedMediaFor')
    if cached is not None and (not isinstance(cached,dict) or set(cached)!={'srcAppId','dramaId'}
            or not isinstance(cached['srcAppId'],str) or re.fullmatch(r'wx[0-9a-f]{16}',cached['srcAppId']) is None
            or not isinstance(cached['dramaId'],str) or re.fullmatch(r'[A-Za-z0-9_-]{1,64}',cached['dramaId']) is None):raise RuntimeError('saved-media-config-invalid')
    actions=['status','search','detail','episodes','rankings','engagement']+(['download_first_episode','download_episode'] if deployment.get('downloadEnabled',False) else [])
    shared=load_shared();protocol=make_protocol(shared,fixed_operations(actions),NativeRpc,call_operation)
    shared.IdentityProtocol=protocol
    cleanup_resources=shared.cleanup_resources
    async def cleanup(frida,script,session,server,state):
        await state.shutdown()
        return await cleanup_resources(frida,script,session,server,state)
    shared.cleanup_resources=cleanup
    def lifecycle_print(text,**_kwargs):
        value=json.loads(text)
        if value.get('type')=='identity-probe-ready':emit({'protocol':1,'type':'event','event':'waiting_target','details':{'durationMs':value['durationMs']}})
        elif value.get('type')=='identity-probe-finished':emit({'protocol':1,'type':'event','event':'closed','details':{'status':value['status'],'cleanup':value['cleanup']}})
    shared.print=lifecycle_print
    try:
        await shared.main()
    except shared.ProbeFailure:
        state=protocol.current
        if state is None or state.status not in {'control-eof','control-close'}:raise
    finally:
        if protocol.current:await protocol.current.shutdown()


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='strict',newline='\n')
    parser=argparse.ArgumentParser();parser.add_argument('--rpc-stdio',action='store_true',required=True);parser.parse_args()
    try:asyncio.run(main())
    except Exception as error:
        emit({'protocol':1,'type':'event','event':'closed','details':{'status':'helper-failed','errorType':type(error).__name__}})
        raise SystemExit(1)

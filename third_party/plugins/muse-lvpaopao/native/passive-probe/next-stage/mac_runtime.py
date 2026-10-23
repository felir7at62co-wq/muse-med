"""Exact-build native transport for the separately prepared isolated Mac WeChat copy."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import time

PROFILE_NAME='macos-269602-isolated'
PROFILE={'expectedAppId':'wx404dde55fb12df78','runtimeProfile':PROFILE_NAME,'runtimePlatform':'darwin','mainSHA256':'a79b1a2f51c3c8277b3ddc6fcb5f2807f6b855760f82160edcab43be7d54d10a','executableSHA256':'2b65dff275f8be25862339ab8a91635610132a7745d41bbac9e05dca4e74ab0a','moduleSHA256':'03fb5a7fc7486c6241219ab54e847e9718071f8b1a835cbe00c521e2f471b9e4','expectedScenes':[1256],'allowDefaultIdentityRead':True,'downloadEnabled':True}
EXE_PART='Contents/MacOS/WeChatAppEx.app/Contents/MacOS/WeChatAppEx'
MODULE_PART='Contents/MacOS/WeChatAppEx.app/Contents/Frameworks/WeChatAppEx Framework.framework/Versions/C/WeChatAppEx Framework'


class MacRuntimeFailure(RuntimeError):
    """A fixed failure code without environment, account data, or native error text."""


def _processes():
    result=subprocess.run(['/bin/ps','-axo','pid=,ppid=,uid=,comm='],capture_output=True,timeout=5,check=True)
    return [row.strip().split(None,3) for row in result.stdout.decode('utf8',errors='replace').splitlines()]


def _started(pid):
    result=subprocess.run(['/bin/ps','-p',str(pid),'-o','lstart='],capture_output=True,timeout=5,check=True)
    value=result.stdout.decode('ascii').strip()
    if not value or len(value)>64:raise MacRuntimeFailure('mac-runtime-start-invalid')
    return value


def discover():
    """Find one current-user isolated copy; the ordinary signed WeChat is excluded."""
    rows=_processes();by_id={row[0]:row for row in rows if len(row)==4};candidates=[]
    for row in rows:
        if len(row)!=4 or row[2]!=str(os.getuid()) or not row[3].endswith('/WeChat-Muse-Test.app/'+EXE_PART):continue
        app=Path(row[3][:-len('/'+EXE_PART)])
        parent=by_id.get(row[1])
        if not parent or parent[2]!=str(os.getuid()) or parent[3]!=str(app/'Contents/MacOS/WeChat'):continue
        metadata=plistlib.loads((app/'Contents/Info.plist').read_bytes())
        if metadata.get('CFBundleIdentifier')!='local.muse.lvpaopao.WeChatTest' or str(metadata.get('CFBundleVersion'))!='269602':continue
        candidates.append({'runtimeProfile':PROFILE_NAME,'appPath':str(app),'privateHome':str(app.parent/'user-home'),'mainPid':int(parent[0]),'rootPid':int(row[0]),'mainStarted':_started(int(parent[0])),'rootStarted':_started(int(row[0])),'executablePath':row[3],'modulePath':str(app/MODULE_PART)})
    if not candidates:return None
    if len(candidates)!=1:raise MacRuntimeFailure('mac-runtime-ambiguous')
    verify(candidates[0]);return candidates[0]


def verify(config):
    """Require the exact isolated binaries, owner, parent, start times and private home."""
    for key in ('rootPid','mainPid'):
        if type(config.get(key))is not int or config[key]<1:raise MacRuntimeFailure('mac-runtime-config-invalid')
    for key in ('appPath','privateHome','executablePath','modulePath','mainStarted','rootStarted'):
        value=config.get(key)
        if not isinstance(value,str) or not value or len(value)>8192 or any(character in value for character in ('\0','\r','\n')):raise MacRuntimeFailure('mac-runtime-config-invalid')
    app=Path(config['appPath']);home=Path(config['privateHome'])
    if not app.is_absolute() or app.name!='WeChat-Muse-Test.app' or home!=app.parent/'user-home':raise MacRuntimeFailure('mac-runtime-path-invalid')
    paths={'mainSHA256':app/'Contents/MacOS/WeChat','executableSHA256':app/EXE_PART,'moduleSHA256':app/MODULE_PART}
    if config['executablePath']!=str(paths['executableSHA256']) or config['modulePath']!=str(paths['moduleSHA256']):raise MacRuntimeFailure('mac-runtime-path-invalid')
    for name,path in paths.items():
        with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
        if digest!=PROFILE[name]:raise MacRuntimeFailure('mac-runtime-build-unsupported')
    rows={int(row[0]):row for row in _processes() if len(row)==4}
    root=rows.get(config['rootPid']);main=rows.get(config['mainPid'])
    if not root or not main or root[1]!=str(config['mainPid']) or root[2]!=str(os.getuid()) or main[2]!=str(os.getuid()) or root[3]!=str(paths['executableSHA256']) or main[3]!=str(paths['mainSHA256']):raise MacRuntimeFailure('mac-runtime-process-changed')
    if _started(config['rootPid'])!=config['rootStarted'] or _started(config['mainPid'])!=config['mainStarted']:raise MacRuntimeFailure('mac-runtime-process-changed')
    info=home.lstat()
    if not home.is_dir() or home.is_symlink() or info.st_uid!=os.getuid():raise MacRuntimeFailure('mac-runtime-home-invalid')
    environment=' '+subprocess.run(['/bin/ps','eww','-p',str(config['mainPid']),'-o','command='],capture_output=True,timeout=5,check=True).stdout.decode('utf8',errors='replace').strip()+' '
    if ' HOME='+str(home)+' ' not in environment or ' CFFIXED_USER_HOME='+str(home)+' ' not in environment:raise MacRuntimeFailure('mac-runtime-home-invalid')
    return {'rootPid':config['rootPid'],'mainPid':config['mainPid'],'isolatedCopy':True,'exactBuildVerified':True,'privateHomeVerified':True}


def require_peer(config,source_port):
    """Admit a loopback socket only from the exact isolated AppEx process tree."""
    verify(config)
    result=subprocess.run(['/usr/sbin/lsof','-nP','-iTCP:9421','-sTCP:ESTABLISHED','-Fpn'],capture_output=True,timeout=5,check=True)
    owners=[];pid=None
    for line in result.stdout.decode('ascii',errors='replace').splitlines():
        if line.startswith('p'):pid=int(line[1:])
        if line=='n127.0.0.1:'+str(source_port)+'->127.0.0.1:9421':owners.append(pid)
    if len(owners)!=1:raise MacRuntimeFailure('mac-runtime-peer-rejected')
    current=owners[0];rows={int(row[0]):row for row in _processes() if len(row)==4}
    for _ in range(32):
        row=rows.get(current)
        if not row or row[2]!=str(os.getuid()) or not Path(row[3]).is_relative_to(config['appPath']):break
        if current==config['rootPid']:return {'rootPid':current,'ownerPid':owners[0],'sourcePort':source_port}
        current=int(row[1])
    raise MacRuntimeFailure('mac-runtime-peer-rejected')


async def run(root,config,protocol_type,cleanup_resources,bounded_call,error_type,print_event):
    """Run the shared fixed-operation protocol with Mac ownership checks and owned cleanup."""
    from websockets.asyncio.server import serve
    import frida
    if config.get('runtimeProfile')!=PROFILE_NAME or config.get('expectedAppId')!=PROFILE['expectedAppId']:raise MacRuntimeFailure('mac-runtime-config-invalid')
    duration=config.get('durationMs');callbacks=config.get('maxCallbacks')
    if type(duration)is not int or not 60000<=duration<=14400000 or type(callbacks)is not int or not 1<=callbacks<=16384:raise MacRuntimeFailure('mac-runtime-config-invalid')
    target=verify(config);loop=asyncio.get_running_loop();connections={};tasks=set();server=None;session=None;script=None;claimed=False
    async def send(frame):await connections['peer'].send(frame)
    state=protocol_type(config,send)
    async def gate(connection,_request):
        nonlocal claimed
        try:
            address=connection.remote_address
            if claimed or not isinstance(address,tuple) or address[0]!='127.0.0.1':raise MacRuntimeFailure('mac-runtime-peer-rejected')
            await asyncio.wait_for(state.hook_enabled.wait(),5)
            state.peer=await asyncio.to_thread(require_peer,config,address[1]);claimed=True
        except Exception as error:
            # No peer-provided text or process metadata reaches the public response.
            return connection.respond(403,'Peer rejected')
    async def handler(connection):
        task=asyncio.current_task();tasks.add(task);connections['peer']=connection
        try:
            await state.enable_route('')
            async for raw in connection:
                await state.accept_frame(raw)
                if state.done.is_set():break
        except asyncio.CancelledError:raise
        except Exception as error:state.status='peer-stopped'
        finally:tasks.discard(task);state.done.set()
    def message(value,binary):
        if binary is not None:return
        payload=value.get('payload') if value.get('type')=='send' else None
        kind=payload.get('type') if isinstance(payload,dict) else 'script-error'
        def apply():
            state.hook_counts[kind if kind in {'ready','target-enabled','cdp-filter-patched','observation-error','disposed'} else 'other']+=1
            if kind=='target-enabled':state.hook_enabled.set()
            if kind=='ready' and payload.get('active') is True and payload.get('guardsVerified') is True:
                print_event(json.dumps({'type':'identity-probe-ready','durationMs':duration}),flush=True)
            if kind in {'script-error','observation-error','disposed'}:state.status='hook-stopped';state.done.set()
        loop.call_soon_threadsafe(apply)
    previous={}
    def stop(*_):
        state.status='cancelled';loop.call_soon_threadsafe(state.done.set)
    def detached(*_):
        if not state.stopping:loop.call_soon_threadsafe(state.done.set)
    for sig in (signal.SIGINT,signal.SIGTERM):previous[sig]=signal.getsignal(sig);signal.signal(sig,stop)
    logger=logging.getLogger('muse-mac-private');logger.handlers=[logging.NullHandler()];logger.propagate=False
    try:
        server=await serve(handler,'127.0.0.1',9421,process_request=gate,max_size=4*1024*1024,compression=None,max_queue=4,open_timeout=10,close_timeout=2,logger=logger)
        session=await asyncio.to_thread(bounded_call,frida,lambda:frida.get_local_device().attach(config['rootPid'],persist_timeout=0,exceptor='off',unwind_broker=False,exit_monitor=False,thread_suspend_monitor=False),10)
        session.on('detached',detached)
        values={'appId':config['expectedAppId'],'modulePath':config['modulePath'],'expectedScenes':PROFILE['expectedScenes'],'maxCallbacks':callbacks,'maxFilterCallbacks':callbacks,'durationMs':duration}
        source=(root/'enable-target-debug-mac-269602.js').read_text().replace('@@CONFIG@@',json.dumps(values))
        script=session.create_script(source);script.on('message',message);script.load()
        if not state.done.is_set():state.status='awaiting-target-peer'
        try:await asyncio.wait_for(state.done.wait(),duration/1000)
        except TimeoutError:state.status='deadline'
    finally:
        state.stopping=True;state.done.set()
        for task in list(tasks):task.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
        cleanup=await cleanup_resources(frida,script,session,server,state)
        for sig,handler_value in previous.items():signal.signal(sig,handler_value)
        receipt={**state.receipt(),'target':target,'cleanup':cleanup,'runtimeProfile':PROFILE_NAME}
        path=root/'native-identity.receipt.json';path.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
        print_event(json.dumps({'type':'identity-probe-finished','status':state.status,'identityMatched':state.identity is not None,'cleanup':{key:cleanup[key] for key in ('dispose','unload','detach','serverClosed')}}),flush=True)
    if not all(cleanup[key] for key in ('dispose','unload','detach','serverClosed')):raise error_type('cleanup-incomplete')
    if state.identity is None:raise error_type('identity-not-established')

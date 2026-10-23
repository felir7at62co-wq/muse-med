"""Offline mocks only: no listener, Windows child command, Frida import, or attach."""
import asyncio
import base64
import importlib.util
import hashlib
import builtins
import io
import tempfile
import json
import ntpath
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock

import remote_wire as wire
from runtime_profiles import PROFILES

ROOT=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('muse_native_identity_controller_tests',ROOT/'run-native-identity.py')
CONTROLLER=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROLLER)


def config(**overrides):
    return {'rootPid':1234,'rootCreatedUtc':'2026-10-19T08:46:00.0000000Z','sessionId':1,'expectedAppId':'wx0123456789abcdef','executablePath':r'C:\Runtime\WeChatAppEx.exe','executableSHA256':'a'*64,'modulePath':r'C:\Runtime\flue.dll','moduleSHA256':'b'*64,'durationMs':180000,**overrides}


def incoming(cdp,native='',op_id=0,seq=29):
    return wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS_RESULT,{'opId':op_id,'payload':json.dumps(cdp),'jscontextId':native},seq=seq)


def decoded_commands(frames):
    result=[]
    for raw in frames:
        frame=wire.decode_frame(raw)
        result.append((frame,json.loads(frame.payload.payload)))
    return result


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent=[]
        async def send(frame):self.sent.append(frame)
        self.state=CONTROLLER.IdentityProtocol(config(),send)

    async def context(self,native='native-1',cdp_id=7):
        await self.state.accept_frame(wire.encode_frame(wire.CATEGORY_ADD_JS_CONTEXT,{'jscontextId':native,'jscontextName':'private display name never logged'}))
        await self.state.accept_frame(incoming({'method':'Runtime.executionContextCreated','params':{'context':{'id':cdp_id,'name':'private page name'}}},native))

    async def identity_response(self,value,native='native-1',op_offset=0):
        _,command=decoded_commands(self.sent)[-1]
        pending=self.state.pending[command['id']]
        await self.state.accept_frame(incoming({'id':command['id'],'result':{'result':{'type':'object','value':value}}},native,pending['opId']+op_offset))

    async def test_only_enable_and_fixed_identity_getter_are_sent(self):
        await self.context()
        commands=decoded_commands(self.sent)
        self.assertEqual([c['method'] for _,c in commands],['Runtime.enable','Runtime.evaluate'])
        frame,command=commands[-1]
        self.assertEqual(command['params']['contextId'],7)
        self.assertTrue(command['params']['returnByValue'])
        self.assertEqual(command['params']['expression'],CONTROLLER.identity_expression(config()['expectedAppId']))
        self.assertNotIn('operateWXData(',command['params']['expression'])
        self.assertNotEqual(frame.outer.seq,frame.payload.opId)
        self.assertNotEqual(frame.payload.opId,command['id'])
        self.assertEqual(frame.outer.after,0)

    async def test_explicit_context_boolean_identity_success_has_no_names(self):
        await self.context()
        await self.identity_response({'matchesExpected':True,'hasOperateWXData':True})
        self.assertTrue(self.state.done.is_set())
        self.assertEqual(self.state.identity['executionContextId'],7)
        self.assertTrue(self.state.identity['hasOperateWXData'])
        receipt=json.dumps(self.state.receipt())
        self.assertNotIn('private display name',receipt)
        self.assertNotIn('private page name',receipt)
        self.assertNotIn('native-1',receipt)
        self.assertIn('nativeContextIdHash',receipt)
        self.assertEqual(self.state.identity['responseIds']['outerSeq'],29)

    async def test_opaque_context_ids_are_not_restricted_to_guessed_characters(self):
        native='上下文 / opaque[] '+('z'*200)
        await self.context(native,12)
        await self.identity_response({'matchesExpected':True,'hasOperateWXData':False},native)
        self.assertTrue(self.state.identity['matchesExpected'])
        self.assertFalse(self.state.identity['hasOperateWXData'])
        self.assertNotIn(native,json.dumps(self.state.receipt(),ensure_ascii=False))

    async def test_response_matches_pending_cdp_and_native_route_without_requiring_op_id_echo(self):
        await self.context()
        _,command=decoded_commands(self.sent)[-1]
        pending=self.state.pending[command['id']]
        await self.state.accept_frame(incoming({'id':command['id']+1,'result':{'result':{'value':{'matchesExpected':True,'hasOperateWXData':True}}}},'native-1',0))
        self.assertIsNone(self.state.identity)
        await self.identity_response({'matchesExpected':True,'hasOperateWXData':True},native='other-native',op_offset=1)
        self.assertIsNone(self.state.identity)
        self.assertEqual(self.state.protocol_errors['response-correlation'],1)
        await self.identity_response({'matchesExpected':True,'hasOperateWXData':True},op_offset=1)
        self.assertTrue(self.state.identity['matchesExpected'])
        self.assertEqual(self.state.identity['requestIds']['opId'],pending['opId'])
        self.assertEqual(self.state.identity['responseIds']['opId'],pending['opId']+1)

    async def test_false_or_nonboolean_identity_is_not_accepted(self):
        for value in [{'matchesExpected':False,'hasOperateWXData':True},{'matchesExpected':'true','hasOperateWXData':True},{'matchesExpected':True,'hasOperateWXData':True,'name':'private'}]:
            with self.subTest(value_kind=type(value['matchesExpected']).__name__):
                await self.asyncSetUp()
                await self.context()
                await self.identity_response(value)
                self.assertIsNone(self.state.identity)
                self.assertNotIn('private',json.dumps(self.state.receipt()))

    async def test_four_candidate_cap_prevents_unbounded_context_reads(self):
        for index in range(12):
            await self.state.accept_frame(incoming({'method':'Runtime.executionContextCreated','params':{'context':{'id':index}}}))
        commands=decoded_commands(self.sent)
        self.assertEqual(len(commands),4)
        self.assertTrue(all(command['method']=='Runtime.evaluate' for _,command in commands))
        self.assertEqual(len(self.state.candidates),4)

    async def test_default_identity_fallback_is_off_without_explicit_flag(self):
        await self.state.enable_route('')
        frame,command=decoded_commands(self.sent)[-1]
        await self.state.accept_frame(incoming({'id':command['id'],'result':{}},op_id=frame.payload.opId))
        self.assertIsNone(self.state.fallback_task)
        self.assertEqual(len(self.sent),1)
        with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'default-identity-disabled'):
            await self.state.command('Runtime.evaluate','',None)

    async def test_opt_in_default_fallback_sends_only_fixed_identity_read(self):
        self.state.config['allowDefaultIdentityRead']=True
        await self.state.enable_route('')
        frame,command=decoded_commands(self.sent)[-1]
        with mock.patch.object(CONTROLLER.asyncio,'sleep',new=mock.AsyncMock()):
            await self.state.accept_frame(incoming({'id':command['id'],'result':{}},op_id=frame.payload.opId))
            await self.state.fallback_task
        _,command=decoded_commands(self.sent)[-1]
        self.assertEqual(command['method'],'Runtime.evaluate')
        self.assertNotIn('contextId',command['params'])
        self.assertEqual(command['params']['expression'],CONTROLLER.identity_expression(config()['expectedAppId']))

    async def test_arbitrary_debug_or_business_methods_are_rejected(self):
        for method in ['Debugger.enable','Network.enable','Page.getResourceTree','wx.operateWXData']:
            with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'command-not-allowed'):
                await self.state.command(method)
        self.assertEqual(self.sent,[])

    async def test_unknown_category_is_counted_without_raw_name_or_payload(self):
        raw=wire._TYPES['DebugMessage'](seq=9,category='unrecognized-private-category',data=b'private payload',compressAlgo=0,originalSize=0).SerializeToString()
        await self.state.accept_frame(raw)
        self.assertEqual(self.state.category_counts,{'unknown':1})
        self.assertFalse(self.state.done.is_set())
        self.assertNotIn('private',json.dumps(self.state.receipt()))
        self.assertEqual(self.sent,[])

    async def test_setup_script_is_never_executed_or_echoed(self):
        await self.state.accept_frame(wire.encode_frame(wire.CATEGORY_SETUP_CONTEXT,{'configureJs':'throw new Error("private remote source")'}))
        self.assertEqual(self.state.category_counts[wire.CATEGORY_SETUP_CONTEXT],1)
        self.assertEqual(self.sent,[])
        self.assertNotIn('private remote source',json.dumps(self.state.receipt()))

    async def test_malformed_frame_stops_without_commands(self):
        await self.state.accept_frame(b'\xff')
        self.assertEqual(self.state.status,'protocol-error')
        self.assertTrue(self.state.done.is_set())
        self.assertEqual(self.sent,[])

    async def test_removed_native_context_invalidates_late_identity(self):
        await self.context()
        frame,command=decoded_commands(self.sent)[-1]
        await self.state.accept_frame(wire.encode_frame(wire.CATEGORY_REMOVE_JS_CONTEXT,{'jscontextId':'native-1'}))
        await self.state.accept_frame(incoming({'id':command['id'],'result':{'result':{'value':{'matchesExpected':True,'hasOperateWXData':True}}}},'native-1',frame.payload.opId))
        self.assertIsNone(self.state.identity)


class PeerTests(unittest.IsolatedAsyncioTestCase):
    async def test_verified_loopback_peer_is_unique_and_others_receive_no_commands(self):
        state=CONTROLLER.IdentityProtocol(config(),mock.AsyncMock())
        state.hook_enabled.set()
        gate=CONTROLLER.PeerGate(config(),SimpleNamespace(),state)
        connection=SimpleNamespace(remote_address=('127.0.0.1',50000),respond=lambda code,text:{'code':code})
        with mock.patch.object(CONTROLLER,'require_peer',return_value={'rootPid':1234,'ownerPid':1234,'sourcePort':50000}) as proof:
            self.assertIsNone(await gate.process_request(connection,None))
            self.assertEqual((await gate.process_request(connection,None))['code'],409)
            self.assertEqual(proof.call_count,1)
        state.send_frame.assert_not_called()

    async def test_nonlocal_or_unverified_peer_is_rejected_without_commands(self):
        for remote in [('10.0.0.2',50000),('127.0.0.1',50000)]:
            state=CONTROLLER.IdentityProtocol(config(),mock.AsyncMock());state.hook_enabled.set()
            gate=CONTROLLER.PeerGate(config(),SimpleNamespace(),state)
            connection=SimpleNamespace(remote_address=remote,respond=lambda code,text:{'code':code})
            with mock.patch.object(CONTROLLER,'require_peer',side_effect=RuntimeError('private failure')):
                self.assertEqual((await gate.process_request(connection,None))['code'],403)
            self.assertFalse(gate.claimed)
            state.send_frame.assert_not_called()


    async def test_shutdown_rejects_new_and_inflight_handshakes_before_commands(self):
        state=CONTROLLER.IdentityProtocol(config(),mock.AsyncMock());state.hook_enabled.set()
        gate=CONTROLLER.PeerGate(config(),SimpleNamespace(),state)
        connection=SimpleNamespace(remote_address=('127.0.0.1',50000),respond=lambda code,text:{'code':code})
        gate.closed=True
        with mock.patch.object(CONTROLLER,'require_peer') as proof:
            self.assertEqual((await gate.process_request(connection,None))['code'],503)
            proof.assert_not_called()
        gate.closed=False
        async def in_flight(*_args):
            gate.closed=True
            return {'rootPid':1234,'ownerPid':1234,'sourcePort':50000}
        with mock.patch.object(CONTROLLER.asyncio,'to_thread',side_effect=in_flight):
            self.assertEqual((await gate.process_request(connection,None))['code'],503)
        self.assertFalse(gate.claimed)
        self.assertIsNone(state.peer)
        state.send_frame.assert_not_called()

    async def test_shutdown_protocol_rejects_sends_and_ignores_late_metadata(self):
        state=CONTROLLER.IdentityProtocol(config(),mock.AsyncMock());state.stopping=True
        with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'probe-stopping'):
            await state.command('Runtime.enable')
        await state.accept_frame(wire.encode_frame(wire.CATEGORY_ADD_JS_CONTEXT,{'jscontextId':'late-context'}))
        state.send_frame.assert_not_called()
        self.assertEqual(state.native_ids,set())


class PeerMetadataTests(unittest.TestCase):
    def proof(self,**overrides):
        return {'RootPid':1234,'CreatedUtc':config()['rootCreatedUtc'],'RootExecutablePath':'c:/runtime/WECHATAPPEX.EXE','RootSessionId':1,'OwnerPid':1234,'OwnerName':'WeChatAppEx.exe','OwnerSessionId':1,'OwnerExecutablePath':'c:/RUNTIME/WeChatAppEx.exe','BelongsToSelectedRoot':True,**overrides}
    def guard(self):
        return SimpleNamespace(file_digest=lambda p:'a'*64 if p.endswith('.exe') else 'b'*64,normal_path=lambda p:ntpath.normcase(ntpath.normpath(p)))
    def test_root_self_and_app_ex_descendant_are_accepted_from_fresh_socket_metadata(self):
        for owner in [1234,9999]:
            data=self.proof(OwnerPid=owner)
            reply=subprocess.CompletedProcess([],0,json.dumps(data).encode(),b'')
            with mock.patch.object(CONTROLLER.subprocess,'run',return_value=reply) as run:
                result=CONTROLLER.require_peer(config(),50000,self.guard())
            self.assertEqual(result['ownerPid'],owner)
            ps=base64.b64decode(run.call_args.args[0][-1]).decode('utf-16le')
            self.assertIn('Get-NetTCPConnection',ps)
            self.assertNotIn('CommandLine',ps)
            self.assertIn('50000',ps)
    def test_wrong_root_time_session_lineage_or_runtime_path_is_rejected(self):
        variants=[{'CreatedUtc':'different'},{'RootPid':5555},{'RootSessionId':2},{'OwnerSessionId':2},{'BelongsToSelectedRoot':False},{'OwnerName':'Other.exe'},{'OwnerExecutablePath':r'C:\Other\WeChatAppEx.exe'}]
        for variant in variants:
            with self.subTest(fields=list(variant)):
                reply=subprocess.CompletedProcess([],0,json.dumps(self.proof(**variant)).encode(),b'')
                with mock.patch.object(CONTROLLER.subprocess,'run',return_value=reply):
                    with self.assertRaises(CONTROLLER.ProbeFailure):CONTROLLER.require_peer(config(),50000,self.guard())
    def test_changed_module_hash_rejects_before_socket_metadata_command(self):
        guard=self.guard();guard.file_digest=lambda _:'c'*64
        with mock.patch.object(CONTROLLER.subprocess,'run') as run:
            with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'runtime-file-changed'):CONTROLLER.require_peer(config(),50000,guard)
            run.assert_not_called()


class ColdLaunchPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='muse-cold-attestation-offline-')
        self.base=Path(self.temporary.name);self.root=self.base/'next-stage';self.root.mkdir()
        self.current=config(loadStartRva=4096,expectedEntryBytes='90'*16)
        self.previous=dict(self.current)
        self.receipt={'attempt':2,'exitCode':0,'stderr':'','stdoutLines':[
            json.dumps({'type':'ready','passive':True,'entryBytesVerified':True,'modulePathMatched':True}),
            json.dumps({'type':'target-launch','inlineOffsets':[152,184],'scene':1183}),
            json.dumps({'type':'observation-finished','status':'target-observed','cleanup':{'dispose':True,'unload':True,'detach':True}})]}
        self.write_proof()
        self.guard=CONTROLLER.load_target_guard()
        self.metadata={'RootPid':1234,'CreatedUtc':self.current['rootCreatedUtc'],'ExecutablePath':self.current['executablePath'],'SessionId':1,'MatchingTargetCount':0,'ForeignAppIdCount':0}
    def tearDown(self):self.temporary.cleanup()
    def write_proof(self):
        previous=self.base/'passive-config.json';proof=self.base/'receipt2.json'
        previous.write_text(json.dumps(self.previous));proof.write_text(json.dumps(self.receipt))
        self.current['coldLaunchAttestation']={'receiptPath':'../receipt2.json','receiptSHA256':hashlib.sha256(proof.read_bytes()).hexdigest(),'configPath':'../passive-config.json','configSHA256':hashlib.sha256(previous.read_bytes()).hexdigest()}
    def evaluate(self):
        reply=subprocess.CompletedProcess([],0,json.dumps(self.metadata).encode(),b'')
        digest=lambda p:self.current['executableSHA256'] if p==self.current['executablePath'] else self.current['moduleSHA256']
        with mock.patch.object(self.guard.subprocess,'run',return_value=reply) as command, mock.patch.object(self.guard,'file_digest',side_effect=digest):
            return CONTROLLER.require_preflight(self.current,self.guard,self.root),command
    def test_explicit_attestation_accepts_current_zero_or_one_and_reports_actual_count(self):
        for count in [0,1]:
            with self.subTest(count=count):
                self.metadata['MatchingTargetCount']=count
                result,_=self.evaluate()
                self.assertEqual(result['targetRendererCount'],count)
                self.assertEqual(result['preflightMode'],'cold-launch-attested')
                self.assertEqual(result['passiveReceiptSHA256'],self.current['coldLaunchAttestation']['receiptSHA256'])
    def test_strict_default_still_rejects_zero_without_falling_back(self):
        self.current.pop('coldLaunchAttestation')
        with self.assertRaisesRegex(RuntimeError,'application identity'):
            self.evaluate()
    def test_cold_mode_still_rejects_ambiguous_renderer_foreign_app_and_reused_root(self):
        for field,value in [('MatchingTargetCount',2),('ForeignAppIdCount',1),('RootPid',9999),('CreatedUtc','new-root-lifetime')]:
            with self.subTest(field=field):
                before=self.metadata[field];self.metadata[field]=value
                with self.assertRaises(RuntimeError):self.evaluate()
                self.metadata[field]=before
    def test_receipt_hash_mismatch_is_rejected_before_any_windows_command(self):
        (self.base/'receipt2.json').write_text('{}')
        with mock.patch.object(self.guard.subprocess,'run') as command:
            with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'hash-mismatch'):
                CONTROLLER.require_preflight(self.current,self.guard,self.root)
            command.assert_not_called()
    def test_prior_root_mismatch_and_invalid_passive_proof_are_rejected_before_windows_command(self):
        self.previous['rootCreatedUtc']='other-lifetime';self.write_proof()
        with mock.patch.object(self.guard.subprocess,'run') as command:
            with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'root-or-runtime-mismatch'):
                CONTROLLER.require_preflight(self.current,self.guard,self.root)
            command.assert_not_called()
        self.previous['rootCreatedUtc']=self.current['rootCreatedUtc']
        self.receipt['stdoutLines'][1]=json.dumps({'type':'target-launch','inlineOffsets':[152],'scene':1183})
        self.write_proof()
        with mock.patch.object(self.guard.subprocess,'run') as command:
            with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'proof-invalid'):
                CONTROLLER.require_preflight(self.current,self.guard,self.root)
            command.assert_not_called()


class CleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_failures_do_not_skip_other_operations(self):
        for failed in [None,'dispose','unload','detach','server']:
            with self.subTest(operation=failed):
                operations=[]
                def act(name):
                    operations.append(name)
                    if failed==name:raise RuntimeError('private exception detail')
                    return {'detached':True,'flushed':True,'sceneWrites':1,'private':'never log'}
                script=SimpleNamespace(exports_sync=SimpleNamespace(dispose=lambda:act('dispose')),unload=lambda:act('unload'))
                session=SimpleNamespace(detach=lambda:act('detach'))
                server=SimpleNamespace(close=lambda **_:act('server'),wait_closed=mock.AsyncMock())
                state=CONTROLLER.IdentityProtocol(config(),mock.AsyncMock())
                with mock.patch.object(CONTROLLER,'bounded_call',side_effect=lambda _f,callback,_s:callback()):
                    result=await CONTROLLER.cleanup_resources(None,script,session,server,state)
                self.assertEqual(operations,['dispose','unload','detach','server'])
                field='serverClosed' if failed=='server' else failed
                if failed:self.assertFalse(result[field])
                else:self.assertTrue(all(result[k] for k in ['dispose','unload','detach','serverClosed']))
                self.assertNotIn('private',json.dumps(result))


class MainCompositionTests(unittest.IsolatedAsyncioTestCase):
    async def run_probe(self,mode='success'):
        loop=asyncio.get_running_loop();order=[];drivers=[];sent=[];callbacks={};import_original=builtins.__import__
        class Connection:
            remote_address=('127.0.0.1',50000)
            def __init__(self):self.queue=asyncio.Queue()
            def respond(self,code,text):return {'code':code}
            def __aiter__(self):return self
            async def __anext__(self):return await self.queue.get()
            async def send(self,raw):
                frame=wire.decode_frame(raw);command=json.loads(frame.payload.payload);sent.append(command)
                if command['method']=='Runtime.enable':
                    self.queue.put_nowait(incoming({'method':'Runtime.executionContextCreated','params':{'context':{'id':7}}}))
                elif command['method']=='Runtime.evaluate':
                    self.queue.put_nowait(incoming({'id':command['id'],'result':{'result':{'value':{'matchesExpected':True,'hasOperateWXData':True}}}},op_id=frame.payload.opId))
                else:raise AssertionError('Business/debug command outside allowlist')
        connection=Connection()
        class Server:
            def __init__(self):self.closed=False;self.handler=None;self.process_request=None
            def close(self,**kwargs):
                order.append('server-close');self.closed=True
            async def wait_closed(self):
                if drivers:await asyncio.gather(*drivers,return_exceptions=True)
        server=Server()
        async def serve_fake(handler,host,port,**kwargs):
            order.append('listen')
            self.assertEqual((host,port),('127.0.0.1',9421))
            self.assertEqual(kwargs['max_size'],4*1024*1024)
            self.assertIsNone(kwargs['compression'])
            server.handler=handler;server.process_request=kwargs['process_request']
            return server
        async def drive():
            response=await server.process_request(connection,None)
            self.assertIsNone(response)
            await server.handler(connection)
        def load():
            order.append('load')
            if mode=='setup-failure':raise RuntimeError('private setup details')
            if mode=='success':
                callbacks['message']({'type':'send','payload':{'type':'ready','active':False,'guardsVerified':True}},None)
                callbacks['message']({'type':'send','payload':{'type':'ready','active':True,'guardsVerified':True}},None)
                callbacks['message']({'type':'send','payload':{'type':'ready','active':True,'guardsVerified':True}},None)
                callbacks['message']({'type':'send','payload':{'type':'target-enabled'}},None)
                loop.call_soon_threadsafe(lambda:drivers.append(asyncio.create_task(drive())))
        def create_script(source,**kwargs):
            order.append('create-script')
            injected=json.loads(source[len('const config='):-1])
            self.assertEqual(set(injected),set(CONTROLLER.HOOK_KEYS))
            self.assertEqual(kwargs['name'],'muse-lvpaopao-native-identity')
            return script
        def on(name,callback):callbacks[name]=callback
        def dispose():
            order.append('dispose')
            callbacks['message']({'type':'send','payload':{'type':'ready','active':True,'guardsVerified':True}},None)
            callbacks['message']({'type':'send','payload':{'type':'observation-error','code':'late-test'}},None)
            return {'detached':True,'flushed':True,'sceneWrites':1,'argumentWrites':1}
        script=SimpleNamespace(on=on,load=load,exports_sync=SimpleNamespace(dispose=dispose),unload=lambda:order.append('unload'))
        session=SimpleNamespace(create_script=create_script,detach=lambda:order.append('detach'))
        def attach(pid,**kwargs):
            order.append('attach');self.assertEqual(pid,1234);self.assertEqual(kwargs,{'persist_timeout':0});return session
        frida=SimpleNamespace(get_local_device=lambda:SimpleNamespace(attach=attach))
        def import_fake(name,*args,**kwargs):
            if name=='frida':order.append('frida-import');return frida
            if name.startswith('frida.'):raise AssertionError('Native Frida submodule import prohibited')
            return import_original(name,*args,**kwargs)
        def gate(_):
            order.append('full-target-gate');return {'rootPid':1234,'sessionId':1,'targetRendererCount':1}
        runtime_config={**config(),**PROFILES['wmpf-25560'],'maxCallbacks':64,'allowDefaultIdentityRead':False,'postUpgradeAuthorization':False}
        with tempfile.TemporaryDirectory(prefix='muse-native-identity-offline-') as directory:
            root=Path(directory);(root/'config.json').write_text(json.dumps(runtime_config));(root/'enable-target-debug.js').write_text('const config=@@CONFIG@@;')
            stdout=io.StringIO();error=None
            with mock.patch.object(CONTROLLER,'__file__',str(root/'run-native-identity.py')), \
                 mock.patch.object(CONTROLLER,'os',SimpleNamespace(name='nt')), \
                 mock.patch.object(CONTROLLER,'load_target_guard',return_value=SimpleNamespace(require_target=gate)), \
                 mock.patch.object(CONTROLLER,'require_peer',return_value={'rootPid':1234,'ownerPid':1234,'sourcePort':50000}), \
                 mock.patch.object(CONTROLLER,'serve',new=serve_fake), \
                 mock.patch.object(CONTROLLER,'bounded_call',side_effect=lambda _f,callback,_s:callback()), \
                 mock.patch.object(CONTROLLER.subprocess,'run',side_effect=AssertionError('No child command is allowed in offline tests')), \
                 mock.patch.object(CONTROLLER.signal,'getsignal',return_value=None), \
                 mock.patch.object(CONTROLLER.signal,'signal'), \
                 mock.patch('builtins.__import__',side_effect=import_fake), \
                 mock.patch('sys.stdout',stdout):
                clock=mock.patch.object(CONTROLLER,'time',SimpleNamespace(monotonic=mock.Mock(side_effect=[0,181,182]))) if mode=='deadline' else mock.patch.object(CONTROLLER,'time',CONTROLLER.time)
                with clock:
                    try:await CONTROLLER.main()
                    except CONTROLLER.ProbeFailure as caught:error=caught
            receipt=json.loads((root/'native-identity.receipt.json').read_text())
        self.assertTrue(server.closed)
        self.assertEqual(order[:4],['full-target-gate','listen','frida-import','attach'])
        self.assertEqual(order[-4:],['dispose','unload','detach','server-close'])
        self.assertTrue(all(receipt['cleanup'][key] for key in ['dispose','unload','detach','serverClosed']))
        self.assertNotIn('private setup details',stdout.getvalue())
        ready=[value for value in map(json.loads,stdout.getvalue().splitlines()) if value.get('type')=='identity-probe-ready']
        self.assertEqual(ready,[{'type':'identity-probe-ready','durationMs':180000}] if mode=='success' else [])
        return receipt,sent,error

    async def test_real_main_wiring_listens_before_fake_frida_and_closes_every_resource(self):
        receipt,sent,error=await self.run_probe()
        self.assertIsNone(error)
        self.assertEqual(receipt['status'],'identity-matched')
        self.assertTrue(receipt['identity']['matchesExpected'])
        self.assertEqual([c['method'] for c in sent],['Runtime.enable','Runtime.evaluate'])
        self.assertEqual(receipt['businessCalls'],0)

    async def test_ready_signal_requires_guards_and_is_not_repeated_or_emitted_during_cleanup(self):
        receipt,_,_=await self.run_probe()
        self.assertEqual(receipt['status'],'identity-matched')
        receipt,_,_=await self.run_probe('setup-failure')
        self.assertEqual(receipt['status'],'failed-RuntimeError')

    async def test_deadline_and_setup_failure_write_minimal_receipts_and_cleanup(self):
        for mode,status in [('deadline','deadline'),('setup-failure','failed-RuntimeError')]:
            with self.subTest(mode=mode):
                receipt,sent,error=await self.run_probe(mode)
                self.assertIsInstance(error,CONTROLLER.ProbeFailure)
                self.assertEqual(receipt['status'],status)
                self.assertIsNone(receipt['identity'])
                self.assertEqual(sent,[])


if __name__=='__main__':unittest.main(verbosity=2)


class CandidatePreflightTests(unittest.TestCase):
    def test_candidate_keeps_exact_guard_and_does_not_claim_renderer_identity(self):
        guard=mock.Mock();guard.require_target.return_value={'rootPid':1234,'targetRendererCount':0}
        value=CONTROLLER.require_preflight(config(targetLaunchCandidate=True),guard,Path('/unused'))
        guard.require_target.assert_called_once_with(config(targetLaunchCandidate=True),allow_missing_renderer=True)
        self.assertEqual(value['preflightMode'],'target-launch-candidate');self.assertEqual(value['targetRendererCount'],0)

    def test_candidate_rejects_nonboolean_or_fabricated_cold_attestation(self):
        guard=mock.Mock()
        for value in (config(targetLaunchCandidate=1),config(targetLaunchCandidate=True,coldLaunchAttestation={})):
            with self.assertRaises(CONTROLLER.ProbeFailure):CONTROLLER.require_preflight(value,guard,Path('/unused'))
        guard.require_target.assert_not_called()

if __name__=='__main__':unittest.main()

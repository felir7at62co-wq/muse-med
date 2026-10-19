"""Offline persistent stdio service checks; no stdin thread, network, or Windows."""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from native_rpc import NativeRpc
from operations.fixed_operations import TARGET_APP_ID,call_operation,fixed_operations
import remote_wire as wire

ROOT=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('muse_persistent_host_tests',ROOT/'run-persistent-host.py')
HOST=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(HOST)
SHARED=HOST.load_shared()
PRIVATE='https://a.qq.com/private?authorization=synthetic-secret'
NATIVE='private opaque native route'


def request(identifier,method,params):
    return json.dumps({'protocol':1,'type':'request','id':identifier,'method':method,'params':params}).encode()


def reply(request_,value):
    frame,cdp=request_
    return wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS_RESULT,{'opId':999999,'payload':json.dumps({'id':cdp['id'],'result':{'result':{'value':value}}}),'jscontextId':frame.payload.jscontextId})


def public_search(title='synthetic title'):
    return {'publicResult':{'operation':'search','status':'search-returned','identityMatched':True,'appVersion':'108','envVersion':'release','pluginVersion':'1.2.3','hostLoginState':True,'businessCalls':1,'timedOut':False,'resultCount':1,'partial':False,'candidates':[{'title':title,'srcAppId':'wx0123456789abcdef','originDramaId':'00121'}]},'privateResult':None}


class PersistentHostTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.outputs=[];self.output_queue=asyncio.Queue();self.frames=asyncio.Queue();self.started=[]
        def emit(value):self.outputs.append(value);self.output_queue.put_nowait(value)
        self.patch_emit=mock.patch.object(HOST,'emit',side_effect=emit);self.patch_emit.start()
        self.patch_thread=mock.patch.object(HOST.threading.Thread,'start',side_effect=lambda:self.started.append('prevented'));self.patch_thread.start()
        async def send(raw):
            frame=wire.decode_frame(raw);self.frames.put_nowait((frame,json.loads(frame.payload.payload)))
        protocol=HOST.make_protocol(SHARED,fixed_operations(['status','search','detail','episodes']),NativeRpc,call_operation)
        self.state=protocol({'expectedAppId':TARGET_APP_ID},send)
        self.assertEqual(self.started,['prevented'])

    async def asyncTearDown(self):
        await self.state.shutdown();self.patch_thread.stop();self.patch_emit.stop()

    async def output(self,identifier=None):
        while True:
            value=await asyncio.wait_for(self.output_queue.get(),1)
            if identifier is None or value.get('id')==identifier:return value

    async def frame(self):return await asyncio.wait_for(self.frames.get(),1)

    async def wait_tasks_empty(self):
        for _ in range(100):
            if not self.state.request_tasks:return
            await asyncio.sleep(0)
        self.fail('Owned request tasks did not settle')

    async def ready(self):
        self.state.seq=5;self.state.op_id=1005;self.state.cdp_id=2005
        self.state.native_ids.add(NATIVE)
        self.state.identity={'nativeContextIdHash':SHARED.context_hash(NATIVE),'executionContextId':7}
        await self.state.identity_matched();identity=await self.frame()
        self.assertEqual((identity[0].outer.seq,identity[0].payload.opId,identity[1]['id']),(6,1006,2006))
        await self.state.accept_frame(reply(identity,{'matchesExpected':True,'hasOperateWXData':True}))
        output=await self.output();self.assertEqual(output['event'],'ready');self.assertTrue(self.state.ready)

    async def test_hello_requires_matching_actual_helper_hash_and_appid(self):
        digest=hashlib.sha256((ROOT/'run-persistent-host.py').read_bytes()).hexdigest()
        self.state.enqueue(request('hello','hello',{'expected_app_id':TARGET_APP_ID,'helper_sha256':digest}))
        output=await self.output('hello');self.assertEqual(output['value']['helper_sha256'],digest);self.assertFalse(output['value']['ready'])
        for identifier,params in [('wronghash',{'expected_app_id':TARGET_APP_ID,'helper_sha256':'0'*64}),('wrongapp',{'expected_app_id':'wx0000000000000000','helper_sha256':digest})]:
            self.state.enqueue(request(identifier,'hello',params));output=await self.output(identifier)
            self.assertEqual(output['error']['code'],'helper-identity-mismatch')
        self.assertTrue(self.frames.empty())

    async def test_status_waiting_and_business_not_ready_are_safe_without_native_calls(self):
        self.state.enqueue(request('status','status',{}));output=await self.output('status')
        self.assertEqual(output['value'],{'status':'waiting_target','ready':False,'expectedAppId':TARGET_APP_ID})
        self.state.enqueue(request('invalid','status',{'url':PRIVATE}));self.assertEqual((await self.output('invalid'))['error']['code'],'parameters-invalid')
        self.state.enqueue(request('search','search',{'query':'synthetic'}));self.assertEqual((await self.output('search'))['error']['code'],'target-not-ready')
        self.assertTrue(self.frames.empty());self.assertNotIn(PRIVATE,json.dumps(self.outputs))

    async def test_unknown_method_and_unready_download_never_dispatch_arbitrary_code(self):
        for identifier,method,code in [('unknown','Runtime.evaluate','operation-not-supported'),('download','download_first_episode','capability-not-ready')]:
            self.state.enqueue(request(identifier,method,{'expression':PRIVATE}));self.assertEqual((await self.output(identifier))['error']['code'],code)
        self.assertTrue(self.frames.empty());self.assertNotIn(PRIVATE,json.dumps(self.outputs))

    async def test_real_rpc_highwater_and_operation_adapter_expose_only_valid_public_output(self):
        await self.ready()
        for identifier,title,expected in [('ok','synthetic title','result'),('bad',PRIVATE,'error')]:
            self.state.enqueue(request(identifier,'search',{'query':'synthetic'}))
            identity=await self.frame();self.assertGreater(identity[1]['id'],2006)
            await self.state.accept_frame(reply(identity,{'matchesExpected':True,'hasOperateWXData':True}))
            business=await self.frame();self.assertEqual(business[1]['params']['contextId'],7)
            await self.state.accept_frame(reply(business,public_search(title)))
            output=await self.output(identifier);self.assertEqual(output['type'],expected)
        self.assertEqual(self.state.counts['search'],1)
        self.assertNotIn(PRIVATE,json.dumps(self.outputs)+json.dumps(self.state.receipt()))
        self.assertTrue(self.state.ready);self.assertFalse(self.state.done.is_set())

    async def test_cancel_of_started_pending_request_settles_and_clears_its_task(self):
        await self.ready();self.state.enqueue(request('pending','search',{'query':'synthetic'}))
        await self.frame()
        self.state.enqueue(b'{"protocol":1,"type":"cancel","id":"pending"}')
        self.assertEqual((await self.output('pending'))['error']['code'],'cancelled')
        await self.wait_tasks_empty();self.assertFalse(self.state.rpc.receipt()['pending'])

    async def test_request_cancel_already_queued_settles_even_before_handler_first_runs(self):
        self.state.enqueue(request('immediate','status',{}))
        self.state.enqueue(b'{"protocol":1,"type":"cancel","id":"immediate"}')
        output=await self.output('immediate');self.assertEqual(output['error']['code'],'cancelled')
        await self.wait_tasks_empty()

    async def test_selected_context_invalidation_stops_host_and_rejects_late_reply(self):
        await self.ready();self.state.enqueue(request('pending','search',{'query':'synthetic'}));identity=await self.frame()
        await self.state.accept_frame(wire.encode_frame(wire.CATEGORY_REMOVE_JS_CONTEXT,{'jscontextId':NATIVE}))
        output=await self.output('pending');self.assertEqual(output['error']['code'],'context-removed')
        self.assertTrue(self.state.done.is_set());self.assertFalse(self.state.ready);self.assertEqual(self.state.status,'host-context-ended')
        await self.state.accept_frame(reply(identity,{'matchesExpected':True,'hasOperateWXData':True}));self.assertTrue(self.frames.empty())

    async def test_shutdown_cancels_pending_and_prevents_new_queued_requests(self):
        await self.ready();self.state.enqueue(request('pending','search',{'query':'synthetic'}));await self.frame()
        await self.state.shutdown()
        before=len(self.outputs);self.state.enqueue(request('late','status',{}));await asyncio.sleep(0)
        self.assertTrue(self.state.closing);self.assertFalse(self.state.ready)
        self.assertEqual(len(self.outputs),before);self.assertTrue(self.frames.empty())
        self.assertTrue(all(task.done() for task in self.state.owned));self.assertFalse(self.state.rpc.receipt()['pending'])

    async def test_eof_and_explicit_close_end_control_without_starting_native_operations(self):
        for line,status in [(None,'control-eof'),(b'{"protocol":1,"type":"close"}','control-close')]:
            with self.subTest(status=status):
                if self.state.done.is_set():
                    await self.state.shutdown()
                    protocol=HOST.make_protocol(SHARED,{},NativeRpc,call_operation)
                    self.state=protocol({'expectedAppId':TARGET_APP_ID},mock.AsyncMock())
                self.state.enqueue(line);await asyncio.wait_for(self.state.done.wait(),1)
                self.assertEqual(self.state.status,status)
                self.assertTrue(self.frames.empty())

    async def test_protocol_invalid_input_stops_control_without_echoing_content(self):
        self.state.enqueue(json.dumps({'protocol':1,'type':'request','id':'bad','method':'search','params':{},'unexpected':PRIVATE}).encode())
        await asyncio.wait_for(self.state.done.wait(),1)
        self.assertEqual(self.state.status,'control-protocol-invalid');self.assertEqual(self.outputs,[]);self.assertTrue(self.frames.empty())


if __name__=='__main__':unittest.main(verbosity=2)

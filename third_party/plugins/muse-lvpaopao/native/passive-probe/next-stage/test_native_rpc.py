"""Synthetic async protocol tests; no sockets, target execution, or Frida."""
import asyncio
import json
import unittest

import native_rpc as rpc
import remote_wire as wire

NATIVE='上下文 / opaque private route'
PRIVATE='https://a.qq.com/media?authorization=synthetic-secret'


def validate(parameters):
    if set(parameters)!={'query'} or not isinstance(parameters['query'],str):
        raise ValueError(PRIVATE)
    return parameters


def operations(timeout=1):
    return {'search':rpc.FixedOperation('(async function(params){return await trustedSearch(params);})(@@PARAMS@@)',validate,timeout)}


def response(request,value,native=None,cdp_id=None,op_id=999999,exception=False):
    frame,cdp=request
    result={'result':{'value':value}}
    if exception:result['exceptionDetails']={'text':PRIVATE}
    return wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS_RESULT,{'opId':op_id,'payload':json.dumps({'id':cdp['id'] if cdp_id is None else cdp_id,'result':result}),'jscontextId':frame.payload.jscontextId if native is None else native},seq=77)


class RpcTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent=[];self.queue=asyncio.Queue()
        async def send(raw):
            frame=wire.decode_frame(raw);request=(frame,json.loads(frame.payload.payload))
            self.sent.append(request);self.queue.put_nowait(request)
        self.rpc=rpc.NativeRpc(send,'wx0123456789abcdef',operations())
        self.addCleanup(self.rpc.close)

    async def request(self):return await asyncio.wait_for(self.queue.get(),1)

    async def verified(self,native=NATIVE,context=7):
        task=asyncio.create_task(self.rpc.verify_context(native,context));request=await self.request()
        self.assertEqual(request[1]['params']['contextId'],context)
        self.assertNotIn('operateWXData(',request[1]['params']['expression'])
        await self.rpc.accept_frame(response(request,{'matchesExpected':True,'hasOperateWXData':True}))
        await task

    async def revalidated_call(self,params=None):
        task=asyncio.create_task(self.rpc.call('search',{'query':'synthetic'} if params is None else params))
        identity=await self.request()
        self.assertTrue(identity[1]['params']['expression'].startswith('(()=>'))
        await self.rpc.accept_frame(response(identity,{'matchesExpected':True,'hasOperateWXData':True}))
        business=await self.request()
        self.assertFalse(business[1]['params']['expression'].startswith('(()=>'))
        return task,business

    async def test_no_operation_before_verified_context_and_unknown_key_never_sends(self):
        for key,parameters,code in [('search',{'query':'a'},'verified-context-required'),('Runtime.evaluate',{'query':'a'},'operation-not-registered'),('search',{'query':'a','expression':'private JS'},'parameters-invalid')]:
            with self.subTest(code=code):
                with self.assertRaisesRegex(rpc.RpcError,code):await self.rpc.call(key,parameters)
        self.assertEqual(self.sent,[])

    async def test_discovery_highwater_prevents_late_old_replies_settling_new_identity(self):
        self.rpc=rpc.NativeRpc(self.rpc._send,'wx0123456789abcdef',operations(),initial_sequence=5,initial_op_id=1005,initial_cdp_id=2005)
        task=asyncio.create_task(self.rpc.verify_context(NATIVE,7));request=await self.request()
        self.assertEqual((request[0].outer.seq,request[0].payload.opId,request[1]['id']),(6,1006,2006))
        for old in range(2001,2006):
            await self.rpc.accept_frame(response(request,{'matchesExpected':True,'hasOperateWXData':True},cdp_id=old))
        self.assertFalse(task.done());self.assertFalse(self.rpc.receipt()['lease']['verified'])
        await self.rpc.accept_frame(response(request,{'matchesExpected':True,'hasOperateWXData':True}));await task
        self.assertTrue(self.rpc.receipt()['lease']['verified'])

    async def test_empty_native_removal_does_not_crash_or_invalidate_a_known_route(self):
        await self.verified();task,request=await self.revalidated_call()
        await self.rpc.accept_frame(wire.encode_frame(wire.CATEGORY_REMOVE_JS_CONTEXT,{'jscontextId':''}))
        await self.rpc.accept_frame(response(request,'safe'));self.assertEqual(await task,'safe')

    async def test_each_business_call_revalidates_identity_and_substitutes_json_data_only(self):
        await self.verified()
        text='\"); throw new Error("private"); /* '+PRIVATE
        task,request=await self.revalidated_call({'query':text})
        expression=request[1]['params']['expression']
        self.assertEqual(expression,operations()['search'].expression.replace('@@PARAMS@@','JSON.parse('+json.dumps(json.dumps({'query':text},ensure_ascii=True,allow_nan=False,separators=(',',':')))+')'))
        await self.rpc.accept_frame(response(request,{'url':PRIVATE}))
        self.assertEqual(await task,{'url':PRIVATE})
        self.assertEqual(len(self.sent),3)
        receipt=json.dumps(self.rpc.receipt(),ensure_ascii=False)
        for value in [PRIVATE,text,NATIVE,'trustedSearch','matchesExpected']:self.assertNotIn(value,receipt)
        self.assertTrue(self.rpc.receipt()['lease']['verified'])

    async def test_identity_false_or_nonboolean_during_revalidation_prevents_business(self):
        for value in [{'matchesExpected':False,'hasOperateWXData':True},{'matchesExpected':True,'hasOperateWXData':False},{'matchesExpected':'true','hasOperateWXData':True}]:
            with self.subTest(value=value):
                await self.verified();count=len(self.sent)
                task=asyncio.create_task(self.rpc.call('search',{'query':'a'}));request=await self.request()
                await self.rpc.accept_frame(response(request,value))
                with self.assertRaisesRegex(rpc.RpcError,'identity-unconfirmed'):await task
                self.assertEqual(len(self.sent),count+1);self.assertIsNone(self.rpc.receipt()['lease'])

    async def test_non_echo_opid_accepted_but_wrong_integer_id_or_native_route_ignored(self):
        await self.verified();task,request=await self.revalidated_call()
        await self.rpc.accept_frame(response(request,'wrong-id',cdp_id=request[1]['id']+1))
        await self.rpc.accept_frame(response(request,'float-id',cdp_id=float(request[1]['id'])))
        await self.rpc.accept_frame(response(request,'wrong-native',native='foreign'))
        self.assertFalse(task.done())
        await self.rpc.accept_frame(response(request,'correct',op_id=1));self.assertEqual(await task,'correct')
        records=self.rpc.receipt()['records']
        self.assertEqual(records[-1]['responseOpId'],1)
        self.assertNotEqual(records[-2]['requestOpId'],records[-1]['responseOpId'])

    async def test_concurrent_callers_are_serial_and_do_not_steal_each_others_results(self):
        await self.verified();first,one=await self.revalidated_call({'query':'first'})
        second=asyncio.create_task(self.rpc.call('search',{'query':'second'}))
        await asyncio.sleep(0)
        self.assertEqual(len(self.sent),3)
        await self.rpc.accept_frame(response(one,'one'));self.assertEqual(await first,'one')
        identity=await self.request();await self.rpc.accept_frame(response(identity,{'matchesExpected':True,'hasOperateWXData':True}))
        two=await self.request()
        await self.rpc.accept_frame(response(one,'late-one'));self.assertFalse(second.done())
        await self.rpc.accept_frame(response(two,'two'));self.assertEqual(await second,'two')

    async def test_native_and_cdp_removal_fail_pending_and_ignore_late_frames(self):
        events=[wire.encode_frame(wire.CATEGORY_REMOVE_JS_CONTEXT,{'jscontextId':NATIVE})]
        for method,params in [('Runtime.executionContextsCleared',{}),('Runtime.executionContextDestroyed',{'executionContextId':7})]:
            events.append(wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS,{'payload':json.dumps({'method':method,'params':params}),'jscontextId':NATIVE}))
        for event in events:
            with self.subTest(event=events.index(event)):
                await self.verified();task,request=await self.revalidated_call()
                await self.rpc.accept_frame(event)
                with self.assertRaisesRegex(rpc.RpcError,'context-removed'):await task
                await self.rpc.accept_frame(response(request,{'url':PRIVATE}))
                self.assertIsNone(self.rpc.receipt()['lease']);self.assertFalse(self.rpc.receipt()['pending'])

    async def test_foreign_context_removal_does_not_invalidate_selected_lease(self):
        await self.verified();task,request=await self.revalidated_call()
        await self.rpc.accept_frame(wire.encode_frame(wire.CATEGORY_REMOVE_JS_CONTEXT,{'jscontextId':'foreign'}))
        await self.rpc.accept_frame(wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS,{'payload':json.dumps({'method':'Runtime.executionContextDestroyed','params':{'executionContextId':8}}),'jscontextId':NATIVE}))
        await self.rpc.accept_frame(response(request,'live'));self.assertEqual(await task,'live')

    async def test_deadline_invalidates_context_and_no_automatic_resend(self):
        self.rpc=rpc.NativeRpc(self.rpc._send,'wx0123456789abcdef',operations(0.01))
        await self.verified();task,request=await self.revalidated_call()
        with self.assertRaisesRegex(rpc.RpcError,'deadline'):await task
        count=len(self.sent);await self.rpc.accept_frame(response(request,PRIVATE))
        with self.assertRaisesRegex(rpc.RpcError,'verified-context-required'):await self.rpc.call('search',{'query':'a'})
        self.assertEqual(len(self.sent),count);self.assertIsNone(self.rpc.receipt()['lease'])

    async def test_cancellation_invalidates_owned_request_without_resend(self):
        await self.verified();task,request=await self.revalidated_call();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        await self.rpc.accept_frame(response(request,PRIVATE));self.assertFalse(self.rpc.receipt()['pending']);self.assertIsNone(self.rpc.receipt()['lease'])

    async def test_cancelling_a_queued_caller_does_not_cancel_another_owned_request(self):
        await self.verified();first,request=await self.revalidated_call()
        queued=asyncio.create_task(self.rpc.call('search',{'query':'queued'}));await asyncio.sleep(0);queued.cancel()
        with self.assertRaises(asyncio.CancelledError):await queued
        self.assertTrue(self.rpc.receipt()['pending'])
        await self.rpc.accept_frame(response(request,'first'));self.assertEqual(await first,'first')
        self.assertTrue(self.rpc.receipt()['lease']['verified'])

    async def test_transport_errors_are_fixed_codes_and_invalidate_the_lease(self):
        await self.verified()
        async def failed(_raw):raise rpc.RpcError(PRIVATE)
        self.rpc._send=failed
        with self.assertRaisesRegex(rpc.RpcError,'^transport-failed$'):await self.rpc.call('search',{'query':'a'})
        self.assertIsNone(self.rpc.receipt()['lease']);self.assertFalse(self.rpc.receipt()['pending'])
        self.assertNotIn(PRIVATE,json.dumps(self.rpc.receipt()))

    async def test_oversized_trusted_template_fails_without_a_ghost_pending_request(self):
        self.rpc=rpc.NativeRpc(self.rpc._send,'wx0123456789abcdef',{'search':rpc.FixedOperation('x'*wire.MAX_PAYLOAD_BYTES+'@@PARAMS@@',validate)})
        await self.verified()
        task=asyncio.create_task(self.rpc.call('search',{'query':'a'}));identity=await self.request()
        await self.rpc.accept_frame(response(identity,{'matchesExpected':True,'hasOperateWXData':True}))
        with self.assertRaisesRegex(rpc.RpcError,'request-encoding-failed'):await task
        self.assertFalse(self.rpc.receipt()['pending']);self.assertIsNone(self.rpc.receipt()['lease'])
        self.assertEqual(len(self.sent),2)

    async def test_close_fails_pending_and_queued_calls_and_ignores_late_frames(self):
        await self.verified();first,request=await self.revalidated_call()
        second=asyncio.create_task(self.rpc.call('search',{'query':'queued'}));await asyncio.sleep(0)
        self.rpc.close()
        for task in [first,second]:
            with self.assertRaisesRegex(rpc.RpcError,'closed'):await task
        count=len(self.sent);await self.rpc.accept_frame(response(request,PRIVATE))
        self.assertEqual(len(self.sent),count);self.assertTrue(self.rpc.receipt()['closed']);self.assertFalse(self.rpc.receipt()['pending'])

    async def test_malformed_frame_fails_pending_without_raw_error_details(self):
        await self.verified();task,request=await self.revalidated_call()
        await self.rpc.accept_frame(b'\xff')
        with self.assertRaisesRegex(rpc.RpcError,'protocol-invalid'):await task
        self.assertIsNone(self.rpc.receipt()['lease'])

    async def test_unknown_category_and_setup_script_are_never_executed_or_logged(self):
        await self.verified();task,request=await self.revalidated_call()
        await self.rpc.accept_frame(wire._TYPES['DebugMessage'](category='private category',data=PRIVATE.encode(),compressAlgo=0).SerializeToString())
        await self.rpc.accept_frame(wire.encode_frame(wire.CATEGORY_SETUP_CONTEXT,{'configureJs':'throw new Error("'+PRIVATE+'")'}))
        await self.rpc.accept_frame(response(request,'safe'));self.assertEqual(await task,'safe')
        receipt=json.dumps(self.rpc.receipt());self.assertNotIn(PRIVATE,receipt);self.assertNotIn('private category',receipt)
        self.assertEqual(self.rpc.receipt()['categoryCounts']['unknown'],1)

    async def test_remote_exception_cannot_be_accepted_as_a_value(self):
        await self.verified();task,request=await self.revalidated_call()
        await self.rpc.accept_frame(response(request,PRIVATE,exception=True))
        with self.assertRaisesRegex(rpc.RpcError,'evaluation-rejected'):await task
        self.assertNotIn(PRIVATE,json.dumps(self.rpc.receipt()))

    async def test_close_aborts_blocked_sender_without_waiting_for_operation_deadline(self):
        await self.verified();started=asyncio.Event();cancelled=asyncio.Event()
        async def blocked(_raw):
            started.set()
            try:await asyncio.Event().wait()
            finally:cancelled.set()
        self.rpc._send=blocked
        task=asyncio.create_task(self.rpc.call('search',{'query':'a'}));await asyncio.wait_for(started.wait(),1)
        self.rpc.close()
        with self.assertRaisesRegex(rpc.RpcError,'closed'):await asyncio.wait_for(task,1)
        self.assertTrue(cancelled.is_set());self.assertFalse(self.rpc.receipt()['pending'])


class ConfigurationTests(unittest.TestCase):
    def test_registry_templates_deadlines_and_expected_identity_are_validated(self):
        for bad in [rpc.FixedOperation('arbitrary',validate),rpc.FixedOperation('@@PARAMS@@ + @@PARAMS@@',validate),rpc.FixedOperation('@@PARAMS@@',validate,0),rpc.FixedOperation('@@PARAMS@@',validate,float('inf'))]:
            with self.subTest(timeout=bad.timeout_seconds):
                with self.assertRaises(rpc.RpcError):rpc.NativeRpc(None,'wx0123456789abcdef',{'search':bad})
        with self.assertRaisesRegex(rpc.RpcError,'expected-app-id-invalid'):rpc.NativeRpc(None,'foreign',operations())

    def test_initial_ids_require_bounded_integers_without_boolean_or_float_aliases(self):
        for key,maximum in [('initial_sequence',wire.UINT32_MAX),('initial_op_id',(1<<64)-1),('initial_cdp_id',(1<<53)-1)]:
            for value in [True,1.0,-1,maximum+1]:
                with self.subTest(key=key,value=value):
                    with self.assertRaisesRegex(rpc.RpcError,'initial-identifier-invalid'):
                        rpc.NativeRpc(None,'wx0123456789abcdef',operations(),**{key:value})


if __name__=='__main__':unittest.main(verbosity=2)

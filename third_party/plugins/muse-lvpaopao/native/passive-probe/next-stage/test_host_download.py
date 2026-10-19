"""Offline persistent host ownership tests; no stdin, sockets, Windows or media IO."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from native_rpc import NativeRpc
from operations.fixed_operations import call_operation,fixed_operations,TARGET_APP_ID

ROOT=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('host_download_tests',ROOT/'run-persistent-host.py')
HOST=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(HOST)
PAIR={'srcAppId':'wx6522458df7ed3af2','dramaId':'121225'}

class HostDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.outputs=asyncio.Queue();self.calls=[];self.started=asyncio.Event();self.release=asyncio.Event();self.active=0
        async def perform(rpc,params,root,identifier,*,cached_receipt_directory=None):
            self.active+=1;self.calls.append((params,identifier,cached_receipt_directory));self.started.set()
            try:await self.release.wait()
            finally:self.active-=1
            return {'operation':'download_first_episode','status':'download-returned'}
        self.patches=[mock.patch.object(HOST,'emit',side_effect=self.outputs.put_nowait),
            mock.patch.object(HOST.threading.Thread,'start'),mock.patch.dict(sys.modules,{'persistent_media':SimpleNamespace(perform_download=perform)})]
        for patch in self.patches:patch.start()
        protocol=HOST.make_protocol(HOST.load_shared(),fixed_operations(['status','search','detail','episodes','download_first_episode']),NativeRpc,call_operation)
        async def send(_raw):raise AssertionError('No native call is expected from this ownership fixture')
        self.state=protocol({'expectedAppId':TARGET_APP_ID,'reuseSavedMediaFor':PAIR},send)
        self.state.ready=True;self.state.rpc=SimpleNamespace(close=lambda:None)
    async def asyncTearDown(self):
        await self.state.shutdown()
        for patch in reversed(self.patches):patch.stop()
    def request(self,identifier,params):
        self.state.enqueue(json.dumps({'protocol':1,'type':'request','id':identifier,'method':'download_first_episode','params':params}).encode())
    async def test_only_exact_configured_pair_uses_saved_receipt(self):
        self.release.set();self.request('same',PAIR)
        await asyncio.wait_for(self.outputs.get(),1)
        self.request('different',{**PAIR,'dramaId':'121226'})
        await asyncio.wait_for(self.outputs.get(),1)
        self.assertEqual(self.calls[0][2],HOST.ROOT);self.assertIsNone(self.calls[1][2])
    async def test_waiting_download_cancellation_does_not_start_another_worker(self):
        self.request('first',PAIR);await asyncio.wait_for(self.started.wait(),1)
        self.request('second',PAIR)
        await asyncio.sleep(0)
        self.state.enqueue(b'{"protocol":1,"type":"cancel","id":"second"}')
        result=await asyncio.wait_for(self.outputs.get(),1)
        self.assertEqual(result['id'],'second');self.assertEqual(result['error']['code'],'cancelled')
        self.assertEqual(self.active,1);self.assertEqual(len(self.calls),1)
        self.release.set();result=await asyncio.wait_for(self.outputs.get(),1)
        self.assertEqual(result['id'],'first');self.assertEqual(result['type'],'result')
    async def test_shutdown_awaits_owned_download_and_rejects_new_admission(self):
        self.request('owned',PAIR);await asyncio.wait_for(self.started.wait(),1)
        await self.state.shutdown()
        self.assertEqual(self.active,0);self.assertEqual(self.state.request_tasks,{})
        self.request('after',PAIR);await asyncio.sleep(0)
        self.assertEqual(len(self.calls),1)

if __name__=='__main__':unittest.main()

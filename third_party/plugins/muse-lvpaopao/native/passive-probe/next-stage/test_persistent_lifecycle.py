"""Exercise the suggested edits in real main flow with offline transport/native fakes."""
import asyncio
import builtins
import io
import json
from pathlib import Path
import tempfile
from types import ModuleType,SimpleNamespace
import unittest
from unittest import mock

from persistent_lifecycle_fixture import apply_suggestion

ROOT=Path(__file__).resolve().parent


class Tests(unittest.IsolatedAsyncioTestCase):
    async def run_fixture(self,mode):
        original=(ROOT/'run-native-identity.py').read_text()
        module=ModuleType('muse_persistent_lifecycle_memory_fixture');module.__file__=str(ROOT/'run-native-identity.py')
        exec(compile(apply_suggestion(original),module.__file__,'exec'),module.__dict__)
        loop=asyncio.get_running_loop();callbacks={};operations=[];drivers=[];captured=[];original_import=builtins.__import__
        base=module.IdentityProtocol
        class State(base):
            def __init__(self,*args):
                super().__init__(*args);self.ready=True;captured.append(self)
        module.IdentityProtocol=State
        class Connection:
            def __aiter__(self):return self
            async def __anext__(self):
                if mode=='already-done':
                    captured[0].status='control-close';captured[0].done.set()
                raise StopAsyncIteration
            async def send(self,_raw):operations.append('enable-route')
        class Server:
            def close(self,**_kwargs):operations.append('server-close')
            async def wait_closed(self):await asyncio.gather(*drivers,return_exceptions=True)
        server=Server()
        async def serve(handler,*args,**kwargs):
            self.assertEqual(args,('127.0.0.1',9421));server.handler=handler;return server
        def message(payload):callbacks['message']({'type':'send','payload':payload},None)
        def load():
            message({'type':'ready','active':True,'guardsVerified':True})
            if mode=='disposed':message({'type':'disposed','reason':'callback-limit'})
            else:
                message({'type':'target-enabled'})
                loop.call_soon_threadsafe(lambda:drivers.append(asyncio.create_task(server.handler(Connection()))))
        def dispose():
            operations.append('dispose');message({'type':'disposed','reason':'requested'})
            return {'detached':True,'flushed':True}
        script=SimpleNamespace(on=lambda name,callback:callbacks.update({name:callback}),load=load,exports_sync=SimpleNamespace(dispose=dispose),unload=lambda:operations.append('unload'))
        session=SimpleNamespace(create_script=lambda *_args,**_kwargs:script,detach=lambda:operations.append('detach'))
        fake_frida=SimpleNamespace(get_local_device=lambda:SimpleNamespace(attach=lambda *_args,**_kwargs:session))
        def fake_import(name,*args,**kwargs):
            if name=='frida':return fake_frida
            if name.startswith('frida.'):raise AssertionError('Real Frida imports are forbidden')
            return original_import(name,*args,**kwargs)
        with tempfile.TemporaryDirectory(prefix='muse-lifecycle-main-') as directory:
            local=Path(directory)
            config={'rootPid':1234,'expectedAppId':'wx0123456789abcdef','durationMs':600000,'maxCallbacks':256,'modulePath':r'C:\Runtime\flue.dll','loadStartRva':4096,'expectedEntryBytes':'90'*16,'cdpFilterRva':8192,'expectedFilterEntryBytes':'90'*16,'expectedScenes':[1183]}
            (local/'config.json').write_text(json.dumps(config));(local/'enable-target-debug.js').write_text('const config=@@CONFIG@@;')
            stdout=io.StringIO()
            with mock.patch.object(module,'__file__',str(local/'run-native-identity.py')),mock.patch.object(module,'os',SimpleNamespace(name='nt')), \
                 mock.patch.object(module,'load_target_guard',return_value=SimpleNamespace()), \
                 mock.patch.object(module,'require_preflight',return_value={'rootPid':1234,'targetRendererCount':0}), \
                 mock.patch.object(module,'serve',new=serve),mock.patch.object(module,'bounded_call',side_effect=lambda _f,callback,_s:callback()), \
                 mock.patch.object(module.signal,'getsignal',return_value=None),mock.patch.object(module.signal,'signal'), \
                 mock.patch.object(module.subprocess,'run',side_effect=AssertionError('No Windows command may run')), \
                 mock.patch('builtins.__import__',side_effect=fake_import),mock.patch('sys.stdout',stdout):
                with self.assertRaises(module.ProbeFailure):await asyncio.wait_for(module.main(),1)
            receipt=json.loads((local/'native-identity.receipt.json').read_text())
        self.assertTrue(all(receipt['cleanup'][key] for key in ['dispose','unload','detach','serverClosed']))
        self.assertEqual(operations[-4:],['dispose','unload','detach','server-close'])
        self.assertLess(receipt['elapsedSeconds'],1)
        self.assertEqual(receipt['businessCalls'],0)
        return captured[0],receipt

    async def test_disposed_hook_stops_immediately_and_downgrades_before_ttl(self):
        state,receipt=await self.run_fixture('disposed')
        self.assertEqual(receipt['status'],'hook-disposed');self.assertFalse(state.ready);self.assertTrue(state.done.is_set())

    async def test_normal_websocket_eof_stops_immediately_and_cleanup_disposed_cannot_overwrite(self):
        state,receipt=await self.run_fixture('eof')
        self.assertEqual(receipt['status'],'peer-ended');self.assertFalse(state.ready);self.assertTrue(state.done.is_set())

    async def test_already_done_status_is_not_replaced_by_normal_eof_or_late_dispose(self):
        state,receipt=await self.run_fixture('already-done')
        self.assertEqual(receipt['status'],'control-close');self.assertTrue(state.done.is_set())

    def test_fixture_edit_is_idempotent_and_does_not_change_peer_gate_or_preflight(self):
        source=(ROOT/'run-native-identity.py').read_text();patched=apply_suggestion(source)
        self.assertEqual(apply_suggestion(patched),patched)
        for start,end in [('def require_preflight(', '\ndef require_peer('),('def require_peer(', '\ndef identity_expression('),('class PeerGate:', '\ndef bounded_call(')]:
            before=source[source.index(start):source.index(end)];after=patched[patched.index(start):patched.index(end)]
            self.assertEqual(before,after)


if __name__=='__main__':unittest.main(verbosity=2)

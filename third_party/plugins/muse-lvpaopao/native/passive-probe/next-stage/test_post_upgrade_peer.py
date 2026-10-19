"""Real async gate and threads, with fake OS checker and WebSocket connections."""
import asyncio
from collections import Counter
import importlib.util
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock
from websockets.protocol import State

from post_upgrade_peer import make_post_upgrade_gate

ROOT=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('muse_post_upgrade_base_tests',ROOT/'run-native-identity.py')
BASE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(BASE)
PRIVATE='https://private.invalid/?secret=synthetic'


class Connection:
    def __init__(self,port=50000):
        self.remote_address=('127.0.0.1',port);self.state=State.OPEN
        self.closed=asyncio.Event();self.close_calls=[];self.sent=[]
    def respond(self,code,text):return {'code':code,'text':text}
    async def wait_closed(self):await self.closed.wait()
    async def close(self,**kwargs):self.close_calls.append(kwargs);self.state=State.CLOSED;self.closed.set()
    def eof(self):self.state=State.CLOSED;self.closed.set()


def state():
    return SimpleNamespace(stopping=False,done=asyncio.Event(),hook_enabled=asyncio.Event(),peer=None,peer_rejection_counts=Counter(),peer_rejections=[],peer_rejections_dropped=0)


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loop=asyncio.get_running_loop();self.previous=self.loop.get_exception_handler();self.loop_errors=[]
        self.loop.set_exception_handler(lambda _loop,context:self.loop_errors.append(context))
        self.config={'rootPid':1234};self.guard=object()

    async def asyncTearDown(self):
        try:self.assertEqual(self.loop_errors,[])
        finally:self.loop.set_exception_handler(self.previous)

    def gate(self,checker,timeout=2):
        self.state=state()
        cls=make_post_upgrade_gate(BASE.PeerGate,checker,BASE.ProbeFailure,'127.0.0.1')
        return cls(self.config,self.guard,self.state,time.monotonic()+timeout)

    async def event(self,event):self.assertTrue(await asyncio.to_thread(event.wait,2))

    async def test_upgrade_is_cheap_and_two_checks_commit_only_after_target_and_fresh_open_proof(self):
        first=threading.Event();release1=threading.Event();second=threading.Event();release2=threading.Event();calls=[]
        def checker(config,port,guard,on_stage):
            self.assertIs(config,self.config);self.assertIs(guard,self.guard);self.assertEqual(port,50000)
            calls.append(port);on_stage('preflight-powershell')
            entered,release=(first,release1) if len(calls)==1 else (second,release2)
            entered.set()
            if not release.wait(2):raise RuntimeError('test release missing')
            return {'rootPid':1234,'ownerPid':1234,'sourcePort':port}
        gate=self.gate(checker);connection=Connection()
        self.assertIsNone(await gate.process_request(connection,None));self.assertIsNone(gate.candidate);self.assertEqual(calls,[])
        task=asyncio.create_task(gate.authorize(connection))
        try:
            await self.event(first);self.assertIsNone(self.state.peer);self.assertFalse(gate.claimed)
            self.assertEqual((await gate.process_request(Connection(50001),None))['code'],409)
            release1.set();await asyncio.sleep(0.01)
            self.assertEqual(len(calls),1);self.assertFalse(task.done());self.assertIsNone(self.state.peer)
            self.state.hook_enabled.set();await self.event(second)
            self.assertIsNone(self.state.peer);self.assertFalse(gate.claimed);self.assertEqual(connection.sent,[])
            release2.set();self.assertTrue(await task)
            self.assertTrue(gate.claimed);self.assertEqual(self.state.peer['sourcePort'],50000);self.assertIsNone(gate.candidate)
            self.assertEqual(len(calls),2);self.assertFalse(self.state.done.is_set());self.assertEqual(connection.close_calls,[])
        finally:
            release1.set();release2.set()
            if not task.done():task.cancel();await task

    async def test_competing_candidate_cannot_run_checker_and_failed_slot_can_be_reused(self):
        started=threading.Event();release=threading.Event();calls=[]
        def checker(_config,port,_guard,_on_stage):
            calls.append(port)
            if port==50000:
                started.set()
                if not release.wait(2):raise RuntimeError('test release missing')
                raise BASE.ProbeFailure('peer-owner-rejected',{'checks':{'ownerIsAppEx':False}})
            return {'rootPid':1234,'sourcePort':port}
        gate=self.gate(checker);self.state.hook_enabled.set();first=Connection();second=Connection(50001)
        task=asyncio.create_task(gate.authorize(first))
        try:
            await self.event(started);self.assertFalse(await gate.authorize(second));self.assertEqual(calls,[50000])
            self.assertEqual(second.close_calls[0]['code'],1008)
            release.set();self.assertFalse(await task);self.assertIsNone(gate.candidate);self.assertFalse(self.state.done.is_set())
            third=Connection(50002);self.assertTrue(await gate.authorize(third));self.assertEqual(calls,[50000,50002,50002])
            self.assertEqual(self.state.peer['sourcePort'],50002)
        finally:
            release.set()
            if not task.done():task.cancel();await task

    async def test_unverified_eof_and_closing_state_never_claim_or_stop_host_even_with_late_proof(self):
        for closing_only in [False,True]:
            with self.subTest(closing_only=closing_only):
                started=threading.Event();release=threading.Event();finished=threading.Event()
                def checker(_config,port,_guard,_on_stage):
                    started.set()
                    try:
                        if not release.wait(2):raise RuntimeError('test release missing')
                        return {'rootPid':1234,'sourcePort':port}
                    finally:finished.set()
                gate=self.gate(checker);self.state.hook_enabled.set();connection=Connection();task=asyncio.create_task(gate.authorize(connection))
                try:
                    await self.event(started)
                    if closing_only:connection.state=State.CLOSING
                    else:connection.eof()
                    await asyncio.sleep(0);self.assertFalse(task.done());self.assertIsNone(self.state.peer)
                    release.set();self.assertFalse(await task)
                    self.assertTrue(finished.is_set());self.assertFalse(gate.claimed);self.assertFalse(self.state.done.is_set())
                    self.assertIsNone(gate.candidate);self.assertEqual(connection.sent,[])
                finally:
                    release.set()
                    if not task.done():task.cancel();await task

    async def test_cleanup_and_repeated_cancellation_join_checker_and_discard_private_error(self):
        started=threading.Event();release=threading.Event();finished=threading.Event()
        def checker(*_args):
            started.set()
            try:
                if not release.wait(2):raise RuntimeError('test release missing')
                raise RuntimeError(PRIVATE)
            finally:finished.set()
        gate=self.gate(checker);self.state.hook_enabled.set();connection=Connection();task=asyncio.create_task(gate.authorize(connection))
        try:
            await self.event(started);gate.closed=True;self.state.stopping=True;task.cancel();await asyncio.sleep(0);task.cancel();await asyncio.sleep(0)
            self.assertFalse(task.done());self.assertFalse(finished.is_set());self.assertIsNone(self.state.peer)
            release.set();self.assertFalse(await task);self.assertTrue(finished.is_set())
            self.assertFalse(gate.claimed);self.assertIsNone(gate.candidate);self.assertEqual(connection.close_calls[0]['code'],1008)
            self.assertFalse(self.state.done.is_set());self.assertNotIn(PRIVATE,str(self.state.peer_rejections));self.assertEqual(self.loop_errors,[])
        finally:
            release.set()
            if not task.done():task.cancel();await task

    async def test_same_checker_failures_keep_safe_boolean_diagnostics_and_send_no_commands(self):
        for check in ['moduleHashMatched','rootCreatedUtcMatches','rootSessionMatches','belongsToSelectedRoot','ownerExecutableMatches']:
            with self.subTest(check=check):
                def checker(*_args):raise BASE.ProbeFailure('peer-owner-rejected',{'stage':'predicate','checks':{check:False}})
                gate=self.gate(checker);self.state.hook_enabled.set();connection=Connection()
                self.assertFalse(await gate.authorize(connection));self.assertEqual(self.state.peer_rejections[-1]['checks'],{check:False})
                self.assertFalse(gate.claimed);self.assertIsNone(self.state.peer);self.assertEqual(connection.sent,[]);self.assertFalse(self.state.done.is_set())
        gate=self.gate(mock.Mock());foreign=Connection();foreign.remote_address=('10.0.0.1',50000)
        self.assertEqual((await gate.process_request(foreign,None))['code'],403)

    async def test_wait_target_deadline_releases_candidate_without_second_check_or_host_done(self):
        checker=mock.Mock(return_value={'rootPid':1234,'sourcePort':50000})
        gate=self.gate(checker,0.05);connection=Connection()
        self.assertFalse(await gate.authorize(connection));self.assertEqual(checker.call_count,1)
        self.assertEqual(self.state.peer_rejection_counts['waitTargetTimeout'],1)
        self.assertIsNone(gate.candidate);self.assertIsNone(self.state.peer);self.assertFalse(gate.claimed);self.assertFalse(self.state.done.is_set())
        self.assertEqual(connection.close_calls[0]['code'],1008)
        gate.closed=True
        self.assertEqual((await gate.process_request(Connection(50001),None))['code'],503)


if __name__=='__main__':unittest.main(verbosity=2)

"""Offline peer diagnostics; no listener, PowerShell process, Windows access or attach."""
import ast
import asyncio
import base64
import importlib.util
import json
import ntpath
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('muse_peer_diagnostics_tests',ROOT/'run-native-identity.py')
CONTROLLER=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(CONTROLLER)
PRIVATE='https://synthetic.invalid/private?secret=not-real'


def config():
    return {'rootPid':1234,'rootCreatedUtc':'2026-10-19T08:46:00.0000000Z','sessionId':1,'expectedAppId':'wx0123456789abcdef','executablePath':r'C:\Runtime\WeChatAppEx.exe','executableSHA256':'a'*64,'modulePath':r'C:\Runtime\flue.dll','moduleSHA256':'b'*64}


def guard():
    return SimpleNamespace(file_digest=lambda path:'a'*64 if path.endswith('.exe') else 'b'*64,normal_path=lambda path:ntpath.normcase(ntpath.normpath(path)))


def proof(**overrides):
    return {'RootPid':1234,'CreatedUtc':config()['rootCreatedUtc'],'RootExecutablePath':r'c:\runtime\WeChatAppEx.exe','RootSessionId':1,'OwnerPid':9999,'OwnerName':'WeChatAppEx.exe','OwnerSessionId':1,'OwnerExecutablePath':r'C:\Runtime\WeChatAppEx.exe','BelongsToSelectedRoot':True,**overrides}


class MetadataTests(unittest.TestCase):
    def call(self,value):
        output=subprocess.CompletedProcess([],0,json.dumps(value).encode(),PRIVATE.encode())
        with mock.patch.object(CONTROLLER.subprocess,'run',return_value=output):
            return CONTROLLER.require_peer(config(),50000,guard())

    def test_same_predicates_accept_root_and_child_and_query_limits_are_unchanged(self):
        stages=[]
        output=subprocess.CompletedProcess([],0,json.dumps(proof()).encode(),b'')
        with mock.patch.object(CONTROLLER.subprocess,'run',return_value=output) as run:
            accepted=CONTROLLER.require_peer(config(),50000,guard(),stages.append)
        self.assertEqual(accepted,{'rootPid':1234,'ownerPid':9999,'sourcePort':50000})
        self.assertEqual(stages,['hash','preflight-powershell','predicate'])
        self.assertEqual(run.call_args.kwargs['timeout'],20)
        self.assertIs(run.call_args.kwargs['check'],True)
        query=base64.b64decode(run.call_args.args[0][-1]).decode('utf-16le')
        for marker in ["-LocalAddress '127.0.0.1'",'-LocalPort 50000',"-RemoteAddress '127.0.0.1'",'-RemotePort 9421','-State Established','-ErrorAction SilentlyContinue','ROOT_ID']:
            if marker=='ROOT_ID':self.assertNotIn(marker,query)
            else:self.assertIn(marker,query)
        self.assertNotIn('CommandLine',query)
        self.assertIn("ProofStatus='peer-connection-unavailable'",query)

    def test_every_existing_root_owner_predicate_has_a_fixed_boolean_without_paths_or_names(self):
        cases=[('rootPidMatches',{'RootPid':5555}),('rootCreatedUtcMatches',{'CreatedUtc':'different'}),('rootSessionMatches',{'RootSessionId':2}),('rootExecutableMatches',{'RootExecutablePath':r'C:\Other\WeChatAppEx.exe'}),('belongsToSelectedRoot',{'BelongsToSelectedRoot':False}),('ownerIsAppEx',{'OwnerName':'Other.exe'}),('ownerSessionMatches',{'OwnerSessionId':2}),('ownerExecutableMatches',{'OwnerExecutablePath':r'C:\Other\WeChatAppEx.exe'}),('ownerPidValid',{'OwnerPid':0})]
        for key,change in cases:
            with self.subTest(predicate=key):
                with self.assertRaises(CONTROLLER.ProbeFailure) as caught:self.call(proof(**change))
                details=caught.exception.details
                self.assertEqual(str(caught.exception),'peer-owner-rejected')
                self.assertEqual(details['stage'],'predicate')
                self.assertFalse(details['checks'][key])
                self.assertEqual(details['currentOwnerPid'],change.get('OwnerPid',9999))
                self.assertEqual(details['currentOwnerSessionId'],change.get('OwnerSessionId',1))
                encoded=json.dumps(details)
                for secret in [PRIVATE,'ExecutablePath','Other.exe','C:\\Other','CreatedUtc":"different','127.0.0.1']:
                    self.assertNotIn(secret,encoded)

    def test_hash_failure_is_recorded_before_any_powershell_with_elapsed(self):
        invalid=guard();invalid.file_digest=lambda _: 'c'*64
        with mock.patch.object(CONTROLLER.subprocess,'run') as run, mock.patch.object(CONTROLLER.time,'monotonic',side_effect=[100,100.123]):
            with self.assertRaises(CONTROLLER.ProbeFailure) as caught:CONTROLLER.require_peer(config(),50000,invalid)
        self.assertEqual(caught.exception.details,{'stage':'hash','elapsedMs':123,'checks':{'executableHashMatched':False}})
        run.assert_not_called()

    def test_powershell_failures_keep_only_fixed_class_and_int_returncode(self):
        for error,expected in [(subprocess.CalledProcessError(7,['private-command'],output=PRIVATE.encode(),stderr=PRIVATE.encode()),{'errorClass':'CalledProcessError','returnCode':7}),(subprocess.TimeoutExpired(['private-command'],20,output=PRIVATE.encode(),stderr=PRIVATE.encode()),{'errorClass':'TimeoutExpired'})]:
            with self.subTest(kind=type(error).__name__):
                with mock.patch.object(CONTROLLER.subprocess,'run',side_effect=error):
                    with self.assertRaises(CONTROLLER.ProbeFailure) as caught:CONTROLLER.require_peer(config(),50000,guard())
                details=caught.exception.details
                self.assertEqual(str(caught.exception),'peer-powershell-failed')
                self.assertEqual(details['stage'],'preflight-powershell')
                for key,value in expected.items():self.assertEqual(details[key],value)
                self.assertNotIn(PRIVATE,json.dumps(details))
                self.assertNotIn('private-command',json.dumps(details))
                self.assertTrue(caught.exception.__suppress_context__)

    def test_absent_or_ambiguous_connections_and_root_always_reject_with_safe_counts(self):
        cases=[{'ProofStatus':'peer-connection-unavailable','ConnectionCount':0},{'ProofStatus':'peer-connection-unavailable','ConnectionCount':2},{'ProofStatus':'root-unavailable','ConnectionCount':1,'RootCount':0},{'ProofStatus':'root-unavailable','ConnectionCount':1,'RootCount':2}]
        for value in cases:
            with self.subTest(status=value['ProofStatus']):
                with self.assertRaises(CONTROLLER.ProbeFailure) as caught:self.call(value)
                self.assertEqual(str(caught.exception),value['ProofStatus'])
                details=caught.exception.details
                self.assertEqual(details['stage'],'preflight-powershell')
                self.assertEqual(details['proofStatus'],value['ProofStatus'])
                self.assertEqual(details['connectionCount'],value['ConnectionCount'])
                self.assertNotIn('currentOwnerPid',details)

    def test_malformed_early_proof_never_falls_back_to_acceptance(self):
        for value in [{'ProofStatus':'peer-connection-unavailable','ConnectionCount':1},{'ProofStatus':'root-unavailable','ConnectionCount':1,'RootCount':1},{'ProofStatus':'peer-connection-unavailable','ConnectionCount':False},{'ProofStatus':'unknown',**proof()},{'ProofStatus':'peer-connection-unavailable','ConnectionCount':0,'url':PRIVATE}]:
            with self.assertRaisesRegex(CONTROLLER.ProbeFailure,'peer-metadata-invalid'):self.call(value)

    def test_probe_details_reject_arbitrary_values_and_sensitive_keys(self):
        for details in [{'url':PRIVATE},{'stage':PRIVATE},{'errorClass':'CustomError'},{'returnCode':True},{'checks':{'private':True}},{'checks':{'ownerPidValid':PRIVATE}}]:
            with self.assertRaisesRegex(ValueError,'peer-diagnostics-invalid'):CONTROLLER.ProbeFailure('fixed-code',details)

    def test_websocket_handshake_timeout_is_still_ten_seconds(self):
        tree=ast.parse((ROOT/'run-native-identity.py').read_text())
        values=[keyword.value.value for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='serve' for keyword in node.keywords if keyword.arg=='open_timeout' and isinstance(keyword.value,ast.Constant)]
        self.assertEqual(values,[10])


class GateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state=CONTROLLER.IdentityProtocol(config(),mock.AsyncMock())
        self.gate=CONTROLLER.PeerGate(config(),guard(),self.state)
        self.connection=SimpleNamespace(remote_address=('127.0.0.1',50000),respond=lambda code,text:{'code':code})

    async def test_wait_target_timeout_remains_five_seconds_and_cannot_claim(self):
        async def expired(awaitable,seconds):
            self.assertEqual(seconds,5);awaitable.close();raise TimeoutError()
        with mock.patch.object(CONTROLLER.asyncio,'wait_for',side_effect=expired),mock.patch.object(CONTROLLER,'require_peer') as require:
            self.assertEqual((await self.gate.process_request(self.connection,None))['code'],403)
            require.assert_not_called()
        self.assertEqual(self.state.receipt()['peerRejectionCounts'],{'waitTargetTimeout':1})
        self.assertFalse(self.gate.claimed);self.state.send_frame.assert_not_called()

    async def test_predicate_and_powershell_reasons_remain_distinct_with_safe_details(self):
        self.state.hook_enabled.set()
        for code,details,reason in [('peer-owner-rejected',{'stage':'predicate','checks':{'belongsToSelectedRoot':False},'currentOwnerPid':9999,'currentOwnerSessionId':1},'rootPredicate'),('peer-powershell-failed',{'stage':'preflight-powershell','errorClass':'CalledProcessError','returnCode':1},'PowerShellFailed'),('peer-connection-unavailable',{'stage':'preflight-powershell','proofStatus':'peer-connection-unavailable','connectionCount':0},'peer-connection-unavailable')]:
            with mock.patch.object(CONTROLLER,'require_peer',side_effect=CONTROLLER.ProbeFailure(code,details)):
                self.assertEqual((await self.gate.process_request(self.connection,None))['code'],403)
            self.assertEqual(self.state.peer_rejections[-1],{'reason':reason,**details})
        self.assertFalse(self.gate.claimed);self.assertIsNone(self.state.peer)

    async def test_open_handshake_cancellation_records_observed_stage_but_shutdown_is_stopping(self):
        for stopping in [False,True]:
            entered=asyncio.Event();block=asyncio.Event()
            self.state.hook_enabled.set()
            async def delayed(function,*args):
                args[-1]('preflight-powershell');entered.set();await block.wait()
            with mock.patch.object(CONTROLLER.asyncio,'to_thread',side_effect=delayed):
                task=asyncio.create_task(self.gate.process_request(self.connection,None))
                await entered.wait();self.gate.closed=stopping;task.cancel()
                with self.assertRaises(asyncio.CancelledError):await task
            rejection=self.state.peer_rejections[-1]
            self.assertEqual(rejection['reason'],'stopping' if stopping else 'openTimeout')
            self.assertEqual(rejection['stage'],'preflight-powershell')
            self.assertIs(type(rejection['elapsedMs']),int)
            self.assertFalse(self.gate.claimed);self.assertIsNone(self.state.peer)

    async def test_rejection_samples_are_bounded_and_do_not_store_peer_address_or_port(self):
        connection=SimpleNamespace(remote_address=('10.23.45.67',50000),respond=lambda code,text:{'code':code})
        for _ in range(20):self.assertEqual((await self.gate.process_request(connection,None))['code'],403)
        value=self.state.receipt()
        self.assertEqual(value['peerRejectionCounts'],{'addressRejected':20})
        self.assertEqual(len(value['peerRejections']),16)
        self.assertEqual(value['peerRejectionsDropped'],4)
        self.assertNotIn('10.23.45.67',json.dumps(value));self.assertNotIn('50000',json.dumps(value))

    async def test_success_and_already_claimed_preserve_unique_peer_policy(self):
        self.state.hook_enabled.set()
        with mock.patch.object(CONTROLLER,'require_peer',return_value={'rootPid':1234,'ownerPid':9999,'sourcePort':50000}) as require:
            self.assertIsNone(await self.gate.process_request(self.connection,None))
            self.assertEqual(self.state.peer_rejections,[])
            self.assertEqual((await self.gate.process_request(self.connection,None))['code'],409)
            self.assertEqual(require.call_count,1)
        self.assertEqual(self.state.peer_rejection_counts,{'alreadyClaimed':1})
        self.state.send_frame.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)

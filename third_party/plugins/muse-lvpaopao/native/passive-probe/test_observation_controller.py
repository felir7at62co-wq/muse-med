"""Offline controller checks. Every Windows command and Frida import is mocked."""
import base64
import builtins
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('muse_passive_observation_controller_tests', ROOT / 'run-observation.py')
CONTROLLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROLLER)
ORIGINAL_IMPORT = builtins.__import__


def configuration():
    return {
        'rootPid': 1234,
        'rootCreatedUtc': '2026-10-19T08:46:00.0000000Z',
        'sessionId': 1,
        'expectedAppId': 'wx0123456789abcdef',
        'executablePath': r'C:\Apps\RadiumWMPF\25560\runtime\WeChatAppEx.exe',
        'executableSHA256': 'a' * 64,
        'modulePath': r'C:\Apps\RadiumWMPF\25560\runtime\flue.dll',
        'moduleSHA256': 'b' * 64,
        'durationMs': 120000,
    }


def metadata(config):
    return {
        'RootPid': config['rootPid'],
        'CreatedUtc': config['rootCreatedUtc'],
        'ExecutablePath': config['executablePath'],
        'SessionId': config['sessionId'],
        'MatchingTargetCount': 1,
        'ForeignAppIdCount': 0,
    }


def powershell_reply(value):
    return subprocess.CompletedProcess([], 0, b'\xef\xbb\xbf' + json.dumps(value).encode(), b'')


class TargetIdentityTests(unittest.TestCase):
    def setUp(self):
        self.config = configuration()
        self.data = metadata(self.config)
        self.frida_imports = []

    def no_frida_import(self, name, *args, **kwargs):
        if name == 'frida' or name.startswith('frida.'):
            self.frida_imports.append(name)
            raise AssertionError('A rejected target must not import Frida')
        return ORIGINAL_IMPORT(name, *args, **kwargs)

    def digest(self, name):
        return {
            self.config['executablePath']: self.config['executableSHA256'],
            self.config['modulePath']: self.config['moduleSHA256'],
        }[name]

    def evaluate(self, value=None, digests=None):
        with mock.patch.object(CONTROLLER.subprocess, 'run', return_value=powershell_reply(self.data if value is None else value)) as command, \
             mock.patch.object(CONTROLLER, 'file_digest', side_effect=self.digest if digests is None else digests) as digest, \
             mock.patch('builtins.__import__', side_effect=self.no_frida_import):
            result = CONTROLLER.require_target(self.config)
        self.assertEqual(self.frida_imports, [])
        return result, command, digest

    def test_known_metadata_and_exact_runtime_hashes_are_accepted(self):
        result, command, digest = self.evaluate()
        self.assertEqual(result, {'rootPid':1234,'sessionId':1,'targetRendererCount':1})
        self.assertEqual(digest.call_args_list, [mock.call(self.config['executablePath']), mock.call(self.config['modulePath'])])
        self.assertEqual(command.call_args.kwargs, {'capture_output':True,'timeout':20,'check':True})
        argv = command.call_args.args[0]
        self.assertEqual(argv[:5], ['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand'])
        source = base64.b64decode(argv[5]).decode('utf-16le')
        self.assertTrue(source.startswith("$ErrorActionPreference='Stop';"))
        self.assertNotIn('ROOT_ID', source)
        self.assertNotIn('EXPECTED_ID', source)
        self.assertIn("Name='WeChatAppEx.exe'", source)
        self.assertIn('MatchingTargetCount=$matches.Count', source)

    def test_windows_case_and_forward_slashes_compare_as_same_path(self):
        self.data['ExecutablePath'] = 'c:/APPS/RADIUMWMPF/25560/runtime/WECHATAPPEX.EXE'
        result, _, _ = self.evaluate()
        self.assertEqual(result['rootPid'], 1234)

    def test_normal_path_uses_windows_semantics_on_mac(self):
        self.assertEqual(CONTROLLER.normal_path(r'C:\Apps\runtime\..\runtime\flue.dll'), CONTROLLER.normal_path('c:/apps/runtime/flue.dll'))

    def test_reused_pid_with_new_creation_time_is_rejected(self):
        self.data['CreatedUtc'] = '2026-10-19T09:00:00.0000000Z'
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            self.evaluate()
        self.assertEqual(self.frida_imports, [])

    def test_different_root_pid_is_rejected(self):
        self.data['RootPid'] = 9999
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            self.evaluate()

    def test_wrong_executable_path_is_rejected(self):
        self.data['ExecutablePath'] = r'C:\Another\WeChatAppEx.exe'
        with self.assertRaisesRegex(RuntimeError, 'executable path changed'):
            self.evaluate()

    def test_wrong_windows_session_is_rejected(self):
        self.data['SessionId'] = 2
        with self.assertRaisesRegex(RuntimeError, 'session or application'):
            self.evaluate()

    def test_missing_or_ambiguous_target_is_rejected(self):
        for count in [0,2,3]:
            with self.subTest(count=count):
                self.data['MatchingTargetCount'] = count
                with self.assertRaisesRegex(RuntimeError, 'session or application'):
                    self.evaluate()

    def test_foreign_application_in_same_tree_is_rejected(self):
        self.data['ForeignAppIdCount'] = 1
        with self.assertRaisesRegex(RuntimeError, 'Another mini-program'):
            self.evaluate()

    def test_wrong_module_hash_is_rejected(self):
        def digest(name):
            return 'c' * 64 if name == self.config['modulePath'] else self.digest(name)
        with self.assertRaisesRegex(RuntimeError, 'runtime file changed'):
            self.evaluate(digests=digest)

    def test_wrong_executable_hash_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'runtime file changed'):
            self.evaluate(digests=lambda _:'c' * 64)

    def test_invalid_appid_never_runs_powershell(self):
        for value in ['wx'+'g'*16, 'wx'+"'"+'a'*15, 'wx'+'A'*16, 'not-an-app-id', None]:
            with self.subTest(kind=type(value).__name__):
                self.config['expectedAppId'] = value
                with mock.patch.object(CONTROLLER.subprocess,'run') as command, mock.patch('builtins.__import__',side_effect=self.no_frida_import):
                    with self.assertRaisesRegex(ValueError,'Invalid expected application'):
                        CONTROLLER.require_target(self.config)
                    command.assert_not_called()
        self.assertEqual(self.frida_imports, [])

    def test_missing_selected_process_powershell_failure_is_not_suppressed(self):
        with mock.patch.object(CONTROLLER.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['mock-only'])) as command, \
             mock.patch.object(CONTROLLER,'file_digest') as digest:
            with self.assertRaises(subprocess.CalledProcessError):
                CONTROLLER.require_target(self.config)
            digest.assert_not_called()
            command.assert_called_once()

    def test_module_read_failure_is_not_accepted(self):
        def digest(name):
            if name == self.config['modulePath']:
                raise FileNotFoundError('offline synthetic module missing')
            return self.digest(name)
        with self.assertRaises(FileNotFoundError):
            self.evaluate(digests=digest)

    def test_non_object_powershell_json_is_not_accepted(self):
        with self.assertRaises(TypeError):
            self.evaluate(value=[])

    def test_main_rejects_every_identity_failure_before_frida_import(self):
        changes = [
            ('CreatedUtc','2026-10-19T09:00:00.0000000Z'),
            ('RootPid',9999),
            ('ExecutablePath',r'C:\Another\WeChatAppEx.exe'),
            ('SessionId',2),
            ('MatchingTargetCount',0),
            ('MatchingTargetCount',2),
            ('ForeignAppIdCount',1),
        ]
        with tempfile.TemporaryDirectory(prefix='muse-observation-offline-') as directory:
            directory = Path(directory)
            (directory/'config.json').write_text(json.dumps(self.config))
            (directory/'observe-launch.js').write_text('const syntheticConfig = @@CONFIG@@;')
            for key,value in changes:
                with self.subTest(field=key):
                    data={**self.data,key:value}
                    with mock.patch.object(CONTROLLER,'__file__',str(directory/'run-observation.py')), \
                         mock.patch.object(CONTROLLER,'os',SimpleNamespace(name='nt')), \
                         mock.patch.object(CONTROLLER.subprocess,'run',return_value=powershell_reply(data)), \
                         mock.patch.object(CONTROLLER,'file_digest',side_effect=self.digest), \
                         mock.patch('builtins.__import__',side_effect=self.no_frida_import):
                        with self.assertRaises(RuntimeError):
                            CONTROLLER.main()
            self.assertEqual(self.frida_imports, [])

    def test_main_wrong_module_hash_rejects_before_frida_import(self):
        with tempfile.TemporaryDirectory(prefix='muse-observation-offline-') as directory:
            directory=Path(directory)
            (directory/'config.json').write_text(json.dumps(self.config))
            (directory/'observe-launch.js').write_text('const syntheticConfig = @@CONFIG@@;')
            def digest(name):
                return 'c'*64 if name==self.config['modulePath'] else self.digest(name)
            with mock.patch.object(CONTROLLER,'__file__',str(directory/'run-observation.py')), \
                 mock.patch.object(CONTROLLER,'os',SimpleNamespace(name='nt')), \
                 mock.patch.object(CONTROLLER.subprocess,'run',return_value=powershell_reply(self.data)), \
                 mock.patch.object(CONTROLLER,'file_digest',side_effect=digest), \
                 mock.patch('builtins.__import__',side_effect=self.no_frida_import):
                with self.assertRaisesRegex(RuntimeError,'runtime file changed'):
                    CONTROLLER.main()
            self.assertEqual(self.frida_imports, [])


class MainLifecycleTests(unittest.TestCase):
    def run_main(self, *, failure=None, deadline=False, incomplete_dispose=False, messages=None):
        config=configuration()
        config.update(loadStartRva='0x1000',expectedEntryBytes='90'*8,scanBytes=128,indirectSlots=4,maxEvents=4)
        callback={}
        timers=[]
        cancellations=[]
        imports=[]
        operations=[]

        class FakeCancellable:
            def __init__(self):
                self.entered=False
                self.exited=False
                self.cancelled=False
                cancellations.append(self)
            def __enter__(self):
                self.entered=True
                return self
            def __exit__(self,*_):
                self.exited=True
            def cancel(self):
                self.cancelled=True

        class FakeTimer:
            def __init__(self,seconds,action):
                self.seconds=seconds
                self.action=action
                self.started=False
                self.cancelled=False
                self.daemon=False
                timers.append(self)
            def start(self):
                self.started=True
            def cancel(self):
                self.cancelled=True

        def record(name):
            operations.append(name)
            if failure==name:
                raise RuntimeError('offline synthetic exception payload must not appear in public receipt')

        def on(name,handler):
            self.assertEqual(name,'message')
            callback['message']=handler

        def load():
            record('load')
            for value in (messages if messages is not None else [] if deadline else [
                {'type':'send','payload':{'type':'target-launch','matched':True,'scene':1145,'inlineOffsets':[32],'indirectOffsets':[{'slot':8,'offset':16}],'unapproved':'private synthetic value'}},
            ]):
                callback['message'](value,None)

        def dispose():
            record('dispose')
            return {'detached':not incomplete_dispose,'flushed':True}

        script=SimpleNamespace(on=mock.Mock(side_effect=on),load=mock.Mock(side_effect=load),exports_sync=SimpleNamespace(dispose=mock.Mock(side_effect=dispose)),unload=mock.Mock(side_effect=lambda:record('unload')))
        captured_source=[]
        def create_script(source,**kwargs):
            record('create-script')
            captured_source.append(source)
            self.assertEqual(kwargs,{'name':'muse-lvpaopao-passive-launch'})
            return script
        session=SimpleNamespace(create_script=mock.Mock(side_effect=create_script),detach=mock.Mock(side_effect=lambda:record('detach')))
        def attach(pid,**kwargs):
            record('attach')
            self.assertEqual(pid,1234)
            self.assertEqual(kwargs,{'persist_timeout':0})
            return session
        device=SimpleNamespace(attach=mock.Mock(side_effect=attach))
        fake_frida=SimpleNamespace(Cancellable=FakeCancellable,get_local_device=mock.Mock(return_value=device))
        def import_fake(name,*args,**kwargs):
            if name=='frida':
                imports.append(name)
                return fake_frida
            if name.startswith('frida.'):
                raise AssertionError('Real Frida submodule import is forbidden in this test')
            return ORIGINAL_IMPORT(name,*args,**kwargs)
        failure_error=None
        with tempfile.TemporaryDirectory(prefix='muse-observation-offline-') as directory:
            directory=Path(directory)
            (directory/'config.json').write_text(json.dumps(config))
            (directory/'observe-launch.js').write_text('const config=@@CONFIG@@;')
            stdout=io.StringIO()
            with mock.patch.object(CONTROLLER,'__file__',str(directory/'run-observation.py')), \
                 mock.patch.object(CONTROLLER,'os',SimpleNamespace(name='nt')), \
                 mock.patch.object(CONTROLLER,'require_target',return_value={'rootPid':1234,'sessionId':1,'targetRendererCount':1}), \
                 mock.patch.object(CONTROLLER.subprocess,'run',side_effect=AssertionError('No real child process may start')), \
                 mock.patch.object(CONTROLLER.threading,'Timer',side_effect=FakeTimer), \
                 mock.patch.object(CONTROLLER.signal,'signal') as signals, \
                 mock.patch.object(CONTROLLER.time,'monotonic',side_effect=[0,121,122] if deadline else [0,1,2,3,4]), \
                 mock.patch('builtins.__import__',side_effect=import_fake), \
                 mock.patch('sys.stdout',stdout):
                try:
                    CONTROLLER.main()
                except RuntimeError as error:
                    failure_error=error
            receipt=json.loads((directory/'observation.receipt.json').read_text())
        self.assertEqual(imports,['frida'])
        self.assertTrue(all(timer.started and timer.cancelled and timer.daemon for timer in timers))
        self.assertTrue(all(item.entered and item.exited for item in cancellations))
        self.assertEqual(signals.call_count,2)
        self.assertNotIn('private synthetic value',stdout.getvalue())
        self.assertNotIn('exception payload',stdout.getvalue())
        return SimpleNamespace(receipt=receipt,error=failure_error,operations=operations,timers=timers,source=captured_source,script=script,session=session,stdout=stdout.getvalue())

    def test_target_success_disposes_unloads_and_detaches(self):
        result=self.run_main()
        self.assertIsNone(result.error)
        self.assertEqual(result.receipt['status'],'target-observed')
        self.assertEqual(result.operations,['attach','create-script','load','dispose','unload','detach'])
        self.assertEqual(result.receipt['cleanup'],{'dispose':True,'unload':True,'detach':True})
        self.assertEqual([timer.seconds for timer in result.timers],[10,10,10,5,5,5])
        self.assertEqual(result.receipt['businessCalls'],0)
        self.assertEqual(result.receipt['applicationFieldWrites'],0)
        self.assertEqual(result.receipt['portsOpened'],0)
        self.assertNotIn('unapproved',result.receipt['events'][0])
        self.assertIn('indirectOffsets',result.receipt['events'][0])
        injected=json.loads(result.source[0][len('const config='):-1])
        self.assertEqual(set(injected),{'expectedAppId','modulePath','loadStartRva','expectedEntryBytes','durationMs','scanBytes','indirectSlots','maxEvents'})
        self.assertNotIn('rootCreatedUtc',injected)
        self.assertNotIn('moduleSHA256',injected)

    def test_deadline_still_disposes_unloads_and_detaches(self):
        result=self.run_main(deadline=True)
        self.assertIsNone(result.error)
        self.assertEqual(result.receipt['status'],'deadline')
        self.assertEqual(result.receipt['events'],[])
        self.assertEqual(result.receipt['cleanup'],{'dispose':True,'unload':True,'detach':True})

    def test_setup_load_failure_still_attempts_all_cleanup(self):
        result=self.run_main(failure='load')
        self.assertIsInstance(result.error,RuntimeError)
        self.assertEqual(result.receipt['status'],'failed-RuntimeError')
        self.assertEqual(result.operations,['attach','create-script','load','dispose','unload','detach'])
        self.assertEqual(result.receipt['cleanup'],{'dispose':True,'unload':True,'detach':True})

    def test_create_script_failure_still_detaches_session(self):
        result=self.run_main(failure='create-script')
        self.assertIsInstance(result.error,RuntimeError)
        self.assertEqual(result.operations,['attach','create-script','detach'])
        self.assertEqual(result.receipt['cleanup'],{'dispose':False,'unload':False,'detach':True})

    def test_attach_failure_does_not_claim_any_cleanup(self):
        result=self.run_main(failure='attach')
        self.assertIsInstance(result.error,RuntimeError)
        self.assertEqual(result.operations,['attach'])
        self.assertEqual(result.receipt['cleanup'],{'dispose':False,'unload':False,'detach':False})

    def test_each_cleanup_failure_does_not_skip_remaining_cleanup(self):
        for name in ['dispose','unload','detach']:
            with self.subTest(operation=name):
                result=self.run_main(failure=name)
                self.assertEqual(result.operations,['attach','create-script','load','dispose','unload','detach'])
                self.assertIsInstance(result.error,RuntimeError)
                self.assertFalse(result.receipt['cleanup'][name])
                self.assertEqual(result.receipt['cleanup'][name+'Error'],'RuntimeError')
                for successful in {'dispose','unload','detach'}-{name}:
                    self.assertTrue(result.receipt['cleanup'][successful])
                self.assertNotIn('exception payload',json.dumps(result.receipt))

    def test_dispose_summary_must_confirm_detached_and_flushed(self):
        result=self.run_main(incomplete_dispose=True)
        self.assertIsInstance(result.error,RuntimeError)
        self.assertFalse(result.receipt['cleanup']['dispose'])
        self.assertTrue(result.receipt['cleanup']['unload'])
        self.assertTrue(result.receipt['cleanup']['detach'])


if __name__ == '__main__':
    unittest.main(verbosity=2)

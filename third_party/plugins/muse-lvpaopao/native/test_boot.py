"""Offline automatic setup tests never attach, inspect live processes or download dependencies."""
import copy
import hashlib
import importlib.metadata
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import boot

TARGET={'rootPid':1234,'rootCreatedUtc':'2026-10-19T08:46:00.0000000Z','sessionId':1,'executablePath':r'C:\WeChat\WeChatAppEx.exe','modulePath':r'C:\WeChat\flue.dll'}
ROW={**TARGET,'targetRendererCount':1,'foreignAppIdCount':0,'sameUser':True}


class Tests(unittest.TestCase):
    def setUp(self):boot.STOP.clear();self.addCleanup(boot.STOP.clear)

    def test_media_tools_use_absolute_host_environment_paths_and_missing_tools_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ffmpeg=root/'ffmpeg';ffprobe=root/'ffprobe'
            for path in (ffmpeg,ffprobe):path.write_text('synthetic executable');path.chmod(0o700)
            with mock.patch.dict(boot.os.environ,{'DSH_FFMPEG_PATH':str(ffmpeg),'DSH_FFPROBE_PATH':str(ffprobe)}),mock.patch.object(boot.shutil,'which') as which:
                boot.check_media_tools();which.assert_not_called()
            with mock.patch.dict(boot.os.environ,{'DSH_FFMPEG_PATH':'relative','DSH_FFPROBE_PATH':str(ffprobe)}):
                with self.assertRaisesRegex(boot.SetupFailure,'setup-media-tools-missing'):boot.check_media_tools()

    def test_unique_same_user_target_requires_all_observed_identity_fields(self):
        self.assertEqual(boot.select_target([ROW]),TARGET);self.assertIsNone(boot.select_target([]))
        for rows in ([ROW,ROW],[dict(ROW,rootPid=True)],[dict(ROW,sameUser=False)],[dict(ROW,foreignAppIdCount=1)],[dict(ROW,targetRendererCount=2)],[dict(ROW,rootCreatedUtc='yesterday')],[dict(ROW,modulePath=r'C:\Other\wrong.dll')],[dict(ROW,rawCommandLine='secret')]):
            with self.subTest(rows=rows):
                with self.assertRaises(boot.SetupFailure):boot.select_target(rows)

    def test_placeholder_appid_root_is_a_candidate_not_a_confirmed_target(self):
        row={**ROW,'targetRendererCount':0,'targetLaunchCandidate':True}
        self.assertEqual(boot.select_target([row]),{**TARGET,'targetLaunchCandidate':True})
        for invalid in [dict(row,targetLaunchCandidate=False),dict(row,targetLaunchCandidate=1),dict(ROW,targetLaunchCandidate=True)]:
            with self.assertRaises(boot.SetupFailure):boot.select_target([invalid])

    def test_missing_or_changed_dependencies_fail_before_discovery(self):
        discover=mock.Mock()
        with mock.patch.object(boot.importlib.metadata,'version',side_effect=importlib.metadata.PackageNotFoundError):
            with self.assertRaisesRegex(boot.SetupFailure,'setup-dependency-missing'):boot.prepare('/unused','/unused',3600000,discover=discover)
        with mock.patch.object(boot.importlib.metadata,'version',return_value='other'):
            with self.assertRaisesRegex(boot.SetupFailure,'setup-dependency-version-mismatch'):boot.prepare('/unused','/unused',3600000,discover=discover)
        discover.assert_not_called()

    def test_waiting_emits_only_fixed_event_and_real_target_is_verified_before_staging(self):
        actions=[];discover=mock.Mock(side_effect=[None,TARGET]);output={'transport':'local'}
        def verify(target):actions.append(('verify',target))
        def stage(resources,home,target,lifetime,*,max_callbacks):actions.append(('stage',target,lifetime,max_callbacks));return output
        notices=[]
        with mock.patch.object(boot,'check_dependencies'):
            result=boot.prepare('/resources','/home',3600000,discover=discover,verify=verify,stage=stage,wait=lambda _seconds:False,emit_wait=notices.append)
        self.assertEqual(result,output);self.assertEqual(notices,[{'event':'waiting_target'}]);self.assertEqual(actions,[('verify',TARGET),('stage',TARGET,3600000,4096)])

    def test_cancelled_wait_never_stages_or_fabricates_target(self):
        stage=mock.Mock()
        with mock.patch.object(boot,'check_dependencies'):
            with self.assertRaisesRegex(boot.SetupFailure,'setup-cancelled'):
                boot.prepare('/resources','/home',3600000,discover=lambda:None,stage=stage,wait=lambda _seconds:True)
        stage.assert_not_called()

    def test_mac_missing_isolated_copy_fails_before_waiting_or_staging(self):
        runtime=SimpleNamespace(discover=mock.Mock(return_value=None),verify=mock.Mock(),MacRuntimeFailure=RuntimeError)
        with mock.patch.object(boot,'_mac_runtime',return_value=runtime),mock.patch.object(boot,'check_dependencies'),mock.patch.object(boot,'stage_runtime') as stage:
            with self.assertRaisesRegex(boot.SetupFailure,'^mac-isolated-wechat-required$'):
                boot.prepare_mac('/resources','/home',3600000)
        runtime.discover.assert_called_once();runtime.verify.assert_not_called();stage.assert_not_called()

    def test_mac_preparation_retains_only_fixed_safe_discovery_failures(self):
        for message,expected in [('mac-runtime-build-unsupported','mac-runtime-build-unsupported'),('mac-runtime-home-invalid','mac-runtime-home-invalid'),('private path and process diagnostic','setup-required')]:
            runtime=SimpleNamespace(discover=mock.Mock(side_effect=RuntimeError(message)),verify=mock.Mock(),MacRuntimeFailure=RuntimeError)
            with self.subTest(message=message),mock.patch.object(boot,'_mac_runtime',return_value=runtime),mock.patch.object(boot,'check_dependencies'):
                with self.assertRaisesRegex(boot.SetupFailure,'^'+expected+'$'):boot.prepare_mac('/resources','/home',3600000)
            runtime.verify.assert_not_called()

    def test_mac_verified_target_still_uses_shared_staging_without_launching_wechat(self):
        runtime=SimpleNamespace(discover=mock.Mock(return_value=TARGET),verify=mock.Mock(),MacRuntimeFailure=RuntimeError)
        stage=mock.Mock(return_value={'transport':'local'});prepare=boot.prepare
        with mock.patch.object(boot,'_mac_runtime',return_value=runtime),mock.patch.object(boot,'check_dependencies'),mock.patch.object(boot,'prepare',side_effect=lambda *args,**kwargs:prepare(*args,stage=stage,**kwargs)):
            self.assertEqual(boot.prepare_mac('/resources','/home',3600000),{'transport':'local'})
        runtime.verify.assert_called_once_with(TARGET);stage.assert_called_once_with('/resources','/home',TARGET,3600000,max_callbacks=4096)

    def test_lifetime_is_explicit_and_bounded_before_side_effects(self):
        for value in (True,59999,14400001,0):
            with self.assertRaisesRegex(boot.SetupFailure,'setup-lifetime-invalid'):boot.prepare('/resources','/home',value)

    def test_callback_limit_remains_bounded_and_accepts_explicit_legacy_limit(self):
        for value in (True,0,16385):
            with self.assertRaisesRegex(boot.SetupFailure,'setup-callback-limit-invalid'):boot.prepare('/resources','/home',3600000,max_callbacks=value)
        stage=mock.Mock(return_value={})
        with mock.patch.object(boot,'check_dependencies'):
            boot.prepare('/resources','/home',3600000,discover=lambda:TARGET,verify=lambda _target:None,stage=stage,max_callbacks=256)
        self.assertEqual(stage.call_args.kwargs['max_callbacks'],256)

    def test_exact_build_hashes_fail_closed(self):
        with mock.patch.object(boot,'_digest',side_effect=[boot.PROFILE['executableSHA256'],boot.PROFILE['moduleSHA256']]):boot.verify_runtime(TARGET)
        with mock.patch.object(boot,'_digest',return_value='0'*64):
            with self.assertRaisesRegex(boot.SetupFailure,'setup-wechat-version-unsupported'):boot.verify_runtime(TARGET)

    def test_private_copy_is_sealed_from_actual_bytes_preserves_downloads_and_uses_direct_guard(self):
        resources=Path(boot.__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix='muse-native-bootstrap-') as directory:
            home=Path(directory).resolve()/'runtime';downloads=home/'passive-probe'/'next-stage'/'downloads';downloads.mkdir(parents=True)
            existing=downloads/'original-receipt';existing.write_bytes(b'keep existing')
            acl=[];guards=[]
            protector=SimpleNamespace(secure_directory=lambda path:acl.append(path))
            guard=SimpleNamespace(require_target=lambda config,**_options:guards.append(copy.deepcopy(config)))
            original_load=boot._load
            def load(path,name):
                if name=='muse_lvpaopao_profiles':return original_load(path,name)
                return SimpleNamespace(WindowsCurrentUserDpapi=lambda:protector) if name.endswith('_receipt') else guard
            source_before={name:(resources/name).read_bytes() for name in boot.RUNTIME_FILES}
            python=Path(directory)/'venv'/'bin'/'python3';python.parent.mkdir(parents=True);python.symlink_to(boot.sys.executable)
            with mock.patch.object(boot,'_load',side_effect=load),mock.patch.object(boot.sys,'executable',str(python)):
                result=boot.stage_runtime(resources,home,TARGET,3600000)
            self.assertEqual(result['localPython'],str(python))
            self.assertEqual(acl,[home]);self.assertEqual(existing.read_bytes(),b'keep existing');self.assertEqual(len(guards),1)
            self.assertNotIn('coldLaunchAttestation',guards[0]);self.assertNotIn('sceneObservation',guards[0]);self.assertEqual(guards[0]['rootPid'],1234)
            self.assertEqual(result['transport'],'local');self.assertTrue(result['downloadEnabled'])
            helper=Path(result['localHelper']);self.assertTrue(helper.is_relative_to(home));self.assertEqual(helper.name,'run-persistent-host.py')
            self.assertEqual(hashlib.sha256(helper.read_bytes()).hexdigest(),result['helperSha256'])
            manifest_path=helper.with_name('helper-manifest.json');raw=manifest_path.read_bytes();manifest=json.loads(raw)
            self.assertIn("EXPECTED_MODULE_MANIFEST_SHA256='"+hashlib.sha256(raw).hexdigest()+"'",helper.read_text())
            for relative,digest in manifest['files'].items():self.assertEqual(hashlib.sha256((helper.parent/relative).read_bytes()).hexdigest(),digest)
            self.assertEqual(json.loads(helper.with_name('config.json').read_text())['durationMs'],3600000)
            self.assertEqual(json.loads(helper.with_name('config.json').read_text())['maxCallbacks'],4096)
            self.assertEqual(source_before,{name:(resources/name).read_bytes() for name in boot.RUNTIME_FILES})

    def test_source_or_destination_symlink_is_rejected_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);outside=root/'outside';outside.mkdir();link=root/'link';link.symlink_to(outside,target_is_directory=True)
            with self.assertRaisesRegex(boot.SetupFailure,'setup-directory-invalid'):boot._owned_path(link/'runtime')
            target=outside/'script.py';target.write_text('original');file=root/'file.py';file.symlink_to(target)
            with self.assertRaises(boot.SetupFailure):boot._write(file,b'replaced')
            self.assertEqual(target.read_text(),'original')


if __name__=='__main__':unittest.main()


class RuntimeProfilesTests(unittest.TestCase):
    def setUp(self):
        self.module=boot._load(Path(boot.__file__).parent/'passive-probe'/'next-stage'/'runtime_profiles.py','test_runtime_profiles')

    def test_modern_pair_selects_volatile_adapter_and_disables_global_monitors(self):
        config={**self.module.PROFILES['wmpf-25799'],'runtimeProfile':'wmpf-25799'}
        hook,options=self.module.select_profile(config)
        self.assertEqual(hook,'enable-target-debug-25799.js')
        self.assertEqual(options,dict(exceptor='off',unwind_broker=False,exit_monitor=False,thread_suspend_monitor=False))
        target={**TARGET,'runtimeProfile':'wmpf-25799'}
        with mock.patch.object(boot,'_digest',side_effect=[config['executableSHA256'],config['moduleSHA256']]):boot.verify_runtime(target)
        self.assertEqual(boot.select_target([{**ROW,'runtimeProfile':'wmpf-25799'}]),target)

    def test_mixed_build_fields_and_unknown_profiles_never_select_an_adapter(self):
        config={**self.module.PROFILES['wmpf-25799'],'runtimeProfile':'wmpf-25799'}
        for key in ('expectedAppId','executableSHA256','moduleSHA256','loadStartRva','expectedEntryBytes','cdpFilterRva','expectedFilterEntryBytes','runtimeProfile'):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):self.module.select_profile({**config,key:'unqualified'})
        with self.assertRaises(boot.SetupFailure):boot.select_target([{**ROW,'runtimeProfile':'unknown'}])

    def test_legacy_config_without_profile_tag_keeps_original_adapter(self):
        self.assertEqual(self.module.select_profile(boot.PROFILE),('enable-target-debug.js',{}))

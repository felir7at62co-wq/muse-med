"""Offline download/cancellation tests; no CDN, Windows, or media subprocesses."""
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

import download_media as media

URL='https://a.qq.com/private?authorization=synthetic-secret'
PROBE=json.dumps({'format':{'duration':'5'},'streams':[{'codec_type':'video','codec_name':'h264','width':720,'height':1280},{'codec_type':'audio','codec_name':'aac'}]}).encode()


class Response(io.BytesIO):
    status=200
    headers={'Content-Length':'6'}


class Process:
    def __init__(self,stdout=b'',returncode=0,actions=None):
        self.stdout=stdout;self.code=returncode;self.returncode=None;self.actions=list(actions or [])
        self.calls=[];self.terminated=False;self.killed=False;self.reaped=False
    def poll(self):return self.returncode
    def communicate(self,timeout):
        self.calls.append(('communicate',timeout))
        if self.actions:
            action=self.actions.pop(0)
            if callable(action):action()
            elif isinstance(action,Exception):raise action
        self.returncode=self.code;self.reaped=True
        return self.stdout,b''
    def terminate(self):self.calls.append(('terminate',));self.terminated=True
    def kill(self):self.calls.append(('kill',));self.killed=True


class Tests(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(media,'_mac_https_context',return_value=media.ssl.create_default_context()))

    def harness(self,response=None,processes=None):
        self.folder=tempfile.TemporaryDirectory(prefix='muse-download-offline-');self.addCleanup(self.folder.cleanup)
        self.output=Path(self.folder.name)/'media'
        self.response=Response(b'abcdef') if response is None else response
        self.processes=[Process(PROBE),Process()] if processes is None else processes
        self.check=self.enterContext(mock.patch.object(media,'check_url',return_value='a.qq.com'))
        self.opener=self.enterContext(mock.patch.object(media.urllib.request,'build_opener'))
        self.opener.return_value.open.return_value=self.response
        self.spawn=self.enterContext(mock.patch.object(media.subprocess,'Popen',side_effect=self.processes))

    def assert_incomplete(self):
        self.assertFalse((self.output/'laoshou-episode-01.mp4').exists())
        self.assertTrue((self.output/'laoshou-episode-01.part').exists())

    def test_urls_require_https_known_cdn_and_public_address(self):
        for url in ['http://a.qq.com/x','https://evil.example/x','https://u:p@a.qq.com/x']:
            with self.assertRaises(media.MediaFailure):media.check_url(url)
        with mock.patch.object(media.socket,'getaddrinfo',return_value=[(0,0,0,'',('127.0.0.1',443))]):
            with self.assertRaises(media.MediaFailure):media.check_url('https://a.qq.com/x')

    def test_native_preview_cdn_accepts_different_tenant_subdomains(self):
        with mock.patch.object(media.socket,'getaddrinfo',return_value=[(0,0,0,'',('8.8.8.8',443))]):
            for host in ('1500046565.vodpreview.wxamedia.com','1500999999.vodpreview.wxamedia.com','other.vodpreview.wxamedia.com'):
                with self.subTest(host=host):self.assertEqual(media.check_url('https://'+host+'/path'),host)

    def test_preview_cdn_rejects_neighbor_domains_and_nonpublic_addresses(self):
        for host in ('vodpreview.wxamedia.com','evilvodpreview.wxamedia.com','a.vodpreview.wxamedia.com.evil.example','a.wxamedia.com'):
            with self.subTest(host=host),mock.patch.object(media.socket,'getaddrinfo') as resolve:
                with self.assertRaisesRegex(media.MediaFailure,'^cdn-host-unverified$'):media.check_url('https://'+host+'/path')
                resolve.assert_not_called()
        for address in ('127.0.0.1','10.0.0.1','169.254.169.254','::1'):
            with self.subTest(address=address),mock.patch.object(media.socket,'getaddrinfo',return_value=[(0,0,0,'',(address,443))]):
                with self.assertRaisesRegex(media.MediaFailure,'^nonpublic-cdn-address$'):media.check_url('https://other.vodpreview.wxamedia.com/path')

    def test_old_two_argument_call_validates_decode_hash_and_cannot_overwrite(self):
        self.harness();result=media.download(URL,self.output)
        self.assertTrue(result['fullDecodePassed']);self.assertTrue(result['hasAudio']);self.assertEqual(result['bytes'],6)
        self.assertEqual(Path(result['path']).read_bytes(),b'abcdef');self.assertEqual(len(result['sha256']),64)
        self.assertNotIn(URL,json.dumps(result));self.assertTrue(all(p.reaped for p in self.processes))
        self.assertEqual([call.args[0][0] for call in self.spawn.call_args_list],(['ffprobe.exe','ffmpeg.exe'] if media.sys.platform=='win32' else ['ffprobe','ffmpeg']))
        self.assertNotIn(URL,str(self.spawn.call_args_list))
        for call in self.spawn.call_args_list:
            self.assertIs(call.kwargs['stdin'],subprocess.DEVNULL)
        self.assertIn('-nostdin',self.spawn.call_args_list[1].args[0])
        with self.assertRaisesRegex(media.MediaFailure,'output-already-exists'):media.download(URL,self.output)
        self.assertEqual(Path(result['path']).read_bytes(),b'abcdef')

    def test_http_error_uses_fixed_code_without_retaining_address_or_response(self):
        self.harness()
        self.opener.return_value.open.side_effect=media.urllib.error.HTTPError(URL,403,'synthetic private response',{},None)
        with self.assertRaisesRegex(media.MediaFailure,'^http-status-rejected$') as raised:
            media.download(URL,self.output,resume=True)
        self.assertNotIn(URL,str(raised.exception));self.spawn.assert_not_called()
        self.assertEqual(list(self.output.iterdir()),[])

    def test_resume_uses_matching_range_validator_and_rehashes_complete_file(self):
        first=Response(b'abcdef');first.headers={'Content-Length':'6','ETag':'"resource-one"'}
        self.harness(response=first)
        class Broken(Response):
            def __init__(self):super().__init__(b'abc');self.reads=0;self.headers=first.headers
            def read(self,size):
                self.reads+=1
                if self.reads==1:return super().read(size)
                raise OSError('synthetic interruption')
        self.opener.return_value.open.return_value=Broken()
        with self.assertRaises(OSError):media.download(URL,self.output,resume=True)
        self.assertEqual((self.output/'laoshou-episode-01.part').read_bytes(),b'abc')
        response=Response(b'def');response.status=206;response.headers={'Content-Length':'3','Content-Range':'bytes 3-5/6','ETag':'"resource-one"'}
        self.opener.return_value.open.return_value=response
        result=media.download(URL,self.output,resume=True)
        request=self.opener.return_value.open.call_args.args[0]
        self.assertEqual(request.get_header('Range'),'bytes=3-');self.assertEqual(request.get_header('If-range'),'"resource-one"')
        self.assertEqual(result['resumedBytes'],3);self.assertEqual(Path(result['path']).read_bytes(),b'abcdef')
        self.assertFalse((self.output/'laoshou-episode-01.part.json').exists())
        self.assertEqual(result['sha256'],media.hashlib.sha256(b'abcdef').hexdigest())

    def test_resume_rejects_changed_resource_ignored_range_and_altered_prefix(self):
        self.harness()
        partial=self.output/'laoshou-episode-01.part';self.output.mkdir()
        partial.write_bytes(b'abc')
        state={'schemaVersion':1,'urlSha256':media.hashlib.sha256(URL.encode()).hexdigest(),'bytes':3,'totalBytes':6,'prefixSha256':media.hashlib.sha256(b'abc').hexdigest(),'validator':{'name':'ETag','value':'"one"'}}
        state_path=partial.with_suffix('.part.json');media._resume_write(state_path,state)
        for status,headers,code in [(200,{'Content-Length':'6','ETag':'"one"'},'resume-response-invalid'),(206,{'Content-Length':'3','Content-Range':'bytes 3-5/6','ETag':'"two"'},'resume-resource-changed'),(206,{'Content-Length':'3','Content-Range':'bytes 2-5/6','ETag':'"one"'},'resume-resource-changed')]:
            response=Response(b'def');response.status=status;response.headers=headers;self.opener.return_value.open.return_value=response
            with self.assertRaisesRegex(media.MediaFailure,code):media.download(URL,self.output,resume=True)
            self.assertEqual(partial.read_bytes(),b'abc');self.spawn.assert_not_called()
        partial.write_bytes(b'xyz')
        with self.assertRaisesRegex(media.MediaFailure,'resume-state-invalid'):media.download(URL,self.output,resume=True)
        self.assertEqual(partial.read_bytes(),b'xyz')

    def test_completed_checkpoint_redecodes_without_network_and_explicit_tools_are_supported(self):
        self.harness();self.output.mkdir();partial=self.output/'laoshou-episode-01.part';partial.write_bytes(b'abcdef')
        media._resume_write(partial.with_suffix('.part.json'),{'schemaVersion':1,'urlSha256':media.hashlib.sha256(URL.encode()).hexdigest(),'bytes':6,'totalBytes':6,'prefixSha256':media.hashlib.sha256(b'abcdef').hexdigest(),'validator':None})
        result=media.download(URL,self.output,resume=True,ffprobe_path='/owned/ffprobe',ffmpeg_path='/owned/ffmpeg')
        self.opener.assert_not_called();self.assertEqual(result['resumedBytes'],6)
        self.assertEqual([call.args[0][0] for call in self.spawn.call_args_list],['/owned/ffprobe','/owned/ffmpeg'])

    def test_host_media_environment_paths_are_used_without_invoking_a_shell(self):
        self.harness()
        with mock.patch.dict(media.os.environ,{'DSH_FFMPEG_PATH':'/owned/bin/ffmpeg','DSH_FFPROBE_PATH':'/owned/bin/ffprobe'}):result=media.download(URL,self.output)
        self.assertTrue(result['fullDecodePassed']);self.assertEqual([call.args[0][0] for call in self.spawn.call_args_list],['/owned/bin/ffprobe','/owned/bin/ffmpeg'])

    def test_resume_without_resource_validator_never_appends_or_leaks_the_url(self):
        self.harness();self.output.mkdir();partial=self.output/'laoshou-episode-01.part';partial.write_bytes(b'abc')
        state={'schemaVersion':1,'urlSha256':media.hashlib.sha256(URL.encode()).hexdigest(),'bytes':3,'totalBytes':6,'prefixSha256':media.hashlib.sha256(b'abc').hexdigest(),'validator':None}
        media._resume_write(partial.with_suffix('.part.json'),state)
        with self.assertRaisesRegex(media.MediaFailure,'resume-validator-missing'):media.download(URL,self.output,resume=True)
        self.assertNotIn(URL,(partial.with_suffix('.part.json')).read_text());self.opener.assert_not_called()

    def test_decode_failure_retains_partial_without_delivered_output(self):
        self.harness(processes=[Process(PROBE),Process(returncode=1)])
        with self.assertRaisesRegex(media.MediaFailure,'media-decode-failed'):media.download(URL,self.output)
        self.assert_incomplete();self.assertEqual((self.output/'laoshou-episode-01.part').read_bytes(),b'abcdef')

    def test_precancelled_event_does_not_resolve_connect_create_folder_or_spawn(self):
        self.harness();event=threading.Event();event.set()
        with self.assertRaisesRegex(media.MediaFailure,'^download-cancelled$'):media.download(URL,self.output,event)
        self.check.assert_not_called();self.opener.assert_not_called();self.spawn.assert_not_called();self.assertFalse(self.output.exists())

    def test_cancel_after_dns_does_not_create_folder_or_connect(self):
        self.harness();event=threading.Event()
        self.check.side_effect=lambda _:event.set() or 'a.qq.com'
        with self.assertRaisesRegex(media.MediaFailure,'download-cancelled'):media.download(URL,self.output,event)
        self.assertFalse(self.output.exists());self.opener.assert_not_called();self.spawn.assert_not_called()

    def test_cancel_after_connection_closes_response_without_creating_partial(self):
        self.harness();event=threading.Event()
        self.opener.return_value.open.side_effect=lambda *_args,**_kwargs:event.set() or self.response
        with self.assertRaisesRegex(media.MediaFailure,'download-cancelled'):media.download(URL,self.output,event)
        self.assertTrue(self.response.closed);self.assertEqual(list(self.output.iterdir()),[]);self.spawn.assert_not_called()

    def test_cancel_after_read_never_writes_the_just_read_chunk(self):
        event=threading.Event()
        class CancellingResponse(Response):
            def read(self,_size):event.set();return b'abcdef'
        self.harness(response=CancellingResponse(b'abcdef'))
        with self.assertRaisesRegex(media.MediaFailure,'download-cancelled'):media.download(URL,self.output,event)
        self.assert_incomplete();self.assertEqual((self.output/'laoshou-episode-01.part').stat().st_size,0)
        self.assertTrue(self.response.closed);self.spawn.assert_not_called()

    def test_cancel_during_probe_or_decode_terminates_and_reaps_only_owned_child(self):
        for stage in ['probe','decode']:
            with self.subTest(stage=stage):
                event=threading.Event()
                def interrupt():event.set();raise subprocess.TimeoutExpired('owned',0.2)
                blocked=Process(actions=[interrupt])
                processes=[blocked] if stage=='probe' else [Process(PROBE),blocked]
                with tempfile.TemporaryDirectory(prefix='muse-download-cancel-stage-') as tmp, \
                     mock.patch.object(media,'check_url',return_value='a.qq.com'), \
                     mock.patch.object(media.urllib.request,'build_opener') as opener, \
                     mock.patch.object(media.subprocess,'Popen',side_effect=processes) as spawn:
                    opener.return_value.open.return_value=Response(b'abcdef')
                    with self.assertRaisesRegex(media.MediaFailure,'^download-cancelled$'):media.download(URL,tmp,event)
                    self.assertFalse((Path(tmp)/'laoshou-episode-01.mp4').exists());self.assertTrue((Path(tmp)/'laoshou-episode-01.part').exists())
                    self.assertTrue(blocked.terminated);self.assertTrue(blocked.reaped)
                    self.assertEqual(spawn.call_count,len(processes));self.assertNotIn(URL,str(spawn.call_args_list))

    def test_termination_timeout_kills_then_reaps_before_cancel_is_returned(self):
        event=threading.Event()
        def interrupt():event.set();raise subprocess.TimeoutExpired('owned',0.2)
        blocked=Process(actions=[interrupt,subprocess.TimeoutExpired('owned',2)])
        self.harness(processes=[blocked])
        with self.assertRaisesRegex(media.MediaFailure,'download-cancelled'):media.download(URL,self.output,event)
        self.assertTrue(blocked.terminated);self.assertTrue(blocked.killed);self.assertTrue(blocked.reaped)
        self.assertEqual(blocked.calls,[('communicate',0.2),('terminate',),('communicate',2),('kill',),('communicate',5)])
        self.assert_incomplete()

    def test_cleanup_failure_is_not_hidden_by_cancellation(self):
        event=threading.Event()
        def interrupt():event.set();raise subprocess.TimeoutExpired('owned',0.2)
        blocked=Process(actions=[interrupt,subprocess.TimeoutExpired('owned',2),subprocess.TimeoutExpired('owned',5)])
        self.harness(processes=[blocked])
        with self.assertRaisesRegex(media.MediaFailure,'^media-process-cleanup-failed$'):media.download(URL,self.output,event)
        self.assertTrue(blocked.terminated);self.assertTrue(blocked.killed);self.assertFalse(blocked.reaped);self.assert_incomplete()

    def test_process_deadline_also_terminates_and_waits_without_a_cancel_event(self):
        process=Process()
        with mock.patch.object(media.subprocess,'Popen',return_value=process),mock.patch.object(media.time,'monotonic',side_effect=[0,31]):
            with self.assertRaisesRegex(media.MediaFailure,'^media-probe-rejected$'):
                media._run_process(['ffprobe.exe','owned-partial'],30,None,'media-probe-rejected')
        self.assertTrue(process.terminated);self.assertTrue(process.reaped)
        self.assertEqual(process.calls,[('terminate',),('communicate',2)])

    def test_cancel_after_decode_before_commit_retains_partial(self):
        event=threading.Event();decode=Process(actions=[event.set])
        self.harness(processes=[Process(PROBE),decode])
        with self.assertRaisesRegex(media.MediaFailure,'download-cancelled'):media.download(URL,self.output,event)
        self.assertTrue(decode.reaped);self.assert_incomplete()

    def test_existing_partial_and_racing_completed_file_are_never_deleted_or_overwritten(self):
        self.harness();self.output.mkdir();partial=self.output/'laoshou-episode-01.part';partial.write_bytes(b'foreign partial')
        with self.assertRaisesRegex(media.MediaFailure,'output-already-exists'):media.download(URL,self.output)
        self.assertEqual(partial.read_bytes(),b'foreign partial');self.opener.assert_not_called();self.spawn.assert_not_called()
        partial.unlink()
        final=self.output/'laoshou-episode-01.mp4'
        self.processes[1].actions=[lambda:final.write_bytes(b'foreign completed')]
        with self.assertRaisesRegex(media.MediaFailure,'output-already-exists'):media.download(URL,self.output)
        self.assertEqual(final.read_bytes(),b'foreign completed');self.assertEqual(partial.read_bytes(),b'abcdef')

    def test_host_output_name_is_optional_safe_basename_and_never_path_or_url(self):
        self.harness()
        for name in ['../escape.mp4','sub/episode.mp4',r'sub\episode.mp4',URL,'x'*81+'.mp4','episode.txt','.mp4']:
            with self.subTest(name_kind=len(name)):
                with self.assertRaisesRegex(media.MediaFailure,'^output-name-invalid$'):media.download(URL,self.output,output_name=name)
        self.check.assert_not_called();self.assertFalse(self.output.exists())
        result=media.download(URL,self.output,output_name='episode-01.mp4')
        self.assertEqual(Path(result['path']).name,'episode-01.mp4')
        self.assertTrue((self.output/'episode-01.mp4').exists())
        self.assertFalse((self.output/'laoshou-episode-01.mp4').exists())


class MacTlsTests(unittest.TestCase):
    def setUp(self):
        media._mac_https_context.cache_clear();self.addCleanup(media._mac_https_context.cache_clear)

    def test_system_roots_are_loaded_with_verification_and_cached(self):
        context=mock.Mock(check_hostname=True,verify_mode=media.ssl.CERT_REQUIRED)
        context.cert_store_stats.return_value={'x509_ca':1}
        with mock.patch.object(media,'_run_process',return_value=b'synthetic PEM') as export,mock.patch.object(media.ssl,'create_default_context',return_value=context) as create:
            self.assertIs(media._mac_https_context(),context);self.assertIs(media._mac_https_context(),context)
            self.assertEqual(export.call_count,1);create.assert_called_once_with(cadata='synthetic PEM')
            self.assertEqual(export.call_args.args[0],['/usr/bin/security','find-certificate','-a','-p','/System/Library/Keychains/SystemRootCertificates.keychain'])

    def test_unavailable_roots_or_disabled_verification_never_fall_back(self):
        for raw in (b'',b'\xff',b'x'*(2*1024*1024+1)):
            with self.subTest(size=len(raw)),mock.patch.object(media,'_run_process',return_value=raw):
                with self.assertRaisesRegex(media.MediaFailure,'tls-trust-unavailable'):media._mac_https_context()
        for hostname,mode,count in ((False,media.ssl.CERT_REQUIRED,1),(True,media.ssl.CERT_NONE,1),(True,media.ssl.CERT_REQUIRED,0)):
            context=mock.Mock(check_hostname=hostname,verify_mode=mode);context.cert_store_stats.return_value={'x509_ca':count}
            with mock.patch.object(media,'_run_process',return_value=b'PEM'),mock.patch.object(media.ssl,'create_default_context',return_value=context):
                with self.assertRaisesRegex(media.MediaFailure,'tls-trust-unavailable'):media._mac_https_context()


if __name__=='__main__':unittest.main(verbosity=2)

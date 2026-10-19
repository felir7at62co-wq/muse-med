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

    def test_observed_native_cdn_is_accepted_while_neighbor_domain_is_not(self):
        with mock.patch.object(media.socket,'getaddrinfo',return_value=[(0,0,0,'',('8.8.8.8',443))]):
            self.assertEqual(media.check_url('https://1500046565.vodpreview.wxamedia.com/path'),'1500046565.vodpreview.wxamedia.com')
            with self.assertRaises(media.MediaFailure):media.check_url('https://other.vodpreview.wxamedia.com/path')

    def test_old_two_argument_call_validates_decode_hash_and_cannot_overwrite(self):
        self.harness();result=media.download(URL,self.output)
        self.assertTrue(result['fullDecodePassed']);self.assertTrue(result['hasAudio']);self.assertEqual(result['bytes'],6)
        self.assertEqual(Path(result['path']).read_bytes(),b'abcdef');self.assertEqual(len(result['sha256']),64)
        self.assertNotIn(URL,json.dumps(result));self.assertTrue(all(p.reaped for p in self.processes))
        self.assertEqual([call.args[0][0] for call in self.spawn.call_args_list],['ffprobe.exe','ffmpeg.exe'])
        self.assertNotIn(URL,str(self.spawn.call_args_list))
        for call in self.spawn.call_args_list:
            self.assertIs(call.kwargs['stdin'],subprocess.DEVNULL)
        self.assertIn('-nostdin',self.spawn.call_args_list[1].args[0])
        with self.assertRaisesRegex(media.MediaFailure,'output-already-exists'):media.download(URL,self.output)
        self.assertEqual(Path(result['path']).read_bytes(),b'abcdef')

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


if __name__=='__main__':unittest.main(verbosity=2)

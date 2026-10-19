"""Actual async orchestration and threads with fake native/DPAPI/media operations."""
import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from download_media import MediaFailure
from operations.fixed_operations import TARGET_APP_ID
from secure_media_receipt import ReceiptFailure
import persistent_media as media

URL='https://a.qq.com/private?authorization=synthetic-secret'
PARAMS={'srcAppId':'wx0123456789abcdef','dramaId':'00121'}
BINDING={'hostAppId':TARGET_APP_ID,**PARAMS,'serialNo':1,'isFirstMediaFree':True,'isStraight':True}
BODY=b'synthetic verified file'


def raw_result(private=True):
    public={'operation':'download_first_episode','status':'first-episode-address-returned' if private else 'first-episode-free-unconfirmed','identityMatched':True,'appVersion':'108','envVersion':'release','pluginVersion':'1.2.3','hostLoginState':True,'businessCalls':2 if private else 1,'timedOut':False,**PARAMS,'title':'synthetic title','episodeCount':36,'isFirstMediaFree':private,'hasVideoInfo':True,'hasPlayAuthorization':True,'serialNo':1 if private else None,'isStraight':private,'hasPrivateMedia':private}
    return {'publicResult':public,'privateResult':{'mediaUrl':URL,'binding':BINDING} if private else None}


def status_result(success=True):
    return {'publicResult':{'operation':'status','status':'status-returned' if success else 'identity-unavailable','identityMatched':success,'appVersion':'108','envVersion':'release','pluginVersion':'1.2.3','hostLoginState':True,'businessCalls':0,'timedOut':False,'hasRequire':success,'hasBizRequest':success,'hasNativeWrapper':success},'privateResult':None}


class Rpc:
    def __init__(self,raw=None):self.calls=[];self.raw=raw_result() if raw is None else raw
    async def call(self,key,params):self.calls.append((key,params));return self.raw


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loop=asyncio.get_running_loop();self.loop_errors=[];self.previous_handler=self.loop.get_exception_handler()
        self.loop.set_exception_handler(lambda _loop,context:self.loop_errors.append(context))
        self.directory=tempfile.TemporaryDirectory(prefix='muse-persistent-media-');self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name);self.rpc=Rpc();self.actions=[];self.main_thread=threading.get_ident()
        def save(folder,url,binding):
            self.assertNotEqual(threading.get_ident(),self.main_thread)
            self.assertEqual((url,binding),(URL,BINDING));self.actions.append('save')
            secure=folder/'secure-media';secure.mkdir(mode=0o700)
            (secure/'native-media.dpapi.json').write_text('{"ciphertext":"synthetic-encrypted"}')
        def use(folder,binding,consumer):
            self.actions.append('use');self.assertEqual(binding,BINDING)
            return consumer(URL)
        def download(url,folder,cancel_event,*,output_name):
            self.actions.append('download');self.assertEqual(url,URL);self.assertEqual(output_name,'episode-01.mp4')
            if cancel_event.is_set():raise MediaFailure('download-cancelled')
            folder.mkdir(mode=0o700);path=folder/output_name;path.write_bytes(BODY)
            return {'status':'download-validated','path':str(path),'bytes':len(BODY),'sha256':hashlib.sha256(BODY).hexdigest(),'durationSeconds':5.0,'width':720,'height':1280,'hasAudio':True,'fullDecodePassed':True,'cdnHost':'a.qq.com'}
        self.save=self.enterContext(mock.patch.object(media,'save_media_receipt',side_effect=save))
        self.use=self.enterContext(mock.patch.object(media,'use_saved_media_url',side_effect=use))
        self.download=self.enterContext(mock.patch.object(media,'download',side_effect=download))

    async def asyncTearDown(self):
        try:self.assertEqual(self.loop_errors,[],'No shielded worker exception may reach the loop logger')
        finally:self.loop.set_exception_handler(self.previous_handler)

    def receipt(self,identifier='req1'):
        return json.loads((self.root/'downloads'/identifier/'transfer.receipt.json').read_text())

    def assert_safe(self,value):
        encoded=json.dumps(value)
        for private in [URL,'synthetic-secret',str(self.root),'cdnHost']:
            self.assertNotIn(private,encoded)

    async def test_success_uses_actual_operation_adapter_thread_and_verified_relative_file(self):
        result=await media.perform_download(self.rpc,PARAMS,self.root,'req1')
        self.assertEqual(result['status'],'download-returned')
        self.assertFalse(result['receiptReused'])
        self.assertEqual(result['media']['relativePath'],'downloads/req1/media/episode-01.mp4')
        self.assertEqual(result['media']['sha256'],hashlib.sha256(BODY).hexdigest())
        self.assertEqual((self.root/result['media']['relativePath']).read_bytes(),BODY)
        self.assertEqual(self.actions,['save','use','download']);self.assertEqual(len(self.rpc.calls),1)
        self.assertEqual(self.receipt()['result'],result);self.assert_safe(result);self.assert_safe(self.receipt())
        if media.os.name!='nt':self.assertEqual((self.root/'downloads'/'req1').stat().st_mode&0o777,0o700)

    async def test_existing_request_id_rejected_before_native_dispatch_without_overwrite(self):
        await media.perform_download(self.rpc,PARAMS,self.root,'req1');before=(self.root/'downloads'/'req1'/'transfer.receipt.json').read_bytes()
        with self.assertRaisesRegex(media.TransferFailure,'^output-already-exists$'):
            await media.perform_download(self.rpc,PARAMS,self.root,'req1')
        self.assertEqual(len(self.rpc.calls),1);self.assertEqual((self.root/'downloads'/'req1'/'transfer.receipt.json').read_bytes(),before)

    async def test_request_and_download_drama_ids_are_restricted_before_any_native_call(self):
        for identifier,params in [('../escape',PARAMS),('x'*65,PARAMS),('req1',{**PARAMS,'dramaId':'part:one'}),('req1',{**PARAMS,'dramaId':'a.b'}),('req1',{**PARAMS,'dramaId':'x'*65})]:
            with self.subTest(identifier_length=len(identifier)):
                with self.assertRaisesRegex(media.TransferFailure,'^parameters-invalid$'):
                    await media.perform_download(self.rpc,params,self.root,identifier)
        self.assertEqual(self.rpc.calls,[]);self.assertFalse((self.root/'downloads').exists());self.save.assert_not_called()

    async def test_native_public_failure_without_private_callback_is_returned_unchanged(self):
        self.rpc=Rpc(raw_result(False));expected=self.rpc.raw['publicResult']
        result=await media.perform_download(self.rpc,PARAMS,self.root,'req1')
        self.assertEqual(result,expected);self.assertNotIn('media',result);self.save.assert_not_called();self.use.assert_not_called();self.download.assert_not_called()
        self.assertEqual(self.receipt()['status'],'first-episode-free-unconfirmed');self.assert_safe(self.receipt())

    async def test_cached_receipt_uses_only_status_then_decrypts_without_new_native_address_or_save(self):
        cached=self.root/'old-task';cached.mkdir();encrypted=cached/'native-media.dpapi.json';encrypted.write_bytes(b'original encrypted receipt')
        before=encrypted.read_bytes();self.rpc=Rpc(status_result())
        result=await media.perform_download(self.rpc,PARAMS,self.root,'req1',cached_receipt_directory=cached)
        self.assertEqual(self.rpc.calls,[('status',{})]);self.save.assert_not_called()
        self.assertEqual(self.use.call_args.args[:2],(cached.resolve(),BINDING));self.assertEqual(encrypted.read_bytes(),before)
        self.assertEqual(result['status'],'download-returned');self.assertEqual(result['businessCalls'],0);self.assertTrue(result['receiptReused'])
        self.assertEqual(result['media']['relativePath'],'downloads/req1/media/episode-01.mp4');self.assert_safe(result);self.assert_safe(self.receipt())

    async def test_cached_status_failure_never_decrypts_or_requests_another_address(self):
        self.rpc=Rpc(status_result(False))
        result=await media.perform_download(self.rpc,PARAMS,self.root,'req1',cached_receipt_directory=self.root)
        self.assertEqual(result['status'],'identity-unavailable');self.assertEqual(result['operation'],'download_first_episode')
        self.assertNotIn('media',result);self.assertFalse(result['receiptReused']);self.assertEqual(self.rpc.calls,[('status',{})])
        self.save.assert_not_called();self.use.assert_not_called();self.download.assert_not_called();self.assert_safe(self.receipt())

    async def test_cached_decryption_failure_does_not_fallback_to_native_or_change_old_receipt(self):
        cached=self.root/'old-task';cached.mkdir();encrypted=cached/'native-media.dpapi.json';encrypted.write_bytes(b'original encrypted receipt')
        self.rpc=Rpc(status_result());self.use.side_effect=RuntimeError(URL)
        with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$'):
            await media.perform_download(self.rpc,PARAMS,self.root,'req1',cached_receipt_directory=cached)
        self.assertEqual(encrypted.read_bytes(),b'original encrypted receipt');self.assertEqual(self.rpc.calls,[('status',{})])
        self.save.assert_not_called();self.download.assert_not_called();self.assertEqual(self.receipt()['status'],'transfer-failed');self.assert_safe(self.receipt())

    async def test_worker_failure_leaves_encrypted_receipt_and_safe_failure_for_reconciliation(self):
        self.download.side_effect=RuntimeError(URL)
        with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$') as caught:
            await media.perform_download(self.rpc,PARAMS,self.root,'req1')
        self.assertTrue((self.root/'downloads'/'req1'/'secure-media'/'native-media.dpapi.json').exists())
        self.assertEqual(self.receipt()['status'],'transfer-failed');self.assert_safe(self.receipt())
        self.assertEqual(caught.exception.details,{'stage':'media-transfer','code':'transfer-failed','errorType':'RuntimeError'})
        self.assertEqual(self.receipt()['error'],caught.exception.details)
        self.assertEqual(len(self.rpc.calls),1)

    async def test_probe_and_decode_failures_keep_fixed_stage_through_actual_operation_callback(self):
        for index,(code,stage) in enumerate([('media-probe-rejected','media-probe'),('media-decode-failed','media-decode')]):
            with self.subTest(code=code):
                identifier=f'fixed{index}';self.download.side_effect=MediaFailure(code)
                with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$') as caught:
                    await media.perform_download(self.rpc,PARAMS,self.root,identifier)
                expected={'stage':stage,'code':code,'errorType':'MediaFailure'}
                self.assertEqual(caught.exception.details,expected);self.assertEqual(self.receipt(identifier)['error'],expected)
                self.assertIsNone(self.receipt(identifier)['result']);self.assert_safe(self.receipt(identifier))

    async def test_cached_dpapi_failure_has_receipt_stage_without_new_native_address(self):
        self.rpc=Rpc(status_result());self.use.side_effect=ReceiptFailure('dpapi-unprotect-failed')
        with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$') as caught:
            await media.perform_download(self.rpc,PARAMS,self.root,'req1',cached_receipt_directory=self.root)
        self.assertEqual(caught.exception.details,{'stage':'receipt-read','code':'dpapi-unprotect-failed','errorType':'ReceiptFailure'})
        self.assertEqual(self.receipt()['error'],caught.exception.details);self.assertEqual(self.rpc.calls,[('status',{})])
        self.save.assert_not_called();self.download.assert_not_called();self.assert_safe(self.receipt())

    async def test_unrecognized_typed_code_and_exception_type_never_enter_diagnostics(self):
        class PrivateError(RuntimeError):pass
        for index,error in enumerate((MediaFailure(URL),PrivateError(URL))):
            identifier=f'unknown{index}';self.download.side_effect=error
            with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$') as caught:
                await media.perform_download(self.rpc,PARAMS,self.root,identifier)
            self.assertEqual(caught.exception.details,{'stage':'media-transfer','code':'transfer-failed','errorType':'MediaFailure' if index==0 else 'Error'})
            self.assertEqual(self.receipt(identifier)['error'],caught.exception.details);self.assert_safe(self.receipt(identifier))

    async def test_metadata_hash_failure_records_validation_stage_and_fixed_code(self):
        original=self.download.side_effect
        def changed(*args,**kwargs):
            result=original(*args,**kwargs);result['sha256']='0'*64;return result
        self.download.side_effect=changed
        with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$') as caught:
            await media.perform_download(self.rpc,PARAMS,self.root,'req1')
        self.assertEqual(caught.exception.details,{'stage':'media-validate','code':'media-hash-mismatch','errorType':'TransferFailure'})
        self.assertEqual(self.receipt()['error'],caught.exception.details);self.assert_safe(self.receipt())

    async def test_missing_or_false_media_evidence_never_returns_download_success(self):
        original=self.download.side_effect
        def mismatched(*args,**kwargs):
            result=original(*args,**kwargs);result['sha256']='0'*64;return result
        self.download.side_effect=mismatched
        with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$'):
            await media.perform_download(self.rpc,PARAMS,self.root,'req1')
        self.assertEqual(self.receipt()['status'],'transfer-failed');self.assert_safe(self.receipt())

    async def test_media_parent_symlink_cannot_publish_an_outside_file_as_local_delivery(self):
        with tempfile.TemporaryDirectory(prefix='muse-outside-media-') as outside:
            def outside_media(_url,folder,_event,*,output_name):
                path=Path(outside)/output_name;path.write_bytes(BODY);folder.symlink_to(outside,target_is_directory=True)
                return {'status':'download-validated','path':str(path),'bytes':len(BODY),'sha256':hashlib.sha256(BODY).hexdigest(),'durationSeconds':5,'width':720,'height':1280,'hasAudio':True,'fullDecodePassed':True}
            self.download.side_effect=outside_media
            with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$'):
                await media.perform_download(self.rpc,PARAMS,self.root,'req1')
            self.assertEqual(self.receipt()['status'],'transfer-failed');self.assert_safe(self.receipt())

    async def test_cancellation_and_repeated_cancellation_wait_for_worker_cleanup(self):
        started=threading.Event();cancelling=threading.Event();release=threading.Event();finished=threading.Event()
        def blocked(url,folder,cancel_event,*,output_name):
            started.set()
            try:
                if not cancel_event.wait(2):raise RuntimeError('test cancellation missing')
                cancelling.set()
                if not release.wait(2):raise RuntimeError('test release missing')
                raise MediaFailure('download-cancelled')
            finally:finished.set()
        self.download.side_effect=blocked
        task=asyncio.create_task(media.perform_download(self.rpc,PARAMS,self.root,'req1'))
        try:
            self.assertTrue(await asyncio.to_thread(started.wait,2));task.cancel()
            self.assertTrue(await asyncio.to_thread(cancelling.wait,2));task.cancel();await asyncio.sleep(0)
            self.assertFalse(task.done());self.assertFalse(finished.is_set())
            release.set()
            with self.assertRaises(asyncio.CancelledError):await task
            self.assertTrue(finished.is_set());self.assertEqual(self.receipt()['status'],'cancelled');self.assert_safe(self.receipt())
            self.assertEqual(len(self.rpc.calls),1)
        finally:
            release.set()
            if not task.done():
                task.cancel()
                try:await task
                except asyncio.CancelledError:pass

    async def test_cancellation_before_private_result_does_not_create_media_or_worker(self):
        started=asyncio.Event()
        async def pending(_key,_params):started.set();await asyncio.Event().wait()
        self.rpc.call=pending
        task=asyncio.create_task(media.perform_download(self.rpc,PARAMS,self.root,'req1'));await started.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.save.assert_not_called();self.assertFalse((self.root/'downloads'/'req1'/'media').exists())
        self.assertFalse(self.receipt()['privateMediaReceived']);self.assert_safe(self.receipt())

    async def test_cancelled_worker_private_exception_never_reaches_asyncio_logger(self):
        started=threading.Event()
        def private_failure(_url,_folder,cancel_event,*,output_name):
            started.set()
            if not cancel_event.wait(2):raise RuntimeError('test cancellation missing')
            raise RuntimeError(URL)
        self.download.side_effect=private_failure
        task=asyncio.create_task(media.perform_download(self.rpc,PARAMS,self.root,'req1'))
        self.assertTrue(await asyncio.to_thread(started.wait,2));task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        await asyncio.sleep(0)
        self.assertEqual(self.loop_errors,[]);self.assertEqual(self.receipt()['status'],'cancelled');self.assert_safe(self.receipt())

    async def test_completion_winning_cancellation_race_remains_recorded_as_validated_media(self):
        original=self.download.side_effect;started=threading.Event();release=threading.Event()
        def completing(url,folder,cancel_event,*,output_name):
            started.set()
            if not release.wait(2):raise RuntimeError('test release missing')
            # The fake commit has already won; it models a downloader completion.
            return original(url,folder,threading.Event(),output_name=output_name)
        self.download.side_effect=completing
        task=asyncio.create_task(media.perform_download(self.rpc,PARAMS,self.root,'req1'))
        try:
            self.assertTrue(await asyncio.to_thread(started.wait,2));task.cancel();await asyncio.sleep(0);release.set()
            with self.assertRaises(asyncio.CancelledError):await task
            receipt=self.receipt();self.assertEqual(receipt['status'],'cancelled')
            self.assertEqual(receipt['result']['status'],'download-returned')
            self.assertTrue((self.root/receipt['result']['media']['relativePath']).exists())
            self.assertEqual(receipt['requestedSource'],{**PARAMS,'serialNo':1});self.assert_safe(receipt)
        finally:release.set()

    async def test_child_cleanup_failure_is_not_acknowledged_as_successful_cancellation(self):
        started=threading.Event()
        def failed_cleanup(_url,_folder,cancel_event,*,output_name):
            started.set()
            if not cancel_event.wait(2):raise RuntimeError('test cancellation missing')
            raise MediaFailure('media-process-cleanup-failed')
        self.download.side_effect=failed_cleanup
        task=asyncio.create_task(media.perform_download(self.rpc,PARAMS,self.root,'req1'))
        self.assertTrue(await asyncio.to_thread(started.wait,2));task.cancel()
        with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$'):await task
        self.assertEqual(self.receipt()['status'],'transfer-failed');self.assert_safe(self.receipt())

    async def test_download_parent_symlink_is_rejected_without_touching_outside_or_native(self):
        with tempfile.TemporaryDirectory(prefix='muse-outside-') as outside:
            (self.root/'downloads').symlink_to(outside,target_is_directory=True)
            with self.assertRaisesRegex(media.TransferFailure,'^transfer-failed$'):
                await media.perform_download(self.rpc,PARAMS,self.root,'req1')
            self.assertEqual(list(Path(outside).iterdir()),[]);self.assertEqual(self.rpc.calls,[])


if __name__=='__main__':unittest.main(verbosity=2)

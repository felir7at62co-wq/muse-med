"""Episode-key reconciliation and retry use the real native-result validator offline."""
import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import persistent_media as media
from download_media import MediaFailure
from operations.fixed_operations import TARGET_APP_ID

PAIR={'srcAppId':'wx6522458df7ed3af2','dramaId':'121225'}
PARAMS={**PAIR,'episodeNo':7,'idempotencyKey':'a'*64}
URL='https://a.qq.com/private?authorization=synthetic-only'
BODY=b'synthetic episode seven'
BINDING={'hostAppId':TARGET_APP_ID,**PAIR,'serialNo':7,'isStraight':True,'playAuthorization':'native-straight-playback'}


def native_result():
    public={'operation':'download_episode','status':'episode-address-returned','identityMatched':True,'appVersion':'108','envVersion':'release','pluginVersion':'1.15.14','hostLoginState':True,'businessCalls':2,'timedOut':False,**PAIR,'title':'Synthetic title','episodeCount':36,'isFirstMediaFree':False,'hasVideoInfo':True,'hasPlayAuthorization':True,'serialNo':7,'isStraight':True,'hasPrivateMedia':True}
    return {'publicResult':public,'privateResult':{'mediaUrl':URL,'binding':BINDING}}


def status_result():
    return {'publicResult':{'operation':'status','status':'status-returned','identityMatched':True,'appVersion':'108','envVersion':'release','pluginVersion':'1.15.14','hostLoginState':True,'businessCalls':0,'timedOut':False,'hasRequire':True,'hasBizRequest':True,'hasNativeWrapper':True},'privateResult':None}


class Rpc:
    def __init__(self):self.calls=[]
    async def call(self,operation,params):
        self.calls.append((operation,params))
        return status_result() if operation=='status' else native_result()


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix='muse-episode-test-');self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name);self.rpc=Rpc();self.bindings={};self.actions=[]
        def save(folder,url,binding):
            self.assertEqual(url,URL);self.bindings[folder.resolve()]=binding
            secure=folder/'secure-media';secure.mkdir(exist_ok=True,mode=0o700)
            media.encrypted_media_path(folder).write_text('{"ciphertext":"opaque-synthetic"}')
            self.actions.append('save')
        def use(folder,binding,consumer):
            self.assertEqual(self.bindings[folder.resolve()],binding);self.actions.append('use');return consumer(URL)
        def download(url,folder,cancel_event,*,output_name,resume):
            self.assertEqual(url,URL);self.assertTrue(resume);self.assertEqual(output_name,'episode-0007.mp4')
            self.actions.append('download');folder.mkdir(exist_ok=True,mode=0o700);path=folder/output_name;path.write_bytes(BODY)
            return {'status':'download-validated','path':str(path),'bytes':len(BODY),'sha256':hashlib.sha256(BODY).hexdigest(),'durationSeconds':5,'width':720,'height':1280,'hasAudio':True,'fullDecodePassed':True}
        self.save=self.enterContext(mock.patch.object(media,'save_media_receipt',side_effect=save))
        self.use=self.enterContext(mock.patch.object(media,'use_saved_media_url',side_effect=use))
        self.download=self.enterContext(mock.patch.object(media,'download',side_effect=download))

    def assert_safe(self,value):
        encoded=json.dumps(value)
        for private in (URL,'synthetic-only',str(self.root)):self.assertNotIn(private,encoded)

    async def test_status_missing_has_no_native_directory_or_decryption(self):
        result=media.episode_download_status(PARAMS,self.root)
        self.assertEqual(result['status'],'request-not-found');self.assertEqual(self.rpc.calls,[])
        self.assertFalse((self.root/'downloads').exists());self.use.assert_not_called()

    async def test_seventh_episode_acquires_once_then_reconciles_real_hash_without_native_or_download(self):
        result=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(result['status'],'download-returned');self.assertEqual(result['serialNo'],7);self.assertEqual(result['episodeNo'],7)
        self.assertEqual(result['media']['relativePath'],f'downloads/{PARAMS["idempotencyKey"]}/media/episode-0007.mp4')
        self.assertEqual(self.rpc.calls,[('download_episode',{**PAIR,'episodeNo':7})])
        repeated=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertTrue(repeated['receiptReused']);self.assertEqual(repeated['businessCalls'],0);self.assertEqual(repeated['episodeNo'],7)
        self.assertEqual(self.actions,['save','use','download']);self.assertEqual(len(self.rpc.calls),1)
        self.assert_safe(result);self.assert_safe(repeated)
        path=self.root/result['media']['relativePath'];path.write_bytes(b'changed data')
        with self.assertRaises(media.TransferFailure):media.episode_download_status(PARAMS,self.root)
        self.assertEqual(len(self.rpc.calls),1)

    async def test_publication_receipt_recovers_crash_before_transfer_state_without_native(self):
        result=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        folder=self.root/'downloads'/PARAMS['idempotencyKey'];path=folder/'media'/'episode-0007.mp4'
        (folder/'transfer.state.json').unlink()
        evidence={field:result['media'][field] for field in ('bytes','sha256','durationSeconds','width','height','hasAudio','fullDecodePassed')}
        path.with_suffix('.mp4.evidence.json').write_text(json.dumps({'schemaVersion':1,'fileName':path.name,'media':evidence}))
        recovered=media.episode_download_status(PARAMS,self.root)
        self.assertEqual(recovered['status'],'download-returned');self.assertEqual(recovered['media']['sha256'],result['media']['sha256'])
        self.assertEqual(len(self.rpc.calls),1);self.assertEqual(self.download.call_count,1)

    async def test_orphan_evidence_without_bound_private_receipt_cannot_become_success(self):
        result=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        folder=self.root/'downloads'/PARAMS['idempotencyKey'];path=folder/'media'/'episode-0007.mp4'
        (folder/'transfer.state.json').unlink();media.encrypted_media_path(folder).unlink()
        evidence={field:result['media'][field] for field in ('bytes','sha256','durationSeconds','width','height','hasAudio','fullDecodePassed')}
        path.with_suffix('.mp4.evidence.json').write_text(json.dumps({'schemaVersion':1,'fileName':path.name,'media':evidence}))
        with self.assertRaises(media.TransferFailure):media.episode_download_status(PARAMS,self.root)
        self.assertEqual(len(self.rpc.calls),1)

    async def test_changed_or_url_bearing_persisted_native_result_is_never_returned(self):
        folder=self.root/'downloads'/PARAMS['idempotencyKey'];folder.mkdir(parents=True)
        (folder/'request.json').write_text(json.dumps({'schemaVersion':1,'operation':'download_episode','requestedSource':{**PAIR,'episodeNo':7},'idempotencyKey':PARAMS['idempotencyKey']}))
        (folder/'transfer.state.json').write_text(json.dumps({'schemaVersion':1,'status':'native-result','result':{'rawUrl':URL}}))
        with self.assertRaises(media.TransferFailure):media.episode_download_status(PARAMS,self.root)
        self.assertEqual(self.rpc.calls,[])

    async def test_same_key_different_episode_and_invalid_keys_are_rejected_before_native(self):
        await media.perform_episode_download(self.rpc,PARAMS,self.root)
        for params in ({**PARAMS,'episodeNo':8},{**PARAMS,'dramaId':'other'},{**PARAMS,'idempotencyKey':'bad'},{**PARAMS,'episodeNo':True}):
            with self.subTest(params=params):
                with self.assertRaises(media.TransferFailure):await media.perform_episode_download(self.rpc,params,self.root)
        self.assertEqual(len(self.rpc.calls),1)

    async def test_unknown_acquisition_is_not_replayed_by_status_or_retry(self):
        started=asyncio.Event()
        async def pending(_operation,_params):started.set();await asyncio.Event().wait()
        self.rpc.call=pending
        task=asyncio.create_task(media.perform_episode_download(self.rpc,PARAMS,self.root));await started.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertEqual(media.episode_download_status(PARAMS,self.root)['status'],'outcome-unconfirmed')
        result=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(result['status'],'outcome-unconfirmed');self.download.assert_not_called();self.save.assert_not_called()

    async def test_failed_transfer_resumes_original_encrypted_address_without_native_reacquisition(self):
        original=self.download.side_effect;self.download.side_effect=MediaFailure('download-cancelled')
        with self.assertRaises(media.TransferFailure):await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(media.episode_download_status(PARAMS,self.root)['status'],'resume-available')
        self.assertEqual(self.rpc.calls,[('download_episode',{**PAIR,'episodeNo':7})])
        self.download.side_effect=original
        result=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(result['status'],'download-returned');self.assertTrue(result['receiptReused'])
        self.assertEqual([op for op,_params in self.rpc.calls],['download_episode','status']);self.assertEqual(self.save.call_count,1)

    async def test_unconfirmed_media_child_cleanup_stays_distinct_and_cannot_resume(self):
        self.download.side_effect=MediaFailure('media-process-cleanup-failed')
        with self.assertRaisesRegex(media.TransferFailure,'^media-process-cleanup-failed$'):
            await media.perform_episode_download(self.rpc,PARAMS,self.root)
        with self.assertRaisesRegex(media.TransferFailure,'^media-process-cleanup-failed$'):
            media.episode_download_status(PARAMS,self.root)
        with self.assertRaisesRegex(media.TransferFailure,'^media-process-cleanup-failed$'):
            await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(self.rpc.calls,[('download_episode',{**PAIR,'episodeNo':7})])
        self.assertEqual(self.download.call_count,1)

    async def test_known_native_denial_remains_known_and_is_not_retried(self):
        raw=native_result();raw['publicResult'].update(status='straight-playback-unconfirmed',isStraight=False,hasPrivateMedia=False);raw['privateResult']=None
        self.rpc.call=mock.AsyncMock(return_value=raw)
        result=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(result['status'],'straight-playback-unconfirmed');self.save.assert_not_called()
        status=media.episode_download_status(PARAMS,self.root)
        self.assertEqual(status['status'],'straight-playback-unconfirmed');self.assertTrue(status['receiptReused'])
        repeated=await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(repeated['status'],'straight-playback-unconfirmed');self.assertEqual(self.rpc.call.await_count,1)

    async def test_existing_folder_without_intent_never_dispatches_or_overwrites(self):
        folder=self.root/'downloads'/PARAMS['idempotencyKey'];folder.mkdir(parents=True)
        with self.assertRaises(media.TransferFailure):await media.perform_episode_download(self.rpc,PARAMS,self.root)
        self.assertEqual(self.rpc.calls,[]);self.assertEqual(list(folder.iterdir()),[])

    async def test_saved_serial_only_receipt_restores_request_identity_without_new_calls(self):
        await media.perform_episode_download(self.rpc,PARAMS,self.root)
        path=self.root/'downloads'/PARAMS['idempotencyKey']/'transfer.state.json'
        value=json.loads(path.read_text());value['result'].pop('episodeNo',None);path.write_text(json.dumps(value))
        result=media.episode_download_status(PARAMS,self.root)
        self.assertEqual(result['episodeNo'],7);self.assertEqual(result['idempotencyKey'],PARAMS['idempotencyKey'])
        self.assertEqual(self.download.call_count,1);self.assertEqual(len(self.rpc.calls),1)
        value['result']['episodeNo']=8;path.write_text(json.dumps(value))
        with self.assertRaises(media.TransferFailure):media.episode_download_status(PARAMS,self.root)


if __name__=='__main__':unittest.main()

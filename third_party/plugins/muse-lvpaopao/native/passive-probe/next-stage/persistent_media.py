"""Target-bound episode transfers with private receipts and durable reconciliation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import secrets
import threading

from download_media import MediaFailure,download
from operations.fixed_operations import OperationError,TARGET_APP_ID,call_operation,split_result,validate_parameters
from secure_media_receipt import ReceiptFailure,WindowsCurrentUserDpapi,save_media_receipt,use_saved_media_url,encrypted_media_path

_STAGES=frozenset(('transfer','parameters','prepare-directory','receipt-save','receipt-read','media-transfer','media-probe','media-decode','media-process-cleanup','media-validate','native-status','native-download','receipt-write'))
_FIXED_CODES=frozenset(('transfer-failed','output-already-exists','parameters-invalid','cdn-host-unverified','declared-size-rejected','download-cancelled','download-deadline','http-status-rejected','media-probe-rejected','media-decode-failed','media-process-cleanup-failed','media-size-limit','media-size-mismatch','nonpublic-cdn-address','output-name-invalid','redirect-not-accepted','url-invalid','media-metadata-rejected','media-file-rejected','media-hash-mismatch','resume-state-invalid','resume-response-invalid','resume-validator-missing','resume-resource-changed','request-binding-conflict','outcome-unconfirmed','dpapi-output-size-rejected','dpapi-unprotect-failed','dpapi-protect-failed','receipt-already-exists','receipt-binding-invalid','receipt-ciphertext-changed','receipt-directory-acl-failed','receipt-directory-acl-invalid','receipt-directory-acl-unverified','receipt-directory-link-rejected','receipt-envelope-invalid','receipt-file-link-rejected','receipt-file-size-rejected','receipt-payload-invalid','receipt-task-directory-invalid','receipt-url-invalid','receipt-user-sid-unavailable','receipt-user-token-invalid','receipt-user-token-unavailable','windows-dpapi-required','operation-result-invalid','operation-template-invalid','operation-whitelist-invalid','private-media-consumer-failed','private-media-consumer-required','private-result-invalid','private-result-unexpected','public-result-invalid'))
_ERROR_TYPES={value:value.__name__ for value in (MediaFailure,ReceiptFailure,OperationError,FileNotFoundError,FileExistsError,PermissionError,OSError,TimeoutError,ValueError,TypeError,AttributeError,RuntimeError,json.JSONDecodeError)}
_SAFE_ERROR_NAMES=frozenset((*_ERROR_TYPES.values(),'TransferFailure','Error'))
_FIXED_CODES=_FIXED_CODES|frozenset(('tls-trust-unavailable','mac-keychain-required','mac-key-lock-invalid','mac-keychain-allocation-failed','mac-keychain-key-unavailable','mac-keychain-algorithm-unsupported','mac-keychain-input-invalid','mac-keychain-transform-failed','mac-keychain-output-invalid','mac-keychain-binding-invalid','mac-receipt-directory-invalid'))


def _bounded_details(details):
    source=details if isinstance(details,dict) else {}
    def label(key,allowed,default):
        value=source.get(key)
        return value if isinstance(value,str) and value in allowed else default
    return {'stage':label('stage',_STAGES,'transfer'),'code':label('code',_FIXED_CODES,'transfer-failed'),'errorType':label('errorType',_SAFE_ERROR_NAMES,'Error')}


class TransferFailure(RuntimeError):
    """A compatible fixed message and bounded stage/code/type diagnostics only."""
    def __init__(self,code='transfer-failed',*,details=None):
        fixed=details.get('code') if isinstance(details,dict) and code=='transfer-failed' else code
        message=fixed if fixed in ('transfer-failed','media-process-cleanup-failed','output-already-exists','parameters-invalid','resume-state-invalid','resume-response-invalid','resume-resource-changed','resume-validator-missing','request-binding-conflict','outcome-unconfirmed') else 'transfer-failed'
        super().__init__(message)
        self.details=_bounded_details(details if details is not None else {'stage':'transfer','code':message,'errorType':'TransferFailure'})


def _failure(error,stage):
    if type(error) is TransferFailure:
        details=_bounded_details(error.details)
        if details['stage']=='transfer':details['stage']=stage
        return TransferFailure(str(error),details=details)
    # Exception messages, paths, stderr and native addresses are never projected.
    code=error.args[0] if isinstance(error,(MediaFailure,ReceiptFailure,OperationError)) and len(error.args)==1 else None
    if not isinstance(code,str) or code not in _FIXED_CODES:code='transfer-failed'
    stage={'media-probe-rejected':'media-probe','media-decode-failed':'media-decode','media-process-cleanup-failed':'media-process-cleanup'}.get(code,stage)
    return TransferFailure(details={'stage':stage,'code':code,'errorType':_ERROR_TYPES.get(type(error),'Error')})


def _directory(path):
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
        raise TransferFailure('transfer-failed')


def _prepare(root,request_id):
    root=Path(root).resolve(strict=True);_directory(root)
    parent=root/'downloads'
    parent.mkdir(mode=0o700,exist_ok=True);_directory(parent)
    folder=parent/request_id
    try:folder.mkdir(mode=0o700)
    except FileExistsError:raise TransferFailure('output-already-exists') from None
    _directory(folder)
    if os.name=='nt':WindowsCurrentUserDpapi().secure_directory(folder)
    else:folder.chmod(0o700)
    return folder


def _metadata(result,folder,request_id,output_name='episode-01.mp4'):
    expected=folder/'media'/output_name
    if not isinstance(result,dict) or result.get('status')!='download-validated' or result.get('fullDecodePassed') is not True:
        raise TransferFailure(details={'stage':'media-validate','code':'media-metadata-rejected','errorType':'TransferFailure'})
    _directory(folder/'media')
    info=expected.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink!=1 or getattr(info,'st_file_attributes',0)&0x400:
        raise TransferFailure(details={'stage':'media-validate','code':'media-file-rejected','errorType':'TransferFailure'})
    if not isinstance(result.get('path'),str) or Path(result['path']).resolve(strict=True)!=expected.resolve(strict=True):
        raise TransferFailure(details={'stage':'media-validate','code':'media-file-rejected','errorType':'TransferFailure'})
    count=result.get('bytes');digest=result.get('sha256');duration=result.get('durationSeconds')
    if (type(count) is not int or count<=0 or count!=info.st_size or not isinstance(digest,str)
            or re.fullmatch(r'[0-9a-f]{64}',digest) is None or type(duration) not in (int,float)
            or not math.isfinite(duration) or duration<=0 or type(result.get('hasAudio')) is not bool
            or any(type(result.get(key)) is not int or result[key]<=0 for key in ('width','height'))):
        raise TransferFailure(details={'stage':'media-validate','code':'media-metadata-rejected','errorType':'TransferFailure'})
    with expected.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
    if actual!=digest:raise TransferFailure(details={'stage':'media-validate','code':'media-hash-mismatch','errorType':'TransferFailure'})
    return {'relativePath':f'downloads/{request_id}/media/{output_name}','bytes':count,'sha256':digest,'durationSeconds':duration,'width':result['width'],'height':result['height'],'hasAudio':result['hasAudio'],'fullDecodePassed':True}


def _worker(folder,url,binding,cancel_event,request_id,cached_directory=None,episode_name=None,resume=False,destination_binding=None):
    # Seal the already obtained address even if cancellation preceded this thread.
    stage='receipt-save'
    def transfer(address):
        nonlocal stage
        if destination_binding is not None and cached_directory is not None and Path(cached_directory).resolve()!=folder.resolve():
            stage='receipt-save'
            save_media_receipt(folder,address,destination_binding)
        stage='media-transfer'
        options={'output_name':episode_name or 'episode-01.mp4'}
        if resume:options['resume']=True
        return download(address,folder/'media',cancel_event,**options)
    try:
        if cached_directory is None:save_media_receipt(folder,url,binding)
        stage='receipt-read'
        source=folder if cached_directory is None else Path(cached_directory).resolve(strict=True)
        result=use_saved_media_url(source,binding,transfer)
        stage='media-validate'
        return _metadata(result,folder,request_id,episode_name or 'episode-01.mp4')
    except Exception as error:raise _failure(error,stage) from None


async def _join_cancelled_worker(task,cancel_event):
    """Repeated caller cancellation cannot abandon the owned worker thread."""
    cancel_event.set()
    while not task.done():
        try:await asyncio.shield(task)
        except asyncio.CancelledError:cancel_event.set()
        except Exception as error:
            # The owned task normally returns a safe tuple; retrieve any failure below.
            break
    if task.cancelled():return None
    status,result=task.result()
    if status=='cleanup-failed':raise TransferFailure(details=result)
    return result if status=='completed' else None


async def _worker_outcome(*arguments):
    # A shielded task must never retain raw exception text for asyncio to log.
    try:return 'completed',await asyncio.to_thread(_worker,*arguments)
    except Exception as error:
        details=_failure(error,'transfer').details
        return ('cleanup-failed' if details['code']=='media-process-cleanup-failed' else 'failed'),details


def _receipt(folder,request_id,status,result,private_received,parameters,error=None):
    value={'schemaVersion':1,'requestId':request_id,'requestedSource':{**parameters,'serialNo':1},'status':status,'result':result,'privateMediaReceived':private_received}
    if error is not None:value['error']=_bounded_details(error)
    with (folder/'transfer.receipt.json').open('x',encoding='utf8') as stream:
        json.dump(value,stream,ensure_ascii=False,separators=(',',':'));stream.write('\n')
    if os.name!='nt':(folder/'transfer.receipt.json').chmod(0o600)


def _failure_receipt(folder,request_id,status,result,private_received,parameters,error=None):
    try:_receipt(folder,request_id,status,result,private_received,parameters,error)
    except Exception as failure:raise _failure(failure,'receipt-write') from None


async def perform_download(rpc,params,root,request_id,*,cached_receipt_directory=None):
    """Return safe public facts and validated local media, or a fixed failure.

    The trusted host owns request IDs and the root. Reusing an ID never dispatches
    another native request. A trusted cached directory uses only status/identity
    checks and the original encrypted binding; decryption never falls back to a
    new native address request. Cancellation waits for the worker before propagating;
    the receipt records completed media if it won the cancellation race. Failure
    details contain only fixed stage/code/type labels, never exception messages.
    """
    if not isinstance(request_id,str) or re.fullmatch(r'[A-Za-z0-9_-]{1,64}',request_id) is None:
        raise TransferFailure('parameters-invalid')
    try:
        validate_parameters('download_first_episode',params)
        if re.fullmatch(r'[A-Za-z0-9_-]{1,64}',params['dramaId']) is None:raise ValueError()
        params=dict(params)
    except Exception as error:
        # Invalid model parameters do not dispatch a native request or include raw input.
        raise TransferFailure('parameters-invalid') from None
    try:folder=_prepare(root,request_id)
    except Exception as error:raise _failure(error,'prepare-directory') from None
    cancel_event=threading.Event();worker=None;media=None;private_received=False;worker_failure=None;stage='native-download'
    async def consume(url,binding,cached_directory=None):
        nonlocal worker,media,private_received,worker_failure
        if worker is not None:raise TransferFailure('transfer-failed')
        private_received=cached_directory is None
        worker=asyncio.create_task(_worker_outcome(folder,url,binding,cancel_event,request_id,cached_directory))
        try:
            outcome,value=await asyncio.shield(worker)
            if outcome!='completed':
                worker_failure=value
                raise TransferFailure(details=value)
            media=value
        except asyncio.CancelledError:
            media=await _join_cancelled_worker(worker,cancel_event)
            raise
    try:
        if cached_receipt_directory is None:
            public=await call_operation(rpc,'download_first_episode',params,private_media_consumer=consume)
        else:
            stage='native-status'
            status=await call_operation(rpc,'status',{})
            public={**status,'operation':'download_first_episode','receiptReused':False}
            if status['status']=='status-returned':
                binding={'hostAppId':TARGET_APP_ID,**params,'serialNo':1,'isFirstMediaFree':True,'isStraight':True}
                await consume(None,binding,cached_receipt_directory)
                public={**status,'operation':'download_first_episode',**params,'serialNo':1,'isFirstMediaFree':True,'isStraight':True,'hasPrivateMedia':True,'receiptReused':True,'businessCalls':0}
        result={**public,'status':'download-returned','receiptReused':cached_receipt_directory is not None,'media':media} if media is not None else public
        stage='receipt-write'
        _receipt(folder,request_id,result['status'],result,private_received,params)
        return result
    except asyncio.CancelledError:
        if worker is not None and not worker.done():media=await _join_cancelled_worker(worker,cancel_event)
        result={'status':'download-returned','media':media} if media is not None else None
        if worker is not None and worker.done() and not worker.cancelled():
            outcome,value=worker.result()
            if outcome!='completed':worker_failure=value
        _failure_receipt(folder,request_id,'cancelled',result,private_received,params,worker_failure)
        raise
    except Exception as error:
        failure=TransferFailure(details=worker_failure) if worker_failure is not None else _failure(error,stage)
        # A success-receipt write may itself have failed after creating the file.
        if not (folder/'transfer.receipt.json').exists():
            _failure_receipt(folder,request_id,'transfer-failed',None,private_received,params,failure.details)
        raise failure from None


_EPISODE_FIELDS={'srcAppId','dramaId','episodeNo','idempotencyKey'}


def _episode_parameters(params):
    if not isinstance(params,dict) or set(params)!=_EPISODE_FIELDS:
        raise TransferFailure('parameters-invalid')
    key=params['idempotencyKey']
    if not isinstance(key,str) or re.fullmatch(r'[0-9a-f]{64}',key) is None:
        raise TransferFailure('parameters-invalid')
    native={field:params[field] for field in ('srcAppId','dramaId','episodeNo')}
    try:validate_parameters('download_episode',native)
    except OperationError:raise TransferFailure('parameters-invalid') from None
    return native,key


def _episode_name(number):
    return f'episode-{number:04d}.mp4'


def _json_file(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or getattr(info,'st_file_attributes',0)&0x400 or not 1<=info.st_size<=65536:
        raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'})
    try:return json.loads(path.read_bytes())
    except (ValueError,TypeError,UnicodeError):
        raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'}) from None


def _publish_state(path,value,*,exclusive=False):
    if path.exists() or path.is_symlink():_json_file(path)
    temporary=path.with_name('.pending-'+secrets.token_hex(12))
    try:
        descriptor=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(descriptor,'w',encoding='utf8') as stream:
            json.dump(value,stream,ensure_ascii=False,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
        if exclusive:os.link(temporary,path)
        else:os.replace(temporary,path)
        if os.name!='nt':
            descriptor=os.open(path.parent,os.O_RDONLY)
            try:os.fsync(descriptor)
            finally:os.close(descriptor)
    finally:temporary.unlink(missing_ok=True)


def _episode_folder(root,key,*,create):
    root=Path(root).resolve(strict=True);_directory(root)
    parent=root/'downloads'
    if not parent.exists() and not parent.is_symlink():
        if not create:return None
        parent.mkdir(mode=0o700)
    _directory(parent)
    folder=parent/key
    if not folder.exists() and not folder.is_symlink():
        if not create:return None
        folder.mkdir(mode=0o700)
        if os.name=='nt':WindowsCurrentUserDpapi().secure_directory(folder)
        else:folder.chmod(0o700)
    _directory(folder)
    return folder


def _episode_state(params,root):
    native,key=_episode_parameters(params)
    folder=_episode_folder(root,key,create=False)
    if folder is None:return native,key,None,None
    intent=folder/'request.json'
    if not intent.exists() and not intent.is_symlink():
        raise TransferFailure(details={'stage':'receipt-read','code':'outcome-unconfirmed','errorType':'TransferFailure'})
    value=_json_file(intent)
    if not isinstance(value,dict) or type(value.get('schemaVersion')) is not int or value!={'schemaVersion':1,'operation':'download_episode','requestedSource':native,'idempotencyKey':key}:
        raise TransferFailure(details={'stage':'receipt-read','code':'request-binding-conflict','errorType':'TransferFailure'})
    state_path=folder/'transfer.state.json'
    state=_json_file(state_path) if state_path.exists() or state_path.is_symlink() else None
    if state is not None and (not isinstance(state,dict) or set(state) not in ({'schemaVersion','status','result'},{'schemaVersion','status','result','error'}) or type(state.get('schemaVersion')) is not int or state['schemaVersion']!=1 or state.get('status') not in ('native-result','download-returned','outcome-unconfirmed','cancelled','transfer-failed') or state.get('result') is not None and not isinstance(state['result'],dict)):
        raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'})
    return native,key,folder,state


def _episode_binding(native):
    return {'hostAppId':TARGET_APP_ID,'srcAppId':native['srcAppId'],'dramaId':native['dramaId'],'serialNo':native['episodeNo'],'isStraight':True,'playAuthorization':'native-straight-playback'}


def _saved_result(folder,key,native,state):
    if state is None or state.get('status')!='download-returned':
        name=_episode_name(native['episodeNo']);path=folder/'media'/name;evidence_path=path.with_suffix('.mp4.evidence.json')
        if not path.exists() or not evidence_path.exists():return None
        _directory(folder/'media')
        encrypted=encrypted_media_path(folder)
        if not encrypted.exists() or encrypted.is_symlink():
            raise TransferFailure(details={'stage':'receipt-read','code':'receipt-binding-invalid','errorType':'TransferFailure'})
        try:use_saved_media_url(folder,_episode_binding(native),lambda _address:True)
        except Exception as error:raise _failure(error,'receipt-read') from None
        evidence=_json_file(evidence_path)
        if (not isinstance(evidence,dict) or set(evidence)!={'schemaVersion','fileName','media'} or type(evidence.get('schemaVersion')) is not int or evidence['schemaVersion']!=1 or evidence['fileName']!=name or not isinstance(evidence['media'],dict)
                or set(evidence['media'])!={'bytes','sha256','durationSeconds','width','height','hasAudio','fullDecodePassed'}):
            raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'})
        metadata=_metadata({**evidence['media'],'path':str(path),'status':'download-validated'},folder,key,name)
        return {'operation':'download_episode',**native,'serialNo':native['episodeNo'],'idempotencyKey':key,'status':'download-returned','receiptReused':True,'businessCalls':0,'identityMatched':True,'isStraight':True,'playAuthorization':'native-straight-playback','media':metadata}
    result=state.get('result')
    if (not isinstance(result,dict) or result.get('operation')!='download_episode' or result.get('status')!='download-returned'
            or result.get('serialNo')!=native['episodeNo'] or type(result.get('serialNo')) is not int
            or 'episodeNo' in result and (type(result['episodeNo']) is not int or result['episodeNo']!=native['episodeNo'])
            or result.get('srcAppId')!=native['srcAppId'] or result.get('dramaId')!=native['dramaId'] or result.get('idempotencyKey')!=key
            or result.get('identityMatched') is not True or result.get('isStraight') is not True or result.get('playAuthorization')!='native-straight-playback' or not isinstance(result.get('media'),dict)):
        raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'})
    name=_episode_name(native['episodeNo']);saved=result['media']
    if saved.get('relativePath')!=f'downloads/{key}/media/{name}':
        raise TransferFailure(details={'stage':'media-validate','code':'media-file-rejected','errorType':'TransferFailure'})
    metadata=_metadata({**saved,'path':str(folder/'media'/name),'status':'download-validated'},folder,key,name)
    return {**result,**native,'media':metadata,'receiptReused':True,'businessCalls':0}


def episode_download_status(params,root):
    """Reconcile one original key without native calls, HTTP or new directories."""
    native,key,folder,state=_episode_state(params,root)
    common={'operation':'download_episode',**native,'idempotencyKey':key}
    if folder is None:return {**common,'status':'request-not-found'}
    if state is not None and isinstance(state.get('error'),dict) and state['error'].get('code')=='media-process-cleanup-failed':
        raise TransferFailure('media-process-cleanup-failed',details=state['error'])
    completed=_saved_result(folder,key,native,state)
    if completed is not None:return completed
    encrypted=encrypted_media_path(folder)
    if encrypted.exists() or encrypted.is_symlink():
        _directory(encrypted.parent)
        info=encrypted.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or not 1<=info.st_size<=16384 or getattr(info,'st_file_attributes',0)&0x400:
            raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'})
        return {**common,'status':'resume-available'}
    if state is not None and state.get('status')=='native-result' and isinstance(state.get('result'),dict):
        try:public,_private=split_result('download_episode',native,{'publicResult':state['result'],'privateResult':None})
        except OperationError:raise TransferFailure(details={'stage':'receipt-read','code':'resume-state-invalid','errorType':'TransferFailure'}) from None
        return {**public,**native,'idempotencyKey':key,'receiptReused':True,'businessCalls':0}
    return {**common,'status':'outcome-unconfirmed'}


async def perform_episode_download(rpc,params,root,*,cached_receipt_directory=None):
    """Download or resume exactly one key; uncertain native acquisition is never replayed.

    The intent is durable before native dispatch. A saved encrypted URL is the only
    source for transfer retry. Existing completed media must pass file/hash checks
    before reuse. Caller cancellation waits for worker cleanup and persists its
    outcome; it cannot turn an unknown native result into a fresh acquisition.
    """
    native,key,folder,state=_episode_state(params,root)
    if folder is not None:
        status=episode_download_status(params,root)
        if status['status'] not in ('resume-available',):return status
    else:
        folder=_episode_folder(root,key,create=True)
        _publish_state(folder/'request.json',{'schemaVersion':1,'operation':'download_episode','requestedSource':native,'idempotencyKey':key},exclusive=True)
    cancel_event=threading.Event();worker=None;media=None;worker_failure=None;public=None
    stage='native-download';name=_episode_name(native['episodeNo'])
    encrypted=encrypted_media_path(folder)
    reuse=folder if encrypted.exists() else cached_receipt_directory
    async def consume(url,binding,cached_directory=None):
        nonlocal worker,media,worker_failure
        if worker is not None:raise TransferFailure('transfer-failed')
        worker=asyncio.create_task(_worker_outcome(folder,url,binding,cancel_event,key,cached_directory,name,True,_episode_binding(native)))
        try:
            outcome,value=await asyncio.shield(worker)
            if outcome!='completed':worker_failure=value;raise TransferFailure(details=value)
            media=value
        except asyncio.CancelledError:
            media=await _join_cancelled_worker(worker,cancel_event)
            raise
    def save_state(status,result=None,error=None):
        value={'schemaVersion':1,'status':status,'result':result}
        if error is not None:value['error']=_bounded_details(error)
        _publish_state(folder/'transfer.state.json',value)
    try:
        if reuse is None:
            public=await call_operation(rpc,'download_episode',native,private_media_consumer=consume)
        else:
            stage='native-status'
            status=await call_operation(rpc,'status',{})
            public={key:value for key,value in status.items() if key not in ('hasRequire','hasBizRequest','hasNativeWrapper')}
            public.update(operation='download_episode',srcAppId=native['srcAppId'],dramaId=native['dramaId'],title=None,episodeCount=None,isFirstMediaFree=False,hasVideoInfo=False,hasPlayAuthorization=False,serialNo=None,isStraight=False,hasPrivateMedia=False)
            if status['status']=='status-returned':
                binding=_episode_binding(native)
                if cached_receipt_directory is not None and native['episodeNo']==1 and reuse!=folder:
                    binding={'hostAppId':TARGET_APP_ID,'srcAppId':native['srcAppId'],'dramaId':native['dramaId'],'serialNo':1,'isFirstMediaFree':True,'isStraight':True}
                await consume(None,binding,reuse)
                public.update(serialNo=native['episodeNo'],isStraight=True,hasPrivateMedia=True)
        result={**public,**native,'status':'download-returned','idempotencyKey':key,'receiptReused':reuse is not None,'media':media} if media is not None else public
        if media is not None:
            result.update(identityMatched=True,isStraight=True,playAuthorization='native-straight-playback')
            save_state('download-returned',result)
        elif public.get('status') in ('native-call-failed','native-call-timeout'):save_state('outcome-unconfirmed',public)
        else:save_state('native-result',public)
        return {**result,**native,'idempotencyKey':key}
    except asyncio.CancelledError:
        if worker is not None and not worker.done():media=await _join_cancelled_worker(worker,cancel_event)
        if media is not None:
            result={'operation':'download_episode','status':'download-returned',**native,'serialNo':native['episodeNo'],'idempotencyKey':key,'receiptReused':reuse is not None,'businessCalls':0,'identityMatched':True,'isStraight':True,'playAuthorization':'native-straight-playback','media':media}
            save_state('download-returned',result)
        else:save_state('cancelled',error=worker_failure)
        raise
    except Exception as error:
        failure=TransferFailure(details=worker_failure) if worker_failure is not None else _failure(error,stage)
        save_state('transfer-failed',error=failure.details)
        raise failure from None

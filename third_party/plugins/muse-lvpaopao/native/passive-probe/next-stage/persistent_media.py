"""Task-local first-episode transfer; private native addresses never reach public output."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import threading

from download_media import MediaFailure,download
from operations.fixed_operations import OperationError,TARGET_APP_ID,call_operation,validate_parameters
from secure_media_receipt import ReceiptFailure,WindowsCurrentUserDpapi,save_media_receipt,use_saved_media_url

_STAGES=frozenset(('transfer','parameters','prepare-directory','receipt-save','receipt-read','media-transfer','media-probe','media-decode','media-process-cleanup','media-validate','native-status','native-download','receipt-write'))
_FIXED_CODES=frozenset(('transfer-failed','output-already-exists','parameters-invalid','cdn-host-unverified','declared-size-rejected','download-cancelled','download-deadline','http-status-rejected','media-probe-rejected','media-decode-failed','media-process-cleanup-failed','media-size-limit','media-size-mismatch','nonpublic-cdn-address','output-name-invalid','redirect-not-accepted','url-invalid','media-metadata-rejected','media-file-rejected','media-hash-mismatch','dpapi-output-size-rejected','dpapi-unprotect-failed','dpapi-protect-failed','receipt-already-exists','receipt-binding-invalid','receipt-ciphertext-changed','receipt-directory-acl-failed','receipt-directory-acl-invalid','receipt-directory-acl-unverified','receipt-directory-link-rejected','receipt-envelope-invalid','receipt-file-link-rejected','receipt-file-size-rejected','receipt-payload-invalid','receipt-task-directory-invalid','receipt-url-invalid','receipt-user-sid-unavailable','receipt-user-token-invalid','receipt-user-token-unavailable','windows-dpapi-required','operation-result-invalid','operation-template-invalid','operation-whitelist-invalid','private-media-consumer-failed','private-media-consumer-required','private-result-invalid','private-result-unexpected','public-result-invalid'))
_ERROR_TYPES={value:value.__name__ for value in (MediaFailure,ReceiptFailure,OperationError,FileNotFoundError,FileExistsError,PermissionError,OSError,TimeoutError,ValueError,TypeError,AttributeError,RuntimeError,json.JSONDecodeError)}
_SAFE_ERROR_NAMES=frozenset((*_ERROR_TYPES.values(),'TransferFailure','Error'))


def _bounded_details(details):
    source=details if isinstance(details,dict) else {}
    def label(key,allowed,default):
        value=source.get(key)
        return value if isinstance(value,str) and value in allowed else default
    return {'stage':label('stage',_STAGES,'transfer'),'code':label('code',_FIXED_CODES,'transfer-failed'),'errorType':label('errorType',_SAFE_ERROR_NAMES,'Error')}


class TransferFailure(RuntimeError):
    """A compatible fixed message and bounded stage/code/type diagnostics only."""
    def __init__(self,code='transfer-failed',*,details=None):
        message=code if code in ('transfer-failed','output-already-exists','parameters-invalid') else 'transfer-failed'
        super().__init__(message)
        self.details=_bounded_details(details if details is not None else {'stage':'transfer','code':message,'errorType':'TransferFailure'})


def _failure(error,stage):
    if type(error) is TransferFailure:
        details=_bounded_details(error.details)
        if details['stage']=='transfer':details['stage']=stage
        return TransferFailure(str(error),details=details)
    # Exception messages, paths, stderr and native addresses are never projected.
    code=error.args[0] if type(error) in (MediaFailure,ReceiptFailure,OperationError) and len(error.args)==1 else None
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


def _metadata(result,folder,request_id):
    expected=folder/'media'/'episode-01.mp4'
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
    return {'relativePath':f'downloads/{request_id}/media/episode-01.mp4','bytes':count,'sha256':digest,'durationSeconds':duration,'width':result['width'],'height':result['height'],'hasAudio':result['hasAudio'],'fullDecodePassed':True}


def _worker(folder,url,binding,cancel_event,request_id,cached_directory=None):
    # Seal the already obtained address even if cancellation preceded this thread.
    stage='receipt-save'
    def transfer(address):
        nonlocal stage
        stage='media-transfer'
        return download(address,folder/'media',cancel_event,output_name='episode-01.mp4')
    try:
        if cached_directory is None:save_media_receipt(folder,url,binding)
        stage='receipt-read'
        source=folder if cached_directory is None else Path(cached_directory).resolve(strict=True)
        result=use_saved_media_url(source,binding,transfer)
        stage='media-validate'
        return _metadata(result,folder,request_id)
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

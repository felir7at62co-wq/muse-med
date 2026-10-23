"""Socket-free, target-bound RPC core for a trusted host's fixed operations.

The host owns transport authentication, context discovery, and the operation
registry. Callers provide only a registered key and JSON parameters. No target
code, parameters, results, URLs, context names, or raw frames enter receipts.
"""
from __future__ import annotations

import asyncio
from collections import Counter, deque
from dataclasses import dataclass
import hashlib
import json
import math
import re
from typing import Awaitable, Callable, Mapping

import remote_wire as wire


class RpcError(RuntimeError):
    """A fixed, non-sensitive RPC failure code."""


@dataclass(frozen=True)
class FixedOperation:
    """Trusted template with exactly one JSON placeholder and a host validator."""
    expression: str
    validate: Callable[[dict], dict]
    timeout_seconds: float = 30


@dataclass
class _Lease:
    native_id: str
    context_id: int
    generation: int
    verified: bool = False


@dataclass
class _Pending:
    cdp_id: int
    op_id: int
    lease: _Lease
    future: asyncio.Future


def _json_object(value):
    if not isinstance(value,dict):raise RpcError('parameters-invalid')
    try:encoded=json.dumps(value,ensure_ascii=True,allow_nan=False,separators=(',',':'))
    except (ValueError,TypeError,RecursionError):raise RpcError('parameters-invalid') from None
    if len(encoded.encode('utf8'))>16384:raise RpcError('parameters-too-large')
    return encoded,json.loads(encoded)


class NativeRpc:
    """One verified lease and one serial request; no network or native lifecycle."""
    def __init__(self,send_frame: Callable[[bytes],Awaitable[None]],expected_app_id: str,
                 operations: Mapping[str,FixedOperation],*,identity_timeout_seconds: float=10,
                 initial_sequence: int=0,initial_op_id: int=1000,initial_cdp_id: int=2000):
        if not isinstance(expected_app_id,str) or re.fullmatch(r'wx[0-9a-f]{16}',expected_app_id) is None:
            raise RpcError('expected-app-id-invalid')
        self._timeout(identity_timeout_seconds)
        for value,maximum in ((initial_sequence,wire.UINT32_MAX),(initial_op_id,(1<<64)-1),(initial_cdp_id,(1<<53)-1)):
            if type(value) is not int or not 0<=value<=maximum:raise RpcError('initial-identifier-invalid')
        for key,operation in operations.items():
            if not isinstance(key,str) or re.fullmatch(r'[a-z][a-z0-9_.-]{0,63}',key) is None:
                raise RpcError('operation-key-invalid')
            if not isinstance(operation,FixedOperation) or not callable(operation.validate) or not isinstance(operation.expression,str) or operation.expression.count('@@PARAMS@@')!=1:
                raise RpcError('operation-template-invalid')
            self._timeout(operation.timeout_seconds)
        self._send=send_frame;self._operations=dict(operations)
        self._identity_timeout=identity_timeout_seconds
        self._identity_expression=('(()=>{try{return {matchesExpected:typeof wx!=="undefined"&&typeof wx.getAccountInfoSync==="function"&&wx.getAccountInfoSync().miniProgram.appId==='+json.dumps(expected_app_id)+',hasOperateWXData:typeof wx!=="undefined"&&typeof wx.operateWXData==="function"};}catch(_){return {matchesExpected:false,hasOperateWXData:false};}})()')
        self._lock=asyncio.Lock();self._lease=None;self._pending=None
        self._closed=False;self._generation=0;self._seq=initial_sequence;self._op_id=initial_op_id;self._cdp_id=initial_cdp_id
        self._counts=Counter();self._errors=Counter();self._records=deque(maxlen=64)

    @staticmethod
    def _timeout(value):
        if type(value) not in (int,float) or not math.isfinite(value) or not 0<value<=600:
            raise RpcError('deadline-invalid')

    def _live(self,lease):
        if self._closed:raise RpcError('closed')
        if self._lease is not lease:raise RpcError('context-invalidated')

    def _invalidate(self,code):
        self._lease=None;self._generation+=1;self._errors[code]+=1
        if self._pending and not self._pending.future.done():
            self._pending.future.set_exception(RpcError(code))

    def close(self):
        """Fail the owned request and queued operations; never open another lease."""
        if not self._closed:self._closed=True;self._invalidate('closed')

    async def verify_context(self,native_context_id: str,execution_context_id: int):
        """Check a host-selected explicit context with only the fixed identity getter."""
        if (not isinstance(native_context_id,str) or len(native_context_id.encode('utf8'))>wire.MAX_CONTEXT_ID_BYTES
                or type(execution_context_id) is not int or not 0<=execution_context_id<=(1<<53)-1):
            raise RpcError('context-id-invalid')
        async with self._lock:
            if self._closed:raise RpcError('closed')
            self._invalidate('lease-replaced')
            lease=_Lease(native_context_id,execution_context_id,self._generation);self._lease=lease
            await self._verify(lease)

    async def _verify(self,lease):
        lease.verified=False
        value=await self._evaluate(lease,self._identity_expression,self._identity_timeout,'identity')
        if (not isinstance(value,dict) or set(value)!={'matchesExpected','hasOperateWXData'}
                or any(type(v) is not bool for v in value.values()) or not all(value.values())):
            self._invalidate('identity-unconfirmed');raise RpcError('identity-unconfirmed')
        self._live(lease);lease.verified=True

    async def call(self,key: str,parameters: dict):
        """Recheck identity and execute exactly one trusted registered template."""
        if not isinstance(key,str) or key not in self._operations:raise RpcError('operation-not-registered')
        operation=self._operations[key]
        _,detached=_json_object(parameters)
        try:validated=operation.validate(detached)
        except Exception:raise RpcError('parameters-invalid') from None
        encoded,_=_json_object(validated)
        async with self._lock:
            lease=self._lease
            if self._closed:raise RpcError('closed')
            if lease is None or not lease.verified:raise RpcError('verified-context-required')
            await self._verify(lease)
            self._live(lease)
            return await self._evaluate(lease,operation.expression.replace('@@PARAMS@@','JSON.parse('+json.dumps(encoded)+')'),operation.timeout_seconds,key)

    async def _evaluate(self,lease,expression,timeout,key):
        self._live(lease)
        self._seq+=1;self._op_id+=1;self._cdp_id+=1
        if self._seq>wire.UINT32_MAX or self._op_id>(1<<64)-1 or self._cdp_id>(1<<53)-1:
            self.close();raise RpcError('identifier-exhausted')
        params={'expression':expression,'contextId':lease.context_id,'returnByValue':True,'silent':True,'awaitPromise':True,'userGesture':False,'includeCommandLineAPI':False}
        cdp={'id':self._cdp_id,'method':'Runtime.evaluate','params':params}
        try:raw=wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS,{'opId':self._op_id,'payload':json.dumps(cdp,separators=(',',':')),'jscontextId':lease.native_id},seq=self._seq,after=0)
        except wire.WireError:
            self._invalidate('request-encoding-failed');raise RpcError('request-encoding-failed') from None
        future=asyncio.get_running_loop().create_future()
        pending=_Pending(self._cdp_id,self._op_id,lease,future);self._pending=pending
        self._records.append({'operation':key,'outerSeq':self._seq,'requestOpId':pending.op_id,'cdpId':pending.cdp_id,'generation':lease.generation})
        async def dispatch():
            self._live(lease)
            try:await self._send(raw)
            except asyncio.CancelledError:raise
            except Exception:raise RpcError('transport-failed') from None
        sender=asyncio.create_task(dispatch())
        try:
            async with asyncio.timeout(timeout):
                done,_=await asyncio.wait({sender,future},return_when=asyncio.FIRST_COMPLETED)
                if sender in done:sender.result()
                return await future
        except TimeoutError:
            self._invalidate('deadline');raise RpcError('deadline') from None
        except asyncio.CancelledError:
            self._invalidate('cancelled');raise
        except RpcError as error:
            if str(error)=='transport-failed':self._invalidate('transport-failed')
            raise
        except Exception:
            self._invalidate('transport-failed');raise RpcError('transport-failed') from None
        finally:
            if self._pending is pending:self._pending=None
            if not future.done():future.cancel()
            elif not future.cancelled():future.exception()
            if not sender.done():sender.cancel()
            await asyncio.gather(sender,return_exceptions=True)

    async def accept_frame(self,raw: bytes):
        """Correlate only owned replies and invalidate a removed selected context."""
        if self._closed:return
        try:
            outer=wire.decode_outer(raw)
            known={wire.CATEGORY_CHROME_DEVTOOLS,wire.CATEGORY_CHROME_DEVTOOLS_RESULT,wire.CATEGORY_ADD_JS_CONTEXT,wire.CATEGORY_REMOVE_JS_CONTEXT,wire.CATEGORY_CONNECT_JS_CONTEXT,wire.CATEGORY_SETUP_CONTEXT}
            category=outer.category if outer.category in known else 'unknown'
            self._counts[category]+=1
            if category=='unknown':return
            frame=wire.decode_frame(raw)
            if category==wire.CATEGORY_REMOVE_JS_CONTEXT:
                metadata=wire.get_context_metadata(frame)
                if metadata and self._lease and metadata.context_id==self._lease.native_id:self._invalidate('context-removed')
                return
            if category not in {wire.CATEGORY_CHROME_DEVTOOLS,wire.CATEGORY_CHROME_DEVTOOLS_RESULT}:return
            cdp=json.loads(frame.payload.payload)
            if not isinstance(cdp,dict):raise ValueError()
            lease=self._lease;native_id=frame.payload.jscontextId
            if lease and native_id==lease.native_id:
                method=cdp.get('method');params=cdp.get('params',{})
                if method=='Runtime.executionContextsCleared' or (method=='Runtime.executionContextDestroyed' and isinstance(params,dict) and params.get('executionContextId')==lease.context_id):
                    self._invalidate('context-removed');return
            pending=self._pending
            if not pending or pending.future.done() or type(cdp.get('id')) is not int or cdp['id']!=pending.cdp_id:return
            if native_id!=pending.lease.native_id:self._errors['response-route']+=1;return
            self._records.append({'responseOpId':frame.payload.opId,'outerSeq':outer.seq,'cdpId':pending.cdp_id,'generation':pending.lease.generation})
            result=cdp.get('result')
            if 'error' in cdp or not isinstance(result,dict) or 'exceptionDetails' in result:
                pending.future.set_exception(RpcError('evaluation-rejected'));return
            remote=result.get('result')
            if not isinstance(remote,dict) or 'value' not in remote:
                pending.future.set_exception(RpcError('result-not-by-value'));return
            pending.future.set_result(remote['value'])
        except (wire.WireError,ValueError,TypeError,AttributeError):
            self._invalidate('protocol-invalid')

    def receipt(self):
        """Return bounded metadata only; operation parameters/results stay private."""
        lease=self._lease
        return {'closed':self._closed,'pending':self._pending is not None,'lease':None if lease is None else {'nativeContextIdSha256':hashlib.sha256(lease.native_id.encode('utf8')).hexdigest(),'executionContextId':lease.context_id,'generation':lease.generation,'verified':lease.verified},'categoryCounts':dict(self._counts),'errors':dict(self._errors),'records':list(self._records)}

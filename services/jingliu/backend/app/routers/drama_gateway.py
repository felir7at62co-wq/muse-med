"""短剧编导的云端转写与剧变音色分配接口（2026-11-05，客户端 muse-account 插件调用）。

镜流账号鉴权。协议与 muse-med 的账号网关一致（客户端那两个模块原样迁过来，只改了地址与鉴权）：
- `POST /v2/drama/asr/jobs`：请求体是音频字节；头部 `idempotency-key`（UUID）、`x-audio-sha256`、
  `x-audio-language`（zh|auto）、`x-muse-asr-purpose`（subtitles|screenplay）。
- `GET /v2/drama/asr/jobs/{id}`：读任务，必要时向火山查一次原任务。
- `POST /v2/drama/voice-slots`：JSON 请求体，头部 `x-jubian-token` 是调用者自己的剧变令牌（只用于核对，不落库）。

服务器没有配置云端转写时 ASR 两个接口回 503（不带 Retry-After），客户端据此报「服务器未配置」。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from .. import access

router = APIRouter(prefix="/v2", tags=["drama-gateway"])


def _drama_user() -> int:
    uid = access.current_user_id()
    if not uid:
        raise HTTPException(401, {"code": "not_signed_in", "message": "没有登录"})
    return uid


def _asr_error(err) -> JSONResponse:
    headers = {"Retry-After": str(err.retry_after)} if err.retry_after else {}
    return JSONResponse({"code": err.code, "message": err.message}, status_code=err.status, headers=headers)


@router.post("/drama/asr/jobs")
async def asr_submit(request: Request):
    """提交一段音轨。同一任务号重复提交返回原任务。"""
    from .. import drama_asr
    from fastapi.concurrency import run_in_threadpool
    uid = _drama_user()
    if not drama_asr.configured():
        return JSONResponse({"code": "not_configured", "message": "服务器尚未配置云端转写"}, status_code=503)
    body = await request.body()
    h = request.headers
    try:
        return await run_in_threadpool(drama_asr.submit, uid, h.get("idempotency-key", ""), h.get("x-audio-sha256", ""),
                                       h.get("x-audio-language", "zh"), h.get("x-muse-asr-purpose", "subtitles"), body)
    except drama_asr.AsrError as err:
        return _asr_error(err)


@router.get("/drama/asr/jobs/{job_id}")
def asr_get(job_id: str):
    """读一个任务（不会新建上游任务）。"""
    from .. import drama_asr
    uid = _drama_user()
    if not drama_asr.configured():
        return JSONResponse({"code": "not_configured", "message": "服务器尚未配置云端转写"}, status_code=503)
    try:
        return drama_asr.get(uid, job_id)
    except drama_asr.AsrError as err:
        return _asr_error(err)


@router.post("/drama/voice-slots")
async def voice_slot(request: Request):
    """剧变音色槽位的认领 / 提交 / 完成 / 放弃 / 读取。"""
    from .. import drama_voice_slots
    from fastapi.concurrency import run_in_threadpool
    uid = _drama_user()
    try:
        value = await request.json()
    except ValueError:
        return JSONResponse({"code": "invalid_request", "message": "请求体不是 JSON"}, status_code=400)
    try:
        return await run_in_threadpool(drama_voice_slots.request, uid, request.headers.get("x-jubian-token", ""), value)
    except drama_voice_slots.SlotError as err:
        return JSONResponse({"code": err.code, "message": err.message}, status_code=err.status)

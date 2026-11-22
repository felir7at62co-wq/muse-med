"""Seedance PE — FastAPI 路由。用户贴原始视频提示词 → 按 skill 方法论优化。"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import User, get_current_user
from . import service as svc

logger = logging.getLogger("seedance_pe.routes")
router = APIRouter(prefix="/v1/seedance-pe", tags=["seedance_pe"])


class OptimizeIn(BaseModel):
    raw_prompt: str = Field(..., description="用户原始/口语化视频提示词, 或可公开分享的完整请求体文本")
    provider: str = Field("gemini", description="LLM provider: gemini / deepseek / gpt5")
    extra_context: str | None = Field(None, description="可选补充背景")


@router.get("/status")
async def status(_: User = Depends(get_current_user)):
    """自检: skill 资产是否齐全 + system prompt 体积。"""
    return svc.get_asset_status()


@router.post("/optimize")
async def optimize(payload: OptimizeIn, _: User = Depends(get_current_user)):
    """按 byted-ark-seedance-pe skill 优化原始视频提示词。"""
    if not (payload.raw_prompt or "").strip():
        raise HTTPException(400, "raw_prompt 不能为空")
    result = await svc.optimize_prompt(
        payload.raw_prompt,
        provider=payload.provider,
        extra_context=payload.extra_context,
    )
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "优化失败"))
    return result
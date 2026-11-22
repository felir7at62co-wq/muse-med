"""计费路由。

用户端 (/v1/billing):
  GET /summary            自己的费用汇总
  GET /records            自己的费用明细 (分页)
  GET /pricing            计费规则 (公示单价)

管理端 (/v1/admin-api/billing):
  GET /summary            全量汇总 (可选 ?user_id= 过滤)
  GET /records            全量明细 (可选 ?user_id= 过滤, 分页)
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends

from ..auth import get_current_user, User
from ..auth.dependencies import require_admin
from . import service, pricing

router = APIRouter(prefix="/v1/billing", tags=["billing"])
admin_router = APIRouter(prefix="/v1/admin-api/billing", tags=["billing-admin"])


@router.get("/pricing")
async def get_pricing(user: User = Depends(get_current_user)):
    """计费规则公示 (前端展示单价)。"""
    return {
        "currency": "CNY",
        "rules": [
            {"model": "gpt-image-2", "desc": "图像生成 (不分辨率)", "unit": "张", "price": pricing.GPT_IMAGE_PRICE},
            {"model": "gemini-3-pro-image-preview", "desc": "Nano Banana Pro 1K/2K", "unit": "张", "price": pricing.GEMINI_PRICE_1K_2K},
            {"model": "gemini-3-pro-image-preview", "desc": "Nano Banana Pro 4K", "unit": "张", "price": pricing.GEMINI_PRICE_4K},
            {"model": "gemini-3.1-flash-image", "desc": "Nano Banana 2 1K/2K", "unit": "张", "price": pricing.GEMINI_FLASH_PRICE_1K_2K},
            {"model": "gemini-3.1-flash-image", "desc": "Nano Banana 2 4K", "unit": "张", "price": pricing.GEMINI_FLASH_PRICE_4K},
            {"model": "image2.5flare", "desc": "image2.5flare (不分辨率)", "unit": "张", "price": pricing.IMAGE25_PRICE},
            {"model": "image2.5sunburst", "desc": "image2.5sunburst (不分辨率)", "unit": "张", "price": pricing.IMAGE25_PRICE},
            {"model": "runninghub", "desc": "高清放大", "unit": "小时", "price": pricing.RH_PRICE_PER_HOUR},
        ],
    }


@router.get("/summary")
async def my_summary(user: User = Depends(get_current_user)):
    return await service.summary(user_id=user.id)


@router.get("/records")
async def my_records(user: User = Depends(get_current_user), limit: int = 50, offset: int = 0):
    return await service.list_records(user_id=user.id, limit=limit, offset=offset)


# ---------- 管理端 ----------

@admin_router.get("/summary")
async def admin_summary(admin: User = Depends(require_admin), user_id: Optional[int] = None):
    return await service.summary(user_id=user_id)


@admin_router.get("/records")
async def admin_records(
    admin: User = Depends(require_admin),
    user_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
):
    return await service.list_records(user_id=user_id, limit=limit, offset=offset)
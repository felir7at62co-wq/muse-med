"""计费规则与估算 (人民币元)。集中在此, 便于后续调价。"""
from __future__ import annotations

from typing import Optional

# 单价表 (估算)
GPT_IMAGE_PRICE = 0.5          # gpt-image-2: 0.5 元/张, 不分辨率
GEMINI_PRICE_1K_2K = 0.4       # Nano Banana Pro 1K/2K: 0.4 元/张
GEMINI_PRICE_4K = 0.8          # Nano Banana Pro 4K: 0.8 元/张
# Nano Banana 2 (gemini-3.1-flash-image): 2026-08-15 用户定版 —— 与 Pro 同价,
# 避免用户全部倒向低价档。后续若要拉开档次, 改这两行即可。
GEMINI_FLASH_PRICE_1K_2K = 0.4  # Nano Banana 2 1K/2K: 0.4 元/张
GEMINI_FLASH_PRICE_4K = 0.8     # Nano Banana 2 4K: 0.8 元/张
RH_PRICE_PER_HOUR = 4.0        # RunningHub 高清放大: 4 元/小时
# ⚠️ 2026-10-14: 下面四个 RunningHub **托管生图模型**的价目已不再产生新账单 ——
# 该渠道整条被摘除（上游 CN 节点合规下线，40310）。**但刻意保留**，理由是
# `image_billing` 里存在 17 条历史记录用的正是这些 model 名：
#   rh-image-n-pro-t2i 9 条 / rh-image-n-pro 4 条 / rh-image-g-2-t2i 3 条 / rh-image-g-2 1 条
# 单价虽已在写入时冻结进行内（unit_price/amount），删除这里的常量对历史账单**没有**
# 影响；保留是为了让"这套模型名曾经是什么价"在代码里仍可查，也避免将来若有
# 按 model 重算的路径时静默落到 fallback 分支（那会把 rh-* 按 gpt-image-2 的 0.5 元
# 计价，与实际 0.1/0.4 元不符）。历史行一旦清空，这里连同 price_per_image 的
# 对应分支可以一并删除。
# RunningHub v2 图生图兜底模型 (按实测 thirdPartyConsumeMoney)
RH_IMAGE_G2_PRICE = 0.1        # 全能图片 G-2 (GPT Image 2.0): 0.1 元/张
RH_IMAGE_NPRO_PRICE = 0.4      # 全能图片 PRO (Nano Banana Pro): 0.4 元/张
RH_IMAGE_G2_T2I_PRICE = 0.1    # 全能图片 G-2.0 文生图 (低价渠道版): 0.1 元/张
RH_IMAGE_NPRO_T2I_PRICE = 0.4  # 全能图片 PRO 文生图 (低价渠道版): 0.4 元/张
# GPT Image 2.5 (image2.5flare / image2.5sunburst): 2026-09-11 接入。
# ⚠ 暂按 gpt-image-2 同价挂账, **上游实际单价尚未确认**, 待核实渠道账单后改这一行。
# 不落进 price_per_image 的 fallback 分支, 是为了让账单明细能区分出是哪个模型。
IMAGE25_PRICE = 0.5            # image2.5flare / image2.5sunburst: 0.5 元/张, 不分辨率


def _gemini_tier(size: Optional[str]) -> str:
    """从 'WxH' 估算 gemini 画质档位 1K/2K/4K (与 providers 同口径)。"""
    if not size:
        return "1K"
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except Exception:  # noqa: BLE001
        return "1K"
    long_edge = max(w, h)
    # ⚠ 阈值必须与 providers._size_to_image_size_tier / workflows.QUALITY_LONG_EDGE
    #   同口径 (锚点 1024/2048/3840, 阈值取相邻锚点中点)。
    #   2026-08-15 由 3200/2240 修正: 旧值配合新锚点会把"2K"(长边 2048) 判成 1K 档,
    #   虽然 1K/2K 同价不影响金额, 但账单明细里的档位标签会写错。
    if long_edge >= 2944:
        return "4K"
    if long_edge >= 1536:
        return "2K"
    return "1K"


def price_per_image(model: str, size: Optional[str]) -> tuple[float, dict]:
    """返回 (单价, 明细)。"""
    if model == "gpt-image-2":
        return GPT_IMAGE_PRICE, {"rule": "gpt-image-2 统一价", "size": size}
    if model == "gemini-3-pro-image-preview":
        tier = _gemini_tier(size)
        price = GEMINI_PRICE_4K if tier == "4K" else GEMINI_PRICE_1K_2K
        return price, {"rule": f"Nano Banana Pro {tier}", "size": size, "tier": tier}
    if model == "gemini-3.1-flash-image":
        tier = _gemini_tier(size)
        price = GEMINI_FLASH_PRICE_4K if tier == "4K" else GEMINI_FLASH_PRICE_1K_2K
        return price, {"rule": f"Nano Banana 2 {tier}", "size": size, "tier": tier}
    if model in ("image2.5flare", "image2.5sunburst"):
        return IMAGE25_PRICE, {"rule": f"{model} 统一价", "size": size}
    # RunningHub v2 图生图兜底模型 (按实测第三方消耗)
    if model == "rh-image-g-2":
        return RH_IMAGE_G2_PRICE, {"rule": "RunningHub G-2 兜底", "size": size}
    if model == "rh-image-n-pro":
        return RH_IMAGE_NPRO_PRICE, {"rule": "RunningHub PRO 兜底", "size": size}
    if model == "rh-image-g-2-t2i":
        return RH_IMAGE_G2_T2I_PRICE, {"rule": "RunningHub G-2.0 文生图(低价)", "size": size}
    if model == "rh-image-n-pro-t2i":
        return RH_IMAGE_NPRO_T2I_PRICE, {"rule": "RunningHub PRO 文生图(低价)", "size": size}
    # 未知模型按 gpt 价兜底
    return GPT_IMAGE_PRICE, {"rule": "fallback", "model": model, "size": size}


def estimate_generate(model: str, size: Optional[str], n_images: int) -> tuple[float, float, dict]:
    """生成任务计费。返回 (单价, 金额, 明细)。

    n_images: 实际产出张数 (grid9 切片后可能 >n; 这里按"实际落库的张数"计)。
    """
    unit = price_per_image(model, size)[0]
    detail = price_per_image(model, size)[1]
    qty = max(0, int(n_images))
    amount = round(unit * qty, 4)
    detail = {**detail, "images": qty}
    return unit, amount, detail


def estimate_upscale(duration_seconds: float) -> tuple[float, float, dict]:
    """高清放大计费: 4 元/小时, 按实际运行时长折算。返回 (单价, 金额, 明细)。"""
    hours = max(0.0, float(duration_seconds)) / 3600.0
    amount = round(RH_PRICE_PER_HOUR * hours, 4)
    detail = {
        "rule": "runninghub 4元/小时",
        "duration_seconds": round(float(duration_seconds), 1),
        "hours": round(hours, 4),
    }
    return RH_PRICE_PER_HOUR, amount, detail
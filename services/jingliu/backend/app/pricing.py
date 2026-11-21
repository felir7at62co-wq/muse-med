"""计价：把一次上游调用的用量换算成金额（**分**，整数）。

口径来源：docs/DESIGN-积分预算与飞书审批-2026-10-13.md 第四节与第八节裁定。
本模块只做纯计算，不碰数据库、不做 IO——P0 用它给用量流水标价，
P1 的冻结/结算闸门复用同一组函数，**两处不许各写一套单价**。

## 单位

全部以「分」为单位（1 元 = 100 分，1 积分 = 1 元）。账本累加一律走整数，
浮点只出现在单笔换算内部，并在出口处**向上取整**到分——
平台宁可多收不足 1 分，也不能出现"累加一万笔后对不平"。

## 已裁定的单价（2026-10-13）

| 类别 | 口径 |
|---|---|
| 图像 | 0.25 元/张，所有生图模型同价（2026-11-21 由 0.15 上调；剧变成本 gpt-image-2/2.5/2.6 ¥0.20、nano-banana-pro ¥0.18）|
| 文本 | 0.5 元/次**用户操作**（不是每次底层调用；一次拆解底层约 670 次调用） |
| RunningHub（海螺 H3、高清放大） | 按**生成耗时** 6 元/小时（不是视频时长） |
| TTS | 0.074 元/段 → 7 分/段 |
| Seedance | 官方 token 价，一律「不含视频输入」档；2.0 与 2.5 两套价 |
| 万相 wan3.0 | 按**输出秒数**，官方价 × 0.7（2026-11-02 用户裁定） |

⚠️ 文本的「按操作计费」**不在本模块计**：本模块只给单次底层调用标 token，
金额为 0。按操作收的那 50 分由提交闸门（P1）在提交时收一次。
若在这里给每次 LLM 调用标 50 分，一次拆解就是 337 元。
"""
from __future__ import annotations

import math

# ---------------------------------------------------------------- 单价常量

#: 图像：每张（分），所有生图模型同价。2026-11-21 用户裁定由 15 上调到 25。
#: 报价说明、扣费流水里的「× 0.25 元」都从这里换算，改价只改这一个常量。
IMAGE_PER_PIC = 25

#: 文本：每次用户操作（分）。**只由提交闸门使用**，见模块文档。
LLM_PER_OPERATION = 50

#: RunningHub 生成耗时单价：每小时（分）。按生成耗时，不按视频时长。
RUNNINGHUB_PER_HOUR = 600

#: 海螺 H3 的**预扣估值**：每秒输出视频（分）。生成耗时无法提前算出，
#: 先按 0.2 元/秒预扣，结束后按 taskCostTime 多退少补。
H3_PREHOLD_PER_VIDEO_SEC = 20

#: 高清放大的预扣估值：每秒素材（分）。实测锚点 2s 素材 → 139s 机时 → ¥0.232，
#: 折 0.116 元/秒，向上取到 12 分/秒。
UPSCALE_PREHOLD_PER_SRC_SEC = 12

#: TTS：每段（分）。实测 ¥0.074/段，向上取整。
TTS_PER_SEGMENT = 7

#: Seedance：每百万 token（分）。「不含视频输入」档——我们没有参考视频功能
#: （providers/video_seedance.py: supports_reference_video = False）。
#: ⚠️ 公开资料另有一套 AICC 刊例价（92/102 元每百万），上线前须用火山控制台账单复核。
SEEDANCE_PER_M_TOKEN: dict[tuple[str, str], int] = {
    ("seedance-2.0", "std"): 4600,     # 480P/720P：46 元/百万
    ("seedance-2.0", "1080p"): 5100,   # 51 元/百万
    ("seedance-2.5", "std"): 7000,     # 70 元/百万
    ("seedance-2.5", "1080p"): 7700,   # 77 元/百万
}

#: 未登记档位的 seedance 变体（如 -mini）按同代最贵档兜底：宁可多预扣，
#: 结算时差额会退；反过来少收则补不回来。
_SEEDANCE_FALLBACK = {"seedance-2.0": 5100, "seedance-2.5": 7700}


#: 万相 wan3.0：每秒输出视频（分）。**官方价 × 0.7**（2026-11-02 用户裁定「七折」）。
#: 官方价（百炼北京，2026-11-02 查 model-pricing 页）：480P 0.3 / 720P 0.6 / 1080P 1.2 元/秒，
#: 有声无声同价、失败不收费。× 0.7 → 0.21 / 0.42 / 0.84 元/秒。
#: ⚠️ 官方页面同时标着「限时 7 折」——那是阿里给我们的进货折扣，可能到期取消；
#: 这里的 0.7 是**对用户的定价**，以官方原价为基数，与阿里的限时活动无关。
WAN_OFFICIAL_FEN_PER_SEC = {"480p": 30, "720p": 60, "1080p": 120}
WAN_DISCOUNT = 0.7
WAN_FEN_PER_SEC = {k: v * WAN_DISCOUNT for k, v in WAN_OFFICIAL_FEN_PER_SEC.items()}


def _ceil_fen(x: float) -> int:
    """单笔金额向上取整到分。负数与 NaN 一律按 0 处理（用量不可能为负）。"""
    if not x or x != x or x < 0:
        return 0
    return int(math.ceil(x - 1e-9))


# ---------------------------------------------------------------- 各类计价

def _int(x) -> int:
    """容错转整数：脏值按 0（计价函数不该因为入参不规整而抛）。"""
    try:
        return max(0, int(x or 0))
    except (TypeError, ValueError):
        return 0


def image_cost(n_pics: int) -> int:
    return _int(n_pics) * IMAGE_PER_PIC


def runninghub_cost(gen_seconds: float) -> int:
    """按**生成耗时**计价（taskCostTime，单位秒）。"""
    try:
        g = float(gen_seconds or 0)
    except (TypeError, ValueError):
        g = 0.0
    return _ceil_fen(g * RUNNINGHUB_PER_HOUR / 3600)


def tts_cost(n_segments: int) -> int:
    return _int(n_segments) * TTS_PER_SEGMENT


def seedance_family(model_id: str) -> str | None:
    """seedance-2.5 / seedance-2.0 / seedance-2.0-mini → 所属代际；非 seedance 返回 None。"""
    m = (model_id or "").lower()
    if m.startswith("seedance-2.5"):
        return "seedance-2.5"
    if m.startswith("seedance-2.0") or m == "seedance-2":
        return "seedance-2.0"
    return None


def seedance_rate(model_id: str, resolution: str | None) -> int | None:
    """该模型 + 分辨率档的单价（分/百万 token）；不是 seedance 返回 None。"""
    fam = seedance_family(model_id)
    if not fam:
        return None
    tier = "1080p" if str(resolution or "").lower() in ("1080p", "2k") else "std"
    if model_id.lower() == fam:               # 正式型号按档位
        return SEEDANCE_PER_M_TOKEN[(fam, tier)]
    return _SEEDANCE_FALLBACK[fam]            # 变体（-mini 等）走同代最贵档


def seedance_cost(model_id: str, resolution: str | None, tokens: int) -> int:
    rate = seedance_rate(model_id, resolution)
    if rate is None:
        return 0
    return _ceil_fen(_int(tokens) * rate / 1_000_000)


def is_wan(model_id: str) -> bool:
    return (model_id or "").lower().startswith("wan3")


def wan_cost(resolution: str | None, seconds: float) -> int:
    """万相按输出秒数计价（分）。未知档位按 1080p 兜底（宁可多预扣，结算时退）。"""
    r = str(resolution or "").lower()
    rate = WAN_FEN_PER_SEC.get(r, WAN_FEN_PER_SEC["1080p"])
    try:
        sec = float(seconds or 0)
    except (TypeError, ValueError):
        sec = 0.0
    return _ceil_fen(max(0.0, sec) * rate)


# ---------------------------------------------------------------- Agent 脑模型

#: 超级 Agent 的**脑模型**（推理 + 工具调用）每百万 token 单价，单位「分」。
#:
#: 2026-10-20 用户裁定：`gpt-6.1-sol` 按 **2 元/百万 token** 折算积分。
#: 与表里其它文本口径的区别要看清，否则会重复收费：
#:   · `LLM_PER_OPERATION` = 0.5 元/**用户操作**，用于拆解/提示词这类
#:     "点一次按钮"的业务调用，一次拆解底层约 670 次调用也只收一次；
#:   · 本条 = 2 元/**百万 token**，只用于 **agent 自己的思考与工具调用**。
#: 两者不重叠：agent 调用 `run_breakdown` 时，业务侧仍按操作收 50 分；
#: agent 为了决定"要不要拆"而跑的那几轮推理，走本条按 token 实算。
#:
#: ⚠️ 这是**唯一**按 token 计费的文本口径。别的文本调用不要套用它。
AGENT_LLM_PER_M_TOKEN = 200      # 2 元 / 1M token


def agent_llm_cost(tokens: int | None) -> int:
    """Agent 脑模型的 token 费用（分）。不足 1 分向上取整。"""
    return _ceil_fen(_int(tokens) * AGENT_LLM_PER_M_TOKEN / 1_000_000)


#: 官方 token 公式里用到的分辨率 → 输出像素（竖屏 9:16 与横屏同像素数）
_RES_PIXELS = {"480p": 854 * 480, "720p": 1280 * 720, "1080p": 1920 * 1080,
               "2k": 2560 * 1440}


def seedance_tokens_estimate(resolution: str | None, seconds: float,
                             fps: int = 24) -> int:
    """官方公式：(输入视频时长 + 输出时长) × 宽 × 高 × 帧率 ÷ 1024。

    无视频输入，第一项为 0。用于 P1 的提交前预扣；P0 只用来核对实测。
    验算：720p / 30s / 24fps = 648,000，库里 seedance-2.5 实测最大值 648,900。
    """
    px = _RES_PIXELS.get(str(resolution or "720p").lower(), _RES_PIXELS["720p"])
    return int(math.ceil(max(0.0, seconds or 0) * px * fps / 1024))


def fen_to_yuan(fen: int) -> str:
    """显示用：分 → "12.34"。"""
    fen = int(fen or 0)
    sign = "-" if fen < 0 else ""
    fen = abs(fen)
    return f"{sign}{fen // 100}.{fen % 100:02d}"


#: 火山 AI MediaKit 画质增强（标准版）：每秒**被处理素材**（分）。
#: 用户裁定 2026-11-09：0.0125 元/秒，按被处理视频的时长算 —— 不是按机时，
#: 也不是按输出时长（两者对我们都是黑盒，材料时长是我们唯一确知的值）。
MEDIAKIT_UPSCALE_FEN_PER_SEC = 1.25


def mediakit_upscale_cost(media_seconds: float) -> int:
    """火山画质增强计价：按被处理素材秒数 × 1.25 分/秒，向上取整到分。"""
    try:
        s = float(media_seconds or 0)
    except (TypeError, ValueError):
        s = 0.0
    return _ceil_fen(max(0.0, s) * MEDIAKIT_UPSCALE_FEN_PER_SEC)


#: 火山 AI MediaKit 文本擦除（精细版）/ 删除视频片段：**占位价**。
#:
#: ⚠️ 真实单价尚未从火山控制台账单确认（2026-11-13）。这里先沿用画质增强的
#: 1.25 分/秒作为**预扣**依据 —— 预扣只是个安全垫，多退少补；漏扣才是事故。
#: 拿到真实单价后**只改这一个常量**，`mediakit_erase_cost` 与调用方都不用动。
MEDIAKIT_ERASE_FEN_PER_SEC = 1.25


def mediakit_erase_cost(media_seconds: float) -> int:
    """火山字幕擦除计价：按被处理素材秒数，向上取整到分。"""
    try:
        s = float(media_seconds or 0)
    except (TypeError, ValueError):
        s = 0.0
    return _ceil_fen(max(0.0, s) * MEDIAKIT_ERASE_FEN_PER_SEC)

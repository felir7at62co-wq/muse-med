"""音色库与语音识别通道状态。

`GET /v2/voice-library` —— 全局音色库列表（**当前常态是空**）
`GET /v2/asr/status`   —— 语音识别是否可用（前端据此启用/置灰「自动生成字幕」）

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。这两条路由都是**只读探测**，
不碰数据库、不写任何状态，与 `routes_v2` 无共享状态，整块搬走最干净。
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter

router = APIRouter(prefix="/v2", tags=["voice"])
logger = logging.getLogger(__name__)

# ---------- 音色库（角色音色的"挑选"来源）----------
#: 为什么是 manifest 文件而不是数据库表：音色库是**全局素材**（不属于任何项目），
#: 内容由运维往目录里放，不由用户在软件里增删。加一张表意味着"放文件"之外还要
#: 写一次入库，多一道会忘的手续；manifest 就在音频旁边，放文件时顺手写完。
#:
#: ⚠️ 现在这个库是**空的**——用户已明确"音色库先留空，只做前端设计，后期再补"。
#: 所以本接口的**主要形态就是返回空列表**，绝不能因为文件不存在就 500：
#: 空库是今天的正常状态，不是错误。前端据此显示"建设中，可自行上传"。
#:
#: 目录 DATA_DIR/voice-library/ 已由 main.py 的 `/media` 整体挂载自动对外，
#: 无需新增 StaticFiles mount。后期补内容 = 丢音频 + 写 manifest，不用改代码。
_VOICE_LIB_DIRNAME = "voice-library"


@router.get("/voice-library")
def voice_library() -> dict:
    """全局音色库列表（可能为空）。

    manifest.json 形如：
      [{"id": "male_warm_01", "name": "沉稳男声", "gender": "male",
        "age": "青年", "style": "沉稳", "tags": ["旁白"], "file": "male_01.wav"}]
    只有 `file` 指向的音频**确实存在**时才返回该条——manifest 写了但文件没传，
    前端点了会试听失败，不如当它不存在。
    """
    from ..media import DATA_DIR
    root = DATA_DIR / _VOICE_LIB_DIRNAME
    mf = root / "manifest.json"
    try:
        raw = json.loads(mf.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"voices": [], "count": 0}
    except Exception as e:  # noqa: BLE001 — 坏 manifest 不该让整个面板打不开
        logger.warning("音色库 manifest 解析失败(%s)，按空库处理: %r", mf, e)
        return {"voices": [], "count": 0, "error": "音色库配置有误，已按空库显示"}

    if not isinstance(raw, list):
        logger.warning("音色库 manifest 顶层不是数组，按空库处理: %s", mf)
        return {"voices": [], "count": 0, "error": "音色库配置有误，已按空库显示"}

    voices: list[dict] = []
    for i, it in enumerate(raw):
        if not isinstance(it, dict):
            continue
        fname = str(it.get("file") or "").strip()
        # 只收单层文件名：manifest 是运维手写的，"../../etc/passwd" 这种既可能是
        # 手滑也可能是恶意，一律拒绝，别让它拼进对外 URL。
        if not fname or "/" in fname or "\\" in fname or fname.startswith("."):
            continue
        if not (root / fname).is_file():
            continue
        vid = str(it.get("id") or "").strip() or f"voice_{i}"
        voices.append({
            "id": vid,
            "name": str(it.get("name") or vid),
            "gender": str(it.get("gender") or "") or None,
            "age": str(it.get("age") or "") or None,
            "style": str(it.get("style") or "") or None,
            "tags": [str(t) for t in (it.get("tags") or []) if str(t).strip()],
            "url": f"/fw/media/{_VOICE_LIB_DIRNAME}/{fname}",
        })
    return {"voices": voices, "count": len(voices)}


# ---------- TB-08 自动字幕（语音识别）----------
@router.get("/asr/status")
def asr_status() -> dict:
    """语音识别通道是否可用（前端据此启用/置灰「自动生成字幕」）。

    返回**具体走的哪一条**（`pick_asr_provider` 的顺序：火山极速版、百炼 Paraformer、旧 whisper）。
    只回一个布尔值时，用户看到"字幕生成失败"根本不知道是没配 key、
    还是配了但渠道挂了 —— 而那正是此前自动字幕长期不可用的真实体验。
    `volc_config_error`：配了 `FW_DRAMA_ASR_CONFIG` 却读不了时的原因（只有错误类型），否则为 null。
    """
    from ..providers.asr import ASRProvider, pick_asr_provider
    from ..providers.asr_volc import VolcFlashASR

    provider = pick_asr_provider()
    volc = VolcFlashASR()
    return {
        "available": provider is not None,
        "provider": getattr(provider, "name", None),
        "volc_configured": volc.available,
        "volc_config_error": volc.config_error,
        "bailian_configured": bool(
            getattr(__import__("app.config", fromlist=["get_settings"])
                    .get_settings(), "bailian_api_key", "")),
        "whisper_configured": ASRProvider().available,
    }

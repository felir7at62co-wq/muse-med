"""/v2 编排 API。MVP：项目管理 + 剧本优化/拆解（走 LLM Provider，文本通道可实测）。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import logging
import uuid
from typing import NamedTuple, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, Response
from pydantic import BaseModel, Field
from sqlalchemy import case, func

from .providers.registry import registry
from .providers.llm import LLMProvider
from .providers.image import ImageProvider
from .db import (Asset, AssetStage, Job, Project, Shot, ShotVersion, desc_of,
                 effective_characters, get_session, profile_of,
                 reset_clip_window)
from .script_import import smart_split_chapters
from .fastjson import json_bytes, json_bytes_cached   # 3.12（F8）：大响应用 UTF-8 直出，不做 \uXXXX 转义
from . import drama_timing
from . import project_purge                # 项目彻底删除：独占文件计算 + 清盘
from . import stale as stale_mod          # 过期原因与消解规则（单一真源）
from . import prompt_health as _ph        # 「提示词是不是剧本原文」（单一真源）
from . import style_preset as _sp         # 生产模式 × 画风预设（单一真源）
from . import asset_gate                  # 被用户删除的资产（墓碑）闸门
from . import stage_gate                  # 被用户删除的造型阶段（墓碑）闸门
from . import agent_proxy                 # AI 指令条：提示词契约 + 模型侧唯一出口
from . import access                      # 多用户隔离：项目/资产归属校验（2026-10-09）
from .agent_proxy import (                # 契约版本与限额常量（/agent/protocol 直读）
    AGENT_CONTRACT_VERSION, agent_max_commands, agent_max_input_chars,
)
from .continuity import refresh_present_characters
# 跨域共享的时长/锚点地基（原先定义在本文件里，任务层被迫局部 import 绕循环）。
# 从共享层导入并**再导出**：本文件与别处对这批名字的引用一处都不用改。
from .shot_timing import (  # noqa: F401
    RESOLUTION_TIERS, _DUR_WINDOW_DEFAULT, _SHOT_DUR_CEIL_FALLBACK, _DurWindow,
    _RECUT_MIN_FALLBACK, _clamp_anchor, _narration_duration, _remap_anchors,
    _renumber, breakdown_shot_cap,
    narration_max_chars, shot_duration_ceiling, shot_seconds_cap,
)
# 子模块的**公共符号**在这里再导出：routes_v2 是这批名字的历史入口，
# 验收脚本（verify_narration_sections.py 等）按 `R.SubtitleClipIn` 这样引用。
# 迁移期间保留再导出，避免一次性改动一堆脚本；等调用方都改到新模块后可删。
# 提交锁与终态 guard：跨域共享，下沉到 job_submit.py（子模块之间不该互相
# import 路由文件，否则依赖图成环）。这里导入后再导出，保持原有引用可用。
from .job_models import JobOut, JobSubmitIn  # noqa: F401
from .job_submit import _SUBMIT_LOCK, _run_job_guarded
from . import charge  # noqa: F401
from .project_defaults import (  # noqa: F401
    BASE_ASPECTS, PRODUCTION_MODES, _LEGACY_DEFAULTS,
)
from .routers.project import (  # noqa: F401
    EpisodeContentIn, EpisodeOut, ProjectCreate, ProjectOut, ProjectPatch,
    ScriptImportIn, create_project, delete_project, episodes_content,
    get_project, list_projects, purge_preview, rename_project, restore_project,
    script_import, script_import_file, update_episode_content,
)
from .routers.look import (  # noqa: F401
    AssetQcIn, ProjectLookIn, ProjectStyleIn, SceneViewsGenerateIn,
    build_scene_board, clear_scene_view, generate_scene_views,
    get_project_art_style, get_project_look, get_scene_views, put_project_art_style,
    put_project_look, qc_asset, regenerate_project_look,
)
from .routers.shots import (  # noqa: F401
    AdoptIn, BreakdownOut, FirstFrameIn, RefOverridesIn, ShotBreakdownIn,
    ShotDraft, ShotOverrideIn, ShotPromptIn, ShotRecutIn, ShotSplitIn,
    ShotTimelineIn, ShotUndoRecutIn, ShotUnsplitIn, SpecialShotIn,
    _clamp_duration, _dur_window, _loc_place_part, _loc_related,
    _loc_time_class, _loc_tokens, _merge_fragment_shots, _merge_short_shots,
    _parse_breakdown_json, _raw_duration, _split_overlong_drama_shots,
    _split_overlong_shots, add_special_shot, adopt_shot_version,
    backfill_thumbs, delete_shot, do_breakdown, patch_ref_overrides,
    transform_rev,
    patch_shot_breakdown, patch_shot_prompt, patch_shot_timeline, recut_shot,
    regen_first_frame, reset_shot_prompt, script_breakdown, set_shot_override,
    shot_versions, split_shot, undo_recut, unsplit_shot,
)
from .routers.stage_scene import (  # noqa: F401
    CharAliasIn, CharAliasPatchIn, SceneAliasIn, SceneApplyIn, SceneCanonIn,
    SceneDescIn, SceneGroupIn, ScenePreviewIn, StageCandidatesIn,
    StageConfirmAllIn, StageDraftIn, StageMergeIn, StageOut, StagePatchIn,
    _clip_ep_ranges, _is_placeholder_stage, apply_project_scene_groups,
    canonicalize_project_characters, canonicalize_project_scenes,
    confirm_all_stages, costume_report, delete_stage, describe_project_scenes,
    list_character_aliases, list_scenes, list_stages, merge_stages,
    patch_character_alias, patch_scene_alias, patch_stage,
    preview_project_scenes, project_readiness, restore_stage, run_stages_draft,
    stage_candidates, stages_draft,
)
from .routers.assets import (  # noqa: F401
    AssetCreateIn, AssetGenerateIn, AssetGenerateOut, AssetImageUpsertIn,
    AssetPatchIn, AssetProfileIn, DescribeImageIn, assets_generate,
    create_asset, delete_asset, describe_image, get_asset_profile,
    latest_asset_candidates, patch_asset, put_asset_profile,
    regenerate_asset_profile, restore_asset, upsert_asset_image,
)
from .routers.audio import (  # noqa: F401
    AudioClipIn, AudioClipPatch, AudioTagIn, DetachAudioIn, GenNarrationIn,
    NarrationVoiceIn, audio_library, create_audio_clip, delete_audio_clip,
    detach_shot_audio, generate_narration, list_audio_clips, patch_audio_clip,
    set_audio_tag, set_narration_voice,
)
from .routers.subtitle import (  # noqa: F401
    SubtitleBulkIn, SubtitleClipIn, SubtitleClipPatch, SubtitleStyleIn,
    bulk_create_subtitle_clips, delete_subtitle_clip, export_subtitles_srt,
    get_project_subtitle_style, list_spoken_lines, list_subtitle_clips,
    patch_subtitle_clip, set_project_subtitle_style,
)

router = APIRouter(prefix="/v2", tags=["v2"])
logger = logging.getLogger(__name__)


# 生产模式 → 默认视频模型（契约 C3；前端拉取，不硬编码）。
# defaults 供前端"点预设→定位全部选项"联动；用户改任一项则前端归入 custom。
PRODUCTION_MODES: dict[str, dict] = {
    # 2026-08 重构：生产模式从「技术参数预设」退化为「配音策略」。
    # 视频模型/分辨率/生成方式改为在创建项目时独立选择（存入 default_profile）；
    # production_mode 只决定 TTS 配音的分配策略。
    #
    # drama（真人剧）：人物台词 → 人物配音，旁白 → 旁白配音。
    #   与以前的所有逻辑相同，仅标签变化。
    #   旧值 fast/consistent/premium/first_frame/custom 在迁移时全部映射到 drama。
    "drama":     {"label": "🎭 真人剧"},
    # narration（解说剧）：整段剧本（含对白）→ 旁白 TTS 流水，画面静音。
    #   剧本文字按句子边界切分到各镜头，TTS 合成后镜头时长跟旁白实际时长走。
    "narration": {"label": "📖 解说剧"},
    # anime（动漫剧，2026-09-09 新增）：配音策略**与真人剧完全相同**（用户决策
    #   「按真人剧那套（音画一体）」），区别只在画风——它选的是 style_preset 里
    #   的动漫三档。所以它在这张表里没有任何独有的技术参数。
    #   ⚠️ 动漫三档目前全部未启用，`list_production_modes` 会把这个模式标成
    #   enabled=false，前端列出但点不动。
    "anime":     {"label": "🎨 动漫剧"},
    # narration_dlg（解说剧·角色开口，2026-10-30 新增）：旁白统一 TTS 推进情节，
    #   角色由视频模型**当场开口**说原文台词。整条流水线独立（app/nd/），
    #   与上面三个模式互不串门——任务入口有闸门（nd/guard.py）。
    "narration_dlg": {"label": "🎙 解说剧·角色开口"},
}

# 旧预设的技术参数，供迁移期间兜底读取（新项目不走这里）
_LEGACY_DEFAULTS: dict[str, dict] = {
    "fast":        {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                    "generation_mode": "full_reference", "resolution": "720p"},
    "consistent":  {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                    "generation_mode": "full_reference", "resolution": "1080p"},
    "premium":     {"video_model": "seedance-2.0",     "image_model": "gpt-image-2",
                    "generation_mode": "full_reference", "resolution": "1080p"},
    # 「首帧精控」旧预设：首帧路线 2026-11-20 下线，按全能参考读（视频 / 生图模型不变）。
    "first_frame": {"video_model": "seedance-2.0",     "image_model": "nano-banana-pro",
                    "generation_mode": "full_reference", "resolution": "1080p"},
    "custom":      {},
}


@router.get("/production-modes")
def list_production_modes() -> dict:
    """生产模式 + 每个模式下的**画风**清单（前端不硬编码任何一项）。

    模式的 label 在本文件（`PRODUCTION_MODES`），画风与可用性在
    `style_preset`（唯一事实来源）。这里把两边合起来下发：
    `modes[k].styles` / `modes[k].enabled` / `modes[k].default_style`。

    `enabled=false` 的模式与画风前端要**列出但禁用 + 挂「待完善」徽章**
    （用户决策）——看得见规划、建不出画风必然回退的项目。
    """
    cat = {m["key"]: m for m in _sp.catalog()["modes"]}
    modes: dict[str, dict] = {}
    for key, info in PRODUCTION_MODES.items():
        m = cat.get(key)
        modes[key] = {
            **info,
            # 模式不在 style_preset 表里（不该发生）→ 保守放行，不因为画风表
            # 漏登记就把一个本来能用的模式锁死。
            "enabled": m["enabled"] if m else True,
            "default_style": m["default"] if m else None,
            "styles": m["styles"] if m else [],
        }
    return {"modes": modes, "aspects": BASE_ASPECTS,
            "resolutions": list(RESOLUTION_TIERS.keys())}


# ---------- 生成路线（能力查询）----------
@router.get("/providers/image")
def list_image_providers() -> dict:
    """用户可选图像模型（渠道链后端内部维护，不暴露）。"""
    from .providers.image import IMAGE_MODELS
    return {"models": IMAGE_MODELS}


@router.get("/providers/video")
def list_video_providers() -> dict:
    """列出已注册的视频 Provider 及其能力档位与各生成模式可用性。"""
    from .providers.base import GENERATION_MODES, live_mode_support
    providers = []
    for info in registry.list_video():
        p = registry.get_video(info["model_id"])
        # 已下线的三种帧模式不下发：有的通道的能力表里还列着它们。
        info["modes"] = live_mode_support(p.mode_support()) if p else {}
        providers.append(info)
    return {"providers": providers, "generation_modes": GENERATION_MODES}


@router.get("/providers/video/lowcost/health")
def lowcost_health() -> dict:
    """「低价seedance2.5」三条渠道的可用性快照。

    ⚠️ 只回**布尔与 base_url**，绝不回 key（哪怕前缀）——与
    `/system/providers-health` 同一条纪律：密钥进前端就可能被截图/日志带走，
    用户只需要知道"哪条还活着、在不在冷却"，改 key 得改服务端环境变量。

    `healthy=false` 是**运行时**状态（最近一次失败被判为渠道级故障、正在冷却），
    `configured=false` 是**配置**状态（key 没配）。两者都不代表永久失效：
    configured 靠改 .env，healthy 会随冷却到期自动恢复。
    """
    from .providers.video_lowcost import LOWCOST_MODEL_ID
    p = registry.get_video(LOWCOST_MODEL_ID)
    if p is None:
        return {"registered": False, "model_id": LOWCOST_MODEL_ID, "channels": [],
                "hint": "三条渠道都没配 key（或渠道清单为空），该模型未注册"}
    return {"registered": True, "model_id": LOWCOST_MODEL_ID,
            "channels": p.channel_report()}


@router.get("/system/providers-health")
def providers_health() -> dict:
    """各外部通道的**配置健康度**（设置页高级区展示）。

    ⚠️ 只回布尔与 base_url，**绝不回任何 key**（哪怕前缀）——
    密钥一旦进了前端就可能被截图/日志泄露。用户只需要知道"配没配"，
    不需要看到值。要改 key 得改服务端环境变量，这是刻意的设计。
    """
    from .config import get_settings
    from .providers.asr import ASRProvider
    from .providers.tts import TTSProvider
    s = get_settings()
    return {
        "channels": [
            {"key": "gateway", "label": "文本/视频网关",
             "base_url": s.gateway_base_url, "configured": bool(s.gateway_api_key)},
            {"key": "image", "label": "图像通道",
             "base_url": s.gateway_base_url,
             "configured": bool(s.image_api_key or s.gateway_api_key)},
            {"key": "ark", "label": "火山方舟（Seedance）",
             "base_url": s.ark_base_url, "configured": bool(s.ark_api_key)},
            {"key": "runninghub", "label": "RunningHub（海螺/TTS）",
             "base_url": s.runninghub_base_url, "configured": bool(s.runninghub_api_key)},
            # kege：2026-10-10 起替换 api4me，文本与图像的第二顺位
            {"key": "kege", "label": "kege（文本/图像兜底）",
             "base_url": s.kege_base_url,
             "configured": bool(s.kege_base_url and (
                 s.kege_gemini_api_key or s.kege_gpt_api_key
                 or s.kege_claude_api_key or s.kege_grok_api_key))},
            # api4me：已停用（403 额度不足），仅 ASR 仍在用，故保留展示便于判断
            # 语音识别为何不可用 —— 它的 available 本来就是靠这两把 key 判定的。
            {"key": "api4me", "label": "api4me（仅语音识别，已欠费）",
             "base_url": s.api4me_base_url, "configured": bool(s.api4me_api_key)},
        ],
        "features": {
            "tts": TTSProvider().available,
            "asr": ASRProvider().available,
        },
        "note": "密钥由服务端环境变量管理，前端不展示也不可修改",
    }


# ---------- 项目 ----------
#: 画幅基准可选项（新建向导展示；生成与导出默认继承）
BASE_ASPECTS = ["9:16", "16:9", "3:4", "4:3", "1:1", "21:9"]


# ---------- 提示词优化框架状态（T-R0-03，契约 C2）—— 已下线 ----------
@router.get("/prompt-opt/status")
def prompt_opt_status() -> dict:
    """原先报告镜流自带提示词引擎（框架就绪状态 + 出品规则口径）。

    2026-11-19 起镜头脚本由 Muse 撰写，那套引擎（`prompt_opt` 的 service /
    house_rules / skill_assets）已删除，没有口径可报 → 410。
    """
    from .jobs import SHOT_SCRIPT_BY_MUSE
    raise HTTPException(status_code=410,
                        detail=SHOT_SCRIPT_BY_MUSE + "，提示词引擎状态接口已下线")


def _res_in_detail(proj) -> dict:
    """项目分辨率档位 + 该项目模型下的**实际**结果（供 /detail 下发）。

    与 `routers/project._resolution_report` 同一口径，但**不查库**（proj 已在手里），
    且刻意不重复算时长上限（`shot_duration_max` 本就在 detail 里单独给）。

    ⚠️ 为什么 detail 要带它而不是让前端再打一个接口：出片面板上的
    「跟随项目（xxx）」是**每次选镜都要显示**的信息，多一个往返就是每次点镜头
    都多一次请求；而且它与 `shot_duration_max` 同源（都随档位变），
    分两处取只会让两者在不同时刻不一致。
    """
    from .jobs import _resolve_project_resolution, _resolve_project_video_model
    from .providers.registry import registry
    from .shot_timing import RESOLUTION_TIERS

    chosen = _resolve_project_resolution(proj)
    model_id = _resolve_project_video_model(proj) or ""
    prov = registry.get_video(model_id) if model_id else None
    mp = RESOLUTION_TIERS.get((chosen or "").lower())
    effective = prov.resolution_for(mp) if (prov is not None and mp) else None
    return {
        "resolution": chosen,
        "effective": effective,
        "supported": getattr(prov, "supported_resolutions", None) if prov else None,
        #: 选了但实际不按它出（seedance 的 2k / 低价渠道的一切非 720p）
        "pending": bool(chosen) and effective is not None
                   and effective != chosen.lower(),
        "model_id": model_id,
        "tiers": list(RESOLUTION_TIERS.keys()),
    }


def _eff_locs(shot, loc_canon: dict[str, str]) -> list[str]:
    """本镜**实际注入**的场景集合（归一名，保序）。纯计算，不查库。

    `scenes.canonical_locations()` 的批量版：那条路径每镜都要查一次别名表
    （1424 镜就是一千多次查询，B29 同款），这里复用已经取全的 `loc_canon`。
    归一规则与它**逐字一致**：先查别名表，查不到退回 `normalize_location`。
    两处必须同源，所以这里 import 的是同一个 `normalize_location`。

    ⚠️ 与 `location_canonical` 的区别（这是本函数存在的全部理由）：
    `location_canonical` 只归一了 `Shot.location` 一个值，**不认 `ref_overrides`**。
    用户在场景轨上「加一个场景 / 减一个场景」改的是 `add_loc` / `remove_loc`，
    出片按改后的集合注入，而前端此前只读 `location_canonical` —— dev 实测 3 镜
    界面显示的场景与出片用的场景不是同一个，编号随之整体错位。
    """
    from .scenes import normalize_location

    def _canon(x: str) -> str:
        key = (x or "").strip()
        if not key:
            return ""
        return loc_canon.get(key) or normalize_location(key)[0] or key

    try:
        ov = json.loads(shot.ref_overrides) if shot.ref_overrides else {}
    except (ValueError, TypeError):
        ov = {}
    if not isinstance(ov, dict):
        ov = {}

    def _names(key: str) -> list[str]:
        return [x for x in ov.get(key, []) if isinstance(x, str) and x]

    remove = {c for c in (_canon(x) for x in _names("remove_loc")) if c}
    l1 = [shot.location] if getattr(shot, "location", None) else []
    out: list[str] = []
    for raw in l1 + _names("add_loc"):
        cn = _canon(raw)
        if cn and cn not in remove and cn not in out:
            out.append(cn)
    return out


def _refs_hidden_of(shot, project_id: str, hide_index) -> list[dict]:
    """本镜被「不带」剔掉的实体清单，带**该删哪个网址**。

    返回 `[{"kind": "角色", "name": "李晚宁", "hide_url": "/fw/media/..."}]`。

    ## 为什么不能只给实体名

    前端的「恢复」要把那条剔除记录从 `profile_override.refs_hide` 里删掉，
    而它手上只有**面板当前显示的那张图**（造型图），`refs_hide` 里存的却是
    用户当初点的那张（通用图）。按面板网址去删是个空操作 —— 用户点一百次
    也不会恢复，而且没有任何报错。所以 `hide_url` 必须由后端给出：
    它就是 `refs_hide` 里那条真正需要删除的网目。

    同一个实体可能对应多条网址（用户在不同时间对不同的图各点过一次
    「不带」），全部下发；前端恢复时一次清干净，避免"恢复了还是不带"。
    """
    try:
        raw = [u for u in ((json.loads(shot.profile_override or "{}") or {})
                           .get("refs_hide") or [])
               if isinstance(u, str) and u.strip()]
    except (ValueError, TypeError, AttributeError):
        return []
    if not raw:
        return []
    # 实体 → 该实体在本镜被剔掉的网址（保序、去重）
    ent: dict[tuple[str, str], list[str]] = {}
    for u in raw:
        for key in hide_index.get((project_id, u), ()):
            lst = ent.setdefault(key, [])
            if u not in lst:
                lst.append(u)
    return [{"kind": k, "name": n, "hide_url": urls[0],
             #: 该实体在本镜被剔的**全部**网址。前端恢复时全删，
             #: 只删第一条会留下残余，用户会看到"恢复了还是不带"。
             "hide_urls": urls}
            for (k, n), urls in sorted(ent.items())]


@router.get("/projects/{project_id}/detail")
def project_detail(project_id: str, request: Request) -> Response:
    """项目详情：分集 + 镜头(含状态/版本) + 资产。

    ⚠️ 3.12（F8）：**不再包含剧本全文**（`raw_script` / `optimized_script`），
    只给一个 `has_script` 布尔。剧本正文走 `/projects/{id}/episodes/content`。
    理由见下面 `has_script` 那段注释。

    ⚠️ 返回的是 `json_bytes(...)` 而不是普通 dict：FastAPI 默认的 JSONResponse
    会把中文转义成 `\\uXXXX`，本项目这一份（1424 镜）实测 2197 KiB → UTF-8
    直出后 1634 KiB。详见 `fastjson.py`。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        # 无框架的视频模型本来就直通原文，别把"提示词==原文"报成优化失败
        _legacy_raw = _ph.project_has_framework(proj)
        shots = session.query(Shot).filter(Shot.project_id == project_id).order_by(Shot.order).all()
        assets = session.query(Asset).filter(Asset.project_id == project_id).all()
        # 每镜有几个历史版本（3.11 R1「版本角标」用）。一次 GROUP BY 取全，
        # 别在下面的列表推导里逐镜查 —— 那是 1424 次查询（同 B29 的教训）。
        # 只有 >1 才有意义：1 版 = 从没重新生成过，角标不该出现。
        ver_counts: dict[str, int] = {}
        #: 每镜"当前采用的那一版是不是高清出来的"（2026-10-15）。
        #: 高清放大（upscale_jobs._install）落的版本行 model_id = "upscale"，
        #: 且它会把 adopted_version 指过去 —— 所以**判它不用加任何新列或新标记**：
        #: 重新生成（jobs.py 的 _save_shot_version）与切回旧版（shots.py 的 adopt）
        #: 都会把指针推走，标记自动消失，一个写入点都不用同步维护。
        #: 若改成在 Shot 上加一列，五处写 video_url 的地方就都得记得清它，
        #: 漏一处就是"界面标着高清、画面其实是新生成的"这种静默错配。
        hd_versions: dict[str, str] = {}
        #: 该镜**有没有擦过字幕**（任意一版是 desub）。与 `hd` 不同，它看的是历史：
        #: 擦完再高清、或擦完又重新生成，那几版里的画面已经是干净的，
        #: 角标不该因此消失（2026-10-19 用户反馈）。前端用它显示「已去字幕」。
        desub_done: set[str] = set()
        if shots:
            from sqlalchemy import func as _func
            for sid, n in (session.query(ShotVersion.shot_id, _func.count(ShotVersion.id))
                           .filter(ShotVersion.shot_id.in_([s.id for s in shots]))
                           .group_by(ShotVersion.shot_id).all()):
                ver_counts[sid] = int(n)
            for sid in (session.query(ShotVersion.shot_id)
                        .filter(ShotVersion.shot_id.in_([s.id for s in shots]),
                                ShotVersion.model_id == "desub")
                        .distinct().all()):
                desub_done.add(sid[0])
            # 只取被采用的那一版：在 SQL 里 join 回 shots 会比在 Python 里
            # 按 adopted_version 反查省一遍内存，且不必把所有版本行拉回来。
            for sid, vno, mid in (
                    session.query(ShotVersion.shot_id, ShotVersion.version_no,
                                  ShotVersion.model_id)
                    .join(Shot, Shot.id == ShotVersion.shot_id)
                    .filter(ShotVersion.shot_id.in_([s.id for s in shots]),
                            ShotVersion.version_no == Shot.adopted_version).all()):
                hd_versions[sid] = mid or ""
        # 一次取全场景归一表：下面每镜要报 location_canonical，逐镜查库
        # 就是 N 次查询（1424 镜的项目见 B29）。
        from .scenes import canonical_map
        loc_canon = canonical_map(session, project_id, shots=shots)
        # 「这个资产被哪些集用到」（2026-10-21 用户需求：要素页要能按集筛选）。
        #
        # ⚠️ 判据必须与**出片注入**同源，否则筛出来的就是"库存里有什么"而不是
        # "哪些集会用到它"——用户按第 3 集筛出来的角色，出片时那一集根本没注入，
        # 比不给筛选更糟。所以三类的集合分别取自与会话同款：
        #   · 角色 → `db.effective_characters`（L1 ∪ L1.5 ∪ 人工add − 人工remove）
        #   · 场景 → `_eff_locs`（(L1 ∪ add_loc) − remove_loc 的**归一名**，
        #            场景资产就按归一名存）
        #   · 道具 → `Shot.props`
        # 一次遍历算完三张表，不做"每个资产查一遍库"（147 个项目、13k 镜的库
        # 那样就是几十万次查询）。
        #
        # 同一名字有多行资产（合并留下的墓碑）时共用这一组集：集数是**镜头维度**
        # 的事实，与被写了几行无关。
        _eps_of: dict[tuple[str, str], set[int]] = {}
        def _mark(kind: str, name: str, ep) -> None:
            nm = (name or "").strip()
            if not nm:
                return
            _eps_of.setdefault((kind, nm), set()).add(int(ep or 1))
        for _sh in shots:
            _ep = _sh.episode
            for _c in effective_characters(_sh):
                _mark("character", _c, _ep)
            for _l in _eff_locs(_sh, loc_canon):
                _mark("location", _l, _ep)
            try:
                _pl = json.loads(_sh.props or "[]")
            except (ValueError, TypeError):
                _pl = []
            for _p in _pl if isinstance(_pl, list) else []:
                if isinstance(_p, str):
                    _mark("prop", _p, _ep)
        # `refs_hide` 网址 → 实体键，**项目级一次查库**（2026-10-28）。
        #
        # ## 为什么这份数据必须由后端下发
        #
        # 用户点「不带」时，前端记的是**面板上那张图**的网址，后端却按**实体**剔
        # （见 jobs._refs_hide_of：界面显示通用图、注入的是造型图，两者网址不同）。
        # 于是同一个 `refs_hide` 在两边被读出**相反的结论**：
        #   · 前端拿面板当前的图（造型图）去比 → 不相等 → 判定"会带上"，
        #     正常列出「图3 李晚宁」，连「恢复」按钮都不给；
        #   · 后端反查成实体 → 整条剔掉。
        # 用户看到界面说会带、成片里没有她，而**没有任何地方能告诉他为什么**
        # —— 生产实例：项目 445e484b065f 第 44 集四镜，李晚宁被点名 15 次，
        # 提示词里 0 处 @图片N（图被剔了，模型只能照着文字现编一张脸）。
        #
        # 判据只能有一份，所以这里把后端算出的**实体键**直接下发，前端照抄渲染，
        # 不再自己比对网址。代价实测（343 镜、26 镜有 hide）33 ms；
        # 对照"下发完整注入清单"是 1.25 s（37 倍），且逐镜 × 每天 3000+ 次
        # 详情请求会挤满 anyio 的 40 线程池（GIL 下加线程反而更慢，实测 0.56x）。
        from .jobs import build_hide_index
        hide_index = build_hide_index(session, project_id)

        # 2026-10-19：改走 ETag 协商。详情今日被请求 3,137 次、下发 4.0 GB，
        # 而前端每次离散编辑（裁剪/移轨/分割）都要重下一份 1.3 MB —— 其中大量
        # 请求的内容与上次**完全相同**。内容哈希做 ETag，没变就回 304 空体。
        return json_bytes_cached({
            "id": proj.id, "title": proj.title,
            "base_aspect": proj.base_aspect,
            "production_mode": proj.production_mode,
            #: 画风：`art_style` 是用户选的（可能是尚未启用的档），
            #: `effective_style` 是**实际生成时用的**。两者不同 = 那档还没放开，
            #: 本项目正按都市档出图，前端要把这句话摊开告诉用户。
            "art_style": proj.art_style,
            "effective_style": _sp.resolve(proj.production_mode, proj.art_style).key,
            #: 单镜时长上限（秒）：时间轴拖拽/时长输入框据此钳制。
            #: 必须由服务端下发——前端自己维护一张"模型→上限"表必然与
            #: providers 漂移，seedance-2.5 的 30s 就会被前端按 15 砍掉。
            "shot_duration_max": shot_duration_ceiling(proj),
            #: 项目当前的分辨率档位与实际结果（2026-10-19）。
            #:
            #: 出片面板上要显示"跟随项目（1080p）"，所以项目这一层必须在打开
            #: 项目时就有，不能让前端再打一次 `/projects/{id}/resolution`。
            #: `effective` 与本项目选定模型有关：seedance 没有 2k、低价渠道恒
            #: 720p —— 用户选了 1080p 出来是 720p 时，面板得当场说出来，
            #: 而不是等出片后去猜"为什么不够清晰"。
            #: 拿不到模型（未配置）时 `effective` 为 None，前端按"未知"处理。
            "resolution": _res_in_detail(proj),
            "narration_voice_url": proj.narration_voice_url,
            #: **我对这个项目是什么档**（owner / manager / editor / viewer）。
            #:
            #: ⚠️ 必须放在**这里**，不能只放在 `GET /projects/{id}` 上。
            #: 前端打开项目走的是本端点（`openProject` → `api.projects.detail`），
            #: 读的是 `d.my_role`。2026-10-16 协作上线时它只加在了
            #: `GET /projects/{id}`（那是"项目元信息"端点，前端只拿它取
            #: default_profile），于是这里的 `d.my_role` 恒为 undefined，
            #: 前端落入 `|| 'viewer'` 的兜底 —— **所有人打开所有项目都成了查看者**，
            #: 包括管理员、包括自己建的项目。修法就是补在这里。
            "my_role": access.project_role(session, project_id),
            "episodes": json.loads(proj.episodes) if proj.episodes else [],
            # ⚠️ 3.12（F8）：这里**不再下发** `raw_script` / `optimized_script` 全文。
            #
            # 全文只在制作流程的前期（剧本页 / 重拆）用得上，日常编辑时间轴时它
            # 是纯粹的负重 —— 实测最大的项目里 `raw_script` 一项就是 223 KiB，
            # 而**每一次离散编辑**（裁剪、移轨、分割）改前都要重下整份详情。
            # 剧本页要正文走 `GET /projects/{id}/episodes/content`（按集切好，
            # 只有当前那一集在屏幕上），不必让每个时间轴操作都拖着一整部剧本。
            #
            # `has_script` 是给「脚本」入口用的：页面只想知道**有没有**剧本，
            # 据此决定按钮可不可点、空态怎么说。字段换了名字而不是保留一个
            # 恒为 null 的 `raw_script`，是为了让老前端在类型上立刻发现改动，
            # 而不是拿到 null 后静默渲染成"这个项目没有剧本"。
            "has_script": bool((proj.raw_script or "").strip()
                               or (proj.optimized_script or "").strip()),
            "period_offsets": json.loads(proj.period_offsets) if proj.period_offsets else [],
            "shots": [
                {"id": s.id, "order": s.order, "episode": s.episode,
                 "script_ref": s.script_ref, "link_to_prev": s.link_to_prev,
                 "characters": json.loads(s.characters), "location": s.location,
                 #: 本镜**实际会注入**的角色集合（2026-10-18）。
                 #:
                 #: ⚠️ 必须与 `characters` 分开下发，不能只给一个：
                 #:   · `characters`  = L1 拆解真值 —— 剧本写了谁，也是编辑器里
                 #:                     「本镜出场角色」那一栏的编辑对象，不能动；
                 #:   · `effective_characters` = (L1 ∪ L1.5 在场推导 ∪ 人工add)
                 #:                     − 人工remove —— **后端注入的真实顺序**。
                 #:
                 #: 前端 `resolveRefs` 此前拿 `characters` 去算 `@图片N` 的编号，
                 #: 而后端按 effective 编号。3.9 加了 L1.5 在场推导之后两者经常
                 #: 不同，于是界面上标「图2」的人，实际是另一个人 —— 用户反馈的
                 #: 「明明引用女1，视频里出现的是女二的脸」。生产实测 2055 镜
                 #: 处在这种状态。
                 #:
                 #: 顺序直接决定编号，所以这里原样下发后端用的那个列表，
                 #: **前端不要再自己算一遍**（两套算法必然漂移，这正是本次根因）。
                 "effective_characters": effective_characters(s),
                 #: 本镜的道具名（2026-10-08）。与 characters 同款 JSON 数组列。
                 #: ⚠️ 前端 resolveRefs 用它算 @图片N 的编号，而那个编号必须与
                 #: 后端注入顺序（角色 → 场景 → 道具）一致 —— 不下发这一列，
                 #: 前端就数不出道具那几位，提示词里的 @编号 会整体错位。
                 #: 老库这列是 NULL（迁移不回填），`or "[]"` 兜住。
                 "props": json.loads(s.props or "[]"),
                 #: 本镜场景的**归一名**（`scenes.canonical_of`）。
                 #: `location` 是拆解写下的原名，同一个房间各集写法不同
                 #: （「夜 内 楚家公馆-客厅」/「楚家公馆-客厅」）；而场景资产、
                 #: 场景轨、造型的 scene 绑定一律用归一名。前端拿原名去比资产名
                 #: 会全部落空（资产弹窗的"出场集数"就会显示为空），所以这里
                 #: 直接把归一名一起给出去——单一真源在后端，前端不要自己清洗。
                 "location_canonical": loc_canon.get((s.location or "").strip(), ""),
                 #: 本镜**实际注入**的场景集合（归一名，保序）——2026-10-18。
                 #:
                 #: ⚠️ `location_canonical` 只是「拆解写的那个场景」，注入用的是
                 #: `scenes.canonical_locations()` = (L1 ∪ 人工 add_loc) − 人工
                 #: remove_loc，再统一归一。两者在用户调过场景轨之后就不一样了：
                 #: dev 实测 3 镜的 `ref_overrides` 里 remove 了原场景、add 了另一个，
                 #: 后端按 add 的那个注入，而前端只认 `location_canonical`，
                 #: 于是界面显示一个场景、出片用的是另一个（编号一起错位）。
                 #:
                 #: 顺序就是注入顺序，**前端不要再自己算**：`ref_overrides` 里的
                 #: 增删、以及原名→归一的匹配规则（空格/别名表）都在后端，
                 #: 前端复刻一遍必然漂移——这正是本次复检发现的 600 镜不一致之一。
                 "effective_locations": _eff_locs(s, loc_canon),
                 #: 本镜**被「不带」剔掉的实体**（2026-10-28）。
                 #: 形如 `[{"kind":"角色","name":"李晚宁","hide_url":"/fw/...png"}]`。
                 #:
                 #: 这是「所见即所得」的唯一依据：前端 `resolveRefs` 拿它判隐藏，
                 #: **不再自己拿网址去比 `refs_hide`**。两套判据必然读出相反结论
                 #: —— 前端比的是面板当前显示的图（造型图），后端反查的是用户当时
                 #: 点的那张（通用图），网址不同，于是界面说"会带上"、实际一条都
                 #: 不注入，而且连「恢复」按钮都不给。
                 #:
                 #: ⚠️ `hide_url` 必须一起下发，不能只给实体名。前端的「恢复」
                 #: 要把剔除记录从 `refs_hide` 里删掉，而它手上只有**面板显示的那张
                 #: 图**（造型图 e45e...），`refs_hide` 里存的却是通用图 8085...
                 #: —— 按面板网址去删是个空操作，用户点一百次也不会恢复。
                 #:
                 #: 只下发**反查得到实体**的那些。反查不到的外链（用户 @ 的站外图）
                 #: 仍按网址精确剔，前端继续用 `profile_override.refs_hide` 处理即可。
                 #: 空数组 = 本镜没有任何按实体生效的剔除。老后端不下发此字段时，
                 #: 前端回落到旧逻辑（拿网址比），行为与改动前一致。
                 "refs_hidden": _refs_hidden_of(s, project_id, hide_index),
                 "video_url": s.video_url, "thumb_url": s.thumb_url,
                 "status": s.status,
                 #: 失败原因与分类：UI 据此区分「重试有用」（channel）与
                 #: 「重试必然再失败」（moderation，要改提示词/换模型）
                 "fail_reason": s.fail_reason, "fail_kind": s.fail_kind,
                 "adopted_version": s.adopted_version, "is_special": bool(s.is_special),
                 #: 3.11 R1：该镜的**历史版本总数**（含当前）。1 = 从没重新生成过。
                 #: 时间轴片段上的 `V3 · 3版` 角标读它 —— 版本列表原来埋在
                 #: Inspector 里，而"重新生成"的主路径（右键→重新生成）根本不
                 #: 经过那里，用户看不到"上一版还在"。
                 "version_count": ver_counts.get(s.id, 0),
                 #: 当前采用的这一版**是不是高清过的**。前端据此打 HD 角标、
                 #: 也据此算成片页的「还有几镜没高清」。
                 #: ⚠️ 判据只看**被采用的那一版**：旧版本高清过、现在用的是新
                 #: 生成的版本 → 不算高清（用户明确要求"重新生成后就算没高清过"）。
                 "hd": hd_versions.get(s.id) == "upscale",
                 #: 这一镜**擦过字幕**（任意一版是 desub，见上面 desub_done 的说明）。
                 "desub_done": s.id in desub_done,
                 "adopted_model": hd_versions.get(s.id) or "",
                 "gen_prompt": s.gen_prompt, "stale": bool(s.stale),
                 #: 过期原因，决定 UI 该引导用户做什么（重拆本集 / 重出提示词 /
                 #: 只需重出片）。NULL = 老数据，前端回落到最保守的兜底文案。
                 "stale_reason": s.stale_reason,
                 "stale_hint": stale_mod.label(s.stale_reason) if s.stale else None,
                 #: 提示词来源：draft 拆解初稿 / aligned 已按资产对齐 /
                 #: sent 出片实际下发稿 / manual 手填 / raw 优化失败回退成了剧本原文。
                 #: 老库为空视同 draft。
                 "prompt_state": s.prompt_state or ("draft" if s.gen_prompt else None),
                 #: 提示词就是剧本原文（优化失败的回退，含没打标的老数据）。
                 #: 判据唯一真源 prompt_health.is_raw；镜头页「重新拆解」据此统计。
                 "prompt_raw": _ph.is_raw(s.gen_prompt, s.script_ref, s.prompt_state,
                                          legacy=_legacy_raw),
                 "duration_sec": s.duration_sec,
                 "disabled": bool(s.disabled),
                 "special_name": s.special_name,
                 "ref_overrides": json.loads(s.ref_overrides) if s.ref_overrides else None,
                 "refs_stale": bool(s.refs_stale),
                 "first_frame_url": s.first_frame_url,
                 #: 2026-09-11 起不再下发 tail_frame_url / prev_tail_ref：
                 #: 尾帧接力已停用（见 docs/DECISION-2026-09-11-尾帧接力停用.md），
                 #: 存量 277 条历史尾帧不再有任何展示或注入用途，继续下发只会让
                 #: 界面显示一条实际不会被注入的"参考图"。
                 "profile_override": json.loads(s.profile_override) if s.profile_override else None,
                 # TB-01 取片窗口 / TB-03+TB-10 变换与变速
                 "clip_in_sec": s.clip_in_sec, "clip_dur_sec": s.clip_dur_sec,
                 "transform_meta": json.loads(s.transform_meta) if s.transform_meta else None,
                 #: 2.3 乐观锁的版本号：客户端写回时原样带上（base_transform_rev），
                 #: 服务端发现已被别处改过就回 409，而不是静默覆盖。
                 "transform_rev": transform_rev(s.transform_meta),
                 # Render V2 多轨：0=主轨，1+=Overlay 层
                 "track_index": s.track_index or 0,
                 "overlay_start_sec": s.overlay_start_sec}
                for _i, s in enumerate(shots)
            ],
            #: 资产。**带上墓碑**（`deleted_at` 非空 = 用户删掉的）而不是在后端
            #: 过滤掉：前端默认不显示它们，但需要一个「已删除 (n)」的入口来恢复。
            #: 生成链路那边是真的看不见它们（见 asset_gate 模块头列的四处闸门）。
            #:
            #: ⚠️ 必须**带稳定排序**（2026-10-13 修）。此前 `query(Asset)` 不带
            #: order_by，返回的是 SQLite 的物理顺序：加个索引、删几行、换个库
            #: 都会变。前端拿它渲染资产清单与 @ 候选，于是同一份清单**每次刷新
            #: 都可能换序**，"我刚建的那个要素排到哪去了"根本无从回答。
            #: 按 created_at 升序（老的在前），NULL（存量行，迁移不回填）垫底——
            #: 不拿别的时刻去猜，猜出来的顺序只是伪造的稳定。
            "assets": [
                {"id": a.id, "kind": a.kind, "name": a.name,
                 "image_url": a.image_url, "voice_url": a.voice_url,
                 #: 这个资产**被哪些集用到**（升序、去重；2026-10-21）。
                 #: 要素页的「按集筛选」直接读它。空数组 = 没有任何在用镜头
                 #: 引用它（拆解改过名、剧本删了这段、或它根本还没被用过）——
                 #: 界面上要如实说"没有被任何镜头用到"，不要当成"筛选没生效"。
                 "episodes": sorted(_eps_of.get((a.kind, (a.name or "").strip()), ())),
                 # `prompt` = 用户改过的整段终稿（NULL = 没改过）；
                 # `desc_auto` = 系统写的描述（场景陈设 / 道具形制 / 角色外貌）。
                 # `desc` = **解析后的描述**（`db.desc_of`：desc_auto 优先，
                 # 存量行回退到 prompt 里那段描述）。前端一律读 `desc` ——
                 # 只读 `desc_auto` 会让拆列之前的老项目卡片一片空白。
                 "prompt": a.prompt, "desc_auto": a.desc_auto,
                 "desc": desc_of(a),
                 "deleted_at": a.deleted_at,
                 "created_at": a.created_at,
                 # 共享资产库里的可见性；NULL = 没设过 = 公开（见 db.Asset.visibility）
                 "visibility": a.visibility or "public"}
                for a in sorted(assets, key=lambda x: (x.created_at is None,
                                                       x.created_at or "", x.id))
            ],
        }, request)


# ---------- 阶段④：镜头视频生成（同步单镜；批量走 /jobs kind=shot_videos）----------
class ShotGenerateIn(BaseModel):
    prompt: str
    model_id: Optional[str] = None       # 缺省用 settings.video_model（veo-3-1-fast）
    #: 生成模式 t2va / full_reference；None=按素材自动推断。
    #: 首帧 / 首尾帧 / 尾帧（i2va / fl2va / l2va）已于 2026-11-20 下线：旧网页还会发来，
    #: 收到按「没指定」处理；下面两张帧图当参考图带上，不再当第一帧 / 最后一帧。
    generation_mode: Optional[str] = None
    first_frame_url: Optional[str] = None
    last_frame_url: Optional[str] = None
    project_id: Optional[str] = None     # 与 order 一起传则把结果写回该镜头
    order: Optional[int] = None
    # ---- 参考路线参数（minimax-h3-ref2v 等 reference 模型使用；veo 通道忽略）----
    reference_image_urls: list[str] = []
    reference_audio_url: Optional[str] = None
    reference_video_url: Optional[str] = None
    duration_ms: Optional[int] = None
    aspect_ratio: Optional[str] = None
    megapixels: Optional[float] = None   # 缺省按时长自动选安全值（防显存 OOM）
    seed: Optional[int] = None           # 缺省随机化（不传则每次结果不同）


class ShotGenerateOut(BaseModel):
    video_url: str
    model_id: str
    #: 实际生效参数（seed/分辨率/帧数等），便于复现与排查
    meta: Optional[dict] = None


@router.post("/shots/generate", response_model=ShotGenerateOut)
@access.requires(access.ROLE_EDITOR)
async def shots_generate(body: ShotGenerateIn) -> ShotGenerateOut:
    """单镜生成（同步等待出片）。

    veo fast 约 1-3 分钟；minimax-h3-ref2v 走 RunningHub 异步工作流，
    1MP/8s 实测约 10 分钟，批量请用 jobs 通道。

    **必须显式盖 `editor`**：它同时会扣费（`charge_sync`）并写回
    `shot.video_url`，查看者一帧都不该能触发。它虽然在 `GLOBAL` 白名单里
    （因为路径上没有 project_id），但中间件**确实**会按 body 里的 project_id
    校验它 —— 而档位只由依赖判定，所以这里不盖章就等于只靠"写方法默认"。
    """
    from .config import get_settings
    from .providers.base import VideoRequest
    from . import charge

    model_id = body.model_id or get_settings().video_model
    # 单镜同步出片：按"这一镜"报价并先扣（时长取自库里的镜头行）。
    # 这条没有 job 行，故不做预扣/结算两步，一步扣掉。
    #
    # ⚠️ 2026-10-25 修（上线验收时真实调用才发现）：这里原来读
    # `body.shot_id` 与 `body.resolution`，而 `ShotGenerateIn` **没有这两个字段**
    # —— 每次调用必然抛 `AttributeError: 'ShotGenerateIn' object has no attribute
    # 'shot_id'`。也就是说这个接口**从来没有成功跑通过一次**（1535679 引入，
    # 2026-10-14 至今）。静态检查看不见：`body` 是 pydantic 实例，属性缺失是运行时
    # 才炸，pyflakes 只认"名字没定义"。
    #
    # 口径改成与本模型实际拥有的字段对齐：
    #   · 没有 shot_id → 按 `project_id + order` 找回镜头行，用它算时长；
    #     找不到就退回 0（estimate 会按 `_area_seconds` / 每镜 5 秒兜底）。
    #   · 没有 resolution → 不传，让 `_video_model` 走"项目设置 > 平台默认"。
    _shot_ids: list[str] = []
    if body.project_id and body.order is not None:
        with get_session() as _s:
            _hit = (_s.query(Shot.id)
                    .filter(Shot.project_id == body.project_id,
                            Shot.order == body.order).first())
        if _hit:
            _shot_ids = [_hit[0]]
    # 不带 `resolution`：本模型根本没有这个字段，而 `_video_model` 在
    # payload 里读不到时本来就会回落到"项目设置 > 平台默认"——那才是原本想要的
    # 口径（传一个 None 进去等于显式声明"用默认"，与不传同义但更绕）。
    charge.charge_sync("shot_videos", {"shot_ids": _shot_ids,
                                       "project_id": body.project_id,
                                       "model_id": model_id},
                       desc="单镜生成", project_id=body.project_id)
    provider = registry.get_video(model_id)
    if provider is None:
        raise HTTPException(status_code=400, detail=f"未注册的视频模型: {model_id}")
    from .providers.base import RETIRED_GENERATION_MODES
    _refs = list(body.reference_image_urls)
    for _frame in (body.first_frame_url, body.last_frame_url):
        if _frame and _frame not in _refs:
            _refs.append(_frame)
    try:
        res = await provider.submit(VideoRequest(
            prompt=body.prompt,
            generation_mode=(body.generation_mode
                             if body.generation_mode not in RETIRED_GENERATION_MODES else None),
            reference_image_urls=_refs,
            reference_audio_url=body.reference_audio_url,
            reference_video_url=body.reference_video_url,
            duration_ms=body.duration_ms,
            aspect_ratio=body.aspect_ratio,
            megapixels=body.megapixels,
            seed=body.seed,
        ))
    except RuntimeError as e:
        # Provider 用 RuntimeError 表达入参不合法（时长/精细度/参考素材数量、
        # 以及 #158 关闭后误传 reference_video_url）——归为 400 而非 500。
        raise HTTPException(status_code=400, detail=str(e))
    if res.status != "done" or not res.video_url:
        raise HTTPException(status_code=502, detail=f"视频生成失败: {res.error}")

    # 可选写回镜头
    if body.project_id and body.order is not None:
        with get_session() as session:
            shot = (session.query(Shot)
                    .filter(Shot.project_id == body.project_id, Shot.order == body.order)
                    .first())
            if shot:
                shot.video_url = res.video_url
                # 3.1：同 jobs.py —— 换素材必须清取片窗口，见 db.py
                reset_clip_window(shot)
                session.commit()
    return ShotGenerateOut(video_url=res.video_url, model_id=model_id, meta=res.raw)


# ---------- 异步任务（长任务：批量生图，后续视频生成同走此通道）----------
from fastapi import BackgroundTasks  # noqa: E402

from .jobs import (RETIRED_KINDS, RUNNERS, _TARGET_KINDS, covers_active_shot,
                   create_job, find_active_job, find_covering_job, get_job,
                   get_job_phase)  # noqa: E402






@router.post("/jobs", response_model=JobOut)
async def submit_job(body: JobSubmitIn, background: BackgroundTasks) -> JobOut:
    # 已下线的任务类型（目前只有 `reprompt`：镜头脚本改由 Muse 撰写）→ 410，
    # 与「未知任务类型」的 400 区分开：网页上还留着按钮，它要能据此提示用户去找 Muse。
    if body.kind in RETIRED_KINDS:
        raise HTTPException(status_code=410, detail=RETIRED_KINDS[body.kind])
    runner = RUNNERS.get(body.kind)
    if not runner:
        raise HTTPException(status_code=400, detail=f"未知任务类型: {body.kind}")

    # 归属校验（2026-10-09）。这里路径是 `/v2/jobs`，project_id 藏在**请求体**里，
    # 中间件的路径拦截够不着 —— 只能自己查。
    #
    # ⚠️ 必须在去重**之前**：`find_active_job` 会按 (kind, project_id) 去重并
    # **把已存在的那条 job 返回给调用者**。若先跑去重，攻击者拿别人的 project_id
    # 提交一次，就能拿到对方正在跑的任务 id —— 既泄露了任务存在性，又拿到一个
    # 可用于 /jobs/{id} 系列端点的抓手。
    #
    # `project_id` 可能为空（少数全局任务不带项目）。空的放行：那条路读不到
    # 任何人的项目数据，见 access.can_access_project 的 `if not project_id`。
    _pid = (body.payload or {}).get("project_id")
    if _pid:
        with get_session() as _s:
            access.require_project_access(_s, _pid)

    # 「解说剧·角色开口」与其他模式的任务互不串门（见 nd/guard.py）
    from .nd.guard import reroute as _nd_reroute
    _kind = _nd_reroute(body.kind, body.payload)
    if _kind != body.kind:
        body.kind, runner = _kind, RUNNERS[_kind]

    # 提交去重：同项目同类型批量任务已在跑就直接返回它，不再开第二批。
    # 这类 job 缺省覆盖全项目镜头，重复提交 = 同一批镜头生成两遍，纯烧钱
    # （实测一次双击让 113/170 个镜头各生成了两份视频）。
    # TB-04：定向提交（payload 带明确 shot_ids）不受此约束——用户点名了要哪几镜，
    # 即使批量任务在跑也应当立即重试，否则「重试这一镜」点了没反应。
    #
    # ⚠️ 「查重 → 建 job」这两步必须**原子**（B34）。它们之间只要出现一次 await，
    # 事件循环就会切走，两个并发提交都能查到"没有在跑的"，各建一条 job ——
    # 后果正是上面那条实测：同一批镜头被生成两遍。
    # 现状（2026-08 实测）：两步之间无 await、服务单 worker，20 次并发提交只落
    # 1 条 job，窗口尚不存在。但这是**易碎的隐性前提**：谁在这中间加一行 await
    # （比如加个鉴权/配额查询），或哪天上 `--workers 2`，去重立刻失效且无人察觉。
    # 因此在此显式加锁把不变式钉住：
    #   · 进程内锁挡住"未来有人加 await"以及同进程并发；
    #   · 多 worker 场景本锁无效 —— 那需要 DB 唯一约束（如
    #     (kind, project_id, status) 部分唯一索引）或 Redis 锁。届时若真要多
    #     worker，必须先补 DB 层约束，不能只依赖这把锁。
    async with _SUBMIT_LOCK:
        dup = find_active_job(body.kind, (body.payload or {}).get("project_id"),
                              body.payload)
        if dup:
            job = get_job(dup)
            if job:
                return JobOut(id=job.id, kind=job.kind, status=job.status,
                              progress=job.progress, deduped=True,
                              phase=get_job_phase(job.id))

        # 定向提交里**已经被在跑任务覆盖**的那些镜头：剔掉，剩下的照常提交。
        #
        # 这里替代的是原先前端那个 `shotJobRunning()` 粗粒度守卫
        # （"该组有任务在跑就把所有生成按钮锁死"）。那个拦法的粒度错了：
        # 它让"生成第 1 镜"顺带锁住了第 2、3 镜，而真正该挡的是
        # **同一镜重复提交**（重复烧钱）。
        #
        # 为什么不做成"整条复用原 job"（deduped）：用户勾了 5 镜、
        # 其中 1 镜在跑时，整条复用会让另外 4 镜一帧都不生，而界面回一句
        # "已提交" —— 用户以为提交成功了。剔除+照常提交才是他要的语义。
        _dropped: list[str] = []
        if body.payload and body.kind in _TARGET_KINDS:
            _ids = body.payload.get("shot_ids")
            if isinstance(_ids, list) and _ids:
                _pid = body.payload.get("project_id")
                _keep = [i for i in _ids if not covers_active_shot(i, body.kind, _pid)]
                _dropped = [i for i in _ids if i not in set(_keep)]
                if not _keep:
                    # 整批都已在跑 → 没有新镜头要生，复用那条任务。
                    # ⚠️ 必须**直接按镜头反查** job，不能拿下面那个
                    #    `find_active_job(kind, pid, payload)`：payload 此刻
                    #    还带着非空 shot_ids，而 TB-04 的"定向放行"会让它
                    #    恒返回 None。结果就是这里不返回、继续往下走，
                    #    建出一条 **shot_ids 为空** 的 job ——
                    #    而运行器把空列表当"全部镜头"（见 _in_scope 与
                    #    run_shot_videos 的范围判据），等于把全片重出一遍。
                    #    那是比原问题严重得多的烧钱 bug。
                    _cover = None
                    for _i in _ids:
                        _cover = find_covering_job(_i, body.kind, _pid)
                        if _cover:
                            break
                    _job = get_job(_cover) if _cover else None
                    if _job:
                        return JobOut(id=_job.id, kind=_job.kind, status=_job.status,
                                      progress=_job.progress, deduped=True,
                                      phase=get_job_phase(_job.id))
                    # 兜底：覆盖判据说"有人在跑"却查不到 job 行（不该发生）。
                    # 硬失败，绝不建空 shot_ids 的 job。
                    raise HTTPException(
                        status_code=409,
                        detail="这些镜头都已在生成队列里了，且查不到对应任务——"
                               "请稍后在「任务队列」确认后再试")
                body.payload = {**body.payload, "shot_ids": _keep}
                body.payload.pop("orders", None)   # 已折成显式 id，别再叠加范围

        # 出片预检（2026-11-03）：范围里的镜头**全部**被排除（停用 / 外部素材）时
        # 当场拒绝并说明是哪几镜、为什么，不建 job、不预扣。
        # 原先会照常建 job，运行器发现没东西可生成就写 done —— 任务队列一秒
        # 显示「成功」，镜头却还是「未出片」。运行器那边也已改成 failed 兜底
        # （agent 等不经本端点的提交方走那条），这里是让网页提交的人当场看到原因。
        # 纯同步 SQL，不破坏上面「锁内无 await」的不变式。
        if body.kind == "shot_videos" and body.payload and body.payload.get("project_id"):
            from .jobs import excluded_note, shot_video_targets
            with get_session() as _s:
                _keep, _excl = shot_video_targets(_s, body.payload["project_id"], body.payload)
            if not _keep and _excl:
                raise HTTPException(status_code=422, detail=excluded_note(_excl))

        # 积分预扣（P1）。位置与顺序都是硬要求：
        #   · 在 lock **内**、且在"查重之后"——命中复用那条已经扣过了，一分不能重扣；
        #   · 必须是**同步 SQL**，不能 await（见本函数上文那段"加一行 await 去重即失效"）。
        # 余额不足抛 402，此时 job 还没建，用户看到的是"没扣钱也没生成"。
        _charged, _ = charge.should_charge(body.kind, body.payload)
        _est, _note = (0, "")
        if _charged:
            _est, _note = charge.estimate(body.kind, body.payload)
        # ⚠️ job id **先生成**：钱和任务必须挂在同一个 id 上。若先扣在一个
        #    临时 id 上再回填，中间任何异常都会留下一笔挂在"不存在任务"上的预扣，
        #    而结算按 job_id 找它——永远找不到，等于白扣用户的钱。
        jid = uuid.uuid4().hex[:12]
        if _charged and _est > 0:
            # ⚠️ **不要**在这里 catch 再包成 HTTPException：那会绕过 main.py 的
            #    InsufficientCredit 处理器，detail 退化成一句裸字符串，
            #    前端拿不到 need_fen/have_fen 就没法显示"还差多少钱"。
            #    直接往上抛，由应用级处理器统一成 402 + 结构化 detail。
            charge.hold(body.kind, body.payload, jid, amount_fen=_est, note=_note)
        create_job(body.kind, body.payload, jid=jid)
    background.add_task(_run_job_guarded, runner, jid, body.kind)
    return JobOut(id=jid, kind=body.kind, status="pending", progress=0,
                  skipped=_dropped)


@router.get("/jobs/{job_id}", response_model=JobOut)
def job_status(job_id: str) -> JobOut:
    # 归属校验走 access.req_job：路径里没有 project_id，中间件拦不到。
    # 它替掉了原来的 `get_job(job_id)` —— 那个是按 id 直取，任何登录用户
    # 知道 job id 就能读到别人的任务结果（含 result 里的素材 URL）。
    with get_session() as session:
        job = access.req_job(session, job_id)
    return JobOut(
        id=job.id, kind=job.kind, status=job.status,
        progress=job.progress, result=job.result, error=job.error,
        phase=get_job_phase(job.id),
    )


@router.get("/projects/{project_id}/jobs")
def list_project_jobs(project_id: str, active: bool = True,
                      limit: int = 60) -> dict:
    """按项目列出 job。

    active=true（默认）只回 pending/running——打开项目时接回进行中任务，
    不依赖 localStorage（换设备/清缓存后进度不失联）。
    active=false 回全部历史，供「AI 任务」面板做失败回溯与重试。

    按项目筛走 `Job.project_id` 索引列（B30）。原来是全表 `.all()` 载入后
    逐行 `json.loads(payload)` 过滤 —— jobs 表只增不删，实测 173 行就已经要
    把 547 KiB 的 payload+result 全部读进内存（其中 result 这个接口压根不用，
    最大单条 34 KiB），行数只会一直涨。
    兼容老数据：迁移已回填 project_id；万一回填漏了（payload 损坏等），
    下面仍按 payload 复核一次，不会把 job 漏掉。
    """
    from .db import Job
    with get_session() as session:
        q = (session.query(Job)
             .filter(Job.project_id == project_id)
             .order_by(Job.created_at.desc()))
        if active:
            q = q.filter(Job.status.in_(("pending", "running")))
        # 多取一些再在应用层排序切片：created_at 为空的老行在 SQL 里排序不稳
        rows = q.limit(max(1, limit) * 3).all()
        # ---- 批量补三样东西：发起人、集号、镜号（2026-10-19 用户需求）----
        # ① 发起人。`Job.user_id` 2026-10-13 起才写入，更早的行为 NULL 且推不出来
        #    （不回填），面板据此显示「—」而不是编一个名字。
        #    名字一律走 `_user_directory`（KnownUser ∪ 现存会话）——只查会话表的话，
        #    会话一过期，一条两周前任务的发起人就变成了空白。
        # ② 集号/镜号。job 的 payload 只记 `shot_ids`（或干脆不记 = 整个项目），
        #    集号与镜号都在 shots 表里，**一次性批量取**，不逐个 job 查。
        from .db import Shot
        from .routers.library import _user_directory
        all_ids = set()
        payloads: dict[str, dict] = {}
        for j in rows:
            try:
                pl = json.loads(j.payload or "{}")
            except json.JSONDecodeError:
                pl = {}
            if not isinstance(pl, dict):
                pl = {}
            payloads[j.id] = pl
            ids = pl.get("shot_ids")
            if isinstance(ids, list):
                all_ids.update(x for x in ids if isinstance(x, str))
        shot_meta: dict[str, dict] = {}
        if all_ids:
            for sid_, ep, order, special in (
                    session.query(Shot.id, Shot.episode, Shot.order, Shot.special_name)
                    .filter(Shot.id.in_(all_ids)).all()):
                shot_meta[sid_] = {"id": sid_, "episode": ep, "order": order,
                                   "special_name": special}
        names: dict[int, str] = {}
        uids = {j.user_id for j in rows if j.user_id is not None}
        if uids:
            for uid, u in _user_directory(session).items():
                if uid in uids:
                    names[uid] = (u.get("display_name") or u.get("username") or "")
        out = []
        for j in rows:
            pl = payloads[j.id]
            shot_ids = pl.get("shot_ids") or []
            shot_ids = [x for x in shot_ids if isinstance(x, str)] \
                if isinstance(shot_ids, list) else []
            shots = [shot_meta[x] for x in shot_ids if x in shot_meta]
            # 同一集里连续的镜号在面板上会折成 `#12–#20`，故排一次序再回传
            shots.sort(key=lambda r: (r["episode"] or 0, r["order"] or 0))
            out.append({
                "id": j.id, "kind": j.kind, "status": j.status,
                "progress": j.progress,
                # 错误串可能很长（含上游 traceback），面板只展示摘要。
                # ⚠️ 从 300 提到 500（2026-10-15）：300 **正好砍在多条明细的
                #    中间**，用户看到的结尾是 `…；#` 这种断尾——那不是显示 bug，
                #    是截断恰好落在第三条的开头。500 与 jobs._ERR_TEXT_CAP 对齐，
                #    也就是说正常情况这里根本不该截到东西（上面已经压过一次了）。
                "error": (j.error or "")[:500] or None,
                "created_at": j.created_at, "updated_at": j.updated_at,
                # 定向任务带上镜头，面板可"定位到该镜"
                "shot_ids": shot_ids,
                # ---- 2026-10-19 新增：协作时能分清是谁发起的、动了哪几集哪几镜 ----
                #: 发起人。None = 该列上线（2026-10-13）之前的老任务，推不出来。
                "user_id": j.user_id,
                "user_name": names.get(j.user_id) if j.user_id is not None else None,
                #: 本任务覆盖的镜头（按集号、镜号排好）。
                #: `order` 是**全剧镜号**（跨集连续），与界面上的 `E01·S003` 同一口径。
                #: 空数组 = 任务没限定镜头（跑整个项目 / 只补未生成的）。
                "shots": shots,
                #: 涉及的集号（去重升序）。空 = 未限定。
                "episodes": sorted({s["episode"] for s in shots
                                    if s["episode"] is not None}),
                "phase": get_job_phase(j.id),
            })
        # 新任务在前；created_at 为空的老数据排最后（ISO 串可直接字典序比较）
        out.sort(key=lambda r: r["created_at"] or "", reverse=True)
        return {"jobs": out[:max(1, limit)]}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    """请求取消一个任务。

    ⚠️ 语义是"标记为已取消"，不是强杀协程——runner 跑在 asyncio 后台任务里，
    没有可靠的中断点。已经发出去的上游生成请求该扣的费仍会扣。
    标记后 runner 的下一个检查点会自行退出（见 jobs.py::is_cancelled）。
    """
    from .db import Job
    with get_session() as session:
        # 归属校验：路径里没有 project_id，只能在这里查（见 access 模块头）
        job = access.req_job(session, job_id)
        if job.status in ("done", "failed", "cancelled"):
            return {"ok": True, "status": job.status, "changed": False}
        job.status = "cancelled"
        job.error = "用户取消"
        job.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        session.commit()
    # 取消**刻意不结算**（裁定：出片是 gather 一次性派发，钱基本已花）。
    # 写在这里是因为下个人看到"别的终态都调了 settle、只有这里没调"，
    # 很容易当成漏写而补上一句——那会让取消变成免费退款的漏洞。
    # 对照：后端重启中断走 maintenance.recover_zombie_tasks，那条全额退。
    return {"ok": True, "status": "cancelled", "changed": True}


@router.post("/jobs/{job_id}/retry", response_model=JobOut)
async def retry_job(job_id: str, background: BackgroundTasks) -> JobOut:
    """按原 kind + payload 重新提交一个失败任务。

    ## 为什么必须有这一条

    任务失败信息里一直写着「后端重启，任务中断（**可在看板重试**）」，
    但看板上从来没有重试按钮，也没有任何接口——那句话是空话，用户照着去找
    什么也找不到。2026-10-05 补上。

    ## 为什么复用 submit_job 而不是自己 create_job + 起协程

    去重（`find_active_job` 走互斥组）与那把 `_SUBMIT_LOCK` 是**防止重复烧钱**
    的不变式：`shot_videos` / `asset_batch` 这类 job 缺省覆盖全项目，
    绕过去重再开一条 = 同一批镜头/同一批资产各生成两遍，钱直接翻倍。
    重试是**最容易**触发这件事的动作（用户对着一个 failed 卡片连点两下），
    所以直接把 payload 转交给 submit_job，让它走完全相同的判据与锁。

    ## 只允许重试终态

    running/pending 的任务不在这里复制一份——那正是去重要挡的事。
    直接返回它本身，前端把"已有一条在跑"如实告诉用户即可（deduped=True）。
    done 的任务也可以重试（用户可能就是想再跑一遍），但同样经过去重。
    """
    from .db import Job
    with get_session() as session:
        # 归属校验：路径里没有 project_id，只能在这里查。必须在取 payload
        # **之前** —— 否则 attacker 能通过"参数损坏"这类差异化报错探知他人 job 的存在。
        job = access.req_job(session, job_id)
        kind, payload_raw = job.kind, job.payload

    if kind in RETIRED_KINDS:
        raise HTTPException(status_code=410, detail=RETIRED_KINDS[kind])
    if kind not in RUNNERS:
        raise HTTPException(status_code=400,
                            detail=f"这条任务的功能已下线，无法重试: {kind}")

    try:
        payload = json.loads(payload_raw or "{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="原任务参数已损坏，无法重试")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="原任务参数格式异常，无法重试")

    # 转交给 submit_job：去重、锁、起后台任务全在那里，行为与用户重新点一次
    # 按钮完全一致。（`RETRYABLE` 判定放在这里只是为了让错误信息更贴切。）
    return await submit_job(JobSubmitIn(kind=kind, payload=payload), background)


# ---------- P2-5 SSE 事件推送（修 G3 实时性 / F2 密集轮询）----------
from fastapi.responses import StreamingResponse  # noqa: E402

from .events import poll as events_poll, tail_seq  # noqa: E402


@router.get("/projects/{project_id}/events")
async def project_events(project_id: str) -> StreamingResponse:
    """SSE：本项目 job/shot/audio 状态变更实时推送。

    前端用 fetch 流式读取（EventSource 带不了 Authorization 头，登录体系下
    会 401；fetch 方案桌面端 WebView 与浏览器通道都通）。连接即从"当前"起
    只推增量——历史状态由 /detail、/jobs 快照接口承载，职责分离。
    心跳 15s 探测断连 + 防代理超时；X-Accel-Buffering 逐响应关 nginx 缓冲
    （站点 /fw/ 段未配 proxy_buffering off，不加此头事件会被攒批延迟）。
    """
    async def gen():
        cursor = tail_seq()
        yield "retry: 3000\n\n"
        idle = 0.0
        while True:
            cursor, items, dropped = events_poll(project_id, cursor)
            if dropped:
                # 缓冲溢出，这中间有本项目事件被挤掉了（B20）。
                # 不能装作没发生：少了哪几条状态变更无从知晓，前端会显示
                # 陈旧状态直到兜底轮询慢慢对上。明确要求前端全量重同步。
                idle = 0.0
                yield "event: resync\ndata: {\"reason\":\"event_buffer_overflow\"}\n\n"
            if items:
                idle = 0.0
                for _seq, ev, data in items:
                    yield f"event: {ev}\ndata: {data}\n\n"
            elif not dropped:
                idle += 0.5
                if idle >= 15:
                    idle = 0.0
                    yield ": ping\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ---------- 场景多视角参考图 / 设定板 / 影调档案 / 资产视觉体检（2026-09-09）----------
#
# 这四组接口服务用户 2026-09-09 的四条反馈（见
# docs/PLAN-场景多视角与影调统一.md）：场景资产出全套 8 张多视角参考图并在左上角
# 标场景名、把 8 张拼成美术设定板、全片影调统一、"人物图无场景 / 场景图无人"可核验。
#
# ⚠️ 放在文件末尾是**必需**的：这里要用到上面才定义的 `JobOut` / `BackgroundTasks`
# 与 `_run_job_guarded`。本文件用了 `from __future__ import annotations`，
# 但 FastAPI 在**装饰器执行时**就要解析返回注解，前置会 NameError。

from . import scene_view as _sv                        # noqa: E402
from . import look_profile as _lp                      # noqa: E402
from .db import SceneView                              # noqa: E402



"""生产模式与项目默认档案：**数据层口径**，不含任何路由逻辑。

## 为什么从 routes_v2.py 搬到这里

这三个常量的真实消费者是 `jobs.py`（旧预设项目平滑读取 `_LEGACY_DEFAULTS`）
与 `migrations.py`，却住在路由文件里 —— 于是 `jobs.py` 被迫写了**三处**
函数内局部 import 绕循环（`from .routes_v2 import _LEGACY_DEFAULTS`）。
这正是 `verify-architecture.ts` 里 P2.2 记的那笔债。

它们描述的是"项目档案长什么样"，与"哪个路由处理请求"无关，
所以正确的位置是数据层附近：route / job / migration 都能直接 import。

⚠️ 常量体是**逐字**从 routes_v2.py 搬来的（AST 取源，未经手改）。
"""
from __future__ import annotations


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


BASE_ASPECTS = ["9:16", "16:9", "3:4", "4:3", "1:1", "21:9"]

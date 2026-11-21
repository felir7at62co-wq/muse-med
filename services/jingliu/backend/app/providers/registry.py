"""Provider 注册表。集中登记可用模型，上层按 model_id 取用。

新增模型步骤：
1. 在 providers/ 下实现一个 VideoProvider 子类。
2. 在 register_defaults() 里注册一行。
3. 完毕——路由/编排层无需改动。
"""
from __future__ import annotations

from .base import VideoProvider

#: **已停用**的视频模型：仍在注册表里（后端可直接按 model_id 调，内部/测试可用），
#: 但前端**置灰不可选**，新建项目也选不到它。
#:
#: 与"删掉"是两件事，别混：
#:   · 删掉（如 veo）→ 不注册、`get_video` 返回 None，用到会明确报「未注册的视频模型」；
#:   · 停用（本集合）→ 仍然注册、能力查询照常，只是 **UI 不可选**。
#:
#: 为什么用后端下发而不是前端写死：视频模型清单本来就以后端注册表为准
#: （前端只有图标/文案的修饰），置灰状态同理 —— 写死在前端会与后端漂移，
#: 而且用户在离线时（后端不可达、走前端兜底清单）会看到一个能点的按钮。
#: `list_video()` 的 `enabled` 字段就是下发给前端的那个开关。
DISABLED_VIDEO_MODELS: frozenset[str] = frozenset({
    # 2026-09-19 用户要求置灰：三渠道兜底的第三方中转方案。
    # 模型仍在注册、渠道配置也照旧读，只是不再出现在可选清单里。
    "seedance-lowcost-2.5",
})


class ProviderRegistry:
    def __init__(self) -> None:
        self._video: dict[str, VideoProvider] = {}

    def register_video(self, provider: VideoProvider) -> None:
        self._video[provider.model_id] = provider

    def get_video(self, model_id: str) -> VideoProvider | None:
        return self._video.get(model_id)

    def list_video(self) -> list[dict]:
        return [
            {
                "model_id": p.model_id,
                "visual_mode": p.visual_mode.value,
                "audio_mode": p.audio_mode.value,
                "duration_slots": p.duration_slots,
                "supports_last_frame": p.supports_last_frame,
                "aspect_ratios": p.aspect_ratios,
                "max_reference_images": p.max_reference_images,
                #: **自动注入**的名额之外，用户手动 @ 还能用到多少张图。
                #: 2.0 = 9、2.5 = 30（含首尾帧）。前端 refCap() 用 max_reference_images
                #: 算自动名额，@ 补全面板用这个算总预算——两个数故意分开：
                #: 自动注入刻意克制，宽出来的留给用户点名。
                "max_input_images": getattr(p, "max_input_images",
                                            p.max_reference_images),
                "supports_reference_audio": p.supports_reference_audio,
                #: 参考音频上限（2.0=3、2.5=10）。前端 @ 音频 的面板据此限制可选张数。
                "max_reference_audios": getattr(p, "max_reference_audios", 1),
                "supports_reference_video": p.supports_reference_video,
                #: 本模型真正吃得下的分辨率档位（2026-10-19）。
                #: `null` = 该模型未声明，前端**不要**据此灰显任何档
                #: （不知道就别装懂——与画风目录 `enabled` 同款语义）。
                #: 已知会"吃不下"的两处：seedance 官方无 2k、低价渠道恒 720p。
                #:
                #: ⚠️ 这里**不给**"实际会按哪档出"：那要拿**项目选的档位**去算
                #: （`resolution_for(mp)`），而本端点只描述模型能力、不知道项目。
                #: 项目级的实际结果由 `/projects/{id}/resolution` 与 `/detail`
                #: 的 `resolution.effective` 下发 —— 在那里算才有 mp 可用。
                "supported_resolutions": getattr(p, "supported_resolutions", None),
                #: 前端据此置灰（`enabled=false` → disabled + 不参与默认档选择）。
                #: 与画风目录的 `enabled` 同款语义。
                "enabled": p.model_id not in DISABLED_VIDEO_MODELS,
                #: 显示名（前端 `m.label || m.model_id`）。未声明的模型照旧显示 model_id。
                "label": getattr(p, "label", None),
            }
            for p in self._video.values()
        ]


registry = ProviderRegistry()


def register_defaults() -> None:
    """登记默认 Provider。

    zx1.deepwl.net 网关实测（2026-08-07）曾注册 `veo-3-1-fast` / `veo-3-1`
    （chat/completions 同步通道，约 1-3 分钟出片）。
    **2026-09-19 用户要求把这两个模型直接删掉**——不再可选，也不再注册。
    其余（kling/grok-video 等）在当前分组无可用渠道（model_not_found），
    渠道开通后在此追加注册即可，上层零改动。

    ⚠️ 删掉 veo 后，`config.video_model` 的默认值**必须**同步改掉：
    它原先指向 `veo-3-1-fast`。不改的话，`get_settings().video_model`
    会在 5 个调用点（`routes_v2.generate_shots` / `jobs` 三处 / `readiness`）
    返回一个**未注册的 model_id**，表现为生成时明确报
    「未注册的视频模型: veo-3-1-fast」——不静默串档，但功能直接不可用。
    已改为 `minimax-h3-ref2v`（与前端 `ProjectList.DEFAULTS.video` 一致）。
    """
    # RunningHub MiniMax H3 参考图生视频（异步 ComfyUI 工作流通道）。
    # 可吃最多 9 张参考图 + 参考音频 + 参考视频，分辨率/比例/时长/seed 精确可控，
    # 适合多角色一致性镜头；代价是慢（1MP/8s 实测约 600s）。
    # 仅在配置了 API key 时注册，未配置则静默跳过（不影响 veo 通道）。
    from ..config import get_settings
    from .video_runninghub import RunningHubH3VideoProvider

    if (get_settings().runninghub_api_key or "").strip():
        registry.register_video(RunningHubH3VideoProvider())

    # 火山方舟 Seedance 2.0 / 2.0 mini（配置 KEY+EP 即注册，同 RunningHub 模式）。
    # 音画一体、支持首帧/尾帧/参考图 role → 五生成模式全开；
    # seedance* 前缀自动命中 seedance2 提示词优化框架（prompt_opt）。
    from .video_seedance import SeedanceVideoProvider
    s = get_settings()
    if (s.ark_api_key or "").strip():
        if (s.seedance_ep or "").strip():
            registry.register_video(SeedanceVideoProvider("seedance-2.0", s.seedance_ep.strip()))
        if (s.seedance_mini_ep or "").strip():
            registry.register_video(SeedanceVideoProvider("seedance-2.0-mini", s.seedance_mini_ep.strip()))
        if (s.seedance25_ep or "").strip():
            # 2.5 与 2.0 同协议同能力，唯一差别是单镜可出 30s（2.0 是 15s）。
            # 提示词优化沿用 seedance2 框架（由 provider.prompt_framework 声明）。
            registry.register_video(SeedanceVideoProvider(
                "seedance-2.5", s.seedance25_ep.strip(), max_duration=30))

    # 低价 seedance2.5：三条第三方中转渠道互为兜底，**与上面的官方通道无关**。
    #
    # 用户需求（2026-09-15）："接入这三个渠道，独立于现在的视频模型选择，
    # 额外加一个'低价seedance2.5'…… 这个模型选择**不能用之前的官方渠道**"。
    # 故它是并列的另一个 model_id，而不是 seedance-2.5 的兜底：
    #   · 不进火山方舟私域资产库（uses_ark_trusted_assets=False）
    #   · 不读 FW_ARK_API_KEY / 不碰任何 seedance 官方 EP
    # 渠道清单是**数据**（providers/lowcost_channels.json），增删渠道改 JSON +
    # 配一把 key 即可，本文件零改动——这是"未来可能要调整这三个渠道"的落点。
    # 三条渠道都没配 key 时静默跳过，行为与加它之前完全一致。
    from .video_lowcost import LowCostSeedanceProvider
    _lc = LowCostSeedanceProvider()
    if any(c.configured for c in _lc.channels):
        registry.register_video(_lc)

    # 万相 wan3.0（阿里云百炼官方，2026-11-02 接入）。配了 FW_WAN_API_KEY 才注册。
    # 提示词沿用 seedance2 框架（provider.prompt_framework 声明）；计费按输出秒数，
    # 官方价 × 0.7（pricing.WAN_FEN_PER_SEC）。
    from .video_wan import WanVideoProvider
    if (s.wan_api_key or "").strip():
        registry.register_video(WanVideoProvider())

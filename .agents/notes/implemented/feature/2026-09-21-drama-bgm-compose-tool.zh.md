# Agent Note: 将短剧 BGM 确定性合成做成工具

Status: implemented

[English](2026-09-21-drama-bgm-compose-tool.md) | 中文

## Problem

短剧工作流可以按实测情绪排列本地曲目，也可以用一条已经混好的 BGM 底轨渲染整集，但没有包持有两者之间的转换。Agent 必须运行项目内的 Python 脚本，才能截取源曲、选择起点、归一化音量、交叉淡化剧情段落、发布底轨并检查它。该脚本服务过一次制作，但其它预设无法复用它的路径、依赖、清理和输出检查，模型工具也不强制执行这些行为。

把该操作并进 `bgm_match` 还会让候选排序与确定性媒体合成共享同一个运行时及许可边界。候选分析使用 m-a-p/MERT-v1-95M 骨干，采用 CC-BY-NC-4.0 且仅限非商业用途；截取与混音不使用它。

## Decision

`@deepseek-ai/dsh-tool-bgm-compose` 把 `drama_bgm` 注册为独立 Host 工具，提供 `preview`、`compose` 与 `verify`。它在 Agent 理解剧情并选定曲目后消费明确的单集计划。本包既不调用也不注入 `bgm_match`；预设可以同时暴露两个工具，计划可以把匹配器实测的 valence 与 arousal 当成普通 JSON 证据带入。

选中集必须连续覆盖实测 `body_end`。相邻边界使用计划的 `crossfade_seconds`，默认 1.5 秒。段落可以冻结 `source_start_seconds`，否则工具在 1–5 秒窗口内寻找第一个可听起音。FFmpeg `volumedetect` 测量实际消耗的源窗口；增益以 `-17.5 dB` 平均值为目标，自动提升最多 `+9 dB`。最终底轨开头淡入 1.5 秒，末尾 2.5 秒淡出，固定为 48 kHz 双声道 `pcm_s16le`。

`preview` 执行计划、来源、哈希、时长、起音与音量工作，不发布产物。`compose` 在目标旁暂存 WAV 与 JSON 报告，探测暂存 WAV，全部检查通过后才硬链接两个目标。已有目标绝不覆盖；冲突会回滚本次已建立的目标，并在操作结束后不保留任何暂存名称。`verify` 测量已有底轨，不重写它。

所有媒体命令都经过 `ctx.subprocess`，使用 provider 持有的可执行文件解析、取消、进程范围终止与有界输出收集。计划、时间线与输出必须留在项目内；选定的只读源曲可以位于其它目录。返回 WAV 作为 `drama_render.bgm` 的输入，同一计划仍作为声明传给 `drama_render.bgm_plan`。

## Alternatives considered

**把合成加入 `dsh-perception-bgm`。** 该包持有模型情绪分析与常驻 Python worker。把混音放进去，会让不涉及模型许可的 FFmpeg 操作依赖 MERT 部署，还会把 Agent 的最终创作选择藏在候选排序后面。

**把合成加入 `dsh-tool-episode-render`。** 渲染器消费一条已审核底轨，并把它与整集原声混合。让它同时选择源窗口，会把音乐准备与交付编码绑在一起，阻止渲染前预检，还会让渲染重试重复无关的源曲分析。

**保留项目内 Python 脚本。** 它验证了音频策略，但 skill 点名的脚本没有工具 schema、Cordis 生命周期、预设组件行或可复用的无覆盖检查。本包保留实测行为，并移除逐项目执行路径。

**在首个包里实现节拍网格推断。** 仓库没有已经安装且维护中的音频分析依赖，FFmpeg 静音检测也不能声称具有音乐节拍精度。工具如实报告可听起音；需要重拍时要求计划显式给出偏移。

## Consequences

候选排序、创作选曲、确定性合成与整集渲染现在各有所有者。合成器无需 MERT 即可运行；`bgm_match` 候选仍受 m-a-p/MERT-v1-95M 的 CC-BY-NC-4.0 约束，仅限非商业用途。

计划冻结源哈希与偏移时可复现；省略偏移则有意让起音分析跟随当前源字节。平均音量归一化不是 integrated LUFS，源曲不循环，技术核验也不等于试听通过。

[整集渲染决定](2026-09-19-drama-episode-render-tool.zh.md)、[设置组件清单决定](2026-09-20-drama-settings-panel.zh.md)与[制作证据决定](2026-09-21-drama-policy-and-result-evidence.zh.md)继续保持活跃。本包补充渲染器、给设置清单增加一个当前组件，并增加合成证据，但不声称创作审核通过。没有记录被完全取代或归档。

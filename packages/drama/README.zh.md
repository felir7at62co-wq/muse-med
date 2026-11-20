---
description: "短剧流水线家族的包地图：短剧预设挂载的资产检查、镜头规划、BGM 合成、整集渲染与设置。"
kind: "package-group"
---

# drama/ — 短剧流水线家族

[English](README.md) | 中文

## Summary

`drama/` 组承载短剧流水线自己的格式、操作与设置。它的工具通过已登录的 Muse 账号转写获授权媒体、对账远端资产、校验并编译镜头脚本、把明确剧情段落合成为实测 BGM 底轨，并按固定样式渲染整集。`drama-settings` 持有目录、交付规格、BGM 库、图片规格与整剧预算设置及其 Web 编辑页。镜头与音乐的创作选择仍归短剧 skill 和 Agent 工作流。

## Table of Contents

- [包](#packages)
- [相关文档](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 提供什么 |
|---|---|
| [`character-asset-catalog/`](character-asset-catalog/README.zh.md) | 按来源区分的人物 metadata 适配，通过调用方读取器核验图片字节，不授予批准或写入存储 |
| [`screenplay-project/`](screenplay-project/README.zh.md) | 以来源为依据写作、独立事实与分集审校、程序生成引用和可恢复的人物知情状态 |
| [`session-video/`](session-video/README.zh.md) | 会话视频清单、授权媒体访问，以及带来源版本检查的画面切镜检测 |
| [`tool-audio-transcribe/`](tool-audio-transcribe/README.zh.md) | 模型可见的 `audio_transcribe` 工具：通过当前账号云端转写本地媒体，保存持久任务收据和版本化转写稿 |
| [`tool-drama-tos-upload/`](tool-drama-tos-upload/README.zh.md) | 模型可见的 `drama_tos_upload` 工具：把一部作品的原始素材和剧本（红果剧的原片和转写材料，或番茄、七猫小说的原文和剧本）存进火山引擎 TOS 的平台与日期目录，不覆盖也不删除远端对象 |
| [`tool-hit-queue/`](tool-hit-queue/README.zh.md) | 模型可见的 `drama_hit_queue` 工具：转写工人从数据站任务队列领取红果爆款、上报进度、登记已存原片并发布剧本 |
| [`workbench-connection/`](workbench-connection/README.zh.md) | 以当前 Muse 用户身份连接剧本工坊，并提供与镜流连接共用的 Muse 账号登录和请求核心 |
| [`tool-workshop/`](tool-workshop/README.zh.md) | 模型可见的 `workshop_video_transcribe` 工具：按流水线卡片的参数查看、开始和停止剧本工坊的视频转剧本工厂任务 |
| [`tool-shot-script/`](tool-shot-script/README.zh.md) | 模型可见的 `drama_shot` 工具：默认严格编译脚本，Muse 短剧模式采用提示型内容检查、分包建议和独立检查草稿 |
| [`bgm-license-info/`](bgm-license-info/README.zh.md) | 曲库与渲染使用方共享的音乐权利声明、明确的未知元数据及用途冲突提示 |
| [`tool-bgm-compose/`](tool-bgm-compose/README.zh.md) | 模型可见的 `drama_bgm` 工具：源曲分析、确定性交叉淡化合成、无覆盖发布与固定 WAV 核验 |
| [`tool-episode-render/`](tool-episode-render/README.zh.md) | 模型可见的 `drama_render` 工具：渲染输入布局、带字幕与音频样式的项目画布交付、按视觉类型确定片尾和水印，以及渲染后检查 |
| [`drama-settings/`](drama-settings/README.zh.md) | 其它各行读取的持久 `drama` 设置段，以及它的 Web GUI 界面：设置页与页面上那份只读组件清单 |
| [`character-library/`](character-library/README.zh.md) | 为人物参考提供有界、由 Host 管理的浏览、预览和推荐能力 |
| [`character-library-tos/`](character-library-tos/README.zh.md) | 通过有界的 List、Head 和 Range Get，从火山引擎 TOS 的固定前缀读取经过审查的公共人物参考 |
| [`tool-character-reference/`](tool-character-reference/README.zh.md) | 模型可见的 `drama_character_references`、`drama_character_reference_view` 与 `drama_character_reference_project` 工具：有界检索人物参考并查看经过校验的图片，不暴露存储位置，也不授予使用权限 |
| [`tool-drama-assets/`](tool-drama-assets/README.zh.md) | 模型可见的 `drama_assets` 工具：付费生成前比对剧变项目已选用的资产与清单，写出付费钩子读取的证据，并逐条记录未登记资产的处置 |
| [`skills/`](skills/README.zh.md) | 可迁移的技能资源：检索历史短剧资产、维护项目状态，并组装已确认的整剧交付 |

-----

<a id="related-documentation"></a>
## 相关文档

先读这个包注册进的那个工具子系统，再读模型实际收到的生成 schema。

- [工具子系统参考](../../docs/subsystems/tools.zh.md) —— 参数 DSL、规范输出值，以及 `drama_shot` 与 `drama_render` 进入的执行流水线。
- [设置子系统参考](../../docs/subsystems/settings.zh.md) —— 持有 `drama` 设置段的命名空间接缝、它的解析顺序，以及设置页写入所经的浏览器传输。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-audio-transcribe) —— 已挂载的 `audio_transcribe` schema 与描述原文。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shot-script) —— 已挂载的行贡献的 `drama_shot` schema 与描述原文。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bgm-compose) —— 已挂载的行贡献的 `drama_bgm` schema 与描述原文。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-render) —— 已挂载的行贡献的 `drama_render` schema 与描述原文。

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。
</details>

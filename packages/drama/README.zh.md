---
description: "短剧流水线家族的包地图：短剧预设挂载的资产检查、镜头规划、BGM 合成、整集渲染与设置。"
kind: "package-group"
---

# drama/ — 短剧流水线家族

[English](README.md) | 中文

## Summary

`drama/` 组承载短剧流水线自己的格式、操作与设置。它的工具对账远端资产、校验并编译镜头脚本、把明确剧情段落合成为实测 BGM 底轨，并按固定样式渲染整集。`drama-settings` 持有档位、目录、交付与 BGM 库设置及其 Web 编辑页。镜头与音乐的创作选择仍归短剧 skill 和 Agent 工作流。

## Table of Contents

- [包](#packages)
- [相关文档](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 提供什么 |
|---|---|
| [`tool-shot-script/`](tool-shot-script/README.zh.md) | 模型可见的 `drama_shot` 工具：硬失败与警告分开的脚本校验、打包预算预演，以及 matched JSON 与单集 package 的编译 |
| [`tool-bgm-compose/`](tool-bgm-compose/README.zh.md) | 模型可见的 `drama_bgm` 工具：源曲分析、确定性交叉淡化合成、无覆盖发布与固定 WAV 核验 |
| [`tool-episode-render/`](tool-episode-render/README.zh.md) | 模型可见的 `drama_render` 工具：渲染输入布局、带字幕与音频样式的固定 1440x2560 交付、经过证明的 2 秒片尾，以及渲染后检查 |
| [`drama-settings/`](drama-settings/README.zh.md) | 其它各行读取的持久 `drama` 设置段，以及它的 Web GUI 界面：设置页与页面上那份只读组件清单 |

-----

<a id="related-documentation"></a>
## 相关文档

先读这个包注册进的那个工具子系统，再读模型实际收到的生成 schema。

- [工具子系统参考](../../docs/subsystems/tools.zh.md) —— 参数 DSL、规范输出值，以及 `drama_shot` 与 `drama_render` 进入的执行流水线。
- [设置子系统参考](../../docs/subsystems/settings.zh.md) —— 持有 `drama` 设置段的命名空间接缝、它的解析顺序，以及设置页写入所经的浏览器传输。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shot-script) —— 已挂载的行贡献的 `drama_shot` schema 与描述原文。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bgm-compose) —— 已挂载的行贡献的 `drama_bgm` schema 与描述原文。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-render) —— 已挂载的行贡献的 `drama_render` schema 与描述原文。

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。
</details>

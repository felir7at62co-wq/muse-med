---
description: "短剧流水线家族的包地图：短剧预设挂载的镜头门禁与单集编译器，供运行或组合剧变短剧流水线的使用者与维护者使用。"
kind: "package-group"
---

# drama/ — 短剧流水线家族

[English](README.md) | 中文

## Summary

`drama/` 组承载短剧流水线自己的格式与作用于其上的操作。`tool-shot-script` 注册 `drama_shot`：按本格式的规则判定导演格式镜头脚本、预演 14 秒打包预算，并编译 matched JSON 与单集 package。`tool-episode-render` 注册 `drama_render`：构建渲染输入、按运营确认过的 1440x2560 交付样式出片，并检查成片。这个组保持很窄：镜头该怎么写属于教学、归短剧 skill；而什么让脚本编译不出来、成片必须实测出什么，都由这条流水线判定。

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
| [`tool-episode-render/`](tool-episode-render/README.zh.md) | 模型可见的 `drama_render` 工具：渲染输入布局、带字幕与音频样式的固定 1440x2560 交付、经过证明的 2 秒片尾，以及渲染后检查 |

-----

<a id="related-documentation"></a>
## 相关文档

先读这个包注册进的那个工具子系统，再读模型实际收到的生成 schema。

- [工具子系统参考](../../docs/subsystems/tools.zh.md) —— 参数 DSL、规范输出值，以及 `drama_shot` 与 `drama_render` 进入的执行流水线。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shot-script) —— 已挂载的行贡献的 `drama_shot` schema 与描述原文。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-render) —— 已挂载的行贡献的 `drama_render` schema 与描述原文。

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。
</details>

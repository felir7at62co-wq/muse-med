---
description: "查找用于 BGM 候选排序、选定曲目下载与可选本地音频分析的音乐情绪包。"
kind: "package-group"
---

# perception/ — 音乐情绪分析与匹配

[English](README.md) | 中文

## 概述

按目标情绪查找 BGM 候选，并把选定的公开曲目下载为经校验的本地文件。本地或公开库匹配不需要 Python；分析新音频需要另行准备解释器和模型资源。选曲由代理决定，合成由短剧包负责。分析骨干仅限非商业用途；音频权利须单独确认。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本组目前提供一个音乐情绪包：

| 包 | 职责 |
|---|---|
| [`perception-bgm`](perception-bgm/README.zh.md) | `bgm_match` 工具：候选排序、经校验的下载、本地索引建立与单曲情绪分析 |

<a id="related-documentation"></a>
## 相关文档

- [工具子系统](../../docs/subsystems/tools.zh.md) —— 注册、参数校验、执行与模型可见结果。
- [短剧包](../drama/README.zh.md) —— 明确的曲目计划、音频合成与分集渲染。
- [模型来源与许可](perception-bgm/SOURCES.md) —— 分析依赖及各自的再分发条件。

<a id="dev-note"></a>
## 开发备注

无。

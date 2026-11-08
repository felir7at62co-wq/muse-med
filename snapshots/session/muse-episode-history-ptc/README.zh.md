---
description: "通过 Headless profile 的 Node PTC executor，免 Key 验证原整集任务查找及离线回执修复。"
kind: "reference"
---

# 通过 PTC 查找原整集任务

[English](README.md) | 中文

本场景通过 `run_code` 与真实 Node PTC runtime 执行[原整集任务历史检查](../muse-episode-history/README.zh.md)。它与原生场景共用 `history-fixture.mjs` 及生产组合，同时独立持有规范 Session、工具 schema 侧文件和预期工作区。

Jubian 作用域在源文件与回执已删除后重新挂载，嵌套的测试专用桥接工具明确选择原历史条目。它检查离线补回执、输出设备号和 inode 不变、渲染器仅调用一次，以及生成账本不变且提供方请求为零。`workspace.expected/episode-history-proof.json` 保存结果。渲染器仍受控；PTC 执行不证明原生编码、Host 进程重启或媒体质量。

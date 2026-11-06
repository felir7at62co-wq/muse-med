---
description: "通过 Headless profile 的 Node PTC executor 免 Key 验证整集受理与发布。"
kind: "reference"
---

# 通过 PTC 交付已审批片段整集

[English](README.md) | 中文

本场景通过 `run_code` 与真实 Node PTC runtime 执行[已审批片段整集交付检查](../muse-episode-delivery/README.zh.md)。它复用原生场景的 `episode-fixture.mjs` 和生产服务组合，同时保留独立的 Session 记录、工具 schema sidecar 及预期工作区。

嵌套的测试桥接工具检查原任务身份、等待中的工作、精确发布及未变化的生成账本。`workspace.expected/episode-proof.json` 保存相同的稳定结果。共享渲染器仍是可控夹具；PTC 执行成功不证明原生编码或媒体质量。

---
kind: upgrade-guide
description: Muse 模型网关移除管理员并发限制设置。
---

# Muse 模型中转并发

[English](guide.md) | 中文

## 变更

Muse 模型中转不再设置每账号或共享并发上限。Desktop 模型路由也移除自身的请求频率限制。网关环境设置 `MUSE_DESKTOP_MODEL_MAX_ACTIVE` 和 `MUSE_DESKTOP_MODEL_MAX_TOTAL` 已移除；存在任一设置都会停止启动并给出迁移提示。供应商限流与模型输出上限仍然有效。

## 迁移

1. 从网关环境文件与服务覆盖配置中删除这两个旧变量。
2. 部署 `services/muse-accounts/` 中的更新文件并重启网关。
3. 确认并行模型请求不再返回本地“模型请求过多”错误。上游 429 仍属于供应商失败，遵循客户端重试策略。

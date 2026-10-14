---
kind: upgrade-guide
description: Muse 模型网关移除管理员并发限制设置。
---

# Muse 模型中转并发

[English](guide.md) | 中文

## 变更

Muse 模型中转不再设置每账号或共享并发上限。Desktop 模型路由也移除自身的请求频率限制。网关环境设置 `MUSE_DESKTOP_MODEL_MAX_ACTIVE` 和 `MUSE_DESKTOP_MODEL_MAX_TOTAL` 已移除；存在任一设置都会停止启动并给出迁移提示。供应商限流与模型输出上限仍然有效。智谱官方凭据池现在按配置的每 Key 供应商额度，在同一网关进程内共同计入 Desktop 与云端请求；额度占满后进入可取消的有界队列，溢出或超时在调用供应商之前返回 503。其他进程与复制后直连的凭据不受此池协调。非法 `max_tokens` 或 `max_completion_tokens` 现在返回 400，不再自动转成默认值。

## 迁移

1. 从网关环境文件与服务覆盖配置中删除这两个旧变量。
2. 部署 `services/muse-accounts/` 中的更新文件并重启网关。
3. 使用智谱 Key 池时，将 `MUSE_ZHIPU_KEY_CONCURRENCY` 设为实际账号权益；初始默认值 20 不是供应商的通用保证。按部署需要设置 `MUSE_ZHIPU_QUEUE_LIMIT` 和 `MUSE_ZHIPU_QUEUE_TIMEOUT_MS`。输出额度传正整数，或省略以使用配置的模型默认值。
4. 确认并行模型请求不再返回本地“模型请求过多”错误。上游 429 仍属于供应商失败，遵循客户端重试策略。

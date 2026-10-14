---
kind: upgrade-guide
description: "首次技能发现不完整时会停止准备，不再发送缺少技能目录的模型请求。"
---

# 技能准备期限

[English](guide.md) | 中文

## 变更

首次技能目录不完整时，现在会在模型请求前失败。此前，请求可能在没有目录的情况下继续执行。后续发现失败时，仍可使用可见的最后一份可用目录。文件系统发现可取消，并受 `discoveryTimeoutMs`（30000 ms）限制；监视器启动受 `watchReadyTimeoutMs`（10000 ms）限制。

## 迁移

1. 修复无法读取的技能文件夹或失败的文件系统监视器后重试。无需迁移会话数据。
2. 对于确实较慢的文件系统，在 profile patch 的 `@deepseek-ai/dsh-skill-filesystem` 配置行设置 `discoveryTimeoutMs` 和 `watchReadyTimeoutMs`。两者均接受不超过 2147483647 ms 的正整数。
3. 确认新回合能够加载完整目录，或在联系模型前报告准备失败。取消等待中的回合应及时返回。

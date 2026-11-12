---
kind: upgrade-guide
description: "Muse 协调存储写入版本 2 记录，旧协调器构建无法恢复这些记录。"
---

# Muse 协调任务核对

[English](guide.md) | 中文

## 变更

可选 Muse 协调器在 `muse_coordination` 存储域写入版本 2 记录，当前读取器同时接受版本 1 记录。任务核对新增 `reconciling` 状态，并在新任务修订中保留已检查的执行会话输入位置。会话日志与此前任务修订保持完整。

旧构建不支持这些记录。JSON 逐条记录后端将不支持的版本视为不存在，因此用旧协调器打开已升级配置可能隐藏任务，这不是受支持的降级方式。汇报 metadata 同时允许新状态；旧 Client 可能显示原始工具结果，而非汇报卡片。

汇报和执行会话选择失败现在提供 `ToolArgsError` 与 `INVALID_ARGS`；缺少核对上下文时提供 `ToolContextUnavailableError` 与 `TOOL_CONTEXT_UNAVAILABLE`。调用方应读取这些字段，不再匹配此前无类型的错误文本。

## 迁移

1. 停止该配置的写入进程，备份完整 Harness 主目录，包括会话历史和 `muse_coordination` 存储域。并行测试实例使用独立主目录。
2. 同时升级 Host 协调器与 Client。自定义组合必须在协调器之前提供 `@deepseek-ai/dsh-session-projection`；随附配置已包含它。版本 1 记录无需清空任务历史即可读取，重写后的记录标记为版本 2。
3. 打开主会话，确认以前的任务与原执行会话仍可见。检查输入已变化且已空闲的执行会话后，用 `coordinator_reconcile` 请求新一轮核对汇报。该操作发送协调上下文，不重放原始用户业务命令。
4. 已升级配置持续使用兼容构建。需要回滚时，停止写入进程，将完整升级前备份恢复到独立主目录；不要将旧任务记录与新会话历史混用，也不要让两个进程同时写入同一主目录。

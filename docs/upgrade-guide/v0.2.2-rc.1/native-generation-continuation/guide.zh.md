---
kind: upgrade-guide
description: "视频自动续聊需要原 Session 绑定，新 inbox 必读事件不能被旧构建读取。"
---

# 原 Session 视频续聊

[English](guide.md) | 中文

## 变更

Desktop 在原普通 Session 中继续已完成的原生视频任务，保留提交时的聊天模型、推理级别、工作目录和工作区成员关系，不激活已归档的 DS Bot。用户后来的选择保持原样，不为了运行待处理任务而覆盖它。

Desktop 启用 `durableInboxClaims`。新的 claim 事件区分排队输入与已经送入模型的输入；暂停通知事件记录生产者卸载时移出的自动输入。这些是 Session 格式 4 中的必读事件，不认识它们的旧读取方拒绝该日志。既有日志代际不改写，未启用该选项的配置保持原事件顺序。[持久化确认记录](../../../persistence-changes/2026-11-10-native-generation-inbox-claims.zh.md)说明双向读取行为。

缺少可信原绑定的历史 watch 保留待处理。已经入档但结果不明的输入保留复核，不自动重放。提供方任务成功本身不代表内容或交付验收通过。

## 迁移

1. 保留活动 Harness home 中的原 Session 目录、视频账本、预览、回执及 `jubian/generation-watches/`。沿用原 key，不通过新建提交补救缺失的恢复证据。
2. 首次启动更新后的 Desktop 时遵循[工作区后继存储指南](../workspace-owned-storage/guide.zh.md)。这些 Session 使用更新后的构建，不支持用旧构建读取新增必读事件。
3. 核对 Session 与 Workspace ID、界面所示模型及推理级别保持不变。具备完整所有者服务时，新的原生提交会自动记录绑定。
4. 绑定缺失、工作区被替换或归档、模型变化，以及已入档请求结果不明时，须检查原记录。保留任务待处理，不改用其他对话、不恢复旧 Bot，也不重复付费请求。

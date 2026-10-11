---
kind: upgrade-guide
description: "原生聚变视频的剧集字段和候选扫描失败改用 VIDEO_TASK_EVIDENCE_INVALID，不再使用 CONTRACT_CHANGED。"
---

# 聚变原生视频任务证据

[English](guide.md) | 中文

## 变更

原生视频任务检查对无效剧集字段、剧集字段矛盾和候选扫描超限报告 `VIDEO_TASK_EVIDENCE_INVALID`，不再使用 `CONTRACT_CHANGED` 的远端信封提示。`JubianErrorCode` 的消费者需要处理这个新分类。`NativeClaimExpectation` 中的剧集 ID 可以为 null，调用方可提供独立的 `episodeCount`。缺失 ID 不再被转成零。已提供的剧集字段格式无效或相互矛盾时直接失败，不再静默扩大扫描范围。

## 迁移

1. 更新 `JubianErrorCode` 的消费者，将 `VIDEO_TASK_EVIDENCE_INVALID` 作为只读归属检查失败处理，不能因此重发收费请求。
2. 使用 `nativeEpisodeScope(preview.payload)` 构造原生认领期望；不要使用 `Number(null)`，也不要从 `episodeCount` 推断提供方 ID。
3. 保留现有 preview 文件与原幂等 key。已有 intent 只执行对账；不要删除账本记录或换 key 绕过检查。
4. 运行原生工具回归测试，确认缺失 ID 的 preview 可以排除明确属于其他集号的任务，而历史归属不明时会在新收费 PUT 前拒绝。不需要迁移 Session 或账本。

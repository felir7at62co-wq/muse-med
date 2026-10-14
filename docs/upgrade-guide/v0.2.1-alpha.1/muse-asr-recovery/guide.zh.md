---
kind: upgrade-guide
description: "云转写恢复不再为已结束且无法查询原提供方响应的极速版请求提供状态轮询。"
---

# Muse 转写恢复

[English](guide.md) | 中文

## 变更

以前，极速版同步识别请求结束后，结果未确定的收据仍可能建议反复查询状态。现在网关返回安全的 `service_version`、`provider_diagnostic` 和 `recovery` 元数据；桌面工具在收据及各音频分段中保存这些字段。`recovery.next_action: inspect_receipt` 配合 `capability: no_query` 会停止自动轮询，不授权再次付费提交。客户端网络错误仍须先向网关核对，不能直接认定提供方结果丢失。旧收据仍可读取。

尚未提交的排队任务可以分配给同一服务版本的空闲资源。已提交或结果未知的任务保留原应用、资源和任务 ID。标准版继续查询提供方的原任务。语音文字优先使用 ASR；已受理的排队任务不代表已取消，也不授权用 OCR 重复识别同一内容。

## 迁移

1. 按[账号网关部署说明](../../../../services/muse-accounts/README.zh.md)部署配套的网关和桌面端。保留所有现有收据引用的资源定义。按预期批量流量配置私密 ASR 配置中的 `requestRatePerMinute`；该参数不会增加提供方 QPS 或 Worker 授权额度。
2. 保留项目 `transcript/jobs/` 收据及其原 ID。不能自动创建新 ID 来恢复旧的极速版未知结果；明确要求的新尝试可能产生额外费用。
3. `audio_transcribe` 结果的消费者须遵循 `recovery.next_action` 并保存安全元数据。只有结果提供 `resume_status` 时才调用该原身份恢复命令。`poll_original` 查询原任务，`wait` 保留任务，`inspect_receipt` 报告响应未确定；`resume_upload` 仅允许对已确认未提交给提供方的音轨使用原 ID 补传。
4. 验证已结束的极速版请求返回 `inspect_receipt` 且不提供状态重试，可恢复的标准版任务保留原查询身份。队列及 OCR 分配规则见[转写工具说明](../../../../packages/drama/tool-audio-transcribe/README.zh.md)。

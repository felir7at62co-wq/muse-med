---
kind: upgrade-guide
description: 红果目录查询报告未验证的媒体可用性，并保留安全的上游错误信息。
---

# 红果原源可用性

[English](guide.md) | 中文

## 变更

目录查询不再于未查询媒体时宣称全集可下载。`hongguo_download_info` 返回 `fullSeriesAvailable: null` 和 `mediaUrlsVerified: false`；公开试看仍返回 `fullSeriesAvailable: false`。非公开模式的 `accessibleEpisodeCount` 为 null，不再采用未经验证的声明总数。原源 API 错误在有限尝试后保留安全的数字 `upstreamCode`、`sourceStage` 和 `retryable: false`，包括大写 `Code` 与 `BaseResp.StatusCode` 中的错误，不再误报为缺少媒体地址。

## 迁移

1. 更新[下载插件](../../../../third_party/plugins/muse-hongguo-download/README.zh.md)的调用方，接受可用性及开放集数为 null。只将 `completeCatalog` 用于判断目录完整性。
2. 使用 `hongguo_download` 收据、请求集覆盖情况及完整解码结果确认实际下载成功，不将目录查询当作下载验收。
3. 平台错误耗尽重试后，根据失败阶段与数字错误码诊断；不得推断该剧不可用或立即重复相同的已耗尽重试下载。

---
description: "供 BGM 使用方读取的音乐权利声明、明确的未知元数据及用途冲突提示。"
kind: "package-library"
---

# BGM 授权信息

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-bgm-license-info` 为曲库发布、候选匹配、下载、合成计划和渲染报告规范化音乐权利声明。它报告证据缺失及明确的商业用途冲突，不审批音乐使用权。

## 目录

- [声明字段](#declaration-fields)
- [使用方](#consumers)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="declaration-fields"></a>

## 声明字段

`license_info` 包含 `license`、`commercial_use`、`source`、`attribution`、`scope` 及派生的 `status`。文本字段缺失或为空时使用 `unknown`；`commercial_use` 是布尔值或 `unknown`。其中 `source` 标识权利依据，与音频 URL 或文件路径独立。`status=declared` 表示所提供字段完整，不表示已核验法律授权。缺失事实产生 `status=unknown`；声明 `commercial_use=true` 却缺少许可证、来源或范围时，其值变为 `unknown`。字段类型非法及不支持的审批状态会导致校验失败。不从文件名、情绪标签、下载成功、哈希或软件许可证推断使用许可。

`intended_use` 是 `commercial`、`non_commercial` 或 `unknown`。`licenseRiskWarnings` 报告声明不完整、用途未指定及 `commercial_use=false` 与商业用途的明确冲突。这些结果仅作提示；空列表也不授予使用权。自由文本的范围限制仍是来源声明，供操作者核对。

<a id="consumers"></a>

## 使用方

`normalizeLicenseInfo` 校验外部元数据；`LicenseInfoInputSchema` 为计划提供相同的规范化行为。`LICENSE_INFO_TOOL_SCHEMA` 和 `BGM_LICENSE_RECORD_TOOL_SCHEMA` 描述规范的工具结果。`BgmLicenseRecord` 将声明关联到曲目、音频来源及可选的曲库 ID 或摘要。本库不调用文件系统、网络或模型。

<a id="dev-note"></a>

## 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>

<a id="model-experience"></a>

## 模型体验

### 权利声明与提示

#### 模型看到的内容

使用方在既有工具结果中展示 `license_info` 和逐曲提示。本库本身不注册提示词或工具；`declared` 表示所提供事实，`unknown` 保留缺失证据而不授予许可。匹配模型的许可证仍独立处理。

#### Token 影响

新增声明及提示字段会按报告曲目数增加结果 token；本库不发起模型请求。

#### KV Cache 影响

使用方将字段追加到已记录的工具结果中。其正常对话记录与 schema 更新决定缓存复用；本库不改变缓存规则。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 结构校验不验证曲库发布者身份、不核验权利文件，也不能阻止作者提供虚假事实。调用方编写的计划仍是声明。本库不解释法律范围文本，也不替代独立的 MERT 许可证要求。它不填写或发布任何真实曲目的权利数据。

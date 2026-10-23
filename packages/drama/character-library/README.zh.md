---
description: "为人物参考提供有界、由 Host 管理的浏览、预览和推荐能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-character-library

[English](README.md) | 中文

## 概述

提供唯一的 Host 领域服务，用于浏览、查看、预览和确定性推荐公共人物参考。服务直接消费 `@deepseek-ai/dsh-character-asset-catalog` 的记录，不再定义一套 metadata 解析器。服务保持只读，不提供入库或使用授权。

每条记录仍然只是参考声明。`pending_review` 可以参与推荐，但 `canPublish`、`canReuse`、`canBind` 和 `applyAllowed` 始终为 `false`。目录资产、项目角色和供应商资产身份不会混合。

## 目录

- [使用本包](#use-this-package)
- [推荐策略](#recommendation-policy)
- [对象存储边界](#object-store-boundary)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

构造 `CharacterLibrary` 前，先注册 `CharacterLibraryObjectStore` provider。store 负责凭据、传输和部署就绪状态。`status()` 必须是零 I/O 的就绪检查；读取配置缺失或异常时返回 `configured: false`，所有读取操作都要在对象 I/O 前失败。

服务将逻辑来源固定为 `muse-character-reference-qa`，并且只读取以下两个已经审查的历史前缀：

- `assets/reference/characters/stylized/ancient/ancient/`
- `assets/reference/characters/stylized/urban/urban/`

`browse()` 有界列举 metadata 页面并返回目录投影。`detail()` 和 `preview()` 使用经过校验的目录 ID，在两个已审查前缀下各检查至多一个规范 metadata key，不会为精确查询列举整个目录；metadata 中的目录 ID、原始素材 ID 和 key 必须与该位置一致。`detail()` 不读取图片字节。`preview()` 通过目录加载器在内存中有界读取并核验一张图片，然后在固定像素和时间限制内完整解码结构有效的 JPEG、PNG 或 WebP 数据。Metadata 对象、目录身份、图片 key 或调用方给定的原图 SHA-256 发生变化时，预览会拒绝。任何方法都不会返回公开 URL 或改变目录审批状态。



<a id="recommendation-policy"></a>
## 推荐策略

`recommend()` 接收结构化角色需求，只返回 `recommended`、`needs_review` 或 `no_match` 之一。所有角色类型都可检索；Agent 根据剧本判断是否需要参考图。可选且有界的 `supportingUseReason` 仅写入解释，不进入目录 metadata，也不授予素材使用权限。

年代声明冲突时拒绝候选。最高分并列时返回 `needs_review`，不使用目录 ID 打破语义平局。这是内部复核状态，不是要求用户从候选列表中选择。消费方应只报告结果需要复核，不能将它解释为素材可应用。

`matchCandidates()` 沿用有界的 metadata 评分，排序后最多返回三张不同的候选，并核验每张原图、返回实测 SHA-256。超出上限时结果包含 `candidate_limit_reached`；Agent 可以细化需求后再次检索。排序只是初筛，不代表已经视觉选图或获得使用授权。Agent 消费方须另行把所选候选的实际图片作为持久化图片内容块提供给 Agent，并在依赖该选择前通过 `preview()` 复核目录 ID 和原图 SHA-256。

<a id="object-store-boundary"></a>
## 对象存储边界

`CharacterLibraryObjectStore` 只提供有界 List、Head 和 Get；不暴露入库、删除、复制、移动、ACL、策略或预签名 URL 操作。

本包不定义 TOS bucket、可变索引、凭据引用或 IAM 策略，也不注册 Agent 工具或生产 profile。

-----

<a id="model-experience"></a>
## 模型体验

### 人物参考推荐

#### 模型看到什么

本包不贡献模型工具、提示词或 Session 事件。独立的 Host 消费方可以暴露最多三张 `matchCandidates()` 候选，并提供实际图片内容供 Agent 查看。仅收到文字候选不代表 Agent 已看图；匹配与预览也都不授予生产使用权。

#### Token 影响

本包本身不增加模型 token。字段选择和输出长度由消费工具负责。

#### KV Cache 影响

本包不构建模型请求，也不定义缓存前缀行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Store/provider 配置、TOS 传输、IAM 和凭据属于部署包，不在本包内实现。
- 匹配排序是基于来源声明的确定性有界文本匹配。领域层核验图片字节和目录身份，但不做视觉判断，也不授予审批结论。
- `needs_review` 不授予应用权限，也不能变成面向用户的候选选择器。
- 生产 TOS 上传、索引发布、项目绑定、供应商生成和生产 Agent 注册均不可用。

<a id="dev-note"></a>
### 开发备注

不得新增第二套 metadata 解析器，也不得启用生产写入。

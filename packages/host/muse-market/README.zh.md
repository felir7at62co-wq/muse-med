---
description: "准备并保留经过校验的本地 Skill 发行归档，不启用其中的指令。"
kind: "package-reference"
---

# 本地 Skill 发行包

[English](README.md) | 中文

## 概述

准备、导入、校验、导出和移除包含完整资源的本地 Skill 发行包。当调用方需要经过校验的不可变本地归档时，在具名 `dsh` profile 中显式挂载 `@deepseek-ai/dsh-muse-market`。所有安装均保持停用，Desktop 默认不挂载该包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

能够解析该私有包的部署可在其具名 profile 的组合中挂载它：

```yaml
- id: muse-market
  name: '@deepseek-ai/dsh-muse-market'
  config:
    root: /absolute/private/muse-market
```

### 发行包生命周期


每个 ZIP 包含一个 Skill、其完整资源目录，以及记录所有资源 SHA-256 和字节数的 `muse-package.json`。路径必须同时适用于 Windows 和 POSIX，且不能包含私有配置名称。Bot 清单和插件行会被拒绝。导入版本以原始归档的 SHA-256 标识，重复导入保留同一安装记录。

所有安装均保持停用。存储操作不会注册 Skill provider，也不会执行指令、插件或脚本。`sources()` 保留注册表的发现完整性；不完整或空的观察结果不能证明其他 provider 中没有 Skill。

准备目录包时，会保留原始 `SKILL.md`、`whenToUse`、metadata、调用设置及全部资源字节。虚拟 Skill 保留其注册的指令和元数据。如果平铺 Markdown Skill 的资源目录还与其他 Skill 共享，则不能直接准备：请另建仅包含 `SKILL.md` 和预期资源的独立目录，注册该目录包后显式选中。服务不会移动或移除原 Skill。

### 存储与配置

`root` 指定私有绝对路径目录，默认使用解析后的 Harness 主目录下的 `muse-market`。`archiveBytes`、`expandedBytes`、`fileCount` 和 `recordBytes` 分别限制压缩归档、展开文件、条目数量以及完整清单和账本记录。插件加载时会校验配置。

`installations.json` 使用本包拥有的私有 version-1 格式。成功的原子账本替换才提交安装。替换失败会保留此前的安装记录；已完整写入但尚未引用的包缓存可能保留，复用前会重新校验。移除安装只删除账本记录，保留不可变缓存字节。导出会先校验归档和完整展开目录，再返回原始 ZIP。

如需保留本地发行包，请备份完整 `root` 目录。仅备份 Session 不会包含这份独立存储。无效或不支持的账本、链接、特殊文件以及已变化的资源都会被明确拒绝。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[归档编解码器](src/package.ts) 校验显式清单和文件摘要；[本地存储](src/local.ts) 负责不可变资源目录及原子安装账本。[服务](src/index.ts) 串行处理显式发行包操作，不注册 Skill provider。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [Skill 注册表](../../skill/skill/README.zh.md)——当前调用元数据和资源 provider。
- [文件系统 Skill](../../skill/skill-filesystem/README.zh.md)——发现现有用户和项目 Skill。
- [本地发行包备份](../../../docs/upgrade-guide/v0.2.2-rc.1/skill-publication-storage/guide.zh.md)——一同保留归档和安装账本。

<a id="model-experience"></a>
## 模型体验

### 由调用方负责的发行包结果

#### 模型看到的内容

显式调用方决定是否在对话中展示发行包结果。服务返回带 `complete` 的发现元数据、带 `enabled: false` 的已校验版本元数据，或用于导出的原始归档字节；它不贡献面向模型的 schema、提示词或 Skill provider，也不会把包中的指令插入模型请求。

#### Token 影响

默认模型请求不会收到这些结果。若调用方展示结果，相应工具历史或消息 token 由调用方负责；本包不组装模型请求，也不添加常驻指令。

#### KV 缓存影响

服务不改变现有模型请求前缀。额外 token 和前缀复用由消费者选取的结果内容及历史更新决定；provider 缓存是否可用不属于该服务的职责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 不提供启用、会话版本绑定、市场浏览界面、上传、审核或云端请求。本地安装不代表发行审核通过，也不代表获准执行 Skill。
- URL、opaque 以及由平铺 Skill 共享的资源根目录不能被准备为本地目录包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

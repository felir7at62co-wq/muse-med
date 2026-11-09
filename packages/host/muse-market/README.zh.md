---
description: "准备本地 Skill 发行包，并为每个 Session 选择精确版本。"
kind: "package-reference"
---

# 本地 Skill 发行包

[English](README.md) | 中文

## 概述

准备并保留完整的本地 Skill 发行包，为未来 Session 选择版本，并让已执行的 Session 保持其已记录版本。存储与激活相互独立：导入不会选择默认版本。私有 Desktop 组合挂载这两个组件；其他具名 `dsh` profile 可仅挂载存储，也可同时挂载两者。

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
- id: muse-market-activation
  name: '@deepseek-ai/dsh-muse-market/activation'
```

激活行没有独立配置，使用基础服务已解析的存储配置。仅需存储时可省略该行。

### 发行包生命周期

每个 ZIP 包含一个 Skill、其完整资源目录，以及记录所有资源 SHA-256 和字节数的 `muse-package.json`。路径必须同时适用于 Windows 和 POSIX，且不能包含私有配置名称。Bot 清单和插件行会被拒绝。导入版本以原始归档的 SHA-256 标识，重复导入保留同一安装记录。

六个基础发行包方法保持原有存储语义。`installed()` 记录保留 `enabled: false` 这一旧有存储字段，不表示激活状态；激活状态请通过下述观察接口读取。仅挂载存储时不会注册 Skill provider，也不会执行指令、插件或脚本。`sources()` 保留发现完整性；不完整或空的观察结果不能证明其他 provider 中没有 Skill。

准备目录包时，会保留原始 `SKILL.md`、`whenToUse`、metadata、调用设置及全部资源字节。虚拟 Skill 保留其注册的指令和元数据。如果平铺 Markdown Skill 的资源目录还与其他 Skill 共享，则不能直接准备：请另建仅包含 `SKILL.md` 和预期资源的独立目录，注册该目录包后显式选中。服务不会移动或移除原 Skill。

### 默认版本与 Session 绑定

`ctx.museMarketActivation.defaults()` 返回激活修订号及完整默认选择。`setDefault({skillName, expected, target})` 显式选择已安装归档的 SHA，或通过 `target: null` 停用该默认值；`expected` 为此前观察到的 SHA 或 null。过期选择会以 `default-conflict` 拒绝；重复选择已生效的目标具有幂等性。已有绑定的 Session 不会改变。

在参与激活的 Session 首次模型请求之前，激活组件通过必读的 `muse-market/bound` 记录完整版本集合。继承完整前缀的 fork 继承该已记录集合。`binding({sessionId})` 对固定选择返回 `bound`，对尚未执行且预览当前默认值的 Session 返回 `blank`，对已执行但无绑定事件、且不使用市场 Skill 的 Session 返回 `legacy`。空白 Session 在首次任务时选择当时的默认值。现有 Skill 目录、加载器和调用控制使用所选版本。

缓存字节缺失或变化时，已记录候选项仍可见，但加载会明确拒绝；不会用更低优先级的 Skill 或更新的默认值替代它。请从备份恢复精确的 ZIP 及匹配的展开资源。移除默认版本前必须先停用其默认选择；仍被 Session 绑定引用的版本依然拒绝移除。

### 存储与配置

`root` 指定私有绝对路径目录，默认使用解析后的 Harness 主目录下的 `muse-market`。`archiveBytes`、`expandedBytes`、`fileCount` 和 `recordBytes` 分别限制压缩归档、展开文件、条目数量以及完整清单和账本记录。插件加载时会校验配置。

存储可读取私有 version-1 和 version-2 `installations.json` 记录。加载激活组件时，会以空默认集合将 version 1 迁移到 version 2，并通过独占创建的 `installations.v1.backup.json` 保留原始字节。备份冲突或后继记录超限时，会在替换账本前拒绝。成功的有界原子替换才提交变更；失败时保留此前账本。移除未使用的安装记录会保留不可变缓存字节。导出会先校验归档和完整展开目录，再返回原始 ZIP。

如需保留本地发行包，请备份完整 `root` 目录。仅备份 Session 不会包含这份独立存储。无效或不支持的账本、链接、特殊文件以及已变化的资源都会被明确拒绝。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[归档编解码器](src/package.ts) 校验清单和资源摘要；[本地存储](src/local.ts) 负责不可变包及原子记录。[基础服务](src/index.ts) 串行处理发行包操作。[激活组件](src/activation.ts)、[绑定投影](src/session.ts)和 [Skill provider](src/skills.ts) 保留并解析精确的 Session 选择。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [Skill 注册表](../../skill/skill/README.zh.md)——当前调用元数据和资源 provider。
- [文件系统 Skill](../../skill/skill-filesystem/README.zh.md)——发现现有用户和项目 Skill。
- [本地发行包备份](../../../docs/upgrade-guide/v0.2.2-rc.1/skill-publication-storage/guide.zh.md)——一同保留归档和安装账本。

<a id="model-experience"></a>
## 模型体验

### 发行包结果与所选 Skill

#### 模型看到的内容

显式调用方可展示存储结果：带 `complete` 的发现元数据、带 `enabled: false` 的版本元数据，或导出的归档字节。挂载激活组件后，现有 Skill 消费者展示所选目录元数据，并加载完整的指令正文及资源位置。`muse-market/bound` 记录这些消费者使用的精确选择。

#### Token 影响

展示存储结果会消耗调用方消息 token。激活组件通过现有 Skill 目录加入所选条目；加载时加入完整的所选指令和资源位置。资源文件按需另行读取，不会全部预先插入。

#### KV 缓存影响

更改默认值不会替换已有绑定的 Session 版本集合。请求前缀的变化与复用由其目录、已加载指令和普通对话历史决定；不保证 provider 缓存可用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 不提供有界目录展示、市场浏览界面、上传、审核或云端请求。本地存储或激活不代表发行审核通过，也不代表获准执行 Skill。
- URL、opaque 以及由平铺 Skill 共享的资源根目录不能被准备为本地目录包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

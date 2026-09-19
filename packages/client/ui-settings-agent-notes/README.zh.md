---
description: "dsh Web 客户端的 Agent 笔记设置分区：按分类浏览部署所配置笔记目录下的 markdown 笔记，搜索它们，并就地编辑单篇笔记。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-agent-notes

[English](README.md) | 中文

## 概述

**Agent 笔记**设置页让你不离开 Web GUI 就能浏览部署所配置笔记目录下的 markdown 工程笔记，并就地编辑其中一篇。笔记按分类分组，可按标题、id 或状态搜索；打开一篇会看到渲染后的 Markdown，选择「编辑」则在同样的字节上切换到原始文本编辑器。每次保存都会带上读取时返回的版本令牌，因此在别处被改动过的笔记会被拒绝并重新读取，而不是被静默覆盖。本页既不创建也不删除笔记，它渲染的任何内容都不会进入模型上下文。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开设置并选择 **Agent 笔记**，即可浏览宿主 `agentNotes` 命名空间所提供的笔记树。请把 `@deepseek-ai/dsh-client-ui-settings-agent-notes` 挂载到已经提供设置外壳与该宿主命名空间的 Web 组合中；本页会注册自己的导航条目，本身不需要任何配置。

### 阅读目录

本页列出所配置根目录下的笔记，按宿主从笔记 id 推导出的分类分组：直接放在根目录里的笔记归入「未分类」，而每组保持宿主自己的列出顺序。每一行显示笔记标题、它的末尾文件名，以及笔记声明状态时的状态标签；页头指明笔记目录与本次列出的笔记数量。搜索框按标题、笔记 id 或状态过滤已加载的目录。尚不存在的笔记根目录会连同路径一起说明，而不会被当成空目录；空目录与无匹配的查询给出不同提示；被宿主截断的列表会明确说明，而不是悄悄缩短目录树。

### 打开并编辑笔记

选中一行会打开该笔记，页头显示它的标题与 id，随后是可选的状态标签与渲染后的 Markdown。选择「编辑」会用覆盖笔记原始 Markdown 的文本域替代渲染视图；草稿与读取返回的文本一致时「保存」保持禁用，「取消」则恢复该文本。保存会连同这次编辑所依据读取的版本令牌提交完整草稿，写入成功后目录会重新读取。

### 在别处被改动的笔记

读取之后被改动过的笔记会被宿主拒绝写入，而不是被覆盖：本页会说明该笔记在别处被改过，重新读取它的最新文本，并把你的草稿留在编辑器里，因此已输入的内容不会丢失。读取失败会展示宿主自己的诊断信息，宿主未给出信息时回退到该失败的稳定错误码；写入失败会让编辑器保持打开，以便再次尝试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是浏览器半边，Host 入口刻意留空：`src/index.ts` 导出一个什么都不做的 `apply`，该行的存在只是让 Loader 能挂载这个由浏览器 bundle 注册页面的包。

### 注册与数据流

`apply()` 在 `ctx.effect` 释放器内注册本包自己的 `settings.agentNotes` locale 命名空间，绑定它，并贡献一个 `settings.section` 条目：id 为 `agent-notes`、顺序 30、随语言变化的导航标签，以及该命名空间作为它的 locale。该贡献经 `ctx.slots.inject('settings.section', …)` 完成，因此延迟声明的分区 slot 仍能到达本页，而卸载 fiber 会同时释放座位与字典。插件还 inject 了 `slots`、`locale`、`remote` 与 `remote.agentNotes`，因此它会等待生成命名空间出现，而不是半激活。注入面把每个 Remote 结果都转成值——`{ ok: true, … }` 或 `{ ok: false, code, message }`——因此本页渲染宿主失败，而不是把它抛出。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host Loader 入口：一个空的 `apply`，让该行可被挂载，页面则由浏览器半边拥有 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件：locale 命名空间、`settings.section` 注册，以及注入的 `list`/`read`/`save` 面 |
| [`src/client/AgentNotesSection.tsx`](src/client/AgentNotesSection.tsx) | 页面本体：目录分组、搜索、渲染与编辑两种视图，以及保存结果 |
| [`src/client/locales.ts`](src/client/locales.ts) | 所有可见与无障碍字符串的中英文字典 |
| [`src/client/AgentNotesSection.module.css`](src/client/AgentNotesSection.module.css) | 页面样式 |
| — | 不发布运行时不变量伴生入口：这个浏览器侧分区只持有一个基于既有 Remote 命名空间的本地化贡献，不拥有可变的跨插件关系。 |

本页只持有视图状态——查询、打开的笔记、它的草稿，以及读取时得到的版本令牌——而笔记根目录、笔记 id 语法、根目录内的包含检查与版本闸门都由宿主拥有，因此这里既不决定笔记 id 可以指向什么，也不决定写入何时被允许。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖承载本页的设置表面、它背后的 Remote 命名空间，以及两者所处的浏览器分层。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 与设置作用域服务的领域底座。
- [ui-settings-general](../ui-settings-general/README.zh.md)——导航中列出并挂载本页的设置外壳。
- [api-remotes](../../api/remotes/README.zh.md)——在浏览器中挂载 `ctx.remote.agentNotes` 的 Remote BFF。
- [ui-primitives](../ui-primitives/README.zh.md)——本页读取笔记所用的共享控件与 Markdown 渲染器。
- [Web 客户端子系统](../../../docs/subsystems/web-client.zh.md)——浏览器分层、Remote 通信与连接恢复。
- [客户端包映射](../README.zh.md)——相邻的浏览器包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是 `agentNotes` Remote 命名空间之上的浏览器侧设置分区；它只渲染和编辑用户撰写的笔记，不注册任何工具、提示词段落或会话事件。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定本页能对笔记树做什么；它们是当前包约束。

- **只能编辑，不能创建**：保存只会替换已存在笔记的文本；本页无法创建、重命名或删除笔记，而在列出之后被移除的笔记会以读取失败报告。
- **目录是一份快照**：本页在挂载时、保存成功后以及你选择「重新读取」时读取目录；它不监视笔记目录，因此 agent（智能体）或其他编辑器写入的笔记要重新读取后才会出现，被宿主截断的列表也只显示前一部分。
- **过期保存被拒绝，而不是合并**：写入会带上这次编辑所依据读取的版本令牌；如果文件在此期间被改动，宿主会拒绝写入，本页重新读取最新文本，而你的草稿会留在编辑器里由你手动重新套用。
- **未保存的草稿不会被保留**：返回列表会直接丢弃编辑器且不作询问，本页也不保留按笔记区分的草稿，因此离开一篇笔记是丢失已输入文本的唯一无提示途径。
- **要么渲染，要么原文**：笔记视图只显示渲染后的 Markdown 或原始文本编辑器之一，因此既没有并排预览，也没有与读取文本的差异对比。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

随附 Web graph 在 web-app bundle patch 中挂载本行，而笔记根目录属于其中的宿主 `agentNotes` 行：除非部署设置 `DSH_AGENT_NOTES_ROOT`，或在更晚的 patch 层覆盖 `root`，它的默认值是 `<process cwd>/.agents/notes`。

</details>

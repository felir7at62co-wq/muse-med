---
description: "面向 Web GUI 的 Agent Notes 服务：把某个已配置笔记根下的 markdown 笔记呈现为按类别排序的标题事实清单，读取单篇笔记的完整文本及其保存必须出示的版本，并在版本围栏下写回、绝不新建文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-agent-notes

[English](README.md) | 中文

## 概述

使用本包可在 Web 设置页中浏览和编辑某个已配置根下的 markdown 工程笔记。它把该目录树列出为按类别排序的标题事实清单，读取单篇笔记的完整文本及其保存必须回传的版本令牌，并且只在令牌仍然匹配时替换该文本。笔记 id 是相对于根的路径，因此解析后逃出根的笔记无法触达，而保存绝不新建笔记。Host 通过 `agentNotes` Remote 命名空间提供这三项操作。

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

在已提供 `ctx.fs` 的组合中挂载 `@deepseek-ai/dsh-api-agent-notes`；本服务声明 `fs`，行必须提供 `root`。随仓库发布的 Web Client 组合把它挂载为 `agent-notes` 行，其 `root: process.env.DSH_AGENT_NOTES_ROOT ?? process.cwd() + '/.agents/notes'` 即仓库本地约定；笔记位于其他检出时，部署在自己的后续补丁层中覆盖 `root`。笔记根是部署事实而非会话事实，因此一行服务所有 Session，未绑定 Session 的设置页也依然能触达它。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 存放笔记树的目录；服务存储 `join(root)`，因此相对值按 Host 进程工作目录解析，而省略该字段会让挂载失败，而不是悄悄读取无人指定的树 |
| `maxNotes` | `2000` | 单次列举报告的笔记数上限；更大的树被截断并报告为 `truncated` |

该命名空间恰好提供三个 Remote 方法，全部限定于已配置的根，且都不接受来自浏览器的文件系统路径：

| 方法 | 返回 | 用途 |
|---|---|---|
| `list()` | `AgentNotesCatalog { state, root, notes, truncated }` | 根下的每篇笔记及其标题事实，先按类别、再按标题排序 |
| `read(id)` | `AgentNoteText { id, title, status?, text, version, bytes }` | 单篇笔记的完整文本，以及后续保存必须出示的版本令牌 |
| `save(id, text, expectedVersion)` | `AgentNoteWriteResult { id, version, bytes }` | 在 `expectedVersion` 仍为当前版本时替换单篇笔记的完整文本 |

### 笔记清单

`list` 只报告普通 `.md` 文件，行的类别取自其自身 id 的首个片段，因此直接位于根下的笔记没有类别。遍历最多下降八层目录，更深的目录会被跳过且不予报告。尚未创建的根是正常的空状态 `state: 'absent'`，没有任何行；而存在但不是目录的根会让该调用以 `agent-note/not-regular-file` 失败。`maxNotes` 会中止遍历并置 `truncated`。标题、`status` 与 `summary` 来自每篇笔记自身的文本，`modifiedMs` 仅在 Host 能观察到该文件修改时间时出现。

### 笔记 id 与根边界

笔记由 id 命名：从笔记根开始、以 `.md` 结尾的 `/` 分隔路径，例如 `implemented/architecture/2026-06-13-capability-seams.md`。每个片段至少要有一个字母或数字，其余字符只能是字母、数字、`_`、`-` 和 `.`；反斜杠被直接拒绝，而不是当作分隔符。因此绝对路径、盘符、UNC 前缀、`..` 片段、百分号编码名称、含 NUL 的名称以及非 markdown 路径都到不了文件系统，会以 `agent-note/bad-id` 失败。随后解析出的目标必须仍位于规范根内（用 `ctx.fs.contains` 检查），因此经链接逃出的路径以 `agent-note/outside-root` 被拒。末端条目在解析跟随它之前先用 `lstat` 检查，因此目录或链接形式的笔记以 `agent-note/not-regular-file` 失败，而不会被读取穿透。

### 保存笔记

`save` 替换单篇笔记的完整文本，绝不新建：背后没有笔记的 id 以 `agent-note/not-found` 失败。写入由调用方读到的版本围栏，因此跨越他人写入而仍然打开的编辑器会以 `agent-note/stale` 失败，更新的字节保持原样，而不会被悄悄覆盖。被接受的保存报告笔记的新版本与字节数，也就是下一次保存必须出示的令牌。文本不是字符串时，是协议的 `gateway/bad-request`。

### 失败

每种拒绝都是一个带类型化 details 的 `RemoteError` 代码，声明于 [`src/types.ts`](src/types.ts)：`agent-note/bad-id`、`agent-note/not-found`、`agent-note/not-regular-file`（带 `kind`）、`agent-note/outside-root` 以及 `agent-note/stale`。调用方按代码分支，绝不按消息文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 设计概念

一个服务持有一个已配置的根：`AgentNotes` 继承 `TypertRemoteService`、声明 `fs` 并发布 `agentNotes` 命名空间，所有文件操作都走 `ctx.fs`，因此换入沙箱后端或远程后端无需改动本包。唯一的例外是修改时间：组合文件系统暴露不透明的版本与大小，却不暴露挂钟时间，所以 `list` 对文件系统自己解析出的路径读取一个 `stat` 字段；目标不在 Host 自身命名空间中的后端，其行就不带时间。

行的 id 由两个解析后的目标派生，而不是在遍历过程中拼接，因此它始终指向被列举的那个文件，同一个值也能原样通过 `read` 与 `save` 校验的 id 语法。标题事实是对不可信笔记内容的纯文本解析：front matter 的 `title`、`status` 与 `description`，`# Agent Note:` 标题，普通 `# ` 标题，`Status:` 行，以及正文首个散文行，优先级依次递减，最后才回退到文件名主干。解析器读不懂的笔记仍会列出，因为本包从不改写笔记内容。版本令牌是不透明的，直接回传给文件系统的 `replaceIfVersion` 写入；后端的过期版本拒绝按其稳定代码识别，而不按类身份识别，因为那个类属于提供方加载的那份 `dsh-fs` 实例。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `AgentNotes`：`agentNotes` 服务与 Remote 命名空间、`Config`、id／包含性／普通文件三道关、有界清单遍历、`list`、`read` 与 `save` |
| [`src/types.ts`](src/types.ts) | 线路类型（`AgentNotesCatalog`、`AgentNoteSummary`、`AgentNoteText`、`AgentNoteWriteResult`）与 `RemoteErrorDetailsMap` 错误码，以 `./types` 发布给 Client 包 |
| [`src/note-text.ts`](src/note-text.ts) | 纯笔记文本处理：`noteIdSegments`、`noteStem`、`readHeadline` 与 `NoteHeadline` |
| — | 不发布运行时 invariant 伴生件；每个边界答案都在调用时由 `ctx.fs` 与已配置的根推导。 |

Typert 生成 `./typert` 与 `./remote` 暴露的 Host 与 Client Remote 产物。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

浏览器端的 Agent Notes 分区（`@deepseek-ai/dsh-client-ui-settings-agent-notes`）是本命名空间的消费方；以下页面覆盖它借以读取的能力、它作答的传输层，以及其清单所解析的笔记约定。

- [文件系统能力](../../fs/fs/README.zh.md)——本服务经由读写的 `ctx.fs` 约定，含 `resolve`、`listDir`、`readText`、`writeText`、`lstat` 与 `contains`。
- [Remote 装配](../../api/remotes/README.zh.md)——Client 包如何触达 `agentNotes` 命名空间。
- [Typert 协议](../../typert/protocol/README.zh.md)——`TypertRemoteService`、`@Remote` 标记，以及拒绝所携带的类型化 `RemoteError` details。
- [设置外壳](../../client/ui-settings/README.zh.md)——在 Remote 命名空间之上渲染设置分区的界面。
- [Agent Note 约定](../../../.agents/notes/README.zh.md)——清单标题事实所读取的标题行、`Status:` 行与 front matter。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包在 `ctx.fs` 之上服务于 Web 设置界面：它不注册工具、不贡献提示词章节、不追加会话事件，并且它存储的笔记是用户撰写的文件，而不是模型上下文。

#### KV Cache 影响

无；本包既不装配也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **保存只能编辑已存在的笔记**——本服务替换已存在笔记的完整文本，绝不新建、重命名或删除笔记，因此撰写新笔记仍归笔记树的主人（人或 agent）负责。
- **清单会读取每篇笔记**——每行的标题、`status` 与 `summary` 都来自笔记自身文本，因此一次列举会读取它报告的（最多 `maxNotes` 个）每个 markdown 文件。
- **上限在排序之前截断**——`maxNotes` 按文件系统枚举顺序中止遍历，存活的行之后才排序，因此被截断的清单报告哪些笔记取决于 `listDir` 返回的顺序，而不是清单自身的顺序。
- **过深的目录会静默消失**——遍历会跳过位于根下八层之外的目录而不置 `truncated`，因此那么深的笔记会从一份报告未截断的清单中缺席。
- **`modifiedMs` 需要 Host 可见的路径**——修改时间来自对文件系统所解析路径的一次 `node:fs` stat，因此目标不在 Host 自身命名空间中的远程或沙箱后端，其行不带时间。
- **front matter 解析有意不完整**——只读取简单的 `key: value` 标量，因此 `status` 或 `description` 以嵌套结构、块标量或多行值出现的笔记，会按其首个标题或文件名主干列出。
- **`agent-note/root-absent` 已声明但从未抛出**——已发布的错误映射声明了该代码，当前没有任何操作产生它，因为未创建的根会回答 `state: 'absent'`；据此分支的 Client 永远走不到该分支。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

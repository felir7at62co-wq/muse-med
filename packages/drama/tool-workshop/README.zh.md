---
description: "让 Muse 把写完的剧本上传到剧本工坊定稿库并为投产取回，以及为云端草稿提交单集修改候选供审阅。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workshop

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-workshop` 注册 Muse 的剧本工坊工具，它们通过 `ctx.workshopConnection` 以当前登录的 Muse 用户身份工作。`script_finalize` 在用户同意定稿后把写完的剧本上传到定稿库；`script_library` 把定稿库里的一版剧本取回，并登记它投产成的镜流项目。`workshop_script_editor` 读取云端草稿，并提交单集候选稿供编辑审阅。

## 目录

- [使用本包](#use-this-package)
- [定稿剧本](#finalized-scripts)
- [云端草稿编辑](#cloud-draft-editing)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Agent 预设中挂载本插件；Desktop 的 `short-drama` 与 `short-drama-v2` 预设挂载本插件。本插件没有配置项。Host 提供 `@deepseek-ai/dsh-workbench-connection` 的 `workshopConnection` 后才注册 `workshop_script_editor`，该服务消失时移除工具，因此没有工坊连接的组合不提供工坊工具。`script_finalize` 和 `script_library` 还需要 `fs` 与 `sandboxPolicy` 服务，按当前对话的工作区解析路径。在 Desktop 组合中，这三个工具归在「剧本工坊」能力下，经 `tool_search` 按需加载，都不常驻。

<a id="finalized-scripts"></a>
## 定稿剧本

`script_finalize` 把写完的剧本上传为该成员定稿库条目的新版本：`POST /script-library`，带剧名、版权、剧本形式、画面风格、原作在数据站的编号和每集正文。文件里有「第N集」标题时按标题拆分；没有时取文件名里的数字，否则按在列表中的位置。工具先按工坊的限制检查（最多 300 集、每集 60,000 字、全剧 3,000,000 字），并指出出问题的集。同一成员同名的条目接收新版本，正文没变则不新增。授权改编需要 `origin`。工坊没有确认上传时，工具以 `WORKSHOP_FINALIZE_OUTCOME_UNKNOWN` 失败。在 Desktop `short-drama-v2` 预设中，`muse-manuscript-delivery` 生效后工具才能运行，该技能要求 Muse 定稿前先用 `ask_user_question` 问用户。

`script_library` 的 `read` 把一版剧本（默认最新版）写到工作区的 `剧本库/<剧名>-v<版本>/第NNN集.md`，每个文件以「第N集」标题开头，`script_finalize` 读回时仍是同样的分集，并返回路径。`link` 用 `POST /script-library/{id}/production` 登记被选用剧本的镜流项目 ID 和项目名，剧本随之变为已投产。选用版本是组长在客户端「剧本」标签里的操作，不是工具操作。

-----

<a id="cloud-draft-editing"></a>
## 云端草稿编辑

`workshop_script_editor` 在「剧本工坊」能力下按需加载，可搜索当前成员可见的草稿，查看分集目录、大纲和故事设定，并逐集读取已保存的正文和版本。

提交候选时带上本集保存版本、改后的完整正文和简短说明。编辑在「剧本」面板查看候选，只有在该面板采纳才会写入草稿。如果保存版本已变更，先读取最新正文，再根据需要准备候选稿。

<a id="further-exploration"></a>
## 进一步探索

- [工作台连接](../workbench-connection/README.zh.md) —— 这些工具如何以 Muse 用户身份登录剧本工坊。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-workshop) —— 生成的参数定义。

-----

<a id="model-experience"></a>
## 模型体验

### 定稿剧本工具

#### 模型看到的内容

两个定义都归在「剧本工坊」能力下按需加载。`script_finalize` 返回剧本编号、剧名、版本、正文是否有变化、阶段和规模；`script_library` 的 `read` 返回版本、阶段、文件夹和文件路径，`link` 返回阶段和项目。

#### Token 影响

每个加载的定义增加一份固定的参数定义。`read` 结果每集列一个路径，最多 300 个；剧本正文写进工作区文件，不进入结果。

#### KV Cache 影响

定义固定；结果追加在可复用前缀之后。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **模型不能选用** —— Muse 不能选用版本；组长在客户端「剧本」标签里选用，没人选用的剧本工坊会拒绝 `link`。
- **`read` 会覆盖** —— `read` 直接替换同一版本文件夹里的文件，不检查本地改动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

工坊一侧在 [`services/workshop`](../../../services/workshop/README.zh.md)：定稿库是 `backend/app/script_library.py`，草稿编辑路由是 `backend/app/script_editor.py`。

</details>

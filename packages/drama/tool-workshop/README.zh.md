---
description: "让 Muse 开始、停止、续跑和查看剧本工坊的视频转剧本工厂任务，把写完的剧本上传到工坊定稿库，并为投产取回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workshop

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-workshop` 注册 Muse 的剧本工坊工具，它们通过 `ctx.workshopConnection` 以当前登录的 Muse 用户身份工作。`workshop_video_transcribe` 按工坊流水线卡片的五个参数查看、开始和停止视频转剧本工厂任务：任务从数据站爆款队列领剧，下载红果整剧，用云端 Muse 逐集转写，再把结果存为工坊剧本。`script_finalize` 在用户同意定稿后把写完的剧本上传到定稿库；`script_library` 把定稿库里的一版剧本取回，并登记它投产成的镜流项目。

## 目录

- [使用本包](#use-this-package)
- [操作](#actions)
- [定稿剧本](#finalized-scripts)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Agent 预设中挂载本插件；所有 Bot 使用的 Desktop `short-drama` 预设已无配置挂载。Host 提供 `@deepseek-ai/dsh-workbench-connection` 的 `workshopConnection` 后才注册工具，该服务消失时移除工具，因此没有工坊连接的组合不提供工坊工具。开始或续跑任务时通过 Host `approval` 服务征求用户确认；没有该服务时 `start` 和 `resume` 以 `WORKSHOP_APPROVAL_REQUIRED` 失败。在 Desktop 组合中，本工具归在「剧本工坊」能力下，经 `tool_search` 按需加载，不常驻。`script_finalize` 和 `script_library` 还需要 `fs` 与 `sandboxPolicy` 服务，按当前对话的工作区解析路径；两者归在同一能力下。

<a id="actions"></a>
## 操作

| 操作 | 工坊请求 | 结果 |
| --- | --- | --- |
| `status` | `GET /factory/video-transcribe/status`，再 `GET /factory/jobs?limit=50` | `{ service, jobs }`：是否就绪、数据站队列计数、`max_slots`，以及最新十个视频转剧本任务的状态、进度说明和出稿、待处理、选材未通过的数量 |
| 带 `job_id` 的 `status` | 先查就绪状态，再 `GET /factory/jobs/{job_id}` | `{ service, job }`：任务参数、各转写位状态，以及每类结果最新 20 条 |
| `start` | 先查就绪状态，经用户确认后 `POST /factory/jobs`，`job_type` 为 `video_transcribe` | `{ job_id, config }`，含实际发送的参数 |
| `stop` | `GET /factory/jobs/{job_id}`；任务等待中或运行中时 `POST /factory/jobs/{job_id}/stop`，再读一次任务 | `{ stop_requested, job }` |
| `resume` | `GET /factory/jobs/{job_id}`；任务已停止、失败或已完成时先查就绪状态，经用户确认后 `POST /factory/jobs/{job_id}/resume`，再读一次任务 | `{ resumed, job }` |

`start` 沿用流水线卡片的默认值：`count` 为 0（持续运行直到停止）、`concurrency` 为 1、`quality` 为 `720p`、`publish` 为 false、不设 `only_series`（按队列顺序）。`concurrency` 不能超过部署的 `max_slots`；`only_series` 接收 15 到 25 位的红果作品编号并去重。步骤未就绪时以 `WORKSHOP_TRANSCRIBE_UNAVAILABLE` 失败，并附上运维给出的原因。工坊没有确认新任务时，`start` 以 `WORKSHOP_JOB_OUTCOME_UNKNOWN` 失败，并提示模型先用 `status` 核对再重试。其他类型的任务以 `WORKSHOP_NOT_TRANSCRIBE_JOB` 失败；其他用户的任务或不存在的任务以 `WORKSHOP_JOB_NOT_FOUND` 失败。停止会保留已领取的每部剧；已结束的任务返回 `stop_requested: false`，不发送停止请求。`resume` 沿用原任务保存的参数和已领取的剧继续运行，确认卡片列出这些参数。仍在等待或运行的任务，或工坊返回 409 时已重新运行的任务，返回 `resumed: false`。工坊没有确认 `resumed: true` 时，调用以 `WORKSHOP_RESUME_UNSUPPORTED` 失败。

待执行卡片的标题写明操作和任务，`start` 卡片显示补全默认值后的参数。完成卡片的标题取自持久化的结果要点：新任务、停止请求、任务状态与百分比，或就绪状态与任务数量。

<a id="finalized-scripts"></a>
## 定稿剧本

`script_finalize` 把写完的剧本上传为该成员定稿库条目的新版本：`POST /script-library`，带剧名、版权、剧本形式、画面风格、原作在数据站的编号和每集正文。文件里有「第N集」标题时按标题拆分；没有时取文件名里的数字，否则按在列表中的位置。工具先按工坊的限制检查（最多 300 集、每集 60,000 字、全剧 3,000,000 字），并指出出问题的集。同一成员同名的条目接收新版本，正文没变则不新增。授权改编需要 `origin`。工坊没有确认上传时，工具以 `WORKSHOP_FINALIZE_OUTCOME_UNKNOWN` 失败。在 Desktop `short-drama-v2` 预设中，`muse-manuscript-delivery` 生效后工具才能运行，该技能要求 Muse 定稿前先用 `ask_user_question` 问用户。

`script_library` 的 `read` 把一版剧本（默认最新版）写到工作区的 `剧本库/<剧名>-v<版本>/第NNN集.md`，每个文件以「第N集」标题开头，`script_finalize` 读回时仍是同样的分集，并返回路径。`link` 用 `POST /script-library/{id}/production` 登记被选用剧本的镜流项目 ID 和项目名，剧本随之变为已投产。选用版本是组长在客户端「剧本」标签里的操作，不是工具操作。

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作台连接](../workbench-connection/README.zh.md) —— 本工具如何以 Muse 用户身份登录剧本工坊。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-workshop) —— 生成的参数定义。

-----

<a id="model-experience"></a>
## 模型体验

### 视频转剧本工具

#### 模型看到的内容

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-workshop)记录参数定义和说明。在 Desktop 组合中，定义只在 `tool_search` 加载后才进入请求；「剧本工坊」能力和搜索关键词会提到它。每个成功结果是操作及其报告字段的 JSON；失败带 `WORKSHOP_*` 或 `INVALID_ARGS` 代码和中文消息。

#### Token 影响

加载后的定义增加一份固定的参数定义。`status` 列表每个任务约一行，最多十个；单个任务的报告受转写位数量和每类结果 20 条的限制，标题和原因各截至 200 字，约 2,000 token 以内。

#### KV Cache 影响

定义文本固定；按需加载后会加入该对话之后的请求。结果是追加在可复用前缀之后的普通工具结果。

### 定稿剧本工具

#### 模型看到的内容

两个定义都像视频转剧本工具一样，归在「剧本工坊」能力下按需加载。`script_finalize` 返回剧本编号、剧名、版本、正文是否有变化、阶段和规模；`script_library` 的 `read` 返回版本、阶段、文件夹和文件路径，`link` 返回阶段和项目。

#### Token 影响

每个加载的定义增加一份固定的参数定义。`read` 结果每集列一个路径，最多 300 个；剧本正文写进工作区文件，不进入结果。

#### KV Cache 影响

定义固定；结果追加在可复用前缀之后。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **续跑需要更新后的剧本工坊** —— `POST /factory/jobs/{id}/resume` 没有视频转剧本分支的工坊版本会按大纲恢复作答；本工具此时报告 `WORKSHOP_RESUME_UNSUPPORTED`，不会当作已续跑。
- **不检查重复开始** —— 另一个视频转剧本任务运行时 `start` 不会拒绝；任务共用部署的转写位，第二个任务只占用空闲的转写位。
- **只看最近的任务** —— 不带 `job_id` 的 `status` 只扫描最新 50 个各类工厂任务；更早的视频转剧本任务需要提供 `job_id`。
- **模型不能选用** —— Muse 不能选用版本；组长在客户端「剧本」标签里选用，没人选用的剧本工坊会拒绝 `link`。
- **`read` 会覆盖** —— `read` 直接替换同一版本文件夹里的文件，不检查本地改动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

工坊一侧是分支 `muse/workshop-transcribe-workflow` 上的 `services/muse-workbenches/video_transcribe.py` 和 `install_transcribe.py`；其中的 `options()` 是本工具对照的共享参数校验。定稿库是同一分支上的 `script_library.py` 和 `install_scripts.py`。

</details>

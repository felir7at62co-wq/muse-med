---
description: "让 Muse 按剧本工坊流水线卡片的参数查看、开始和停止视频转剧本工厂任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workshop

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-workshop` 注册模型可见的 `workshop_video_transcribe` 工具。它是剧本工坊「视频转剧本」步骤在 Muse 中的入口：一个工厂任务从数据站爆款队列领剧，运行数据站的 AI 观众选材，下载红果整剧并用云端 Muse 逐集转写，再把每部出稿的剧存为工坊剧本。本工具以当前登录的 Muse 用户身份，发送与工坊流水线卡片相同的五个参数。任务、转写位和结果都归剧本工坊；本包只通过 `ctx.workshopConnection` 调用它的工厂接口。

## 目录

- [使用本包](#use-this-package)
- [操作](#actions)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Agent 预设中挂载本插件；所有 Bot 使用的 Desktop `short-drama` 预设已无配置挂载。Host 提供 `@deepseek-ai/dsh-workbench-connection` 的 `workshopConnection` 后才注册工具，该服务消失时移除工具，因此没有工坊连接的组合不提供工坊工具。开始任务时通过 Host `approval` 服务征求用户确认；没有该服务时 `start` 以 `WORKSHOP_APPROVAL_REQUIRED` 失败。在 Desktop 组合中，本工具归在「剧本工坊」能力下，经 `tool_search` 按需加载，不常驻。

<a id="actions"></a>
## 操作

| 操作 | 工坊请求 | 结果 |
| --- | --- | --- |
| `status` | `GET /factory/video-transcribe/status`，再 `GET /factory/jobs?limit=50` | `{ service, jobs }`：是否就绪、数据站队列计数、`max_slots`，以及最新十个视频转剧本任务的状态、进度说明和出稿、待处理、选材未通过的数量 |
| 带 `job_id` 的 `status` | 先查就绪状态，再 `GET /factory/jobs/{job_id}` | `{ service, job }`：任务参数、各转写位状态，以及每类结果最新 20 条 |
| `start` | 先查就绪状态，经用户确认后 `POST /factory/jobs`，`job_type` 为 `video_transcribe` | `{ job_id, config }`，含实际发送的参数 |
| `stop` | `GET /factory/jobs/{job_id}`；任务等待中或运行中时 `POST /factory/jobs/{job_id}/stop`，再读一次任务 | `{ stop_requested, job }` |

`start` 沿用流水线卡片的默认值：`count` 为 0（持续运行直到停止）、`concurrency` 为 1、`quality` 为 `720p`、`publish` 为 false、不设 `only_series`（按队列顺序）。`concurrency` 不能超过部署的 `max_slots`；`only_series` 接收 15 到 25 位的红果作品编号并去重。步骤未就绪时以 `WORKSHOP_TRANSCRIBE_UNAVAILABLE` 失败，并附上运维给出的原因。工坊没有确认新任务时，`start` 以 `WORKSHOP_JOB_OUTCOME_UNKNOWN` 失败，并提示模型先用 `status` 核对再重试。其他类型的任务以 `WORKSHOP_NOT_TRANSCRIBE_JOB` 失败；其他用户的任务或不存在的任务以 `WORKSHOP_JOB_NOT_FOUND` 失败。停止会保留已领取的每部剧；已结束的任务返回 `stop_requested: false`，不发送停止请求。

待执行卡片的标题写明操作和任务，`start` 卡片显示补全默认值后的参数。完成卡片的标题取自持久化的结果要点：新任务、停止请求、任务状态与百分比，或就绪状态与任务数量。

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

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不能续跑已停止的任务** —— 已停止的独立任务保留已领取的剧，但只有工坊流水线运行能续跑；`start` 会新建任务。
- **不检查重复开始** —— 另一个视频转剧本任务运行时 `start` 不会拒绝；任务共用部署的转写位，第二个任务只占用空闲的转写位。
- **只看最近的任务** —— 不带 `job_id` 的 `status` 只扫描最新 50 个各类工厂任务；更早的视频转剧本任务需要提供 `job_id`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

工坊一侧是分支 `muse/workshop-transcribe-workflow` 上的 `services/muse-workbenches/video_transcribe.py` 和 `install_transcribe.py`；其中的 `options()` 是本工具对照的共享参数校验。

</details>

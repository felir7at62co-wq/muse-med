---
description: "让转写工人从数据站任务队列领取一部红果爆款、在不符合选材标准时淘汰、上报进度、登记已存原片并发布完成的剧本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-hit-queue

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-hit-queue` 为每日爆款转写循环注册模型可见的 `drama_hit_queue` 工具。工人会话从数据站任务队列领取一部红果剧，按数据站给出的选材标准判断整部剧，不符合就淘汰，上报进度和心跳，凭清单地址登记用 `drama_tos_upload` 存好的原片，并发布通过检查的剧本或报告失败。选片、租约、重试和成员看到的储备看板都归数据站；本包只调用它的服务接口。

## 目录

- [使用本包](#use-this-package)
- [请求安全](#request-safety)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在云端转写部署中与 `drama_tos_upload` 一起组合本插件。它被归为可选包，不在 Desktop 默认组合中。

```yaml
- name: '@deepseek-ai/dsh-tool-hit-queue'
  config:
    tokenRef: MUSE_DATA_SERVICE_TOKEN
```

`tokenRef` 必须配置，调用开始时通过 Host `credentials` 服务解析数据站服务令牌；缺少该服务或取不到值时，调用以 `HIT_QUEUE_UNCONFIGURED` 失败。`baseUrl` 默认为同一主机上的数据站 `http://127.0.0.1:19617/api/service/hits`；`manifestOrigin` 默认为 `https://muse.tos-cn-beijing.volces.com`。`requestTimeoutMs` 默认 60000（1000–300000），`maxResponseBytes` 默认 4 MiB（1 KiB–32 MiB），`maxScriptBytes` 默认 20 MiB，即数据站自己的上限。`baseUrl` 或 `manifestOrigin` 无效时，插件加载即失败。

| 操作 | 数据站请求 | 必填字段 |
| --- | --- | --- |
| `claim` | 以 `muse-worker-<会话 ID>` 身份 `POST /claim` | 无；填 `work_id` 时领取指定作品 |
| `status` | `GET /jobs/:workId` | `work_id` |
| `progress` | `POST /jobs/:workId/progress`；只带 `lease` 即为心跳 | `work_id`、`lease` |
| `videos` | `PUT /jobs/:workId/videos`，以清单为 `upload` | `work_id`、`lease`、`manifest_url` |
| `publish` | multipart 形式 `POST /jobs/:workId/script` | `work_id`、`lease`、`script_path`、`checks_passed` |
| `fail` | `POST /jobs/:workId/fail` | `work_id`、`lease`、`reason` |
| `reject` | `POST /jobs/:workId/reject`；数据站把任务结束为复核淘汰，不再自动选入该作品 | `work_id`、`lease`、`reason` |

<a id="request-safety"></a>
## 请求安全

- 令牌只放在 `X-Muse-Data-Service-Token` 请求头里，经过公网 `/data/` 代理也不会被清掉。拒绝重定向。
- `work_id` 必须是红果 `series_id`，可带 `hongguo:` 前缀，写进路径时做 URL 编码。
- `manifest_url` 必须直接位于 `manifestOrigin` 之下，不能带查询或片段。清单必须是第 1 版、平台为 `hongguo`，其 `work_id` 与本次调用的 `work_id` 一致；桶、日期、目录和对象在发给数据站前都会校验。
- `script_path` 必须是 `maxScriptBytes` 以内的绝对路径普通文件，扩展名为 `.docx`、`.md`、`.txt` 或 `.pdf`；在任何请求之前检查。
- 数据站错误按 HTTP 状态给出代码（`HIT_QUEUE_UNAUTHORIZED`、`_NOT_FOUND`、`_CONFLICT`、`_REJECTED`、`_FAILED`），最多引用数据站说明的 300 个字符。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

`src/station.ts` 发送有界的 JSON 或 multipart 请求并映射响应。`src/manifest.ts` 读取 `drama_tos_upload` 的清单，组装数据站需要的 `upload`；清单自身的键取自清单地址，而不是清单内容。`src/index.ts` 在加载时校验配置，每次调用时解析令牌，从调用会话得到工人 ID，并注册工具。数据站一侧的接口契约是数据站仓库中的 `docs/hit-transcription.md`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [短剧 TOS 上传](../tool-drama-tos-upload/README.zh.md) — 存原片并写出本工具登记用的清单。
- [凭据](../../credentials/credentials/README.zh.md) — Host 管理的凭据引用与秘密解析。

-----

<a id="model-experience"></a>
## 模型体验

### 任务队列工具

#### 模型看到什么

组合本插件后，模型会看到 `drama_hit_queue` 的定义，含一个 `action` 及上表中的字段。每次成功调用返回 `{ action, result }`，`result` 是数据站的 JSON 回答：`claim` 为 `{ job, lease, work, review }`，其中 `work` 含剧名、全部标签、简介和数据站的规则评估，`review` 含 `required` 与可修改的 `standard` 文本，其他操作为 `Job` 记录，`publish` 为 `{ job, script }`。失败时带 `HIT_QUEUE_*` 代码和中文说明。描述原文如下：

##### 工具描述

```markdown
数据站爆款转写任务队列。claim 领取一部待转写的红果剧（不填 work_id 取队首），返回任务、租约 lease、作品信息 work 和选材复核 review；之后每一步都带上 work_id 和 lease。review.required 为 true 时，下载转写前先按 review.standard 判断整部剧是否符合选材方向，不符合就用 reject 淘汰并写明具体理由；reject 只用于选材不符。progress 上报阶段和第几集，也作心跳，至少每 30 分钟一次；videos 用 drama_tos_upload 返回的 manifest.url 登记原片；publish 上传通过程序检查的剧本并发布；fail 报告下载、转写或检查失败，检查重写后仍不过时设 needs_attention。status 查询任务。
```

#### Token 影响

提供该工具的每次请求都会带上一份固定的参数定义。每次结果是一条数据站 `Job` 记录，约几百个 token；`claim` 结果还带剧的简介、标签和选材标准，不到约 1000 个 token。

#### KV Cache 影响

定义文本固定不变，跨轮次保持稳定。结果是普通工具结果，追加在可复用前缀之后。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **尚未组合** — 没有任何已发布的配置选用本插件；云端转写组合会连同令牌引用一起加入。
- **仅限红果** — 数据站队列只放红果剧；小说和抖音不经过本工具。
- **选材复核依赖数据站的复核接口** — 只有实现了该接口的数据站版本，`claim` 才返回 `work` 与 `review`，`reject` 才能成功；旧版数据站不返回 `review`，工人不做复核，`reject` 得到 `HIT_QUEUE_NOT_FOUND`。
- **租约由模型携带** — `claim` 返回的租约要在之后每次调用时传回；工具不按会话保存租约。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

循环设计见维护者检出目录下的 `.artifacts/daily-hit-transcription-loop-design-20261115.md`。主会话路由器不调用本工具；每个被派出的工人自己领取作品，路由器保持只派发。

</details>

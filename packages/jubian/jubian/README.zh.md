---
description: "剧变 HTTP 传输、凭据修复、五个稳定错误码，以及 dsh-tool-jubian 与 dsh-jubian-api 所依赖的两阶段 NDJSON 写入账本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jubian

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-jubian` 是通往剧变的唯一 HTTP 通道：你用凭据解析器构造一个 `JubianClient`，发送一次固定源请求，然后读回信封数据、传输状态以及响应原始字节的 sha256。它修复粘贴令牌通常携带的 shell 分隔符与成对引号，把每一次失败归入五个稳定错误码之一且从不回显提供方文本，并把每次付费或改变状态的调用记入两阶段 NDJSON 账本——重复的 `idempotency_key` 返回既有记录，且一个请求都不发。`@deepseek-ai/dsh-tool-jubian` 与 `@deepseek-ai/dsh-jubian-api` 消费本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当你的代码必须直接与剧变通信时导入本库。它是一条依赖，而不是一条组合行：它不注册任何 Cordis 服务、工具、提示词段落或会话事件，因此没有任何 `cordis.yml` 行挂载它，模型能看到的一切都属于 `@deepseek-ai/dsh-tool-jubian`。

### 何时选择本包

当你自己拥有调用点时选择它——工具包、使用桩 `fetch` 的测试，或读取单个提供方端点的脚本。当模型应通过工具调用剧变时，改用 `@deepseek-ai/dsh-tool-jubian`；当你需要为本客户端已经交付的载荷提供带类型的读取器时，改用 `@deepseek-ai/dsh-jubian-api`。

### 发送一次请求

`request()` 解析凭据，只发送一次尝试，并返回信封载荷以及它是如何到达的证据：

```ts
import { JubianClient, JubianError } from '@deepseek-ai/dsh-jubian'

const client = new JubianClient({ credential: resolveJubianToken })

try {
  const response = await client.request({ method: 'GET', path: '/aigc/asset/123' })
  console.log(response.transport.http_status, response.response_sha256, response.data)
} catch (error) {
  if (error instanceof JubianError) console.error(error.code)
}
```

`path` 自带查询字符串，`body` 会在接受它的方法上序列化为 JSON。成功时 `data` 原样返回，因此提供方新增的字段在这里永远不会变成错误。构造函数会以 `TypeError` 拒绝 1..60000 之外的 `timeoutMs` 与 1..32 MiB 之外的 `maxResponseBytes`；默认值分别是 30000 毫秒与 2 MiB，`baseUrl` 默认为 `https://web.jubianai.net/prod-api`。

### 读取两种信封形态

该提供方同时存在两种形态，客户端为你隐藏了这一差异。单对象端点把载荷嵌套在 `data` 下；列表端点把 `code`、`total` 与 `rows` 放在顶层，完全没有 `data`。当 `data` 键存在时客户端返回嵌套的 `data`，否则返回去掉 `msg` 文本后的整个信封——因此 `total` 与 `rows` 会作为一个对象到达，读取方无需知道提供方发来的是哪种形态。

### 修复已存储的令牌

`trimBearerToken()` 去掉首尾空白、一个尾部 shell 分隔符（`;` 或 `&`）以及一对匹配的引号——这些是 shell 导出或复制的设置值留下的残留——并且从不改写内部字符。`isUsableBearerToken()` 随后要求取值非空且不含空白。仍带内部空格的取值会在任何请求离开之前于本地以 `AUTHENTICATION_REQUIRED` 失败，因此损坏的密钥既不会到达网络，也不会进入日志。本包拥有的凭据引用名是 `JUBIANAI_ADMIN_TOKEN`；它的值由宿主拥有。

### 五个稳定错误码

每一次失败都是一个只携带错误码的 `JubianError`。提供方的响应文本与令牌都不会被附加，因此远端消息永远不会被回显进模型上下文或日志。

| 错误码 | 触发条件 |
|---|---|
| `AUTHENTICATION_REQUIRED` | 凭据解析器抛出异常、修复后的令牌不可用、HTTP 为 401 或 403，或信封 `code` 为 401 |
| `PERMISSION_DENIED` | HTTP 为 2xx 而信封 `code` 为 403 |
| `RATE_LIMITED` | HTTP 为 429，或信封 `code` 为 429 |
| `CONTRACT_CHANGED` | 响应体不是 JSON、不是合法 UTF-8、不是对象、超出字节上限、不带整数 `code`，或带有本包不映射的错误码 |
| `NETWORK_ERROR` | 连接失败、调用超时、重定向被拒绝，或 HTTP 为任何其他非 2xx 状态 |

HTTP 200 而信封 `code` 为 401，是该提供方对无法接受的令牌返回的形态，它的失败方式与 HTTP 401 完全一致。两个成功码是 `0` 与 `200`。

### 以两个阶段记录一次写入

`JubianLedger` 回答超时留下的唯一问题：那笔扣费究竟发生了吗？在请求离开前写入 intent 行，在响应读完后写入 settle 行。

```ts
import { JubianLedger } from '@deepseek-ai/dsh-jubian'

const ledger = new JubianLedger({ root: ledgerRoot })
const begun = await ledger.begin({
  idempotencyKey: 'episode-1-upscale-428322',
  method: 'video_upscale',
  requestSha256: 'sha256:9f2c…',
})

if (!begun.replayed) {
  const response = await client.request({ method: 'POST', path: '/aigc/video/upscale', body: { taskId: 428322 } })
  await ledger.settle('episode-1-upscale-428322', {
    httpStatus: response.transport.http_status,
    applicationCode: response.transport.application_code,
    responseSha256: response.response_sha256,
    outcome: 'accepted',
  })
}
```

`begin()` 写入 intent 行；当该 key 已被记录时，它返回 `replayed: true` 与既有记录，此时你什么都不发。`settle()` 在响应读完后追加结果。每天一个 NDJSON 文件 `<root>/YYYY-MM-DD.ndjson` 同时保存这两行，因此一次文本扫描就能看到每一次尝试；有 intent 行而没有 settle 行，正是超时产生的那种未知状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是在 `fetch` 之上的五个小模块：一个拥有线路边界的模块、一个修复凭据的模块、一个命名失败的模块，以及一个记录写入的模块。除账本自己的文件外，这里没有任何东西在调用之间持有状态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公开接口：客户端、凭据 helper、错误码与账本 |
| [`src/client.ts`](src/client.ts) | 唯一的 HTTP 通道：固定源、单次尝试、有界读取、信封校验与响应哈希 |
| [`src/credential.ts`](src/credential.ts) | 凭据引用名，以及构建任何请求头之前应用的粘贴残留修复 |
| [`src/error.ts`](src/error.ts) | 五个稳定错误码、HTTP 状态映射与信封 code 映射 |
| [`src/ledger.ts`](src/ledger.ts) | 两阶段 NDJSON 写入账本：intent 行、settle 行与重放折叠 |
| — | 不发布运行时不变量配套入口；本传输不拥有可独立观察的生命周期流，其边界规则改由单元测试保障。 |

### 单次尝试、固定源与字节上限

`request()` 把 URL 组装为 `baseUrl + path`，设置 `redirect: 'error'`，并通过 `AbortSignal.any()` 把调用方的 `signal` 与自身超时合并。这里没有重试、没有退避、也没有轮询循环：是否重复一次调用由调用方决定，而对写入而言，账本的幂等 key 才让这种重复变得安全。响应体分块读取，一旦超过 `maxResponseBytes` 便立即以 `CONTRACT_CHANGED` 拒绝，因此超大或无尽的响应体永远不会在内存中累积。这些原始字节随后按严格 UTF-8 解码并哈希为 `sha256:<hex>`，调用方因此可以把收到的内容与账本的 settle 行对照。

### 一个返回值承载两种信封形态

响应体只解析一次，并检查 `code` 是否为整数。`failureForEnvelopeCode()` 对非成功码分类，随后选择载荷：存在 `data` 键时取 `data`，否则取除 `msg` 之外的每个顶层字段。正是这第二条分支，让提供方那些报告 `total` 与 `rows`、且不带 `data` 的列表端点，能通过与单对象端点相同的返回类型读取。

### 错误为何只携带错误码

`JubianError` 只保存错误码与一条固定的本地消息。没有任何东西把提供方字符串、响应体或嵌套原因复制进去，因此一次失败可以被渲染进工具结果、日志行或模型轮次，而不会引入远端文本。HTTP 401 与 403 都变成 `AUTHENTICATION_REQUIRED`，而 HTTP 2xx 背后信封 `code` 为 403 则变成 `PERMISSION_DENIED`；因此传输层与应用层保持可区分，同时不暴露提供方拒绝的原因。

### 两阶段账本带来什么

`begin()` 会为该 key 读取所有既有 NDJSON 文件，并在追加任何内容之前把匹配的行折叠成一条记录：`begin` 行开启记录，之后同 key 的 `settle` 行填入 `http_status`、`application_code`、`response_sha256` 与 `outcome`。命中时返回 `{ replayed: true, record }`，调用方不得发送。只有当 HTTP 为 2xx 且应用码为 `0` 或 `200` 时，`outcome` 才是 `accepted`；其他任何情况都是 `unknown`。这一区分正是关键：超时之后文件里会留下一条没有 settle 行的 intent 行，这是诚实的答案，而不是猜测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要本传输之上的层，或它遵循的仓库规则时，阅读以下页面。

- [Jubian 工具包](../tool-jubian/README.zh.md) — 拥有凭据引用、账本根目录与每一次付费写入的面向模型工具。
- [模块图](../../../docs/module-graph.zh.md) — 本传输包在仓库包顺序中的位置。
- [新增包](../../../docs/cookbook/adding-a-package.zh.md) — 本 README 及其双语对遵循的包契约。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册任何工具、提示词段落或会话事件，而 `@deepseek-ai/dsh-tool-jubian` 拥有对本传输的每一次面向模型的使用。

#### KV Cache 影响

本包对请求前缀没有任何贡献。模型看到的工具与结果都属于 `@deepseek-ai/dsh-tool-jubian`，因此仅挂载或升级本依赖不会改变可复用的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些约束是当前的包行为，而不是任务待办列表。

- **只尝试一次，绝不重试** — 超时、被拒绝的重定向或 HTTP 429 都会让这次调用以失败告终，是否重复由调用方决定。对于写入，账本的幂等 key 才让这种重复变得安全，而不会造成第二次扣费。
- **字节上限让调用失败，而不是截断响应** — 大于 `maxResponseBytes` 的响应体在读到至多该字节数之后被以 `CONTRACT_CHANGED` 拒绝，因此大型提供方列表必须通过提供方自己的分页参数重新读取，而不是提高上限。
- **无法识别的信封 code 会被读作契约变更** — `failureForEnvelopeCode()` 只映射 0、200、401、403 与 429；其他任何应用码都会变成 `CONTRACT_CHANGED`，因此新引入的提供方错误码以形态变更的形式到达，而不是成为独立的失败类别。
- **已存储的令牌只被修复，从不被校验** — `trimBearerToken()` 只去掉一个尾部分隔符与一对引号，本包从不用该值向提供方做校验，因此格式良好但已被吊销的令牌只能在第一次真实调用时被发现。
- **账本检测写入，但不锁定写入** — `begin()` 在追加之前读取既有文件，因此共享同一个账本根目录的两个进程可能为同一个 key 各写一条 `begin` 行；串行化写入方是调用方的责任。
- **没有任何东西自动对账账本** — 没有 settle 行的 intent 行会一直保持未决，直到调用方或运维人员读取 NDJSON 文件，而目前没有任何界面列出这些未决记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

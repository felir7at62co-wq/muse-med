---
description: "剧变 HTTP 传输、凭据修复、六个稳定错误码，以及 dsh-tool-jubian 与 dsh-jubian-api 所依赖的两阶段 NDJSON 写入账本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jubian

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-jubian` 用凭据解析器向固定来源发送剧变请求，并返回响应数据、状态与原始字节的摘要。它修复粘贴令牌时常见的残留字符，且以六个稳定错误码报告失败，不泄露提供方文本。两阶段 NDJSON 账本记录付费或改变状态的调用；重复的 `idempotency_key` 返回既有记录，供调用方避免再次发送。

`pool_claim` 记录剧本池提交。认领工具会在另一个 key 提交前检查同一剧本的既有记录；结果不明确时保持 `unknown`，等待只读对账。

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

const token = process.env.JUBIANAI_ADMIN_TOKEN
if (!token) throw new Error('Set JUBIANAI_ADMIN_TOKEN')
const client = new JubianClient({ credential: async () => token })

try {
  const response = await client.request({ method: 'GET', path: '/aigc/asset/123' })
  console.log(response.transport.http_status, response.response_sha256, response.data)
} catch (error) {
  if (error instanceof JubianError) console.error(error.code)
}
```

`path` 自带查询字符串，`body` 会在接受它的方法上序列化为 JSON。成功时 `data` 原样返回，因此提供方新增的字段在这里永远不会变成错误。构造函数会以 `TypeError` 拒绝 1..60000 之外的 `timeoutMs` 与 1..32 MiB 之外的 `maxResponseBytes`；默认值分别是 30000 毫秒与 2 MiB，`baseUrl` 默认为 `https://web.jubianai.net/prod-api`。

### 读取该提供方发出的每一种信封形态

有两种形态是有据可查的，客户端为你隐藏了这一差异。单对象端点把载荷嵌套在 `data` 下；列表端点把 `code`、`total` 与 `rows` 放在顶层，完全没有 `data`。当 `data` 键存在时客户端返回嵌套的 `data`，否则返回去掉 `msg` 文本后的整个信封——因此 `total` 与 `rows` 会作为一个对象到达，读取方无需知道提供方发来的是哪种形态。另有四种形态被容忍，因为传输层一旦拒绝，读取方就再也拿不回载荷：被包在单元素数组里的成功信封、被包在单元素数组里的载荷对象、顶层的裸数组、以及本身就是一个成功信封的载荷。每个响应都用 `envelope_layout` 说明它实际使用的形态；而本身不带信封的被容忍形态会报告 `transport.application_code: null`，因此任何调用方都不会把它误当成已验证的成功。一个合法 JSON 但不属于上述任何一种的响应体——字符串、数字、`null`，或不带整数 `code` 的对象——仍以 `CONTRACT_CHANGED` 失败。

### 修复已存储的令牌

`trimBearerToken()` 去掉首尾空白、一个尾部 shell 分隔符（`;` 或 `&`）以及一对匹配的引号——这些是 shell 导出或复制的设置值留下的残留——并且从不改写内部字符。`isUsableBearerToken()` 随后要求取值非空且不含空白。仍带内部空格的取值会在任何请求离开之前于本地以 `AUTHENTICATION_REQUIRED` 失败，因此损坏的密钥既不会到达网络，也不会进入日志。本包拥有的凭据引用名是 `JUBIANAI_ADMIN_TOKEN`；它的值由宿主拥有。

### 六个稳定错误码

`JubianError` 保留稳定错误码与本地消息。HTTP 失败只追加数字状态，例如 `HTTP 502`；已识别的超时、中止、DNS、连接与 TLS 失败追加白名单内的本地撰写详情。提供方消息、响应体、URL、令牌与原始 cause 都不会被附加。未知传输失败仍为 `Jubian request failed`；诊断不会触发重试。

| 错误码 | 触发条件 |
|---|---|
| `AUTHENTICATION_REQUIRED` | 凭据解析器抛出异常、修复后的令牌不可用、HTTP 为 401 或 403，或信封 `code` 为 401 |
| `PERMISSION_DENIED` | HTTP 为 2xx 而信封 `code` 为 403 |
| `RATE_LIMITED` | HTTP 为 429，或信封 `code` 为 429 |
| `CONTRACT_CHANGED` | 响应体不是 JSON、不是合法 UTF-8、不是对象、超出字节上限、不带整数 `code`，或带有本包不映射的错误码；详情描述响应体的结构 |
| `NETWORK_ERROR` | 连接失败、调用超时、重定向被拒绝，或 HTTP 为任何其他非 2xx 状态 |
| `BUDGET_EXCEEDED` | 一次计费调用不被本部署的授权覆盖；详情说明缺的是哪一项 |

HTTP 200 而信封 `code` 为 401，是该提供方对无法接受的令牌返回的形态，它的失败方式与 HTTP 401 完全一致。两个成功码是 `0` 与 `200`。

被拒绝的响应体由 `describePayload()` 或 `describeUnparsed()` 描述，而不是被复述：顶层类型、自身键名、数组长度、字节数与一段有界摘录，其中凭据类字段的取值被移除、绝对 URL 被缩减为来源、长的不透明串被替换。`Jubian response did not match the expected envelope: top-level array of 7 elements, first element object with keys [id, scriptId, …]` 就是这类失败现在会说的话。

### 给一个项目的花费设上限

`checkBudget` 回答"再来一次计费调用是否放得下"：

```
settled spend + in-flight reservations + this call's quote <= the project's limit
```

明确项目额度保存在 `<账本目录>/authorization.json`。操作人可以填写，也可以由共享预算写入方核实用户授权后保存：

```json
{ "version": 1,
  "projects": { "2708": { "limit": "200", "unit": "CNY", "note": "2026-09-22 用户授权",
                          "estimates": { "storyboard_native_submit": "15" } } } }
```

`estimates` 是"这次调用自己报不出价"时用来记账的额度。按 token 计价的视频模型给的是每百万 token 的单价，不是每条任务的价格，而 token 数只有任务跑完才知道，所以由人声明一次这样的调用值多少；账本会把这份估算记成该次调用的报价。既没有报价、也没有估算的调用一律拒绝——把未知花费当成 0，会让上限恰恰在最需要它的地方失效。

尚未结算或结果为 `unknown` 的计费调用，有可用报价时计入在途预留：它可能已经扣费。没有可用报价的计费记录会阻止其所属项目继续消费，结果为 `unknown` 时也不例外；其他已知项目的记录保持隔离。没有项目归属的计费记录不论结果如何，都会阻止共享该账本的所有项目继续消费，直到人工核对归属。结果未知绝不代表费用为零。金额按整数分比较。

既没有匹配项目授权，也没有已挂载的短剧默认预算时，计费调用在记录 intent 和请求提供方之前被拒绝。默认值给未单独授权的项目提供人民币上限；明确项目条目覆盖默认值。没有报价或认可估算时仍拒绝收费。`readProjectBudget` 返回实际额度、已花、预留与精确修订，其公开 JSON 类型 `ProjectBudget` 可从 `@deepseek-ai/dsh-jubian/types` 导入。`updateProjectBudget` 保留历史估算、其他项目和账本消费，将用户证据追加至 `authorization_history`，在账本预留队列和独占 `.authorization.lock` 下检查修订，再原子替换 JSON 并真实回读。低于已记账消费的额度、未解决的账务、不支持的币种、损坏文件或过期版本都在替换文件前拒绝。预算写入锁排斥其他进程的预算写入方；付费预留仍只在同一运行时串行。本地文件访问不构成独立安全隔离。

分镜视频批次在 `beginManyChecked` 内调用 `checkBudget(..., count)`，先检查整批估算金额，再一次登记各个原 key 的计价 intent，随后才允许发送任何提供方 PUT。每种计费方法的单笔报价或估算至少须为授权币种的 0.01；舍入后为零的不足一分金额不能授权消费。预算拒绝或 key 已存在时不新增 intent。同进程的队列会把这次预约与单项计费写入串行处理；不同进程仍不受该队列保护。

### 以两个阶段记录一次写入

`JubianLedger` 回答超时留下的唯一问题：那笔扣费究竟发生了吗？在请求离开前写入 intent 行，在响应读完后写入 settle 行。

```ts
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'

const token = process.env.JUBIANAI_ADMIN_TOKEN
if (!token) throw new Error('Set JUBIANAI_ADMIN_TOKEN')
const client = new JubianClient({ credential: async () => token })
const ledger = new JubianLedger({ root: './jubian-ledger' })
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
    outcome: response.transport.application_code === 0 || response.transport.application_code === 200
      ? 'accepted' : 'unknown',
  })
}
```

`begin()` 写入 intent 行；当该 key 已被记录时，它返回 `replayed: true` 与既有记录，此时你什么都不发。`settle()` 在响应读完后追加结果。每天一个 NDJSON 文件 `<root>/YYYY-MM-DD.ndjson` 同时保存这两行，因此一次文本扫描就能看到每一次尝试；有 intent 行而没有 settle 行，正是超时产生的那种未知状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是在 `fetch` 之上的几个小模块：一个拥有线路边界的模块、一个修复凭据的模块、一个命名失败的模块，以及一个记录写入的模块。除账本自己的文件外，这里没有任何东西在调用之间持有状态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公开接口：客户端、凭据 helper、错误码与账本 |
| [`src/client.ts`](src/client.ts) | 唯一的 HTTP 通道：固定源、单次尝试、有界读取、信封形态读取与响应哈希 |
| [`src/credential.ts`](src/credential.ts) | 凭据引用名，以及构建任何请求头之前应用的粘贴残留修复 |
| [`src/diagnostic.ts`](src/diagnostic.ts) | 每个被拒响应体与每条 dump 记录所依据的脱敏结构描述 |
| [`src/debug-dump.ts`](src/debug-dump.ts) | `DSH_JUBIAN_DEBUG_DUMP` 背后那个可选的 JSONL 响应落盘 |
| [`src/error.ts`](src/error.ts) | 六个稳定错误码、HTTP 状态映射与信封 code 映射 |
| [src/budget.ts](src/budget.ts) | 花费上限：人的授权文件，以及一次计费调用的判定 |
| [src/ledger.ts](src/ledger.ts) | 两阶段 NDJSON 写入账本：intent 行、settle 行与重放折叠 |
| — | 不发布运行时不变量配套入口；本传输不拥有可独立观察的生命周期流，其边界规则改由单元测试保障。 |

### 单次尝试、固定源与字节上限

`request()` 把 URL 组装为 `baseUrl + path`，设置 `redirect: 'error'`，并通过 `AbortSignal.any()` 把调用方的 `signal` 与自身超时合并。这里没有重试、没有退避、也没有轮询循环：是否重复一次调用由调用方决定，而对写入而言，账本的幂等 key 才让这种重复变得安全。响应体分块读取，一旦超过 `maxResponseBytes` 便立即以 `CONTRACT_CHANGED` 拒绝，因此超大或无尽的响应体永远不会在内存中累积。这些原始字节随后按严格 UTF-8 解码并哈希为 `sha256:<hex>`，调用方因此可以把收到的内容与账本的 settle 行对照。

### 一个返回值承载每一种信封形态

响应体只解析一次，并按上面某一种形态读取。在任何载荷被选中之前，`failureForEnvelopeCode()` 先对非成功码分类，`envelope_layout` 报告实际读到的形态。那条扁平分支——除 `msg` 之外的每个顶层字段——让提供方那些报告 `total` 与 `rows`、且不带 `data` 的列表端点，能通过与单对象端点相同的返回类型读取。单元素数组按它持有的那个对象读取，更长的裸数组作为该数组交给读取方，而本身就是一个成功信封的载荷会再被解开一层。自身不带 code 的形态报告 `transport.application_code: null`，而不是编造一个。

### 安全的失败诊断

客户端在抛出的对象及其直接 cause 上精确匹配传输错误码或超时／中止名称，不遍历更深的 cause。合并后的 signal 标识调用方取消或客户端截止时间，也覆盖响应体读取阶段。HTTP 401 与 403 仍为 `AUTHENTICATION_REQUIRED`；HTTP 2xx 背后的信封 `code` 为 403 时仍为 `PERMISSION_DENIED`。本客户端无法接受的响应体改由 `describePayload()` 或 `describeUnparsed()` 报告：顶层类型、自身键名、数组长度、字节数与一段有界摘录，凭据类字段被脱敏、绝对 URL 被缩减为来源，因此工具结果可以说清收到的是什么，而不必把它复述出来。[诊断决策](../../../.agents/notes/implemented/bug-fix/2026-09-23-jubian-safe-transport-diagnostics.zh.md)记录脱敏的取舍与验证范围限制，[形态决策](../../../.agents/notes/implemented/bug-fix/2026-09-28-jubian-unreadable-response-diagnostics.zh.md)记录被容忍形态的由来。

<a id="dumping-responses-on-purpose"></a>
### 按需把响应落盘

把 `DSH_JUBIAN_DEBUG_DUMP` 设为一个文件路径，`request()` 就会为每个响应追加一条 JSONL 记录：时间戳、方法、路径、HTTP 状态、应用码、信封形态、字节数、响应哈希与脱敏后的载荷。变量未设置或为空白时它始终关闭，没有任何路径会自动打开它，文件所在目录会在首次写入时创建。记录的是每一次调用，而不只是 `GET`，因为 `subtasks` 正是一个只读的 `POST`；dump 从不读取请求头（包括 `Authorization`），每个响应体都走与错误诊断相同的脱敏。在平台支持的情况下，文件以仅属主可读写创建；dump 的任何失败都不会改变它所观察的那次调用。请分享这个文件，永远不要分享令牌：它存在的意义就是让运维者把远端真正返回的内容发回来，而无需附带任何凭据。

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
- **被容忍的形态只被记录，尚未升级为规则** — 上面那些数组与嵌套信封之所以被接受，是因为传输层无从知道读取方能用什么，而 `envelope_layout` 说明了实际读到的是哪一种；要把某一种收紧成它自己的规则，需要真正抓到会发出它的端点，因此当前接受集刻意比有据可查的集合更宽。
- **被容忍的形态不带应用码** — `array-payload` 与 `array-single` 报告 `transport.application_code: null`，因此需要提供方自身成功码的调用方（例如写入账本）对这些响应体记录的是 `unknown`，而不是 `accepted`。
- **读取方自己的拒绝不带结构描述** — 上面的描述属于本客户端的信封读取；`@deepseek-ai/dsh-jubian-api` 里的读取方拒绝一个它能读的载荷时，仍只报 `CONTRACT_CHANGED` 而不点名字段，因此那种情况要靠 debug dump 排查，而不是靠错误文本。
- **debug dump 是一个需要运维者自行删除的文件** — 它保存提供方载荷，凭据按字段名脱敏、URL 缩减为来源、不透明长串被替换；以不起眼字段名携带的凭据，以及上游已经错误脱敏的内容，都不会被识别，因此该文件只留在本地，并在诊断结束后删除。
- **已存储的令牌只被修复，从不被校验** — `trimBearerToken()` 只去掉一个尾部分隔符与一对引号，本包从不用该值向提供方做校验，因此格式良好但已被吊销的令牌只能在第一次真实调用时被发现。
- **账本检测写入，但不锁定写入** — `begin()` 在追加之前读取既有文件，因此共享同一个账本根目录的两个进程可能为同一个 key 各写一条 `begin` 行；串行化写入方是调用方的责任。
- **没有任何东西自动对账账本** — 没有 settle 行的 intent 行会一直保持未决，直到调用方或运维人员读取 NDJSON 文件，而目前没有任何界面列出这些未决记录。

配置的默认项目额度同样适用于已有授权文件中未列出的项目。明确的较低项目额度继续有效；缺少价格仍表示费用未知，不按零计算。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

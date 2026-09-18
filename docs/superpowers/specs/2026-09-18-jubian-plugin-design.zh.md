# 剧变（Jubian）工具插件设计

[English](2026-09-18-jubian-plugin-design.md) | 中文

- 日期：2026-09-18
- 状态：待评审
- 范围：`packages/jubian/*`（新增）。**本轮不改动 `packages/bundle/muse-product` 的任何代码。**

## 1. 背景与目标

剧变（`web.jubianai.net`）是 MUSE 短剧产品唯一的多媒体生成后端。它今天只以两种形态存在：

1. 约 3000 行与 MUSE 治理层交织的适配代码（`packages/bundle/muse-product/src/` 下的 20 个 `jubian-*.ts`，3434 行），其中大部分依赖 Task 准入、租约、收据、报价等 MUSE 专属机制；
2. 一个 Python CLI（`jubianai-api/scripts/jubianai_api.py`，约 203 KB），**产品代码从不调用它**，只作为归档知识被哈希钉住。

结果是：任何非 MUSE 的 DSH 会话都无法查询或操作剧变项目。

**目标**：把剧变的全部 HTTP 能力做成一个 DSH 插件包，使任意 DSH 模式挂上即可查询与操作剧变；凭证、错误语义与审计口径在一个地方定义。

**非目标**（本轮明确不做）：

- 不修改、不重构 MUSE；不让 MUSE 依赖新包；
- 不提供旧 CLI 的兼容命令（`create-video`、`submit-video-task`、直连 `POST /admin/aigc/video/task/create`）；
- 不做多账号；
- 不做消费配额封顶（写工具开箱可用，是否封顶留待后续单独决定）。

## 2. 包结构

遵循仓库现有约定：目录 `packages/<组>/<名>`，包名 `@deepseek-ai/dsh-<名>`（与 `packages/tool-*` 下 23 个包一致）。

```
packages/jubian/
  jubian/         @deepseek-ai/dsh-jubian        纯库：HTTP 客户端、信封校验、稳定错误码、幂等账本
  jubian-api/     @deepseek-ai/dsh-jubian-api    类型化端点读写器（21 个端点）+ 业务字段解析
  tool-jubian/    @deepseek-ai/dsh-tool-jubian   Cordis 插件（Host 半）：注册 4 个工具、解析凭证
  client-jubian/  @deepseek-ai/dsh-client-jubian 设置页那一格：粘贴 token（Client 半，第 10 节阶段 4 才做）
```

依赖单向 `jubian ← jubian-api ← tool-jubian`，**没有任何一条指向 MUSE**。

- `jubian` 与 `jubian-api` 是纯库，不注册工具、不消费 Cordis 服务，可用 vitest 直接单测（与 `dsh-skill`、`dsh-llm` 同形）。
- `tool-jubian` 是 Host 插件行，可被任意 preset 以一行挂载。
- `client-jubian` 是浏览器半，遵循仓库既有约定：**客户端界面单独成包**（如 `packages/client/ui-settings-plugin-inventory`、`packages/client/ui-settings-models`），因为它需要自己的客户端打包配置。它只负责 token 写入那一格，不影响工具可用性——先不装它，工具照样能读能写，只是没有粘贴界面。

## 3. 端点清单（21 个）

从产品代码静态提取，出处为 `packages/bundle/muse-product/src/` 下文件与行号。

### 3.1 读（17）

| 端点 | 出处 |
|---|---|
| `GET /model/charge/getSelectList?taskType=1\|2\|10` | `jubian-catalog.ts:62,198` |
| `GET /model/charge/{standardId}` | `jubian-catalog.ts:75,99,204` |
| `GET /aigc/script/{scriptId}` | `jubian-catalog.ts:173` |
| `GET /aigc/episode/list?scriptId=&pageNum=&pageSize=` | `jubian-catalog.ts:132` |
| `GET /aigc/asset/{assetId}` | `jubian-asset-reader.ts:772,807,823,862` |
| `GET /aigc/asset/list?scriptId=&pageNum=&pageSize=` | `jubian-asset-reader.ts:452` |
| `GET /aigc/material/list?scriptId=&isUsed=1&pageNum=1&pageSize=1000` | `jubian-asset-reader.ts:775` |
| `GET /aigc/material/getGeneratedImageByAssetId?assetId=` | `jubian-asset-reader.ts:871` |
| `GET /aigc/storyboard/{storyboardId}` | `jubian-asset-reader.ts:428` |
| `GET /admin/aigc/video/task/{taskId}` | `jubian-asset-reader.ts:161,242,554,925` |
| `GET /admin/aigc/video/task/list?scriptId=&taskType=1&pageNum=` | `jubian-asset-reader.ts:491` |
| `POST /admin/aigc/video/task/sub/list`（查询体 `{aigcVideoTaskId}`，**只读语义**） | `jubian-asset-reader.ts:166,245,509,556,654` |

> 注：第 12 项是读接口但动词为 POST，因为查询体承载 `aigcVideoTaskId`。工具层必须把它标注为"只读"。

**这 17 个读接口足以还原一个剧变项目的全貌**：`script → episode/list → asset/list → material/list（含 isLocal、hsAssetStatus）→ storyboard → video/task(+sub/list)`。查询能力不依赖 MUSE 任何机制。

### 3.2 写（4）

| 端点 | 动词 | 出处 | 性质 |
|---|---|---|---|
| `/aigc/asset` | POST（无父）/ PUT（有父） | `jubian-image-sender.ts:88` | **收费**：单张图片生成/重生成 |
| `/aigc/storyboard` | POST 建 / PUT 存 | `jubian-storyboard-save.ts:99` | PUT 带 `isGenerate:0` 免费；`:1` **收费** |
| `/aigc/storyboard/subtitleEraser` | POST | `jubian-storyboard-save.ts:99` | **收费**：去字幕任务 |
| `/aigc/material/confirm/{materialId}` | **GET** | `jubian-casting.ts:33` | **写·GET 有副作用**（确认出演） |

> 最后一项是全仓库唯一用读动词做写事的地方。工具描述必须显式写明"不要重试"，否则任何幂等框架都会误判。

## 4. 工具面（4 个工具 / 21 个方法）

按域分组，不按端点一工具。理由：工具 schema 常驻请求前缀，工具数与参数表直接乘每轮 token 成本，且改动会打断 KV cache（`packages/bundle/muse-product/README.md:61-67`）。

| 工具 | 方法 | 端点 | 计费标注 |
|---|---|---|---|
| `jubian_catalog` | `models` | getSelectList | 只读 |
| | `rate` | model/charge/{id} | 只读 |
| | `script` | aigc/script/{id} | 只读 |
| | `episodes` | aigc/episode/list | 只读 |
| `jubian_asset` | `get` | aigc/asset/{id} | 只读 |
| | `list` | aigc/asset/list | 只读 |
| | `materials` | aigc/material/list | 只读 |
| | `generated_image` | material/getGeneratedImageByAssetId | 只读 |
| | `confirm_casting` | material/confirm/{id} | **写·GET 副作用** |
| `jubian_storyboard` | `get` | aigc/storyboard/{id} | 只读 |
| | `create` | storyboard POST | 写·免费 |
| | `save` | storyboard PUT (`isGenerate:0`) | 写·免费 |
| | `generate` | storyboard PUT (`isGenerate:1`) | **收费·不可撤销** |
| | `erase_subtitle` | storyboard/subtitleEraser | **收费** |
| `jubian_video` | `task` | video/task/{id} | 只读 |
| | `tasks` | video/task/list | 只读 |
| | `subtasks` | video/task/sub/list | 只读（动词为 POST） |
| | `image_generate` | aigc/asset POST/PUT | **收费·不可撤销** |

**计费与副作用必须写进 tool description 本身**——模型读的是 description，不是源码。至少包含：

- `generate` / `erase_subtitle` / `image_generate`：会真实计费、不可撤销、不要在超时后盲目重试；
- `confirm_casting`：GET 动词但有副作用；
- `subtasks`：POST 动词但只读。

写方法默认注册、开箱可用（与读一致），不设 `writes` 开关。

### 4.1 待定映射（实现阶段第一步要定）

下列方法的**入参形态**尚未从产品代码完整提取，spec 只钉住其来源与语义边界，实现时以源码为准：

| 方法 | 入参来源 | 已知约束 |
|---|---|---|
| `image_generate` | `jubian-image-request.ts:buildJubianImageRequest` | 无父 POST / 有父 PUT；请求体 ≤ 1 MiB；token 不含空白 |
| `storyboard.create` / `save` | `storyboard-save-payload.ts:buildStoryboardCreatePayload` / `buildStoryboardSavePayload` | 请求体 ≤ 8 MiB；`save` 的载荷 `isGenerate` 必须为 0 |
| `storyboard.generate` | `storyboard-save-payload.ts:buildStoryboardGenerationPayload` | 必须先有已保存的 `isGenerate:0` 分镜；`contentDurationMs` 为 4000–14000 的整数秒 |
| `erase_subtitle` | `jubian-subtitle-request.ts:buildJubianSubtitleRequest` | 需要解码后的画面几何与已批准像素区域 |
| `confirm_casting` | `jubian-casting.ts` | `materialId` 必须匹配 `^[1-9][0-9]*$`，且必须是生成材质 ID，不能是父资产或异步任务 ID |

## 5. 凭证

**归属**：键归插件，值归宿主。包内不含任何密钥。

| 项 | 位置 |
|---|---|
| 键名（唯一权威） | `JUBIANAI_ADMIN_TOKEN`，由 `tool-jubian` 定义并导出 |
| 值的存储 | `$DSH_HOME/.credentials.yaml`，经 `credentials` 服务读写 |
| 写入界面 | `tool-jubian` 提供 `settings.section` 一个"剧变"页；`credentials.describe([ref])` 查状态、`credentials.set(ref, value)` 写入（照 `packages/client/ui-settings-models/src/client/operations.ts:85,89` 的现成做法） |
| 环境变量覆盖 | `JUBIANAI_ADMIN_TOKEN`，用于 CI/容器 |

**凭证层级**（`packages/credentials/credentials-local/src/index.ts:5-10`）：

```
继承的进程环境（只读，最高）
> $DSH_HOME/.credentials.yaml（provider 管理，可写）
> <启动目录>/.env
> $DSH_HOME/.env
```

进程环境优先，因此 `JUBIANAI_ADMIN_TOKEN=… dsh` 会盖过设置页的值并使其显示为只读。这是设计意图，文档需写明，避免"改了没生效"的误判。

**禁止**：任何把 `.credentials.yaml` 或明文 token 复制进 `packages/jubian/` 的做法。该文件当前不被 git 跟踪，一旦入包即随检出外流，而检出 remote 是 `deepseek-ai/deepseek-harness`。

**token 边界修复**：沿用 `jubian-credential.ts:12-23` 的语义——去掉首尾空白、一个 shell 分隔符（`;`/`&`）、一对成对引号；值内部仍有空白则本地按 `AUTHENTICATION_REQUIRED` 失败，不发请求、不记录、不回显。

## 6. 幂等账本

目的只有一个：网络超时或回应歧义时，能查清"这笔到底发出去没有"，而不是靠猜。

每次写方法的记录：

| 字段 | 含义 |
|---|---|
| `record_id` | `req_` + 单调 ID |
| `at` | 出网前的时间戳 |
| `method` | 工具方法名 |
| `idempotency_key` | **调用方通过工具入参提供，必填**；缺失即 `INVALID_ARGUMENT`，不代生成（见下） |
| `request_sha256` | 请求体规范化哈希 |
| `quoted_amount` / `quote_standard_id` / `quote_observed_at` | 出网前抓取的报价快照（能取到时） |
| `http_status` / `application_code` / `response_sha256` | 出网后回填；未回填即为未知 |
| `outcome` | `accepted` = HTTP 2xx 且 `application_code` 为 0 或 200；其余（含超时、异常、非成功码）一律 `unknown` |

实现要求：

- **`idempotency_key` 必填且不代生成。** 它唯一的用途是让调用方在一次超时后能安全重发。若插件在缺失时自动生成，重发就会拿到新键、绕过既有记录，正是这个机制要防的事——因此缺失是错误，不是便利。
- 同键重复调用**不重发**，直接返回既有记录，并在结果里标明 `replayed: true`。
- **出网前先落一条，回填第二条**；崩溃或超时留下的"只有前半条"的记录就是未知态，可被查询与对账；
- **绝不自动重试**写请求。未知态只能由调用方看到记录后自行决定；
- 存储：NDJSON 追加写，按日分片，位于 `$DSH_HOME/jubian/ledger/`（路径可配置）。

## 7. 错误处理

五个稳定错误码，与远端响应体、远端 message、token 完全隔离（`jubian-catalog.ts:8-17,239-243,265-267`）：

| 码 | 触发 |
|---|---|
| `AUTHENTICATION_REQUIRED` | 无 token / token 含内部空白 / HTTP 401 或 403 / 信封 code 401 或 403 |
| `PERMISSION_DENIED` | 信封 code 403 且 HTTP 为 2xx（HTTP 层的 403 一律归 `AUTHENTICATION_REQUIRED`） |
| `RATE_LIMITED` | HTTP 429 / 信封 code 429 |
| `CONTRACT_CHANGED` | 响应不是 JSON 对象、非严格 UTF-8、超字节上限、信封形状不符 |
| `NETWORK_ERROR` | 连接失败、超时、重定向被拒、其他非 2xx |

**已解析的一处历史不一致**：产品代码对 HTTP 403 有两种处理——`jubian-catalog.ts:241` 归 `PERMISSION_DENIED`，`jubian-asset-reader.ts:306` 归 `AUTHENTICATION_REQUIRED`。本设计统一取后者：HTTP 层的 401 与 403 都表示"这个 token 用不了"，`PERMISSION_DENIED` 只由信封内的 `code: 403` 产生（HTTP 2xx 但应用层拒绝）。实现与测试均以此为准，不再重新推导。

工具层把错误码转成可读文本返回给模型，**永不携带远端响应体**。

## 8. HTTP 客户端契约

```ts
class JubianClient {
  constructor(options: {
    credential: () => Promise<string>   // 注入式；tool-jubian 注 credentials，测试注固定值
    baseUrl?: string                    // 默认 https://web.jubianai.net/prod-api
    timeoutMs?: number                  // 默认 30000，上限 60000
    maxResponseBytes?: number           // 默认 2 MiB，上限 32 MiB
    ledger?: JubianLedger               // 省略即不记账（纯读场景）
  })
  request(input: {
    method: 'GET' | 'POST' | 'PUT'
    path: string
    body?: JsonObject
    signal?: AbortSignal
  }): Promise<{
    transport: { http_status: number | null; application_code: number | null }
    response_sha256: string | null
    data: unknown                       // 已通过信封与 code 校验后的 data
  }>
}
```

固化行为（与产品现有实现逐条对齐）：

- 固定 origin，`redirect: 'error'`，单次尝试，**不重试**；
- 超时通过 `AbortSignal.timeout` 与该次调用自身的 signal 组合；
- 流式读取并按 `maxResponseBytes` 截断，超限报 `CONTRACT_CHANGED`；
- 严格 UTF-8 解码（`fatal: true`）、必须是 JSON 对象、`code` 必须为 0 或 200；
- `code === 0` 与 `200` 都视为成功（远端两种都出现过）。

**`jubian` 与 `jubian-api` 内不得出现任何按业务字段取值的逻辑**，只有信封形状检查；业务字段解析一律留在 `jubian-api` 各自的读取器里，上游新增字段不会导致工具报错。

## 9. 测试

- 单元：`trimBearerToken` / `isUsableBearerToken` 的全部边界；信封与错误码映射；幂等键计算与账本追加-回填。
- 契约：用录制的响应样本钉住每个读取器的字段解析，新增样本即新增用例。
- 网络：所有测试经注入的 `fetch` 替身进行；**默认测试套件不发起真实网络请求**。
- 写路径：以一个显式的、需人工开启的 opt-in 用例验证真实提交（默认跳过）。

## 10. 实施顺序

1. `packages/jubian/jubian` + `packages/jubian/jubian-api`：客户端、错误码、账本、凭证修复；先只接通 `/model/charge/getSelectList`，用它验证登录态与信封。
2. `packages/jubian/tool-jubian`：注册 4 个工具，**这一阶段只注册读方法**（17 个中的 12 个读端点）。
3. 写方法逐个落地，每个都必须先有账本：`image_generate` → `storyboard.create`/`save` → `generate` → `erase_subtitle` → `confirm_casting`。
   - 顺序理由：从"最像普通 POST"到"GET 带副作用"，风险递增，前面的阶段为后面的建立账本与错误处理的可信度。
4. `packages/jubian/client-jubian`：设置页那一格 token 写入界面。
   - 可选。不做也能用（环境变量或直接编辑 `.credentials.yaml`），做了才是"挂上就能用"。
5. 文档：`packages/jubian/tool-jubian/README.md` 记录端点表、计费标注、凭证层级与账本位置。

**阶段 1–3 交付后，DSH 任意模式即可读、可写剧变**；阶段 4 只消除首次配置的摩擦。

## 11. 风险

1. **第三方实现，无官方文档**。`web.jubianai.net` 的响应结构可能变化，当前所有形状都是从产品代码与归档的 `references/api-contract.md` 反推的。缓解：信封与业务解析分层（第 8 节末）。
2. **静态提取不等于运行时验证**。第 3 节清单来自代码，未逐个发起真实请求核对。缓解：实施第 1 步先用一个只读端点验证登录态与信封，再逐个确认。
3. **写方法的入参形态尚未完整提取**（第 4.1 节）。这是实施阶段的第一项工作，不是可以跳过的细节。
4. **`isGenerate` 与计费耦合**。同一个 `/aigc/storyboard` PUT，`:0` 免费、`:1` 收费，工具层必须把两者拆成两个方法，不能合成一个带布尔参数的方法。
5. **凭证层级会静默覆盖设置页**（第 5 节）。

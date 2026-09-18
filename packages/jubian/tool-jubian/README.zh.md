---
description: "五个剧变（Jubian）工具：DSH 模型用它们驱动一次制作——目录读取、资产与分镜写入、计费的图片与视频生成、去字幕、转高清，以及提供方媒体下载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jubian

[English](README.md) | 中文

## 概述

`dsh-tool-jubian` 给 DSH 模型五个工具，端到端驱动一次剧变制作：目录读取、资产与分镜编辑、计费的图片与视频生成、去字幕、转高清，以及媒体下载。读取免费；每个计费或改变状态的调用都需要调用方给出的 `idempotency_key`，插件在请求离开前写一条 intent，在响应返回后写一条 settle。同一个 key 重放不会发送任何请求，直接返回已记录的结果。账本是判断一次超时到底有没有扣费的唯一依据。

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

在需要读取或改变剧变制作的任意 preset 里挂载这一行，然后把任务交给模型；五个工具会把各自的费用写在描述里一起出现。

### 何时选择

当 agent 必须查看项目、确认出演、生成图片、生成或擦除视频、把成片转成 1080p，或把提供方媒体取回给本地的看图工具时，选择本包。凭证能解析的地方都可以挂载它，因为同一行既服务只读勘察，也服务计费生成。会话完全不接触剧变时不要挂载：无论是否使用，五个 schema 与它们的描述都会一直对模型可见。

### 最小配置

```yaml
- insert:
    - id: tool-jubian
      name: '@deepseek-ai/dsh-tool-jubian'
      # config is optional:
      # ledgerRoot: D:\somewhere\jubian-ledger   # default <DSH_HOME>/jubian/ledger
      # baseUrl: https://web.jubianai.net/prod-api
      # timeoutMs: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ledgerRoot` | `<DSH_HOME>/jubian/ledger` | 存放写账本的目录；每天一个 NDJSON 文件 |
| `baseUrl` | 传输层自己的默认 origin | 覆盖所有请求的 origin |
| `timeoutMs` | 传输层自己的默认值 | 单次调用的中止预算，单位毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-jubian)是每个受支持字段及其 JSDoc 的穷尽式真源。这一行注入 `tools` 与 `credentials`，并在挂载时注册全部五个工具；没有按工具启用的开关。

### 凭证

这一行在每次调用时通过 `ctx.credentials` 解析提供方令牌，所以在凭证库中修改的值会被下一次调用直接取用，不需要重启。

| 项 | 位置 |
|---|---|
| 引用名 | `JUBIANAI_ADMIN_TOKEN`，由传输层包声明 |
| 值的存储 | `$DSH_HOME/.credentials.yaml`，经 DSH `credentials` 服务读取 |
| 环境变量覆盖 | `JUBIANAI_ADMIN_TOKEN` |

凭证提供方按以下顺序解析，越靠前优先级越高，来自 [`credentials-local`](../../credentials/credentials-local/src/index.ts)：

```text
inherited process environment (read-only, highest)
> $DSH_HOME/.credentials.yaml (provider-managed, writable)
> <launch directory>/.env
> $DSH_HOME/.env
```

继承的进程环境优先级最高，所以 `JUBIANAI_ADMIN_TOKEN=… dsh` 会盖过已存储的值并让它显示为只读。当改过的 token 看起来没生效时，先查这个顺序。传输层会修复粘贴通常带来的边界痕迹——首尾空白、一个 `;`、一对引号——且从不改写 token 本身；值内部还有空白时本地就失败，一个请求都不会发出。明文永远不会进入工具结果。

### 五个工具

五个注册工具就是全部面向模型的表面。本包不发布系统提示词区段，因此模型需要的每条操作事实都写在工具描述或 schema 描述里。

| 工具 | 方法 | 计费与副作用 |
|---|---|---|
| `jubian_catalog` | `models`、`rate`、`script`、`episodes` | 只读，不产生费用 |
| `jubian_asset` | `get`、`list`、`materials`、`generated_image` | 只读，不产生费用 |
| | `confirm_casting` | 用 `GET` 改变远端状态；需要 `idempotency_key` |
| | `remove` | 不可恢复地删除一个父资产；需要 `idempotency_key` |
| `jubian_storyboard` | `get`、`create`、`save` | 写，但免费；`save` 强制 `isGenerate=0` |
| | `generate`、`erase_subtitle` | 计费且不可撤销；需要 `idempotency_key` |
| `jubian_video` | `task`、`tasks`、`subtasks` | 只读，不产生费用 |
| | `image_generate`、`upscale` | 计费且不可撤销；需要 `idempotency_key` |
| `jubian_media` | `download` | 免费且不需要凭证；写入一个本地文件 |

- `jubian_catalog` 读取某一任务类型的账户模型目录（`task_type` 1 视频、2 图片、10 去字幕）、用 `standard_id` 读取单个计价标准、用 `script_id` 读取剧本身份，以及它的分集分页。
- `jubian_asset` 读取单个资产、项目资产分页、已确认的主体设定材质，或某个资产的生成图 URL。`confirm_casting` 接受的是生成材质 ID——不是父资产，也不是任务 ID——并让该材质被本次制作采用。`remove` 发出 `DELETE /aigc/asset/removeAsset/{assetId}?scriptId=<id>&isParent=1`：父资产与其媒体版本被移除，引用它的镜头匹配不会因此重建，已生成的视频也不会重新生成。取消一次选用决定是另一个动作；`remove` 不是它。
- `jubian_storyboard` 读取单个分镜、用调用方给出的完整请求体新建分镜、保存而不生成、提交生成，或擦除烧录字幕。`generate` 先读当前分镜快照，把 `isGenerate=1` 写回，因此还必须给出与该分镜已保存时长一致的 `content_duration_ms`；不一致时在任何请求离开前就失败。`erase_subtitle` 需要视频画面尺寸，并接受可选的 `model_id` `quzimuToB`（区域性，需 `subtitle_box`）或 `ark-erase-video-subtitle-pro`（自动，不接受 `subtitle_box`）；其余源身份从提供方读取。
- `jubian_video` 读取单个任务（含观测到的费用）、项目视频任务分页，或某个任务的子结果——子结果带成片 `video_url`、字幕像素框、阶段历史、每个结果的分辨率与 `needs_upscale` 判定。`subtasks` 用 `POST` 请求体承载查询，但仍然只读。`image_generate` 生成一张计费的资产图：必填 `asset_name`、`asset_type`、`prompt`，可选有序的 `references`；给出 `parent_asset_id` 时用 `PUT` 重生成该资产，否则用 `POST` 新建。`upscale` 提交一次计费的 1080p 转换（SeedVR2 视频高清，1 元/条），只需 `task_id` 与 `idempotency_key`；其他身份都从父任务与其首个子结果读取。
- `jubian_media` 把一个提供方媒体下载到 `output_path`，返回路径、探测出的媒体类型、字节数与 sha256。它绝不把字节放进结果：几十 MB 的 base64 会污染之后每一次请求。

### 安全写入：幂等与账本

每个写方法都要求非空的 `idempotency_key`，且任何方法都不代生成 key；代生成的 key 会让一次结果未知后的重试绕过第一次尝试的记录。

同一个 key 再调一次**不发任何请求**，直接返回既有记录并带上 `replayed: true`。这条保证是结构性的而不是约定：写请求体是惰性编译的，所以重放的调用连编译请求体所需的提供方读取都不会发生。

账本位于 `<ledgerRoot>/YYYY-MM-DD.ndjson`，分两阶段追加：

- **出网前**落一条 `intent`，含 key、方法、请求体的 `sha256` 与报价快照；
- **出网后**回填一条 `settle`，含 `http_status`、`application_code`、`response_sha256` 与 `outcome`。

只有 intent 没有 settle 的那条，就是超时留下的"未知态"，也是回答那次调用到底扣没扣费的唯一依据。只有 HTTP 为 2xx 且信封 `code` 为 `0` 或 `200` 时 `outcome` 才是 `accepted`；其余一律 `unknown`。

### 错误

传输失败会归结为五个稳定码之一，且永不携带提供方的响应文本或 token。

| 码 | 触发 |
|---|---|
| `AUTHENTICATION_REQUIRED` | 无 token、token 含内部空白、HTTP 401 或 403，或信封 `code` 401 或 403 |
| `PERMISSION_DENIED` | HTTP 为 2xx 而信封 `code` 为 403 |
| `RATE_LIMITED` | HTTP 429 或信封 `code` 429 |
| `CONTRACT_CHANGED` | 非 JSON 对象、非法 UTF-8、超出字节上限、信封形状不符，或读取器字段缺失 |
| `NETWORK_ERROR` | 连接失败、超时、重定向被拒，或其他非 2xx 状态 |

### 提交异步阶段

去字幕与转高清都是提供方的异步任务。`erase_subtitle` 与 `upscale` 在提供方受理后立刻返回，并附上被受理的任务 ID；实测一次转高清会持续几分钟到十几分钟。

```text
submit -> receive the accepted task id -> do other work -> re-read subtasks
```

不要在提交处阻塞等待。之后回读 `jubian_video` 的 `subtasks`，用该任务的 `hd_count`、`last_task_type` 与 `resolution` 判断是否完成，而不是靠最初那次响应。回读时传入 `delivery_resolution`（例如 `1080p`），每一行才会得到 `needs_upscale` 判定：`true` 表示该结果低于目标分辨率、不能就这样交付；`null` 表示标签不足以判断。改扩展名或本地转码都不能顶替提供方的这一阶段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释这一行是怎么搭起来的；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在三个决定之上：

- **描述承载 schema 装不下的事实。** 每个工具描述都用模型自己阅读的语言写明哪些方法花钱、哪些动词会说谎、以及超时永远不等于"可以重试"。注册表负责类型与校验；描述负责这些操作事实。
- **付费授权留在调用方。** 这一行不做预算检查，也不做付费确认。它只保证一件事：重放的 key 不会变成第二次扣费。到底该不该花，是部署方与调用方的决定。
- **传输层拥有线上行为，账本拥有金钱问题。** 凭证解析、信封归一、错误分类、重定向与字节上限都属于 `dsh-jubian`。两阶段账本与惰性编译的请求体留在这里，因为只有这一层知道哪些方法是写。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 接口、账本与客户端构造、五次 `ctx.tools.register`，以及共享的参数与输出约定 |
| [`src/methods.ts`](src/methods.ts) | 每个工具一个 async 函数：方法派发、请求塑形、两阶段 `writeUnderLedger` 助手，以及本地媒体写入 |
| — | 不发布运行时不变量配套入口，因为这是面向模型的适配器、不拥有独立生命周期事件流；执行关系属于它调用的能力 seam。 |

### 写路径

写方法先拒绝缺失的 key，再向账本查这个 key 是否已存在。命中时直接返回已存结果，既不编译请求体也不发请求。未命中时编译请求体——可能需要先读提供方，例如图片生成要取实时选择器——记录报价快照，追加 intent，只发送一次请求，再追加 settle。请求抛错时同样会追加一条状态为 null 的 settle，所以文件总能显示这次尝试已经离开进程。

### 读路径

读方法从不触碰账本。每次发送一个请求，把信封的 `data` 交给 `dsh-jubian-api` 里的读取器，由它返回带具名字段的归一对象，而不是提供方的原始形状。无法识别的提供方值会以 `null` 保留而不是被猜测，这也解释了 `needs_upscale` 为什么可能是 `null`：无法识别的分辨率标签没有诚实的判定。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从生成目录进入这一行之下的两个包，以及它所依赖的凭证规则。

- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jubian)——五个工具的精确 schema 与描述。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-jubian)——每个受支持配置字段及其源声明。
- [dsh-jubian 传输层源码](../jubian/src/index.ts)——这一行所依赖的客户端、五个稳定失败码、凭证修复与写账本。
- [dsh-jubian-api](../jubian-api/README.zh.md)——每个方法背后的读取器与请求构造器。
- [dsh-credentials](../../credentials/credentials/README.zh.md)——凭证引用与记录 seam，以及解析顺序。
- [凭证记录与授权流程](../../../.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)——token 值为何由提供方管理。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到 `jubian_catalog`、`jubian_asset`、`jubian_storyboard`、`jubian_video` 与 `jubian_media` 的 schema 与描述，即[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jubian)中生成的那一份。每个 schema 都是一个开放 JSON 对象，带必填的 `method` 枚举与该方法是接受的参数；参数与枚举描述是纯中文文本，因为它们面向模型而不是面向本地化 UI。提供方定义的数字码照原样出现——`task_type`（`1` 视频、`2` 图片、`10` 去字幕）、`asset_type`，以及 `subtasks` 的 `hd_count`／`last_task_type`／`resolution`。

#### Token 影响

这一行挂载期间每次请求固定开销：五份工具定义及其枚举与参数描述，没有提示词区段。启用或移除这一行是这笔开销的唯一手段。

#### KV Cache 影响

只要挂载的工具集与包版本不变，前缀就保持稳定；包升级、挂载变化，或任何描述序列化形式的改变，都可能使从第一处变化的定义 token 起的复用失效。

### 描述中的幂等约定

#### 模型看到的内容

每个写方法的描述都写明 `idempotency_key` 必填、同一个 key 再调一次会返回既有记录并带 `replayed: true` 而不发送任何请求，以及超时或结果未知时应改用同一个 key 而不是新 key 再调一次。读方法不接受 key。

#### Token 影响

每次写方法描述里的固定增量，并在共享的 `idempotency_key` 参数描述中重复一次；不占提示词 token。

#### KV Cache 影响

只要描述文本不变，前缀就保持稳定。改动这些句子属于包变更，因此会从第一处变化的工具定义起使复用失效。

### 描述中的费用与副作用警告

#### 模型看到的内容

描述把 `jubian_video` 的 `image_generate` 与 `upscale`、`jubian_storyboard` 的 `generate` 与 `erase_subtitle`、以及 `jubian_asset` 的 `remove` 标为计费或不可撤销，并写明 `confirm_casting` 虽然动词像读取，却用 `GET` 改变了远端状态。`jubian_video` 的 `subtasks` 写明它的 `POST` 只读。异步方法写明它们受理即返回、完成与否要之后从 `subtasks` 回读。

#### Token 影响

每个工具的固定描述文本；计费工具带着本包最长的描述。不占提示词 token，在模型调用之前也不产生结果 token。

#### KV Cache 影响

只要挂载集合与这些描述不变，前缀就保持稳定；改写它们的包变更会从第一处变化的定义起使复用失效。

### 工具结果

#### 模型看到的内容

每次调用都在共享的开放对象输出 schema 下返回一个美化打印的 JSON 对象，按发问的方法命名（`asset`、`assets`、`storyboard`、`subtasks`、`task` 等），并附模型用的指引字段。写结果带 `replayed`、`outcome`、`response_sha256` 与信封数据；`erase_subtitle` 与 `upscale` 另加 `accepted_task_id` 和一句告诉模型不要等待的 `next`。每个工具结果产生后都会留在会话里。

#### Token 影响

在本次会话余下时间里持续保留。一次分页的资产或子结果列表可能很大，因此 `page_size` 与 `delivery_resolution` 是模型自己控制结果大小的手段，而 `jubian_media` 刻意返回路径而不是媒体本身。

#### KV Cache 影响

仅追加：新的工具结果追加在可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 失败

#### 模型看到的内容

失败的调用会变成错误工具结果，携带五个稳定码之一——`AUTHENTICATION_REQUIRED`、`PERMISSION_DENIED`、`RATE_LIMITED`、`CONTRACT_CHANGED` 或 `NETWORK_ERROR`——即一个 `JubianError`。请求之前就抛出的参数与前置条件失败（例如缺少 `idempotency_key`，或 `content_duration_ms` 与该分镜已保存的时长不一致）同样使用 `CONTRACT_CHANGED`，所以单看错误码无法判断请求是否发出过；账本可以。提供方自己的响应文本与 token 永远不出现在结果里。

#### Token 影响

只有保留下来的错误结果会增加 token；请求之前抛出的失败什么都没发出。

#### KV Cache 影响

仅追加；错误位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包在哪些地方有意不完整，或需要调用方配合。它们是当前约束，不是任务清单。

- **没有花费上限、预算检查或付费写确认** —— 只要调用方要求且请求体完整，这一行就会提交。幂等只防止同一个 key 的重复扣费，不阻止第一次扣费。需要封顶或人工确认的部署必须自己加一条 `tools/pre-execute` 策略。
- **端点集合是从抓包转写的** —— 每个路径、查询参数与请求形状都以抓到的证据存在于 `dsh-jubian-api`，而不是已发布的契约。提供方一变，表现出来就是 `CONTRACT_CHANGED` 或某个字段读回 `null`；验证一条新路径需要重新抓包，所以这里没有哪个方法可以当作有 schema 版本。
- **结果未知要靠账本而不是靠本包来判定** —— 超时后这一行记录 `outcome: unknown` 并抛错。只有调用方能决定要不要用同一个 key 回读，也没有任何东西会自动对账"只有 intent 没有 settle"的那条。
- **`jubian_media` 写入调用方指定的本地路径** —— `output_path` 会被解析并按需创建，该路径上已存在的文件会被直接覆盖而不会询问。它的 origin 白名单刻意排除了某些载荷字段返回的镜像 origin。
- **不注册系统提示词区段** —— 部署方无法在不改包的情况下调整这些工具的模型指引，提供方一旦重命名某个方法，描述会一直过时到包被改动为止。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文为准。

#### 未来：付费写的预估成本

`jubian_catalog` 的 `rate` 已经能读单个计价标准，`image_generate` 也把展示单价快照进了 intent，但没有任何方法在提交前给出整批的完整预估，描述里也没有这一步。今天想要预估的调用方需要自己用目录读取拼出来。

#### 未来：账本的对账读取

没有任何东西回读账本。一个列出"只有 intent 没有 settle"的命令，本可以在不手写扫描 `<ledgerRoot>/YYYY-MM-DD.ndjson` 的情况下回答"还有什么没定论"，但目前没有这样的表面。

</details>

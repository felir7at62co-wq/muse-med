---
description: "五个剧变（Jubian）工具：DSH 模型用它们驱动一次制作——目录读取、资产与分镜写入、本地参考图上传、主体视频的分镜原生通道、计费的图片与视频生成、去字幕、转高清，以及提供方媒体下载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jubian

[English](README.md) | 中文

## 概述

`dsh-tool-jubian` 给 DSH 模型五个工具，端到端驱动一次剧变制作：目录读取、资产与分镜编辑、本地参考图上传、主体视频的分镜原生通道、计费的图片与视频生成、去字幕、转高清，以及媒体下载。读取免费；每个计费或改变状态的调用都需要调用方给出的 `idempotency_key`，插件在请求离开前写一条 intent，在响应返回后写一条 settle。同一个 key 重放不会发送任何请求，直接返回已记录的结果。账本是判断一次超时到底有没有扣费的唯一依据。

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

当 agent 必须查看项目、上传本地参考图、保存主体设定选择、准备并提交主体视频、确认出演、生成图片、生成或擦除视频、把成片转成 1080p，或把提供方媒体取回给本地的看图工具时，选择本包。凭证能解析的地方都可以挂载它，因为同一行既服务只读勘察，也服务计费生成。会话完全不接触剧变时不要挂载：无论是否使用，五个 schema 与它们的描述都会一直对模型可见。

### 最小配置

```yaml
- insert:
    - id: tool-jubian
      name: '@deepseek-ai/dsh-tool-jubian'
      # config is optional:
      # ledgerRoot: D:\somewhere\jubian-ledger   # default <DSH_HOME>/jubian/ledger
      # baseUrl: https://web.jubianai.net/prod-api
      # timeoutMs: 30000
      # workspaceSecrets: true                   # default true
      # imagePlatformId: KU_AI                   # which gpt-image-2 platform the paid image route buys from
      # imageStandardId: 66                      # or the catalogue row's own id, instead of the platform
      # imageActiveTimeoutMs: 180000             # default 180000
      # imageActivePollMs: 3000                  # default 3000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ledgerRoot` | `<DSH_HOME>/jubian/ledger` | 存放写账本的目录；每天一个 NDJSON 文件 |
| `baseUrl` | 传输层自己的默认 origin | 覆盖所有请求的 origin |
| `timeoutMs` | 传输层自己的默认值 | 单次调用的中止预算，单位毫秒 |
| `workspaceSecrets` | `true` | 凭证库没有值时，是否允许用 workspace 的流水线密钥文件顶替 |
| `imagePlatformId` | 无 | `taskType=2` 目录里 `image_generate` 从哪个 `platformId` 购买，如 `KU_AI` |
| `imageStandardId` | 无 | `image_generate` 从哪一行（`standardId`，即该行自己的 `id`）购买；它与 `imagePlatformId` 给出其一即可锁定一行 |
| `imageActiveTimeoutMs` | `180000` | `image_generate` 等待新资产变为 `hsAssetStatus` `Active` 的上限，超过即报回读超时 |
| `imageActivePollMs` | `3000` | 上面这次回读的轮询间隔 |

一个账户目录可能把同一个 modelId 按平台列成多行，各自单价不同；`image_generate` 不会替你挑其中一行，所以目录里有多行 `gpt-image-2` 而这两个字段都没配时，请求体构造阶段就会失败，并列出每个候选行的 `platformId`、`standardId`、单价与单位。

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

当凭证库解析不出任何值时，这一行才会回落到流水线自己的密钥文件 `.agents/secrets/pipeline.env`，从启动目录逐级向上查找；文件里的 `JUBIANAI_ADMIN_TOKEN` 优先于遗留的 `JUBIANAI_TOKEN`。该文件每次调用都重新读取，所以改动无需重启即可生效，值也永远不会被回显。把 `workspaceSecrets` 设为 `false` 可以让凭证库成为唯一来源。

### 五个工具

五个注册工具就是全部面向模型的表面。本包不发布系统提示词区段，因此模型需要的每条操作事实都写在工具描述或 schema 描述里。

| 工具 | 方法 | 计费与副作用 |
|---|---|---|
| `jubian_catalog` | `models`、`rate`、`script`、`episodes` | 只读，不产生费用 |
| `jubian_asset` | `get`、`list`、`materials`、`generated_image` | 只读，不产生费用 |
| | `confirm_casting` | 用 `GET` 改变远端状态；需要 `idempotency_key` |
| | `remove` | 不可恢复地删除一个父资产；需要 `idempotency_key` |
| | `upload_reference` | 免费且不创建任务；向提供方对象存储写入一个对象 |
| `jubian_storyboard` | `get`、`create`、`save` | 写，但免费；`save` 强制 `isGenerate=0` |
| | `select_assets` | 免费，强制 `isGenerate=0`；需要 `idempotency_key` |
| | `prepare_video` | 远端只读、免费；只写一个本地 preview 文件 |
| | `generate`、`submit_video`、`erase_subtitle` | 计费且不可撤销；需要 `idempotency_key` |
| `jubian_video` | `task`、`tasks`、`subtasks` | 只读，不产生费用 |
| | `image_generate`、`upscale` | 计费且不可撤销；需要 `idempotency_key` |
| | `retry` | 改变提供方任务状态；需要 `idempotency_key` |
| `jubian_media` | `download` | 免费且不需要凭证；写入一个本地文件 |

- `jubian_catalog` 读取某一任务类型的账户模型目录（`task_type` 1 视频、2 图片、10 去字幕）、用 `standard_id` 读取单个计价标准、用 `script_id` 读取剧本身份，以及它的分集分页。
- `jubian_asset` 读取单个资产、项目资产分页、已确认的主体设定材质，或某个资产的生成图 URL。`confirm_casting` 接受的是生成材质 ID——不是父资产，也不是任务 ID——并让该材质被本次制作采用。`remove` 发出 `DELETE /aigc/asset/removeAsset/{assetId}?scriptId=<id>&isParent=1`：父资产与其媒体版本被移除，引用它的镜头匹配不会因此重建，已生成的视频也不会重新生成。取消一次选用决定是另一个动作；`remove` 不是它。`upload_reference` 接受本地 `image_path`，检查两条边是否都是 16 的倍数（提供方图片流水线要求的那条规则），上传到实时前端 bundle 配置的目的地，并返回资产请求或 `image_generate` 的 `references` 所需的 `materialUrl`/`materialType`/`sortOrder` 条目。它不收费、不创建任务，但确实会向提供方对象存储写入一个对象。
- `jubian_storyboard` 读取单个分镜、用调用方给出的完整请求体新建分镜、保存而不生成、提交生成，或擦除烧录字幕。`generate` 先读当前分镜快照，把 `isGenerate=1` 写回，因此还必须给出与该分镜已保存时长一致的 `content_duration_ms`；不一致时在任何请求离开前就失败。`erase_subtitle` 需要任务 ID、视频画面尺寸和一个明确的 `model_id`：`quzimuToB`（区域性——擦除矩形按提供方对画面的默认比例推导，所以 `subtitle_box` 可选且通常省略）或 `ark-erase-video-subtitle-pro`（自动，不接受 `subtitle_box`）。它没有默认模型，所以省略 `model_id` 的调用方会被告知缺哪个参数，而不是被替它挑一个。项目、分集与源身份从任务及其子结果读取，因此不需要 `script_id`。三个分镜原生方法见下文「主体视频的分镜原生通道」一节。
- `jubian_video` 读取单个任务（含观测到的费用）、项目视频任务分页，或某个任务的子结果——子结果带成片 `video_url`、字幕像素框、阶段历史、每个结果的分辨率与 `needs_upscale` 判定。`subtasks` 用 `POST` 请求体承载查询，但仍然只读。`image_generate` 生成一张计费的资产图：必填 `asset_name`、`asset_type`、`prompt`，可选有序的 `references`；给出 `parent_asset_id` 时用 `PUT` 重生成该资产，否则用 `POST` 新建。这次写是异步的，因此该方法随后会把新资产回读到 `hsAssetStatus` 为 `Active`，并返回它的 `material_id`（`confirm_casting` 要的就是它）与 `image_url`；见下文「计费生图路径」。`upscale` 提交一次计费的 1080p 转换（SeedVR2 视频高清，1 元/条），只需 `task_id` 与 `idempotency_key`；其他身份都从父任务与其首个子结果读取。`retry` 重新执行一次已终止且未计费的失败；它先读父任务与子结果，只有在父任务已终止失败、没有任何子结果持有文件或处于活动/成功状态、且任务没有真实费用时才发送请求。
- `jubian_media` 把一个提供方媒体下载到 `output_path`，返回路径、探测出的媒体类型、字节数与 sha256。它绝不把字节放进结果：几十 MB 的 base64 会污染之后每一次请求。

### 主体视频的分镜原生通道

主体视频由提供方从一次 `isGenerate=1` 的分镜 `PUT` 创建；直接的建任务 `POST` 不会保留主体身份。生产证据把这条差异钉死了：任务 `335343` 来自分镜 `PUT`，七项身份全部保留并成功；`335470` 来自 direct `POST /admin/aigc/video/task/create`，丢失 `assetId`/`materialName` 并失败。因此本包不支持那条路径，也没有任何方法调用它。

唯一正常的顺序是三次调用：

```text
select_assets  (isGenerate=0, free)  -> prepare_video (free, local preview) -> submit_video (one PUT, paid)
```

- `select_assets` 保存一次有序的主体设定选择。每个 `material_key` 必须按提示词里 `@[名称](key)` 的顺序出现，每个选择必须唯一对应同一项目里的一行有效主体设定与一个父资产，而该行的可信 `hsAssetId` 就是提供方会翻译成子任务身份的那个值。请求体永远强制 `isGenerate=0`。这一次 `PUT` 之后，该方法会回读分镜并重新拉取项目任务列表：保存下来的顺序与计划不符就报错；而一次"仅保存选择"却带来了新视频任务时，会返回 `billing_safety_violation`，让调用方停下来而不是继续往下走。
- `prepare_video` 免费，且对提供方只读。它用实时 `scriptId` 校验 `project_dir` 里的 `project_config.json`，从实时分镜、主体设定与父资产补齐每个有序素材，要求 `9:16`/`720p`/`genNum=1` 以及 1–14 秒的整数内容时长，从实时目录里选出带 `9:16`/`720p`/`genNum=1` 标准的非 Mini Seedance 2.0 模型，并把一份 preview 通过临时文件加重命名写进 `<project_dir>/video_tasks/storyboard-<id>-<key12>.storyboard-native.prepared.json`。它不发 `PUT`、不创建任务、不收费。
- `submit_video` 接受该 `preview_path` 与一个**必须等于 preview 自带 fingerprint** 的 `idempotency_key`。key 不符、preview 已过期（写入之后实时语义变了），或该 preview 不是本插件自己的产物，都会在任何请求发出之前失败。否则它先取一份完整的分页任务快照，若第二次读取同一快照发生漂移就拒绝继续，最多发送一次 `isGenerate=1` 的 `PUT /aigc/storyboard`，再取第二份快照，认领那个有序 `assetId`/`materialName`/`imageUrl` 与模型、提示词证据都与 preview 完全一致的新任务。

判定本身就是契约。`submitted` 表示已认领唯一任务且身份完整；`subject_identity_lost` 是终态——子结果保住了 URL 却丢了身份字段，答案是人工核对，绝不是第二次 `PUT`；`reconcile_conflict` 表示出现多个候选或证据不完整，同样不是重试信号；`reconcile_required` 表示那一次 `PUT` 已经发生但暂时看不到任务，用同一个 preview 与同一个 key 再调一次只会重新对账。任何原因失败的 `PUT`——超时、`5xx`、连接中断——都会被记成 `outcome: unknown` 与 `put_ambiguous: true`：不存在自动重试，同一个 key 也永远不会发出第二次 `PUT`。

由于 key 就是 preview 的 fingerprint，同一个 preview 文件一生只能造成一次请求。因此 preview **不能**与 CLI 自己产出的 prepared 文件互换：两边的序列化文本不同，一方写出的 preview 在另一方那里会被判为过期而拒绝。

### 计费生图路径

`image_generate` 是「一次计费写 + 一次免费回读」，而它到底写在哪一行目录上，是部署决定而不是猜测：

```text
pin the gpt-image-2 row (imagePlatformId / imageStandardId)
  -> POST (or PUT) /aigc/asset                          paid, accepted with the new asset id
  -> GET /aigc/asset/{id}                               free, until hsAssetStatus is Active
  -> GET /aigc/material/getGeneratedImageByAssetId      free, the material id and the image URL
```

这次写会在资产还没有图的时候就返回；实测资产要一到两分钟后才变成 `Active`。因此结果用 `asset_status` 说明回读结论，而不是让调用方把「受理」读成「已有图」：

| `asset_status` | 含义 | 调用方该做什么 |
|---|---|---|
| `active` | 资产已读到 `Active`，生成图也已读回 | 用 `material_id` 调 `confirm_casting`，用 `image_url` 作为图片；此时才可安全落盘或送审 |
| `timeout` | 回读预算用尽时资产仍未 `Active` | 没有任何重投；稍后用 `jubian_asset` 的 `get` 或 `generated_image` 续读，绝不要换 key |
| `failed` | 提供方把该资产判为终止失败 | 换一个新的 `idempotency_key` 重新生成 |
| `replayed` | 该 key 已有记录，本次既没有发送也没有回读 | 用 `jubian_asset` 读取该资产 |
| `unverified` | 没有拿回资产 ID，或这次写并未被受理 | 先读 `jubian_asset` 的 `list`，再下任何结论 |

回读超时是**报告**出来的，不是抛出来的：计费写已经被受理、账本也已经记下，抛异常会把一次已经完成的扣费呈现成一次失败调用。任何非 `active` 的结果都带 `readback_error`，写明确认了什么、没确认什么；无论哪种结论，结果都带 `parent_asset_id`、`model_selection`（`standard_id` 与 `platform_id`，即实际购买的那一行）、`observed_asset_status` 与 `waited_ms`。

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
| `INVALID_ARGUMENT` | 调用方漏掉了该方法无法运行的参数；报错信息会点名是哪一个 |
| `NETWORK_ERROR` | 连接失败、超时、重定向被拒，或其他非 2xx 状态 |

### 提交异步阶段

去字幕与转高清都是提供方的异步任务。`erase_subtitle` 与 `upscale` 在提供方受理后立刻返回，并附上被受理的任务 ID；实测一次转高清会持续几分钟到十几分钟。

```text
submit -> receive the accepted task id -> do other work -> re-read subtasks
```

不要在提交处阻塞等待。之后回读 `jubian_video` 的 `subtasks`，用该任务的 `hd_count`、`last_task_type` 与 `resolution` 判断是否完成，而不是靠最初那次响应。回读时传入 `delivery_resolution`（例如 `1080p`），每一行才会得到 `needs_upscale` 判定：`true` 表示该结果低于目标分辨率、不能就这样交付；`null` 表示标签不足以判断。改扩展名或本地转码都不能顶替提供方的这一阶段。

`image_generate` 是唯一例外，而且只是因为不这样做结果就没法用：该方法在调用内部等待自己的资产变成 `Active`，上限由 `imageActiveTimeoutMs` 决定，超时以 `asset_status: timeout` 报告而不是抛错。

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
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 接口、账本与客户端构造、凭证回落、五次 `ctx.tools.register`，以及共享的参数与输出约定 |
| [`src/methods.ts`](src/methods.ts) | 每个工具一个 async 函数：方法派发、请求塑形，以及本地媒体写入 |
| [`src/write.ts`](src/write.ts) | 两阶段 `writeUnderLedger` 助手、请求体哈希，以及所有写路径共用的"必须有 key"检查 |
| [`src/native.ts`](src/native.ts) | 分镜原生流程：分页双快照、唯一一次 `PUT`、任务认领，以及 preview 的原子写入 |
| [`src/reference.ts`](src/reference.ts) | 本地参考图上传：读文件、可选的 `ffmpeg` 重编码、读取前端 bundle，以及带签名的对象 `PUT` |
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

描述把 `jubian_video` 的 `image_generate` 与 `upscale`、`jubian_storyboard` 的 `generate`、`submit_video` 与 `erase_subtitle`、以及 `jubian_asset` 的 `remove` 标为计费或不可撤销，并写明 `confirm_casting` 虽然动词像读取，却用 `GET` 改变了远端状态。`jubian_video` 的 `subtasks` 写明它的 `POST` 只读。`jubian_video` 的 `image_generate` 另外写明它受理后会把资产回读到 `Active` 再返回、每个 `asset_status` 取值是什么含义，以及目录里有多行 `gpt-image-2` 而未配置 `imagePlatformId`/`imageStandardId` 时会失败。`jubian_storyboard` 写明整条分镜原生顺序：`select_assets` 强制 `isGenerate=0`、`prepare_video` 既不 `PUT` 也不收费，以及 direct 建任务 `POST` 被禁止。异步方法写明它们受理即返回、完成与否要之后从 `subtasks` 回读。

#### Token 影响

每个工具的固定描述文本；计费工具带着本包最长的描述。不占提示词 token，在模型调用之前也不产生结果 token。

#### KV Cache 影响

只要挂载集合与这些描述不变，前缀就保持稳定；改写它们的包变更会从第一处变化的定义起使复用失效。

### 工具结果

#### 模型看到的内容

每次调用都在共享的开放对象输出 schema 下返回一个美化打印的 JSON 对象，按发问的方法命名（`asset`、`assets`、`storyboard`、`subtasks`、`task` 等），并附模型用的指引字段。写结果带 `replayed`、`outcome`、`response_sha256` 与信封数据；`erase_subtitle` 与 `upscale` 另加 `accepted_task_id` 和一句告诉模型不要等待的 `next`。`image_generate` 返回 `parent_asset_id`、`model_selection`、`asset_status`、`material_id`、`image_url`、`observed_asset_status`、`waited_ms`、`readback_error` 与一句 `next`，因此模型从结果里读到这张图的身份，而不是把「受理」当成「已有图」。`prepare_video` 返回整份 preview 及其 `preview_path`；`submit_video` 返回认领判定（`submitted`、`subject_identity_lost`、`reconcile_conflict` 或 `reconcile_required`）、认领到的 `task_id`，以及一句只指出唯一安全动作的 `next`。每个工具结果产生后都会留在会话里。

#### Token 影响

在本次会话余下时间里持续保留。一次分页的资产或子结果列表可能很大，因此 `page_size` 与 `delivery_resolution` 是模型自己控制结果大小的手段，而 `jubian_media` 刻意返回路径而不是媒体本身。

#### KV Cache 影响

仅追加：新的工具结果追加在可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 失败

#### 模型看到的内容

失败的调用会变成错误工具结果，携带六个稳定码之一——`AUTHENTICATION_REQUIRED`、`PERMISSION_DENIED`、`RATE_LIMITED`、`CONTRACT_CHANGED`、`INVALID_ARGUMENT` 或 `NETWORK_ERROR`——即一个 `JubianError`。`INVALID_ARGUMENT` 把调用方自己的失误与提供方的行为分开：它在派发之前抛出、点名缺失的参数，并且意味着没有发出任何请求、没有写任何账本行。信封层与读取器层的意外使用 `CONTRACT_CHANGED`，所以单看这个码无法判断请求是否发出过；账本可以。调用方事先看不到的前置条件（例如 `content_duration_ms` 与该分镜已保存的时长不一致）同样使用 `CONTRACT_CHANGED`。提供方自己的响应文本与 token 永远不出现在结果里。

#### Token 影响

只有保留下来的错误结果会增加 token；请求之前抛出的失败什么都没发出。

#### KV Cache 影响

仅追加；错误位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包在哪些地方有意不完整，或需要调用方配合。它们是当前约束，不是任务清单。

- **没有花费上限、预算检查或付费写确认** —— 只要调用方要求且请求体完整，这一行就会提交。幂等只防止同一个 key 的重复扣费，不阻止第一次扣费。需要封顶或人工确认的部署必须自己加一条 `tools/pre-execute` 策略。
- **计费生图只会从部署锁定的那一行购买** —— 账户目录可能把 `gpt-image-2` 按平台列成多行、各自定价，而本插件没有在它们之间选择的规则：多行且 `imagePlatformId` 与 `imageStandardId` 都未配置时，请求体构造阶段就会失败并列出全部候选。这是刻意的——给一个默认值意味着在没人选过的平台上花真钱——但代价是：新账户一旦多出第二行 `gpt-image-2`，`image_generate` 在锁定之前就是一个配置错误。
- **生图回读超时是一个结论，不是一次失败** —— `image_generate` 报 `asset_status: timeout` 而不抛错，因为计费写已被受理、账本也已记账。调用方仍需自己回读；到底是提供方慢还是生成失败，本包无法从截止时间上看出来。
- **`upload_reference` 处理不合规图片时需要本地 `ffmpeg`** —— 提供方图片流水线要求两条边都是 16 的倍数，Node 没有内置图像编解码器，而本包不增加运行时依赖，所以已经合规的文件按原字节上传，其余文件交给外部 `ffmpeg` 重编码；该二进制按 `DSH_JUBIAN_FFMPEG`、`FFMPEG_PATH`、`MUSE_FFMPEG_EXECUTABLE`、`PATH` 的顺序解析。找不到 `ffmpeg` 时该调用返回 `alignment_required` 并给出应有的尺寸，一个字节都不会上传；它永远不会把不合规的文件送上去。
- **prepared preview 绑定在本包的序列化器上** —— fingerprint 哈希的是本插件的规范化 JSON，因此流水线 Python 客户端写出的 preview 与这里写出的 preview 不能互换，任一方都会把另一方的产物判为过期而拒绝。
- **`retry` 有前置门禁，但看不到尚未写回的费用** —— 它在发送任何请求前先读父任务与子结果，并在任务已有结果文件、有活动或成功的子结果、或已记录真实费用时拒绝。它看不到提供方还没写到任务上的扣费，所以刚失败后的重试仍然是调用方的判断。
- **端点集合是从抓包转写的** —— 每个路径、查询参数与请求形状都以抓到的证据存在于 `dsh-jubian-api`，而不是已发布的契约。提供方一变，表现出来就是 `CONTRACT_CHANGED` 或某个字段读回 `null`；验证一条新路径需要重新抓包，所以这里没有哪个方法可以当作有 schema 版本。对象存储签名是唯一的例外：它照实时 bundle 里的 SDK 复刻，并对真实 bucket 做过验证。
- **结果未知要靠账本而不是靠本包来判定** —— 超时后这一行记录 `outcome: unknown` 并抛错。只有调用方能决定要不要用同一个 key 回读，也没有任何东西会自动对账"只有 intent 没有 settle"的那条。`submit_video` 是最严格的一例：它记录这次不明确的 `PUT`、返回对账指引，并且在任何情况下都不会用同一个 key 发出第二次 `PUT`。
- **`jubian_media` 写入调用方指定的本地路径** —— `output_path` 会被解析并按需创建，该路径上已存在的文件会被直接覆盖而不会询问。它的 origin 白名单刻意排除了某些载荷字段返回的镜像 origin。
- **提供方的 `taskExecute` 与 `terminate` 没有实现** —— 流水线自己的客户端从不调用它们，在这里加上就只是没有证据的转写。如果哪天需要中止一个失控任务，`terminate` 就是最明显的缺口。
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

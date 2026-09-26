---
description: "九个剧变（Jubian）工具：DSH 模型用它们驱动一次制作——目录读取与剧本名查找、资产与分镜写入、按类别的命名规范、资产库文件夹与改名、只读的组织视图、本地参考图上传、主体视频的分镜原生通道、计费的图片与视频生成与去字幕，以及提供方媒体下载。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-jubian

[English](README.md) | 中文

## 概述

`dsh-tool-jubian` 给 DSH 模型九个工具，端到端驱动一次剧变制作：目录读取、剧本名查找、资产与分镜编辑、资产库文件夹与改名、按「集数 → 类别」的只读组织视图、本地参考图上传、主体视频的分镜原生通道、计费的图片与视频生成、去字幕、转高清，以及媒体下载。读取免费；每个计费或改变状态的调用都需要调用方给出的 `idempotency_key`，插件在请求离开前写一条 intent，在响应返回后写一条 settle。同一个 key 重放不会重复写入；支持对账的方法可以重新读取。

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

在需要读取或改变剧变制作的任意 preset 里挂载这一行，然后把任务交给模型；九个工具会把各自的费用写在描述里一起出现。

### 何时选择

当 agent 必须把一个剧本名解析成它的项目、查看项目、按集数与类别整理资产、上传本地参考图、保存主体设定选择、准备并提交主体视频、确认出演、生成图片、生成或擦除视频、把成片转成 1080p，或把提供方媒体取回给本地的看图工具时，选择本包。凭证能解析的地方都可以挂载它，因为同一行既服务只读勘察，也服务计费生成。会话完全不接触剧变时不要挂载：无论是否使用，九个 schema 与它们的描述都会一直对模型可见。

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
      # nameSeparator: '｜'                      # default '｜'
      # seriesLabel: 全剧                        # default 全剧
      # assetIndexPath: _probe/asset-index.md    # default _probe/asset-index.md
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ledgerRoot` | `<DSH_HOME>/jubian/ledger` | 存放写账本的目录；每天一个 NDJSON 文件 |
| `baseUrl` | 传输层自己的默认 origin | 覆盖所有请求的 origin |
| `timeoutMs` | 传输层自己的默认值 | 单次调用的中止预算，单位毫秒 |
| `watchPollIntervalMs` | `15000` | 观察轮询间隔，毫秒；1..60000 范围内的整数 |
| `watchTimeoutMs` | `1800000` | 观察期限，毫秒；1..86400000 范围内的整数 |
| `workspaceSecrets` | `true` | 凭证库没有值时，是否允许用 workspace 的流水线密钥文件顶替 |
| `imagePlatformId` | 无 | `taskType=2` 目录里 `image_generate` 从哪个 `platformId` 购买，如 `KU_AI`；这是兜底锁定，只在短剧设置段没有锁定行时生效 |
| `imageStandardId` | 无 | `image_generate` 从哪一行（`standardId`，即该行自己的 `id`）购买；它与 `imagePlatformId` 给出其一即可锁定一行，同样受设置页优先级约束 |
| `imageActiveTimeoutMs` | `180000` | `image_generate` 等待新资产变为 `hsAssetStatus` `Active` 的上限，超过即报回读超时 |
| `imageActivePollMs` | `3000` | 上面这次回读的轮询间隔 |
| `nameSeparator` | `｜` | 由 `episode` 参数组合出来的名字里，各段之间的分隔符 |
| `seriesLabel` | `全剧` | 服务全剧的资产的集号 token；调用方把它当作 `episode` 原样传入 |
| `assetIndexPath` | `_probe/asset-index.md` | `jubian_organize` 写索引的位置，相对于项目目录 |

`nameSeparator` 或 `seriesLabel` 为空白会让挂载失败：用它们组合出来的名字无法再切回各段。

一个账户目录可能把同一个 modelId 按平台列成多行，各自单价不同；`image_generate` 不会替你挑其中一行，所以目录里有多行 `gpt-image-2` 而没有锁定行时，请求体构造阶段就会失败，并列出每个候选行的 `platformId`、`standardId`、单价与单位。

锁定行有两个去处，设置页优先：**设置 → 短剧 → 资产图生成通道**把选择存进 `drama` 设置段，并按实时目录列出每个候选及其价格；这两个 config 字段则留给没有那个页面的部署。锁定在每次计费调用发生时解析，因此页面上的改动不需要重启就能到达下一次调用；而页面锁定的那一行就是整个选择——旁边的 config 平台会被丢掉，而不是并进一个人并没有做出的锁定里。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-jubian)是每个受支持字段及其 JSDoc 的穷尽式真源。这一行注入 `tools` 与 `credentials`，在挂载时注册全部九个工具，并挂载两个 Remote 命名空间：设置页调用的 `jubianToken`，以及只为短剧页面的选择器读取账户 `gpt-image-2` 行的 `jubianImage`；既没有按工具启用的开关，也没有单独的一行页面配置。

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

### 令牌设置页

同一个凭据在**设置 → 剧变**里有一页。这一页属于本包，而不属于通用的配置面：通用面能写页面点名的任意引用，这一页只写 `JUBIANAI_ADMIN_TOKEN`。

它会报告是否已配置、当前由哪一层来源提供、以及当前部署能否写入。只读来源（例如继承的进程环境变量）会禁用两个按钮并说明原因。保存通过宿主凭据服务写入粘贴进来的值，清除把它删掉，两者都不会回传该值：写入成功后输入框是空的，状态行是「该令牌已存」的唯一证据。

两个方向都经生成的 `jubianToken` Remote 命名空间（`describe`、`set`、`unset`）跨越浏览器与宿主之间的边界。`set` 拒绝空值或全空白值，并说明清除该引用要用 `unset`；提供方的拒绝报告为 `jubian-token/rejected`，其 details 只携带引用名。

### 生图通道 Remote 命名空间

第二个命名空间 `jubianImage` 只为一次读取而存在：`routes()` 返回账户目录里的 `gpt-image-2` 行——`standardId`、`platformId`、单价与单位——好让 **设置 → 短剧** 按价格把它们摆出来，而不是让人从一条报错里抄。它免费，读的是计费调用所读的同一份目录、走同一条传输，且这里没有任何方法会写入或回传令牌。

读不动的目录报告为 `jubian-image/catalogue-unreadable`，消息就是传输层自己的原因，页面原样显示。这里不缓存：每次调用都重读账户，因为某一行的价格与是否存在属于账户状态，而不是插件状态。

### 九个工具

九个注册工具就是全部面向模型的表面。本包不发布系统提示词区段，因此模型需要的每条操作事实都写在工具描述或 schema 描述里。

| 工具 | 方法 | 计费与副作用 |
|---|---|---|
| `jubian_catalog` | `models`、`rate`、`script`、`episodes` | 只读，不产生费用 |
| `jubian_find` | `scope`（`mine`、`pool`）、`mine` 的 `production_type`／`share_target_type` 过滤 | 只读，不产生费用 |
| `jubian_asset` | `get`、`list`、`materials`、`generated_image` | 只读，不产生费用 |
| | `confirm_casting` | 用 `GET` 改变远端状态；需要 `idempotency_key` |
| | `remove` | 不可恢复地删除一个父资产；需要 `idempotency_key` |
| | `upload_reference` | 免费且不创建任务；向提供方对象存储写入一个对象 |
| | `create_folder`、`move`、`rename` | 改变控制台里资产库的组织方式；各自需要 `idempotency_key` |
| `jubian_organize` | `index` | 只读、免费；写一个本地索引文件 |
| `jubian_model` | `preview`、`apply` | Preview 对远端只读；apply 以 `isGenerate=0` 保存用户批准的已有分镜设置 |
| `jubian_storyboard` | `get`、`create`、`save` | Get 只读；create/save 是免费写入，强制 `isGenerate=0`，包括调用方提供的创建请求体 |
| | `select_assets` | 免费，强制 `isGenerate=0`；需要 `idempotency_key` |
| | `prepare_video` | 远端只读、免费；只写一个本地 preview 文件 |
| | `generate`、`submit_video`、`erase_subtitle` | 计费且不可撤销；需要 `idempotency_key` |
| `jubian_video` | `task`、`tasks`、`subtasks` | 只读，不产生费用 |
| | `image_generate`、`upscale` | 计费且不可撤销；需要 `idempotency_key` |
| | `retry` | 改变提供方任务状态；需要 `idempotency_key` |
| `jubian_media` | `download` | 免费且不需要凭证；写入一个本地文件 |
| `jubian_watch` | `task_id`, `stage` | 只读后台观察；返回当前进程内的 job ID |

- `jubian_catalog` 读取某一任务类型的账户模型目录（`task_type` 1 视频、2 图片、10 去字幕）、用 `standard_id` 读取单个计价标准、用 `script_id` 读取剧本身份，以及它的分集分页。
- `jubian_find` 在不知道 `script_id` 的情况下按名字定位一个剧本，范围二选一：`mine`——调用方自己名下的画布项目（`GET /aigc/script/list`）；`pool`——可认领的剧本池（`GET /script/center/pool/list`）。`name` 可选，先去掉首尾空白、把内部连续空白并成一个空格、忽略大小写，再匹配 `script_name` 或 `manuscript_name` 的子串；没有拼音、别名或模糊匹配，所以差一个字就是没找到，而不是给出一个看着像的错项目。省略 `name` 就是列出该范围的第一页，而不是报错。`page_size` 只限制单次请求，不限制扫描：工具会一直翻页，直到读完 `total`、某一页为空，或达到 `scan_page_limit`；`complete: false` 表示这次没有覆盖 `total`，不要读成"就这些"，而 `scanned_pages`、`returned` 与 `truncated` 说明实际发生了什么。`status` 原样转发，且只对 `pool` 有效。`production_type` 与 `share_target_type` 原样转发为 `productionType` 与 `shareTargetType`，且只对 `mine` 有效：控制台打开「漫剧视频」时自己发的那次请求，就是在同一个 `/aigc/script/list` 上带 `productionType=0` 与 `shareTargetType=1`，所以这一对参数正是列出漫剧项目的方式。两个取值都是提供方自己的编码——本工具既不解释、也不校验、也不给默认值，因此省略的那个根本不会出现在查询串里。它不写账本、不需要 `idempotency_key`、不改动任何远端，也不会从池子里认领剧本；读不懂的响应直接报 `CONTRACT_CHANGED`，而不是当成"没找到"，因此漏本和没本仍然能区分。
- `jubian_asset` 读取单个资产、项目资产分页、已确认的主体设定材质，或某个资产的生成图 URL。`confirm_casting` 接受的是生成材质 ID——不是父资产，也不是任务 ID——并让该材质被本次制作采用。`remove` 发出 `DELETE /aigc/asset/removeAsset/{assetId}?scriptId=<id>&isParent=1`：父资产与其媒体版本被移除，引用它的镜头匹配不会因此重建，已生成的视频也不会重新生成。取消一次选用决定是另一个动作；`remove` 不是它。`upload_reference` 接受本地 `image_path`，检查两条边是否都是 16 的倍数（提供方图片流水线要求的那条规则），上传到实时前端 bundle 配置的目的地，并返回资产请求或 `image_generate` 的 `references` 所需的 `materialUrl`/`materialType`/`sortOrder` 条目。它不收费、不创建任务，但确实会向提供方对象存储写入一个对象。三个资产库写方法见下文「组织资产库」。
- `jubian_organize` 为一个项目建立一份只读视图：每一集用到哪些角色、场景与道具，各自远端的标识与状态；命名审计；类别审计；以及个人资产库每个类别的文件夹树。它不改动任何远端，只写一个本地索引文件。详见下文「组织视图」。
- `jubian_storyboard` 读取单个分镜、用调用方给出的完整请求体新建分镜、保存而不生成、提交生成，或擦除烧录字幕。`generate` 先读当前分镜快照，把 `isGenerate=1` 写回，因此还必须给出与该分镜已保存时长一致的 `content_duration_ms`；不一致时在任何请求离开前就失败。`erase_subtitle` 需要任务 ID、视频画面尺寸和一个明确的 `model_id`：`quzimuToB`（区域性——擦除矩形按提供方对画面的默认比例推导，所以 `subtitle_box` 可选且通常省略）或 `ark-erase-video-subtitle-pro`（自动，不接受 `subtitle_box`）。它没有默认模型，所以省略 `model_id` 的调用方会被告知缺哪个参数，而不是被替它挑一个。项目、分集与源身份从任务及其子结果读取，因此不需要 `script_id`。三个分镜原生方法见下文「主体视频的分镜原生通道」一节。
- `jubian_video` 读取单个任务（含观测到的费用）、项目视频任务分页，或某个任务的子结果——子结果带成片 `video_url`、字幕像素框、阶段历史、每个结果的分辨率与 `needs_upscale` 判定。`subtasks` 用 `POST` 请求体承载查询，但仍然只读。`image_generate` 生成一张计费的资产图：必填 `asset_name`、资产类别、`prompt`，可选有序的 `references`；给出 `parent_asset_id` 时用 `PUT` 重生成该资产，否则用 `POST` 新建。这次写是异步的，因此该方法随后会把新资产回读到 `hsAssetStatus` 为 `Active`，并返回它的 `material_id`（`confirm_casting` 要的就是它）与 `image_url`；见下文「计费生图路径」。`upscale` 提交一次计费的 1080p 转换（SeedVR2 视频高清，1 元/条），只需 `task_id` 与 `idempotency_key`；其他身份都从父任务与其首个子结果读取。`retry` 重新执行一次已终止且未计费的失败；它先读父任务与子结果，只有在父任务已终止失败、没有任何子结果持有文件或处于活动/成功状态、且任务没有真实费用时才发送请求。
- `jubian_media` 把一个提供方媒体下载到 `output_path`，返回路径、探测出的媒体类型、字节数与 sha256。它绝不把字节放进结果：几十 MB 的 base64 会污染之后每一次请求。

### 后台观察操作

提交返回已受理的**本次操作**任务 ID 后，调用 `jubian_watch({ task_id, stage })`；不要用源视频任务 ID 代替。`task_id` 必须是正安全整数，`stage` 为 `generate`、`upscale` 或 `erase_subtitle`。接纳后立即返回 `{ job_id, task_id, stage, status: "running" }`。缺少 `jobs` 只会使本工具失败；接纳任务还要求有已挂载的任务控制器。观察器只读同一任务及其分页子结果，不写账本，也不重投收费请求。

完成要求本次操作以所请求类型成功，且子结果列表完整、身份唯一并全部属于该操作。每个子项都必须成功且能确认输出属于请求阶段；属于本次生成的原始文件无需下游阶段标记。缺失 ID、未知阶段、不完整总数、源任务的旧成功状态和历史高清标记都不能确认完成。这些情况保持未验证，直到配置期限到达而使任务失败。提供方失败或读取失败也会使观察任务失败；都不授权重新收费提交。

现有[任务工具](../../jobs/tool-jobs/README.zh.md)通过唤醒空闲 Agent 或向忙碌 Agent 注入消息来通知完成。其 `maxConsecutiveWakes` 策略（默认 3）仍然生效，观察器不会绕过它。用 `job_output` 收集结果；`job_kill` 中止轮询及进行中的读取，不取消提供方操作。观察任务和 job ID 仅属于当前进程，重启后不恢复。返回的输出仍需抽帧、音频和交付分辨率检查；提供方成功和去字幕阶段证据不等于视觉审核通过。

### 命名规范

提供方在资产上没有分组、标签或集数字段，所以调用方能控制「控制台怎么呈现这个资产」的只有两件事：它的名字，以及本包新增资产库写方法之后的文件夹。这一行两样都管。

```text
EP05｜道具｜红包
全剧｜角色｜陆沉舟
EP05-P3-sb12-去字幕
```

前两个是资产名，第三个是处理任务名，按集数与包号排序。命名是按调用选择的：给了 `episode` 就套规范；没给就完全按调用方自己的 `asset_name` 与 `task_name` 原样发送，因此这个能力出现之前的每一次调用含义都不变。

| 参数 | 出现在 | 作用 |
|---|---|---|
| `episode` | `image_generate`、`erase_subtitle`、`upscale`、`rename` | `5` 与 `05` 都规范成 `EP05`；配置的 `seriesLabel` 表示跨集母版 |
| `asset_category` | `image_generate`、`rename` | `角色`、`场景` 或 `道具`；既是名字里的类别段，也决定提供方的 `assetType` |
| `package_number` | `erase_subtitle`、`upscale` | 在阶段自己的任务名前加 `EP05-P3-` |

`asset_category` 是对一个真实缺陷的根因修复：早先的 schema 只提供 `asset_type`，而只有 `1` 有证据，于是流水线在建场景或道具时也发 `1`，控制台就把它们归进了角色库。场景是 `2`、道具是 `3`，与资产库文件夹用的是同一套编号。`image_generate` 仍然接受 `asset_type` 以兼容旧调用方，两者必须一致——名字写着场景、类型却写角色的资产会在任何请求离开前失败。

### 组织资产库

三个写方法改变人在控制台里看到的东西。每个都需要调用方给出的 `idempotency_key`；凡是提供方只用同一个拒绝码、分不清两种失败的地方，它们都先读再写。

| 方法 | 端点 | 参数 | 做什么 |
|---|---|---|---|
| `create_folder` | `POST /aigc/assetFolder/add` | `folder_name`、`asset_scope_type`、`root_category_type`，可选 `parent_id` | 在某个类别库里建文件夹，随后回读文件夹树报告它的 `folder_id` |
| `move` | `PUT /aigc/material/move` | `material_ids`、`target_folder_id`、`asset_scope_type`、`root_category_type` | 把材质行移进文件夹，或移回库根目录 |
| `rename` | `PUT /aigc/material/reName` | `material_id`、`asset_name`，可选 `episode`/`asset_category` | 改资产的显示名称；给了 episode 就按规范组合 |

`asset_scope_type` 是 `1` 团队资产、`2` 个人资产；`root_category_type` 是 `1`/`2`/`3` 对应角色/场景/道具——与 `assetType` 同一套编号。不给 `parent_id` 时文件夹建在库根下；库根自己的 ID 就是类别数字，这也正是控制台传的值。要移出所有文件夹，就把同一个数字当作 `target_folder_id`。

两种拒绝在本地、在任何请求发出之前就定下来：同级已有同名文件夹会返回 `folder_exists` 与那个文件夹的 ID；`target_folder_id` 不在该库的文件夹树里会返回 `target_folder_missing`。至于提供方自己对改名或移动的拒绝，会以下面某个稳定失败码到达——传输层刻意不让提供方的文本进入结果。

这三个方法都不动图片、不动 ID、不换类别。改名改的是人读到的字；它不会把资产在控制台的角色/场景/道具页签之间搬——只有按正确 `assetType` 重新生成才能做到。

### 组织视图

`jubian_organize` 的 `index` 回答「这个项目按集数到底有什么」，且什么都不改。它读取项目的分页资产列表、已使用的主体材质、视频任务与每个类别的文件夹树，再与项目自己的 `assets_manifest.json` 连接。

```text
GET /aigc/asset/list?scriptId=
GET /aigc/material/list?scriptId=&isUsed=1
GET /admin/aigc/video/task/list?scriptId=&taskType=1
GET /aigc/assetFolder/tree?assetScopeType=2&rootCategoryType=1|2|3
<project_dir>/assets_manifest.json
```

资产列表会分页读到最后一页；清单就是集数映射。

结果带四样东西，同样的内容会写到 `<project_dir>/<assetIndexPath>`：

- `episodes`——每集一条，`categories`（角色/场景/道具）列出该集用到的资产及其 `asset_id`、`material_id`、清单状态、远端名与远端状态，外加名字里带该集号 token 的视频任务。
- `series`——清单里没有写集号的资产，也就是跨集母版。
- `naming_violations`——每个读起来不是 `EP{nn}｜{类别}｜{名称}` 或 `全剧｜{类别}｜{名称}` 的远端资产名与材质名，以及原因。它只报告，绝不改名。
- `category_mismatches`——提供方 `assetType` 与清单声明或自身名字声明（名字里的 场景/道具 段、`scene_`/`prop_` 前缀、日/夜 场次标记）不一致的资产。那 77 个场景与 21 个道具按 `assetType` 1 建出来的资产就在这张表里。

这里没有任何自动动作。想把任一张表变成行动，用 `rename`、`create_folder` 与 `move`——并且先问用户，因为这些是人正在读的名字与位置。

### 按范围配置模型

调用 `jubian_model preview`，提供 `project_dir`、与之绑定的 `script_id`、明确的 `scope` 与非空 `changes`。`storyboards` 接受精确远端 `storyboard_ids`；`episodes` 接受远端 `episode_ids`，不是显示集号；`project` 表示全部已有分镜，不涉及未来默认值。未指定的设置保留，选择器 ID 从实时目录重新解析。更换 `modelId` 而未给 `platformId` 时，要求唯一兼容平台，不沿用旧平台。Preview 返回每项 before/after，写入 `<project_dir>/video_tasks/<fingerprint>.model-settings.prepared.json`，不产生任何远端写入。

用户批准范围与设置后，调用 `apply`，提供同一项目绑定、`preview_path` 及等于 `fingerprint` 的 `idempotency_key`。它在第一次写入前拒绝被改动的计划、变化的成员、过期的目标或变化的目录选择器，并在每项 `PUT` 前即时回读目标。请求体从实时目标构造，只改模型设置，并强制 `isGenerate=0`。回读核验设置、提示词、资产身份/顺序与非模型值。错误会停止剩余目标并逐项报告；重放只对已尝试目标进行回读对账，不重发也不续写该计划。已生成媒体与项目未来默认值保持不变。

### 主体视频的分镜原生通道

主体视频由提供方从一次 `isGenerate=1` 的分镜 `PUT` 创建；直接的建任务 `POST` 不会保留主体身份。生产证据把这条差异钉死了：任务 `335343` 来自分镜 `PUT`，七项身份全部保留并成功；`335470` 来自 direct `POST /admin/aigc/video/task/create`，丢失 `assetId`/`materialName` 并失败。因此本包不支持那条路径，也没有任何方法调用它。

唯一正常的顺序是三次调用：

```text
select_assets  (isGenerate=0, free)  -> prepare_video (free, local preview) -> submit_video (one PUT, paid)
```

- `select_assets` 保存一次有序的主体设定选择。每个 `material_key` 必须按提示词里 `@[名称](key)` 的顺序出现，每个选择必须唯一对应同一项目里的一行有效主体设定与一个父资产，而该行的可信 `hsAssetId` 就是提供方会翻译成子任务身份的那个值。请求体永远强制 `isGenerate=0`。这一次 `PUT` 之后，该方法会回读分镜并重新拉取项目任务列表：保存下来的顺序与计划不符就报错；而一次"仅保存选择"却带来了新视频任务时，会返回 `billing_safety_violation`，让调用方停下来而不是继续往下走。
- `prepare_video` 免费，且对提供方只读。它用实时 `scriptId` 校验 `project_dir` 里的 `project_config.json`，从实时分镜、主体设定与父资产补齐每个有序素材，保留已存的模型、平台、比例、分辨率与时长，从当前目录解析精确选择器，要求 `genNum=1`。Seedance 2.0（`doubao-seedance-2-0-260128`）接受 2–15 秒总时长；Seedance 2.5（`doubao-seedance-2-5-260628`）接受 2–30 秒。总时长包含一秒自然收束；不支持或不唯一的选择直接失败，不用默认值替换。它把一份 preview 通过临时文件加重命名写进 `<project_dir>/video_tasks/storyboard-<id>-<key12>.storyboard-native.prepared.json`。它不发 `PUT`、不创建任务、不收费。
- `submit_video` 接受该 `preview_path` 与一个**必须等于 preview 自带 fingerprint** 的 `idempotency_key`。key 不符、preview 已过期（写入之后实时语义变了），或该 preview 不是本插件自己的产物，都会在任何请求发出之前失败。否则它先取一份完整的分页任务快照，若第二次读取同一快照发生漂移就拒绝继续，最多发送一次 `isGenerate=1` 的 `PUT /aigc/storyboard`，再取第二份快照，认领那个有序 `assetId`/`materialName`/`imageUrl` 与模型、提示词证据都与 preview 完全一致的新任务。`PUT` 前后都一样：一条任务行只有在能被证明属于当前分镜时才算认领的候选——行自带 `storyboardId`、任务详情自带，或它的某个子结果自带。一个项目装着它所有分镜的任务，而多数任务行根本不写 `storyboardId`，因此三者都证明不了的行属于别的分镜：它既不是匹配，也不是让判定不安全的证据。

读取任务详情和子结果前，提交与对账会排除明确带有有效集 ID、且该 ID 与 preview 不同的行。集 ID 缺失或格式无效的行仍保留为候选。补充读取最多 100 个候选、完整任务快照和账本最多一次 PUT 的保护保持不变。

判定本身就是契约。`submitted` 表示已认领唯一任务且身份完整；`subject_identity_lost` 是终态——子结果保住了 URL 却丢了身份字段，答案是人工核对，绝不是第二次 `PUT`；`reconcile_conflict` 表示出现多个候选或证据不完整，同样不是重试信号；`reconcile_required` 表示那一次 `PUT` 已经发生但暂时看不到任务，用同一个 preview 与同一个 key 再调一次只会重新对账。任何原因失败的 `PUT`——超时、`5xx`、连接中断——都会被记成 `outcome: unknown` 与 `put_ambiguous: true`：不存在自动重试，同一个 key 也永远不会发出第二次 `PUT`。

由于 key 就是 preview 的 fingerprint，同一个 preview 文件一生只能造成一次请求。因此 preview **不能**与 CLI 自己产出的 prepared 文件互换：两边的序列化文本不同，一方写出的 preview 在另一方那里会被判为过期而拒绝。

### 计费生图路径

`image_generate` 是「一次计费写 + 一次免费回读」，而它到底写在哪一行目录上，是部署决定而不是猜测：

```text
pin the gpt-image-2 row (short-drama settings page, else imagePlatformId / imageStandardId)
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

同一个 key 再调一次不会重复写入，并带上 `replayed: true`。普通写方法直接返回已记录结果，不编译请求体，也不读取提供方。`submit_video` 与 `jubian_model apply` 则执行只读对账；模型配置计划不会续写剩余目标。

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

`upscale` 将源身份与 SeedVR2 选择字段提交到 `/aigc/storyboard/hdConversion`，不发送 `videoResolution` 字段。任何端点（包括错误路径）产生的 `unknown` 记录，在路由修复后仍受同一账本 key 保护。考虑再次提交前必须核对提供方任务与费用；修改路径不构成换新 key 的授权（[路由证据](../../../.agents/notes/implemented/bug-fix/2026-09-21-jubian-upscale-route.zh.md)）。

去字幕与转高清都是提供方的异步任务。`erase_subtitle` 与 `upscale` 在提供方受理后立刻返回，并附上被受理的任务 ID；实测一次转高清会持续几分钟到十几分钟。

```text
submit -> receive the accepted task id -> do other work -> re-read subtasks
```

`needs_upscale` 仅比较实际分辨率与 `delivery_resolution`：`true` 表示低于目标，`false` 表示达到或高于目标，`null` 表示未知。它不是内容不可用判定，也不构成付费处理义务。SD2.5 默认使用原片，不自动提交或等待高清。任何模型都不能仅因 `needs_upscale=true` 自动付费；只有用户明确要求或授权具体高清处理时才调用 `upscale`，SD2.5 也可按此要求处理。普通导出尺寸与真实源分辨率须分别如实报告；本地缩放不等于恢复源画质。

已获授权的提交完成后先做别的，稍后回读 `subtasks`；用上文的操作观察器核验是否完成，而不是靠最初的响应。

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
- **计费写入要求项目额度。** 没有匹配的 `<账本目录>/authorization.json` 项目记录，也没有已挂载短剧设置提供的整剧自动人民币上限时，共享账本写路径在记录 intent 或发送请求前拒绝计费；同一个 key 重放不再发送。可写的授权文件和设置文档都不能证明人已批准，需要由使用者掌控的同意时，部署方还须单独强制执行。
- **传输层拥有线上行为，账本拥有金钱问题。** 凭证解析、信封归一、错误分类、重定向与字节上限都属于 `dsh-jubian`。两阶段账本与惰性编译的请求体留在这里，因为只有这一层知道哪些方法是写。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 接口、账本/客户端/命名规范的构造、凭证回落、九次 `ctx.tools.register`，以及共享的参数与输出约定 |
| [`src/methods.ts`](src/methods.ts) | 每个工具一个 async 函数：方法派发、请求塑形，以及本地媒体写入 |
| [`src/find.ts`](src/find.ts) | 剧本名查找：两条范围路径、共用的名字归一，以及 `complete` 判定背后的有界扫描 |
| [`src/naming.ts`](src/naming.ts) | 集数与类别的命名规范：名字组合、提供方的类别编号，以及两份审计 |
| [`src/folders.ts`](src/folders.ts) | 三个资产库写方法：建文件夹、移动、改名，以及两种在本地判定的拒绝 |
| [`src/organize.ts`](src/organize.ts) | 只读的组织视图：分页读取、清单连接、markdown 渲染与本地原子写入 |
| [`src/write.ts`](src/write.ts) | 两阶段 `writeUnderLedger` 助手、请求体哈希，以及所有写路径共用的"必须有 key"检查 |
| [`src/native.ts`](src/native.ts) | 分镜原生流程：分页双快照、唯一一次 `PUT`、任务认领，以及 preview 的原子写入 |
| [`src/reference.ts`](src/reference.ts) | 本地参考图上传：读文件、可选的 `ffmpeg` 重编码、读取前端 bundle，以及带签名的对象 `PUT` |
| [`src/token.ts`](src/token.ts) | `jubianToken` Remote 命名空间：只围绕那一个凭据引用，由 `apply` 与工具一起挂载 |
| [`src/image.ts`](src/image.ts) | 计费生图通道的锁定——`drama` 设置段压过本行 config，逐次调用解析——以及只读的 `jubianImage` Remote 命名空间，用来列出人可以锁定的那些行 |
| [`src/client/mount.ts`](src/client/mount.ts) | 浏览器半边：生成 Remote 贡献的挂载生命周期、设置项注册与注入面 |
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

- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jubian)——九个工具的精确 schema 与描述。
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

模型会看到 `jubian_catalog`、`jubian_find`、`jubian_asset`、`jubian_organize`、`jubian_model`、`jubian_storyboard`、`jubian_video`、`jubian_media` 与 `jubian_watch` 的 schema 与描述，即[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jubian)中生成的那一份。每个 schema 都是一个开放 JSON 对象：派发型工具用必填的 `method` 枚举做选择器，其他工具用这次调用自己的必填参数——`jubian_find` 是 `scope`，`jubian_watch` 是 `task_id` 与 `stage`——其后是该调用接受的参数；参数与枚举描述是纯中文文本，因为它们面向模型而不是面向本地化 UI。提供方定义的数字码照原样出现——`task_type`（`1` 视频、`2` 图片、`10` 去字幕）、`asset_type` 与 `asset_category`（`1`／`2`／`3` 对应角色／场景／道具）、`asset_scope_type`（`1` 团队、`2` 个人），以及 `subtasks` 的 `hd_count`／`last_task_type`／`resolution`。

#### Token 影响

这一行挂载期间每次请求固定开销：九份工具定义及其枚举与参数描述，没有提示词区段。启用或移除这一行是这笔开销的唯一手段。

#### KV Cache 影响

只要挂载的工具集与包版本不变，前缀就保持稳定；包升级、挂载变化，或任何描述序列化形式的改变，都可能使从第一处变化的定义 token 起的复用失效。

### 描述中的幂等约定

#### 模型看到的内容

每个写方法的描述都写明 `idempotency_key` 必填、同一个 key 再调一次会带 `replayed: true` 而不重复写入，以及超时或结果未知时应改用同一个 key 而不是新 key 再调一次。读方法不接受 key。

#### Token 影响

每次写方法描述里的固定增量，并在共享的 `idempotency_key` 参数描述中重复一次；不占提示词 token。

#### KV Cache 影响

只要描述文本不变，前缀就保持稳定。改动这些句子属于包变更，因此会从第一处变化的工具定义起使复用失效。

### 描述中的费用与副作用警告

#### 模型看到的内容

描述把 `jubian_video` 的 `image_generate` 与 `upscale`、`jubian_storyboard` 的 `generate`、`submit_video` 与 `erase_subtitle`、以及 `jubian_asset` 的 `remove` 标为计费或不可撤销，并写明 `confirm_casting` 虽然动词像读取，却用 `GET` 改变了远端状态。`jubian_video` 的 `subtasks` 写明它的 `POST` 只读。`jubian_video` 的 `image_generate` 另外写明它受理后会把资产回读到 `Active` 再返回、每个 `asset_status` 取值是什么含义、目录里有多行 `gpt-image-2` 而未锁定行时会失败、锁定行要么是人在短剧设置页上选的、要么是 `imagePlatformId`/`imageStandardId` 配置给的，以及模型应当把候选念给用户而不是自己挑，还有类别决定 `assetType`、场景与道具不能按角色发。`jubian_asset` 写明 `create_folder`、`move` 与 `rename` 会真实写入、同名文件夹或目标文件夹不存在时只报告不发送，以及批量改名或搬家必须先取得用户明确同意。`jubian_organize` 写明它只读、不重命名也不移动，但仍会写一个本地索引文件。`jubian_storyboard` 写明整条分镜原生顺序：`select_assets` 强制 `isGenerate=0`、`prepare_video` 既不 `PUT` 也不收费，以及 direct 建任务 `POST` 被禁止。异步方法写明它们受理即返回、完成与否要之后从 `subtasks` 回读。

#### Token 影响

每个工具的固定描述文本；计费工具带着本包最长的描述。不占提示词 token，在模型调用之前也不产生结果 token。

#### KV Cache 影响

只要挂载集合与这些描述不变，前缀就保持稳定；改写它们的包变更会从第一处变化的定义起使复用失效。

### 工具结果

#### 模型看到的内容

每次调用都在共享的开放对象输出 schema 下返回一个美化打印的 JSON 对象，按发问的方法命名（`asset`、`assets`、`storyboard`、`subtasks`、`task` 等），并附模型用的指引字段；只有 `jubian_find` 按它扫描的范围命名自己的结果。写结果带 `replayed`、`outcome`、`response_sha256` 与信封数据；`erase_subtitle` 与 `upscale` 另加 `accepted_task_id` 和一句告诉模型不要等待的 `next`。`image_generate` 返回 `parent_asset_id`、`model_selection`、`asset_status`、`material_id`、`image_url`、`observed_asset_status`、`waited_ms`、`readback_error` 与一句 `next`，因此模型从结果里读到这张图的身份，而不是把「受理」当成「已有图」。`create_folder` 返回 `sent`、`status`、`folder_id`、`confirmed` 与一句 `next`；`move` 与 `rename` 返回 `sent`、`status` 与一句 `next`，两种本地拒绝则返回 `status: folder_exists` 或 `status: target_folder_missing` 并带 `sent: false` 与它查找过的 ID。`jubian_organize` 返回 `episodes`、`series`、`unmatched_remote_assets`、`naming_checked`、`naming_violations`、`category_mismatches`、`folders` 与 `index_path`，与它写出的文件内容一致。`jubian_find` 返回它扫描的 `scope` 与 `name`、`total`、`scanned_pages`、`complete`、`returned`、`truncated` 与 `scan_page_limit`，以及 `matches`——每行带 `script_id`、`script_name`、`manuscript_name`、`episode_count`、`status` 与 `script_style`（提供方自己的风格编码，用来区分真人与漫剧），`scope: pool` 时另有 `can_claim`、`claim_leader_name` 与 `claim_member_name`，而 `script_style` 在 pool 下不出现，因为池子的行没有被实测到带这个字段。`prepare_video` 返回整份 preview 及其 `preview_path`；`submit_video` 返回认领判定（`submitted`、`subject_identity_lost`、`reconcile_conflict` 或 `reconcile_required`）、认领到的 `task_id`，以及一句只指出唯一安全动作的 `next`。`jubian_model` 的 preview 返回冻结的 before/after 设置与 fingerprint；apply/重放则逐项目标报告 `applied`、`stale`、`unknown`、`readback_mismatch` 与 `not_attempted`。每个工具结果产生后都会留在会话里。

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

- **模型配置不是远端事务** —— 同一运行时内、共享规范化根目录的账本实例会串行认领计划，不跨进程互斥。即时回读会检测先前编辑，但提供方没有条件 PUT，无法排除回读之后发生的竞争写入。错误会停止整批但不回滚；保留账本，先对账再创建另一份计划。项目/分集列表超过 40 页时直接失败，不应用不完整范围。
- **本地项目额度不是由人掌控的批准** —— 账本会拒绝没有匹配手工额度或短剧设置额度的计费调用，并在同一运行时串行预留；但有文件写权限的 agent 可修改这些文档，不同进程也不共享锁。组员部署需要另行强制执行归属人的策略，才可允许计费。`rename`、`create_folder` 与 `move` 等免费资产库写入仍会改变控制台展示；描述会要求先征得同意，但本行不会强制执行。
- **类别错了只能重新生成资产** —— 资产库写方法能改名、能移动，没有一个能改它的 `assetType`。按错类别建出来的资产会一直保持那个类别，索引把它列进 `category_mismatches` 而不是提供一个修复动作。
- **工作区构建不会重新生成加载器实际导入的那个 bundle** —— `pnpm run build:lib:host` 只把本包的 TypeScript 产出到 `lib/types/`；若部署是从工作副本加载本包，宿主会一直运行旧的 `lib/index.js`，直到运行 `pnpm exec tsdown --config packages/jubian/tool-jubian/tsdown.config.ts` 重写它并重启宿主。只重启不会改变任何东西，而只改 TypeScript 会看起来已经生效、实际宿主仍在执行旧 bundle。
- **`move` 与 `rename` 收的是材质 ID，不是父资产 ID** —— 控制台自己的改名与移动是 `PUT /aigc/material/reName` 与 `PUT /aigc/material/move`，它们的 `id`／`ids` 是材质行的标识，也就是 `jubian_asset` 的 `materials` 返回的 `material_id`。传父 `asset_id` 会以未知行的身份到达提供方，回来时是某个稳定失败码，而不是可区分的「没有这个材质」。
- **组织视图只读个人资产库的文件夹** —— 读树用的是 `assetScopeType=2`，即控制台默认打开的那个范围。团队资产库里的文件夹不会出现在索引里；`create_folder` 与 `move` 仍然接受显式的 `asset_scope_type`，在两个库里都能用。
- **计费生图只会从部署锁定的那一行购买** —— 账户目录可能把 `gpt-image-2` 按平台列成多行、各自定价，而本插件没有在它们之间选择的规则：多行且没有锁定行时，请求体构造阶段就会失败并列出全部候选。这是刻意的——给一个默认值意味着在没人选过的平台上花真钱——但代价是：新账户一旦多出第二行 `gpt-image-2`，`image_generate` 就得等有人去锁定：在短剧设置页上选一行，或（没有那个页面的部署）在本行的 `imagePlatformId`/`imageStandardId` 里写一行。
- **选择器读的是实时账户状态，存下的锁定行不是** —— `jubianImage.routes()` 每次调用都重读目录，而 `drama` 设置段存的是当初选中的行 id。目录里消失的那一行仍会被存着，下一次计费调用会失败并列出幸存者，而不是退回到其中一行；这与锁定错行是同一种失败，也是唯一诚实的那种。
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

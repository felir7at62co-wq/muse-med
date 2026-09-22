---
description: "短剧流水线门禁插件：在短剧会话里拦截工具调度，拒绝提示词无法保证的违规调用，供运行或排查剧变短剧流水线的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-drama

[English](README.md) | 中文

## 概述

当短剧流水线必须遵守硬规则、而不能靠提示词自觉时，使用本包。作为一个预设行挂载后，它拦截工具调度并拒绝可以判定为错误的调用：缺幂等键的剧变写方法、会落盘非法镜头脚本或 matched JSON 的写入、没有正式资产的付费分镜提交，以及在对账之前新建的计费资产。每条拒绝都是中文，并写明修复动作。它只读文件、从不写文件；不注册工具、提示词段落或事件。

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

把插件作为短剧预设的一行挂载。无需手工接线：按默认值，它判定该会话发起的每一次工具调用，并在调用破坏规则之前保持沉默。

### 何时选择

当某个会话运行仿真人流水线，而一次错误调用要么花钱、要么毁掉已编译产物时选择它——重复计费的分镜重生成、时长字段格式错误的 matched 产物、引用了没人确认过的资产的付费提交。不要指望它评判质量：它从不看图片、不看提示词措辞、也不看剪辑节奏，视觉与剪辑审核仍属于镜头脚本与视频审核技能。同样不要在与流水线无关的会话上挂载它；本行之所以是预设成员，正是为了让其他会话不为这些检查付出代价。

### 在预设中挂载

把这一行加进短剧预设的 `agent.cordis.yml`，或在 profile 补丁里按 id 覆盖它：

```yaml
- id: drama-gate
  name: '@deepseek-ai/dsh-guard-drama'
  config:
    workspaceRoot: E:\aa-manju        # fallback root when the session states no cwd
    workshopDir: short-drama          # the workshop directory below that root
    projectRoot: ''                   # explicit project root; empty means derive it
    idempotencyKey: true              # refuse a Jubian write method with no key
    shotScript: true                  # check the text a write or edit would commit
    officialAssets: true              # require an official asset before paid work
    reconcileFirst: true              # require a fresh asset reconcile before a new asset
    museToolNames: true               # explain a retired MUSE tool name
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workspaceRoot` | `''` | 兜底根路径（绝对路径），仅在会话没有声明工作目录时使用 |
| `workshopDir` | `short-drama` | 工作区根下存放短剧项目的目录名 |
| `projectRoot` | `''` | 覆盖项目根推导的绝对项目根 |
| `idempotencyKey` | `true` | 拒绝不带 `idempotency_key` 的剧变写/计费方法 |
| `shotScript` | `true` | 拒绝会落盘非法镜头脚本或 matched JSON 的写入/编辑 |
| `officialAssets` | `true` | 没有记录 `official=true` 资产时拒绝付费分镜提交 |
| `reconcileFirst` | `true` | 项目根没有新鲜且已全部处置的对账报告时，拒绝新建计费资产 |
| `museToolNames` | `true` | 对已下线的 MUSE 工具名给出替代工具说明 |

`workshopDir` 为绝对路径或含分隔符、`workspaceRoot` 或 `projectRoot` 为相对路径时，加载即报清晰错误，而不会静默地去判定错误的目录。

### 你会得到什么

按默认值，会话以 `method: generate` 调用 `jubian_storyboard` 却没有 `idempotency_key` 时，调用在触网之前就被拒绝，模型读到一句话：补上该键；如果上一次结果不明，用同一个键重复同一次调用，而不是新造一个。明确时长字段格式错误会被拒绝并给出修复建议；创作选择放行，通过 `drama_shot` 警告复核：

```text
短剧门禁拦下这次 write（…/short-drama/demo/prompts/01.txt）：时长「0秒」不合法：明确声明时长时必须是正整数秒，例如「时长：20秒」；也可省略，由 drama_shot 估算。
```

以 `method: image_generate` 调用 `jubian_video` 时，只要本项目的对账证据缺失、无法解析、超过 24 小时、比时钟超前 5 分钟以上、仍带着未处置的未登记资产，或没有标记 `ready`，调用就会被拒绝；拒绝文案写明读到的是哪一种，并给出两条可照抄的修复命令——对账本身，以及给确实不需要的资产写下处置：

```text
jubian_video.image_generate 会新建资产并真实计费，但先要有本项目的资产对账证据：对账已过期（2026-09-20T14:22:10+08:00，超过 24 小时）（已查：…\short-drama\demo-drama）。清单只记录我们生成过什么，不等于剧变项目里已经有什么；先在项目根跑一次对账：`python _tools/asset_reconcile.py`。对账列出的「远端已选用、清单里没有」的资产不要重新生成，登记进 assets_manifest.json 复用；确认不需要的写明原因：`python _tools/asset_reconcile.py --dispose <asset_id> --status ignored --note "为什么不需要"`。证据 24 小时内有效，ready=true 且 blocking 与 ignored_without_note 都为空才放行。
```

被拒绝的调用绝不进入工具主体，因此不产生费用、不写文件，而这条拒绝就是模型接下来读到的工具结果——位置与工具报错完全一致。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释单次待执行调用如何被判定、存在哪些规则以及代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

门禁建立在四项承诺之上：

- **只做可判定的规则。** 只有当工具名、已解析参数与一次文件读取就能定论时，规则才配存在。需要像素、审美或剧情判断的一切都留在技能里，因为一个靠猜的拒绝型门禁会挡住正确的工作。
- **判定「将要存在」的那个文件。** `write` 按其完整新文本判定；`edit` 按套用替换后的文件判定，并使用编辑工具自己的字面 `split`/`join` 语义，因此门禁看到的正是工具将要提交的内容，而不是一个片段。
- **用模型自己的语言拒绝。** 每条理由都是中文，点出违规的值，并用流水线既有的说法写明修复动作——字数折算规则、资产门禁、已下线的工具名。模型无法据以行动的拒绝，就是白白浪费一轮的拒绝。
- **只读，绝不写。** 插件打开文件并给出判定。它不修复、不改写参数（参数已被记录并呈现），也不新增工具、提示词段落、会话事件或服务。

### 五条规则

- **写与计费方法必须带幂等键。** 对 `jubian_model` 的 `apply`、`jubian_storyboard` 的 `create`/`save`/`generate`/`erase_subtitle`、`jubian_video` 的 `image_generate`/`upscale`、`jubian_asset` 的 `confirm_casting`/`remove`，缺失或空白的 `idempotency_key` 会拒绝该调用，并复述流水线规则：补上键；结果不明时用同一个键重复，而不是换一个新键。
- **镜头产物必须能按结构读取。** 在工作间的 `prompts/`、`matches/`、`episode_packages/` 中，明确的 `时长` 必须是安全正整数秒；允许省略时长供编译器估算。matched JSON 必须能解析、包含对象组成的 shots 数组，每镜 `script_duration` 或 `duration` 为正整数，给出的 `text` 为字符串。长镜头、慢台词、旁白与风格选择不拒绝。[`drama_shot`](../../drama/tool-shot-script/README.zh.md) 返回可操作的创作警告，并在编译时执行明确的分镜预算。
- **付费分镜提交必须有正式资产。** 除非工作间下某个项目记录了 `official=true` 资产——`assets_manifest.json` 中的条目，或在没有 manifest 时 `pipeline_state.json` 里已完成的 `official_assets` 阶段——否则 `jubian_storyboard` 的 `generate` 会被拒绝。资产生成本身刻意不受本规则约束，因为它正是「还没有任何正式资产」时运行的那一步。
- **新建计费资产前必须先对账项目。** 除非某个候选项目根下的 `_probe/asset-reconcile.json` 满足：`ran_at` 不超过 24 小时且不比时钟超前 5 分钟以上、`blocking` 与 `ignored_without_note` 都为空、`ready` 为真，否则 `jubian_video` 的 `image_generate` 会被拒绝。不带时区的时间戳按中国标准时间读取，也就是流水线工具写出的那个时区。证据来自流水线自己的只读对账——它才是把 `assets_manifest.json` 与剧变项目里已选用的资产逐条比对的那一步：清单记录的是我们生成过什么，而不是项目里有什么，只看清单的模型会重新生成一张早就存在的图。本规则只约束这一个方法；`erase_subtitle`、`upscale`、`confirm_casting` 与各只读方法仍由它们各自的规则管。
- **已下线的 MUSE 工具名会得到回答，而不是被无视。** 调用注册表解析不到的 `drama`、`asset`、`shot`、`project`、`timeline` 或 `delivery` 时，会被拒绝并给出替代工具名，而不是让模型读到会被理解成「部署坏了」的裸 `UNKNOWN_TOOL`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、快速失败的路径校验、宿主文件系统读取器与 `tools/pre-execute` 拦截器 |
| [`src/rules.ts`](src/rules.ts) | 纯判定器：规则顺序、写方法/付费提交/资产新建三张表、工作间路径分类，以及正式资产与对账证据读取 |
| [`src/shot-script.ts`](src/shot-script.ts) | 内容规则：`【镜头N】` 解析器、matched JSON 读取、有效字计数与全部拒绝文案 |
| — | 不发布运行时不变式配套组件；门禁不拥有任何独立变化的观测值。它在调用之间不保存状态、不公开快照，其全部约定都是「调用 + 所读文件」的纯函数。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从门禁所在的调度 waterfall 出发，经过流水线自己的规则，最后到它所属的 guard 组。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——`tools/pre-execute` waterfall 与拒绝所返回的 `PreToolDecision`。
- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md)——pre-execute 位于参数物化与工具主体之间的哪一段。
- [guard 组映射](../README.zh.md)——同组的 guard 包以及各自监视的对象。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本插件不注册任何工具 schema、提示词段落或会话事件：它的全部贡献就是在 `tools/pre-execute` 里拒绝一次待执行调用，而模型只会通过被拒绝调用本就产生的工具结果读到该拒绝文案。

#### KV Cache 影响

拒绝会成为该调用自己的错误工具结果，追加在结果原本会出现的位置，不改写任何更早的消息——因此可复用的请求前缀仍然可复用。被放行的调用除被拦截工具本来就产生的内容之外，不增加任何东西。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本门禁是什么、不是什么。它们是当前包约束，不是任务积压。

- **只覆盖工具可见面**——短剧预设实际使用的付费分镜路径还会经过技能脚本（`select-storyboard-assets`、`prepare-storyboard-video`、`submit-storyboard-video`），它们从 shell 启动，从不经过工具调度，因此本门禁看不到它们。
- **shell 写入完全绕过内容规则**——只有 `write` 与 `edit` 工具会被检查。由 shell 命令生成或复制的脚本改由编译器判定。
- **工作间之外的写入不被检查**——内容规则只作用于 `<workspaceRoot>/<workshopDir>` 之下，且只在流水线写入的 `prompts/`、`matches/`、`episode_packages/` 目录内，因此归档的原始剧本与其他任何文件都不受影响。
- **没有工作区根就没有文件规则**——会话没有声明工作目录、部署也没有配置兜底根时，内容规则、正式资产规则与对账规则都没有可判定的项目，会放行而不是拒绝；幂等键规则与下线工具名规则仍然生效。
- **正式资产证据按工作间而非按镜头**——门禁证明的是工作间下某个项目有正式资产，而不是本次提交的镜头引用了这些资产。在工作间存放多个项目时，这项检查比字面读起来更弱。
- **对账证据同样按工作间、且不认项目身份**——同一次搜索接受任何候选项目根，证据里的 `script_id` 也从不与正在写入的项目比对，因此在存放多个项目的工作间里，一个项目的新鲜报告会让另一个项目也能新建资产。
- **对账只覆盖本项目**——它比对的是 `assets_manifest.json` 与剧变项目里已选用的资产。别的项目里现成资产能否复用是另一次检索（asset-library 技能与报告自带的 `cross_project_note`），本门禁从不读那个字段。
- **只校验 `official` 标记本身**——拒绝文案同时说明资产需要剧变 asset/material id 与 URL，但检查只读该标记，因此 `official: true` 的记录即使 id 已失效或缺失也仍然通过。
- **创作警告属于编译器结果**——文件拦截器不向成功写入追加建议；调用 `drama_shot validate/preview/compile` 复核节奏、发声与提示词建议。
- **此处不检查视频打包**——明确的分镜时长预算、任务边界与台词/说话人连续性属于编译器和提交执行器，而非单次文件写入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关文档为准。

本门禁读取的工作间布局（`short-drama/<项目>/` 下的 `prompts/`、`matches/`、`episode_packages/`、`assets_manifest.json`、`pipeline_state.json`）是流水线自己的约定，由工作区本地的短剧技能确立，而不是由本仓库确立。若预设改用别的根名，该行需要改的字段只有 `workshopDir`。

对账证据由工作区自己的 `_tools/asset_reconcile.py` 写出，它位于生产项目目录，不在本仓库。门禁只读它在 `_probe/asset-reconcile.json` 的 JSON，并复刻该工具 `evidence_state()` 的判定；若那个工具的字段或新鲜度窗口变了，需要跟着改的是 `src/rules.ts` 里的 `reconcileState()` 与 `RECONCILE_*` 常量。24 小时窗口刻意沿用工具自己的口径，好让 `--check` 与本门禁对「这份报告还算不算数」给出同一个答案。

拦截器在每次命中的调用上同步读取文件。这是刻意的——文件很小，读取只发生在 `write`、`edit` 与付费剧变方法上，而一个改为 await 异步文件系统服务的门禁将不得不声明它本不需要的依赖。等某个工作间真的出现大到影响性能的 matched JSON 时再重新考虑。

门禁只会拒绝，不能修复。将来的修订可以把更正后的时长作为结构化反馈交给模型，而不是一句话；但 `PreToolDecision` 排除了参数改写，而关于镜头时长的第二个事实来源会比拒绝更糟。

本行随本包的 `cordis.patch.yml` 发布，并作为一条 `insert` 落到短剧预设里；在该预设挂载之前，本包不会给任何会话带来任何影响。

</details>

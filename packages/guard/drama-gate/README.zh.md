---
description: "短剧流水线门禁插件：在短剧会话里拦截工具调度，拒绝提示词无法保证的违规调用，供运行或排查剧变短剧流水线的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-drama

[English](README.md) | 中文

## 概述

当短剧流水线必须遵守硬规则、而不能靠提示词自觉时，使用本包。作为一个预设行挂载后，它拦截工具调度并拒绝可以判定为错误的调用：缺幂等键的剧变写方法、会落盘非法镜头脚本或 matched JSON 的写入、以及没有正式资产记录的付费分镜提交。每条拒绝都是中文，并写明修复动作。它只读文件、从不写文件；不注册工具、提示词段落或事件。

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

当某个会话运行仿真人流水线，而一次错误调用要么花钱、要么毁掉已编译产物时选择它——重复计费的分镜重生成、悄悄带回旁白的镜头脚本、引用了没人确认过的资产的付费提交。不要指望它评判质量：它从不看图片、不看提示词措辞、也不看剪辑节奏，视觉与剪辑审核仍属于镜头脚本与视频审核技能。同样不要在与流水线无关的会话上挂载它；本行之所以是预设成员，正是为了让其他会话不为这些检查付出代价。

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
| `museToolNames` | `true` | 对已下线的 MUSE 工具名给出替代工具说明 |

`workshopDir` 为绝对路径或含分隔符、`workspaceRoot` 或 `projectRoot` 为相对路径时，加载即报清晰错误，而不会静默地去判定错误的目录。

### 你会得到什么

按默认值，会话以 `method: generate` 调用 `jubian_storyboard` 却没有 `idempotency_key` 时，调用在触网之前就被拒绝，模型读到一句话：补上该键；如果上一次结果不明，用同一个键重复同一次调用，而不是新造一个。写入带回旁白标记的镜头脚本会被拒绝，并给出所在行、标记与修复动作：

```text
短剧门禁拦下这次 write（…/short-drama/demo/prompts/01.txt）：第 4 行出现旁白/心声标记「旁白」。本格式没有旁白：把该台词落成画面内台词（角色在画面中当场说出，文字逐字不改）后重写；落不进画面内的段落回报失败，不要静默丢弃、不要改写成叙述字幕。
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

### 四条规则

- **写与计费方法必须带幂等键。** 对 `jubian_storyboard` 的 `create`/`save`/`generate`/`erase_subtitle`、`jubian_video` 的 `image_generate`/`upscale`、`jubian_asset` 的 `confirm_casting`/`remove`，缺失或空白的 `idempotency_key` 会拒绝该调用，并复述流水线规则：补上键；结果不明时用同一个键重复，而不是换一个新键。
- **镜头脚本与 matched JSON 必须满足流水线自己的约定。** 在工作间的 `prompts/`、`matches/`、`episode_packages/` 目录内，`write`/`edit` 在以下情况被拒绝：文本含旁白标记（`画外音`、`画外声`、`心声`、`旁白`，或独立成词的 `VO`/`OS`）；`【镜头N】` 块没有 `时长` 声明、声明为小数秒、或不在 1–4 秒内；某镜画面内台词的有效字超过 36；或声明时长与 `max(1, ceil(有效字 / 9))` 不一致。有效字只数汉字、拉丁字母与数字，标点和空格不计。matched JSON 则逐字段检查：每个 `script_duration`（或旧字段 `duration`）必须是 1–4 的整数，每镜 `text` 同样受字数与时长规则约束。
- **付费分镜提交必须有正式资产。** 除非工作间下某个项目记录了 `official=true` 资产——`assets_manifest.json` 中的条目，或在没有 manifest 时 `pipeline_state.json` 里已完成的 `official_assets` 阶段——否则 `jubian_storyboard` 的 `generate` 会被拒绝。资产生成本身刻意不受门禁约束，因为它正是「还没有任何正式资产」时运行的那一步。
- **已下线的 MUSE 工具名会得到回答，而不是被无视。** 调用注册表解析不到的 `drama`、`asset`、`shot`、`project`、`timeline` 或 `delivery` 时，会被拒绝并给出替代工具名，而不是让模型读到会被理解成「部署坏了」的裸 `UNKNOWN_TOOL`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、快速失败的路径校验、宿主文件系统读取器与 `tools/pre-execute` 拦截器 |
| [`src/rules.ts`](src/rules.ts) | 纯判定器：规则顺序、写方法与付费提交表、工作间路径分类、正式资产证据读取 |
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
- **没有工作区根就没有文件规则**——会话没有声明工作目录、部署也没有配置兜底根时，基于文件的规则无从判定，会放行而不是拒绝；幂等键规则与下线工具名规则仍然生效。
- **正式资产证据按工作间而非按镜头**——门禁证明的是工作间下某个项目有正式资产，而不是本次提交的镜头引用了这些资产。在工作间存放多个项目时，这项检查比字面读起来更弱。
- **只校验 `official` 标记本身**——拒绝文案同时说明资产需要剧变 asset/material id 与 URL，但检查只读该标记，因此 `official: true` 的记录即使 id 已失效或缺失也仍然通过。
- **无法解析的 matched JSON 只扫描旁白**——文档解析失败时无法逐字段评估数字规则，因此只运行原始文本的旁白扫描。
- **视频打包不受门禁约束**——14 秒内容上限加 1 秒收束、切任务规则、台词与说话人连续性属于编译器的职责，不是本门禁的；它们无法从一次文件写入判定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关文档为准。

本门禁读取的工作间布局（`short-drama/<项目>/` 下的 `prompts/`、`matches/`、`episode_packages/`、`assets_manifest.json`、`pipeline_state.json`）是流水线自己的约定，由工作区本地的短剧技能确立，而不是由本仓库确立。若预设改用别的根名，该行需要改的字段只有 `workshopDir`。

拦截器在每次命中的调用上同步读取文件。这是刻意的——文件很小，读取只发生在 `write`、`edit` 与付费剧变方法上，而一个改为 await 异步文件系统服务的门禁将不得不声明它本不需要的依赖。等某个工作间真的出现大到影响性能的 matched JSON 时再重新考虑。

门禁只会拒绝，不能修复。将来的修订可以把更正后的时长作为结构化反馈交给模型，而不是一句话；但 `PreToolDecision` 排除了参数改写，而关于镜头时长的第二个事实来源会比拒绝更糟。

本行随本包的 `cordis.patch.yml` 发布，并作为一条 `insert` 落到短剧预设里；在该预设挂载之前，本包不会给任何会话带来任何影响。

</details>

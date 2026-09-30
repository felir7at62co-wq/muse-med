---
description: "Web GUI 的短剧设置：持久 `drama` 设置段（交付目录、剪映草稿根目录、交付规格、BGM 库、生图通道行、每部剧自动预算）、编辑它的设置页，以及页面上那份只读组件清单；供短剧流水线的使用者与维护者使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-drama-settings

[English](README.md) | 中文

## 概述

持有持久 `drama` 设置段、编辑它的 **设置 → 短剧**页，以及页面上那份只读的组件清单。设置段承载交付与剪映草稿目录、交付规格、本地 BGM 库、计费生图通道的 `gpt-image-2` 目录行，以及每部剧自动收费预算。Host 半把 schema 注册进设置服务；Client 半编辑解析后的值，并把被拒绝的写入报告出来，而不是显示成已保存。预算内的收费调用不需要逐笔或首次确认。项目工具保留已确认规格、已完成任务与版本历史。

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

本组合包的 `cordis.patch.yml` 会向 profile 插入这一行；也可以在运行 Web GUI 的组合里手动挂载同一行。Host 半需要一个已组合的设置提供方；没有它时不注册任何东西，Client 半则把该命名空间报告为不可用。

```yaml
- insert:
    - id: drama-settings
      name: '@deepseek-ai/dsh-drama-settings'
```

没有 config。默认值就是 schema 自己的默认值；想换默认值的部署去改用户设置文档——用这个设置页，或直接改 `$DSH_HOME/settings.yaml` 里的同一个命名空间——而不是再加一层组合配置。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `deliveryDir` | 空 | 成片交付的绝对目录；留空表示 `<项目>/delivery`，即交付模板填充的那个根（`00成片`、`01主角`、`02海报`、`05剧本&简介`） |
| `jianyingDraftDir` | 空 | 已安装剪映专业版中设置的绝对草稿根目录；留空表示未配置，不会自动探测目录 |
| `deliverySpec` | `1440` × `2560`、`60` fps、`4.6` Mbps | 成片的分辨率、帧率与码率下限 |
| `bgmDir` | （空） | 下载的曲目落到哪里；留空时唯一来源就是已发布曲库与 matcher 自己的下载缓存 |
| `imageStandardId` | 缺省 | 计费资产图通道从哪一行 `gpt-image-2` 购买，写该行自己的 `id`；缺省表示交给通道自己判断，而那只在账户目录里恰好一行时成立 |
| `seriesBudgetCents` | `400000`（人民币 ¥4000） | 未单独授权项目的人民币默认上限，非负安全整数分；无需逐笔或首次确认；没有报价及估算的调用仍被拒绝；`0` 禁止这些项目的收费调用 |

### 项目圣经

`drama_project` 在已有绝对项目目录中读取、预览和更新项目。没有结构化圣经时，`read` 返回 `unconfigured`，保留旧配置并给出当前 Settings 默认值，不创建文件。新项目记录交付默认值与不可变的 `initial_budget_cents` 初始快照。`current_settings_budget_cents` 返回默认值；已绑定项目还返回来自计费调用同一授权来源的实时 `budget` 账务。明确项目额度覆盖默认值。可编辑项目 JSON 不复制当前金额；工具返回的 Markdown 包含实时回读，磁盘圣经指向实际授权。通过 `jubian_budget` 或项目预算编辑器调整额度。`preview` 合并已确认的修改并列出受影响阶段；`update` 要求相同 changes/reason、精确 `expected_revision` 和匹配的 `preview_fingerprint`。

`project_config.json` 是权威数据。`project_bible` 保存风格、比例、精确视频模型/平台/生成分辨率、独立的交付宽高/帧率/码率、灵活分集计划、可选角色身份与已确认声音描述、稳定视频包与分镜映射、已完成任务引用和版本历史。顶层 `jubian_script_id` 与 `delivery.max_effective_chars_per_shot` 继续供现有读取方使用。其他旧字段在更新后保留。已有项目和视频包绑定不能被静默替换；已完成任务引用只追加，不抹掉旧记录。

每个角色的 `voice_profile` 可用 `reference_audio`（HTTPS URL）、`reference_audio_asset_id`、`reference_audio_sha256`（64 位十六进制）和 `reference_audio_duration_seconds`（实测，大于 0 且不超过 15）绑定已认可音频资产。替换已绑定参考须同时提供四项；更换服装或省略声音字段会保留当前声线。在已预览的更新中设 `reference_audio: null` 会删除这四项引用，保留描述和说话人 ID，落盘不存 null。旧的未绑定路径或 ID 参考仍有效。[声音连续性技能](../skills/skills/tweet-drama-voice-continuity/SKILL.md) 负责音频库回读、样本认可和原卡绑定；存储这些字段不验证远端媒体，也不能替代实际听音。

工具在项目独占写入锁下原子替换 JSON，再原子替换派生的 `project-bible.md`。含符号链接或 junction 的路径被拒绝。文件版本过期、预览被改、字段无效或锁被占用时，两份输出都不改变。JSON 提交后 Markdown 渲染失败时，错误给出已提交版本；重试前先读配置。遗留 `.project-bible.lock` 需检查后才能手工删除。视频选择仍须由实时剧变目录及准备工具验证；存储的声音指导不保证提供方能强制相同生成音色。

### 设置页

生成草稿前，Agent 无参数调用 `drama_draft_dir`。ready 结果以 `path` 返回本机已有、可读写的编辑器绝对根目录；空设置返回 `unconfigured`。路径缺失或失效时，用 `ask_user_question` 询问本机编辑器实际草稿根目录。把回答作为 `path` 传入后，工具验证目录、以修订号保护只保存 `jianyingDraftDir`，并回读确认。生成器使用返回路径且拒绝覆盖已有草稿；有效设置不重复询问。此前的写作和制作步骤不依赖此设置。

**设置 → 短剧**里每个字段一组：两个目录；交付规格的四个数字；BGM 库、资产图生成通道，以及醒目的每部剧预算。没有存储覆盖时新页面显示 ¥4000；预算以人民币元编辑，最多两位小数，留空、负数、分以下的小数或超出安全整数分均不能保存。每组显示的都是解析后的值，路径框留空即表示使用 schema 默认值。剪映专业版草稿根目录的默认值是未配置，占位符提示填写软件里设置的真实目录，不显示其他人的路径。

**保存**把表单编译成一次原子的命名空间写入，并报告结果：`已保存。`；宿主保留了另一个设置段时给出失败行；某个数字字段或预算无效时给出对应提示（这种情况一个请求都不发）。**恢复默认**用一次写入清掉全部字段，这正是把设置段交还给 schema 默认值的方式。已经等于默认值的字段保持清空状态，而不是存一份默认值的副本，因此用户层永远不会说出它并不表示的意思。设置为只读文档时两个按钮都禁用，并说明原因。

默认预算只适用于未单独授权的项目。项目预算组读取精确剧变项目 ID，显示实际总额度、已花和预留，使用聊天相同的带修订保护的授权写入方保存用户填写的新总额度。保存后下一次计费立即生效，无需重启；保留已有消费，并拒绝过期版本或低于已记账消费的额度。刷新会重新读取实际数据。恢复 Settings 默认值不会清空项目授权。

### 资产图生成通道

账户目录把 `gpt-image-2` 按平台各列一行、各自定价，而计费的 `image_generate` 拒绝在它们之间替人选：没有锁定行时它会失败并列出全部候选。这一组就是用来锁定的。下拉里除了「不指定」，每个 `gpt-image-2` 行一项——`KU_AI · 0.12 元/条 · #66`——实时读自 `@deepseek-ai/dsh-tool-jubian` 持有的 `jubianImage` Remote 命名空间，因此读取背后的令牌不会进入浏览器。设置段里锁定、而目录里已经没有的那一行仍可选，显示为 `#66（当前目录里没有这一行）`；保存永远不会把它丢掉：这个页面读不到的清单，不是清掉别人已经做过的选择的许可。没有组合剧变工具、目录读不出来、目录里没有 `gpt-image-2` 行，这三种情况各自说明自己那一种。

在这里锁定一行优先于工具行自己的 `imageStandardId`/`imagePlatformId` 配置，因为只有这个页面能把每个候选的单价摆在人眼前。

### 组件清单

页面最后是按流水线顺序排列的组成，以及只读插件清单此刻对每个包的结论：`@deepseek-ai/dsh-guard-drama`（工具分发门禁）、`@deepseek-ai/dsh-tool-drama-assets`（生图前的资产对账）、`@deepseek-ai/dsh-tool-shot-script`（`drama_shot`）、`@deepseek-ai/dsh-perception-bgm`（`bgm_match`）、`@deepseek-ai/dsh-tool-bgm-compose`（`drama_bgm`）与 `@deepseek-ai/dsh-tool-episode-render`（`drama_render`）。匹配器是独立插件，不属于短剧包；行文案如此说明，而 BGM **目录**仍是它上面的一项独立设置。

每一行带一个状态：已加载、启动中、加载失败、按条件加载、未加载、清单里没有，或无法查询。页面通过 `ctx.get` 读取 `pluginInventory`——宿主那份只读的 Loader 与 preset 投影——因此该命名空间是可选的：没有组合插件清单的部署对每个包都显示无法查询，并附上「这些包随 short-drama preset 或宿主 cordis patch 加载」的说明。沉默永远不会被渲染成「已加载」。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/settings.ts`](src/settings.ts) | 两个编译面共用：命名空间、字段名、默认值，以及 Host 注册、浏览器校验所用的 schemastery schema |
| [`src/project-bible.ts`](src/project-bible.ts) | 权威项目数据、版本保护的变更预览及可读 Markdown 渲染 |
| [`src/index.ts`](src/index.ts) | Host 半：导出该行自己的 `Config`，并在 `ctx.inject(['settings'])` 下调用 `settings.configure({ auto: false })`——命名空间 `drama-settings` 由 settings 服务拥有 |
| [`src/client/index.ts`](src/client/index.ts) | Client 半：一次 `ctx.configForms.get('drama-settings')`、字典、设置页注册，以及可选的清单与生图通道探针 |
| [`src/client/section.ts`](src/client/section.ts) | 页面的草稿编译器：表单值到设置段、设置段加当前值到路径操作，以及「写进去了没有」的判定 |
| [`src/client/routes.ts`](src/client/routes.ts) | 页面读到的计费生图行：一次 `jubianImage.routes` 回答的含义，包括它可能「没有行」的两种情形 |
| [`src/client/components.ts`](src/client/components.ts) | 组成生产的那些包，以及从一次清单回答折算出每行状态的过程 |
| [`src/client/DramaSettingsSection.tsx`](src/client/DramaSettingsSection.tsx) | 设置页组件，含通道选择器与组件清单 |
| [`src/client/locales.ts`](src/client/locales.ts) | 页面的文案，包括每个组件的职责与每个状态标签 |

页面通过 `ctx.slots.inject` 注册：它会等待设置外壳声明该槽位，并在声明崩塌时移除贡献。

写入结论是读出来的，不是假设的。写入被拒绝时设置作用域不抛异常——它恢复宿主的当前状态后正常返回——所以 [`section.ts`](src/client/section.ts) 把解析后的设置段与目标设置段比对，用的正是页面渲染的那份快照：没写进去就报告失败，写进去了就报告宿主实际存下的值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当上面的界面不够用时读这些页面。它们从本包的设置段走到持有它的接缝，以及读取它的各行。

- [设置子系统参考](../../../docs/subsystems/settings.zh.md) —— 命名空间注册、默认值 → 组合基础层 → 用户层的解析顺序，以及页面写入所经的浏览器传输。
- [ui-settings](../../client/ui-settings/README.zh.md) —— 本包从其 `configForms` 读取自己的表单，并注册进它的设置外壳。
- [drama-gate](../../guard/drama-gate/README.zh.md) —— 拥有流水线硬规则的工具分发门禁。
- [dsh-tool-jubian](../../jubian/tool-jubian/README.zh.md) —— 持有本页列出可购行所经 `jubianImage` 命名空间的包，也是 `imageStandardId` 配置作为兜底锁定的那个工具行。

-----

<a id="model-experience"></a>
## 模型体验

### settings 与 tools 可用时的工具 schema

#### 模型看到什么

两个服务都已组合时，本包提供 `drama_draft_dir` 和 `drama_project`。说明与参数见[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-drama-settings)。本包不添加系统提示词。

#### Token 影响

两个工具注册期间增加固定的 schema 开销。Settings 值与项目数据不进入工具定义。

#### KV Cache effect

已注册定义形成稳定的重复前缀。挂载、卸载或改变工具定义可能改变该前缀；编辑 Settings 或项目文件不会改变这些 schema。

### 草稿目录工具结果

#### 模型看到什么

`drama_draft_dir` 通过已记录的工具结果返回含 `status` 和 `path` 的 JSON。空设置返回 `unconfigured` 与空路径；有效且已存在的编辑器根目录返回 `ready` 与规范化后的绝对路径。保存只改变 `jianyingDraftDir`；工具不创建目录或草稿。

#### Token 影响

每次调用追加简短的状态和路径结果。结果长度取决于宿主路径；设置页编辑的值只有被工具读取后才直接影响 token。

#### KV Cache effect

工具结果追加到 transcript 并保留已有前缀。目录编辑改变后续结果的 token；它不替换已记录结果，也不发起单独的模型请求。

### 项目圣经工具结果

#### 模型看到什么

`drama_project` 返回当前配置、项目路径、精确文件修订与当前 Settings 默认值。预览增加拟议配置、审阅指纹、变更字段、受影响阶段和可读 Markdown；更新返回已提交配置与新修订。结果使用标准 JSON 文本展示。[项目圣经技能](../skills/skills/tweet-drama-project-bible/SKILL.md) 持有集中启动询问与现有剧变流程。

#### Token 影响

调用追加随数据变化的 JSON。配置长度随角色声音档案、稳定包映射、已完成任务和修订历史增长；预览还包含拟议配置及其 Markdown 投影。

#### KV Cache effect

读取、预览和更新结果追加到 transcript，不替换此前结果。项目或 Settings 改变影响后续结果的 token；本包不发起独立模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制标出本包有意不完整、或需要运营者配合的地方。它们是当前约束，不是任务清单。

- **项目预览报告影响但不改变制作状态**——流程持有 stale 阶段对账和真实媒体 QA。项目工具记录目录选择与已确认声音指导，不发送远端请求，无法保证原生生成音色固定或支持参考音频。
- **设置页接受路径字符串** —— 不检查存在性，也不展开环境变量。`drama_draft_dir` 在返回路径供生成使用前验证宿主上的草稿根目录；这不能证明编辑器实际配置使用了哪个目录，因此该位置由用户提供。单集渲染器不创建原生草稿。
- **交付规格只被存下，尚未被应用** —— `dsh-tool-episode-render` 目前仍按自己固定的 1440x2560 样式出片；这个设置段是那份契约将来被读取的地方，在那之前改这里不会改变成片。
- **默认值属于本包** —— 想要不同默认值的部署要改 schema；这个命名空间的组合没有声明 `base` 层，所以每个默认值只有一处出处。反面是升级可能改掉某个部署正在依赖的默认值，这也是页面把每个解析后的值都显示出来的原因。
- **路径框留空会清除其覆盖值** —— 解析后的 `deliveryDir` 表示 `<项目>/delivery`；解析后的 `jianyingDraftDir` 仍为空，不能因此认为已找到本机安装的剪映目录。这个页面不拿路径对宿主文件系统作校验。
- **组件清单的可信度取决于它所读的清单** —— 状态来自 `pluginInventory`，而部署未必组合它；那时页面对每个包都报无法查询，而不是做任何假设。即便有清单，如果某个包实际挂载的模块说明符与列出的不同，它会显示为「清单里没有」；只带条件的 preset 行显示为「按条件加载」，因为这个判断归 Loader。多个组合都点名同一个包时（两个 preset，或 preset 与宿主 Loader），由带 fiber 状态的那一行作答，因为已挂载的组合才是会话能跑的组合；页面每个包只显示一行，不说明它来自哪个组合。
- **通道选择器的可信度取决于目录读取** —— 行来自 `jubianImage` 命名空间，它属于 `@deepseek-ai/dsh-tool-jubian`；没有组合剧变工具的部署会显示「暂时列不出通道」，而凭证读不动的目录会显示传输层自己的原因。存下的锁定行不受这两种情况影响：页面读不到的东西，它也不会去清掉。
- **写入时不拿存下的行 id 去核对目录** —— schema 接受任何正整数，因此直接写进文档的行 id 即便账户从未列过它也会被存下。它会在下一次计费调用处明确报错：列全部候选，而不是从不存在的行购买。
- **组件清单说的是包，不是能力** —— 它只说明生产由哪些插件组成，不说明后续某一步一定会成功：`drama_render` 已加载不等于交付规格可达，而行里的职责也只是一句话，不是实时配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**Runtime invariant:** 不发布运行时不变量配套入口，因为这一行不拥有独立生命周期事件流：它只注册一个设置命名空间，以及一处注册进并非自己声明的槽位的贡献，而 HMR 安全测试证明销毁会移除这两者。

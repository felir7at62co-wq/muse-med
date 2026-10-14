---
description: "把短剧流水线的付费生成前资产对账做成一个模型可见的工具：比对剧变项目里已选用的资产与清单、写出宿主付费钩子读的证据、并逐条记录处置，供运行剧变短剧流水线的使用者与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-drama-assets

[English](README.md) | 中文

## 概述

当短剧会话必须在为一张新资产付费之前知道剧变项目里已经有什么时，用这个包。工具 `drama_assets` 同时读两边——剧变远端已选用的资产与项目自己的 `assets_manifest.json`——并写出宿主付费钩子读的证据：`_probe/asset-reconcile.json`。`reconcile` 做这次比对；`dispose` 记录某人对它发现的某条资产的决定。清单只记录这条流水线生成过什么，不等于项目里有什么——只看清单的模型会把已经存在的资产生成第二遍。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件作为短剧预设的一行挂载；它需要工具注册表与凭据库：

```yaml
- id: tool-drama-assets
  name: '@deepseek-ai/dsh-tool-drama-assets'
  config:
    timeoutMs: 30000        # per-read abort budget
    workspaceSecrets: true  # let .agents/secrets/pipeline.env stand in for a missing store value
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 客户端自己的默认源 | 剧变远端读取的源覆盖。 |
| `timeoutMs` | `30000` | 单次读取的中止预算，毫秒，1–60000。 |
| `workspaceSecrets` | `true` | 凭据库没有值时，是否允许最近的 `.agents/secrets/pipeline.env` 提供 token。 |
| `matchPageSize` | `1000` | 匹配与共享查询的提供方页大小，1–1000。 |
| `matchPageLimit` | `100` | 匹配／共享查询每个列表的正整数页数上限；超限时匹配阻断，共享查询覆盖范围记为不完整。 |
| `matchRequirementLimit` | `100` | 单次调用的正整数匹配需求数量或查询输出行数上限。 |

token 本身就是凭据引用 `JUBIANAI_ADMIN_TOKEN`，每次读取都经 `ctx.credentials` 解析，绝不写进结果、日志或预览。

<a id="methods"></a>
### 方法

| 方法 | 读取 | 写入 | 用途 |
|---|---|---|---|
| `reconcile` | 剧变项目的资产与材质，以及清单 | `<project_dir>/_probe/asset-reconcile.json` | 在任何付费生成之前，知道哪些已选用资产清单里没有 |
| `dispose` | 证据文件 | 同一个证据文件 | 记录对某条未登记资产的一个决定——`registered` 或 `ignored` |
| `reuse_preview` | 匹配输入及可选的分镜卡 GET | 无 | 集中审核和保留原卡的绑定建议，不审批或执行 |
| `shared_usage_preview` | 完整共享资产、材质、剧集和当前包绑定 | 无 | 定位精确远端用途并比较同时期声线候选 |
| `usage_preview` | 当前清单、项目圣经及可选的摘要锁定编译结果 | 无 | 精确的本地资产用途与声线缺口 |
| `match_preview` | 原文需求、清单、项目圣经、声线记录及完整当前项目 GET 列表 | 无 | 准备人物、场景与已认可声线复用建议 |

| 参数 | 何时必填 | 含义 |
|---|---|---|
| `method` | 始终 | `reconcile`、`dispose`、`match_preview`、`reuse_preview` 或 `usage_preview` / `shared_usage_preview` |
| `project_dir` | 始终 | 绝对项目根目录；`shared_usage_preview` 需要含 `jubian_script_id` 的 `project_config.json`，其他方法需要 `assets_manifest.json` |
| `asset_id` | `dispose` 必填；用途预览可选 | 决定针对的精确未登记资产，或用途筛选的精确父资产 |
| `character_id` | `shared_usage_preview` 可选 | 精确稳定人物身份；资产身份未知时人物筛选不完整 |
| `output_offset` | `shared_usage_preview` 可选 | 非负输出行偏移；保持原筛选条件，沿 `pagination.next_offset` 读取后页 |
| `status` | `dispose` | `registered` 或 `ignored` |
| `note` | `ignored` | 为什么这个资产不需要；判 `ignored` 时必须非空 |

`reconcile` 只发两个请求，都是提供方自己的列表接口，不计费。`dispose` 一个都不发。两个方法写的文件只有证据文件一个，原子替换，并在支持的平台上使用仅所有者可访问的权限。

<a id="shared-project-uses"></a>
### 共享项目用途

`shared_usage_preview` 从 project_config.json 读取项目 ID，两次完整分页扫描当前资产、材质、剧集与视频包。一致库存表示观察到的稳定读取，不是供应商原子快照。按实际父资产／材质 ID 或唯一精确媒体 URL 匹配，同一资产在同包只计一次，名称不用于认领。集号来自剧集库存，缺少归属保留 null。可按精确 asset_id 或 character_id 筛选；本地明确的妆造登记可补人物标识，带标签音频保留人生时期。complete 表示库存和引用检查是否支持精确当前包计数；complete=false 时 package_count 为 null，observed_package_count 仅为实际发现数量。query_complete 还要求输出未截断；按 character_id 筛选时，人物身份也须完整。人物筛选遇到未知身份时 query_complete=false，保留已知包的真实计数，余下资产可按 ID 查询。输出上限仅截断展示行，不减少底层扫描与汇总计数。不完整或截断查询不能证明零引用，也不授予删除权限。

pagination 包含 output_offset、output_limit、next_offset 和无前缀的 64 位十六进制 query_sha256。从偏移 0 开始，保持相同筛选条件，沿 next_offset 读到 null。该偏移同时作用于 assets、uses、duplicate_audio_groups 和 issues；汇总数与包引用计数属于底层查询，不是本页数量。仅在各页 query_sha256 相同时拼接返回数组；摘要变化须重新从偏移 0 查询。后页因省略了前面的行仍为 truncated=true，后页空数组不能证明资产不存在或零引用。可缩小到精确资产／人物筛选，或继续分页，无需调整部署输出上限。

重复音频仅按同项目、同人物、同人生时期归组。显示本地已采用声线；使用次数排序不授予删除权限，也不证明录音可互换。历史任务、其他电脑本地计划和其他账号声线默认不在本视图内。用原卡音频预览／写入工具迁移适用引用并回读，再走检查后的删除；已完成视频不重新生成。查询不写文件、不收费、不增加制作流程要求。

### 音频准备与当前用途

视频成功下载后，消费预设主动加载声线连续性技能。随包 `prepare_voice_assets.py` 提取完整混合音轨及缺声线角色的 PCM WAV 候选，保留当前 voice_profile，并在操作系统释放的锁内原子合并本地声音清单。原任务 ID、来源摘要、角色 ID 和区间共同确定候选，重复运行及换装仍复用同一条。提取不上传、不认可；完整长音轨不直接上传为人物声线，包含背景声的两秒讲话短参考允许选用。实际听音和既有上传、登记、回读工具负责选用。

`usage_preview` 只读当前项目文件，不联网、不写文件。省略 `plan_path` 可查看项目声线引用和缺口。提供 version=1 的索引，documents 的每项包含已保存且成功的 `drama_shot compile` 完整结果文件的 path、实际 SHA-256 sha256 和正整数 episode。工具核对每包明确的父资产/材质 ID、名字、类别和 URL 是否与当前资产清单一致，随后返回包引用及逐镜实际绑定该资产的镜头和精确登记版本。可选 asset_id 按精确父资产筛选。total 统计符合条件的用途；truncated 表示 matchRequirementLimit 限制下有行未展示，该限制也约束文档和声音状态数量。视图明确区分本地计划引用与远端绑定回执；远端身份、认可状态和生成质量仍由既有回读负责。新登记下次读取即可显示，不增加另一份权威缓存。输入问题只定位相关引用或拒绝该查询，不增加项目流程门禁。

```json
{"version":1,"documents":[{"path":"episode_packages/54-compile.json","sha256":"<actual-file-sha256>","episode":54}]}
```

声音需求可指定精确 voice_period_id。角色配置 voice_profiles 时必须明确选时期，不能在儿童／成年或旧默认间回退。匹配与用途状态分别列出各时期，归档样本不是认可引用或活跃候选。共享音频身份元数据与登记收敛由[剧变工具](../../jubian/tool-jubian/README.zh.md)负责，不由这份本地投影授予。

### 只读匹配预览

调用 `method=match_preview`，传 `project_dir` 与项目内 `requirements_path`。[输入和判断规则](../skills/skills/tweet-drama-core/references/match-preview.md)规定版本1需求、精确原文行/SHA-256、已登记身份关系、场景条件和认可声线样本。结果返回 `reuse_ready`、`needs_review`、`missing` 或 `blocked`，附候选ID与原因。同名不证明身份；明确提供的稳定身份和人物身份必须与清单、项目圣经一致，矛盾时返回 `IDENTITY_FIELDS_CONFLICT`。已登记的服装版本允许不同母资产ID，但项目参考资产也必须登记为同一人物、已正式确认且存在于当前项目资产目录中。读取失败、分页不完整、项目冲突或来源变化均阻断，不能当作缺素材。

此方法不写本地或远端文件，不生成、不审批、不绑定。`missing` 仅限当前项目；历史检索继续由既有素材库 Skill 负责。复用依据是登记事实与已有认可记录，不是图像或音频质量通过判定。正式采用仍由人工决定，实际绑定沿用原工具。预览不产生 `ready` 对账证据，不改变对账、付费授权或账本。提供方读取后重新检查输入；最终绑定仍需自己的实时校验。

### 集中复用预览

`reuse_preview` 复用相同匹配检查，仅在身份、状态、条件和候选选择一致时归组，返回候选详情、适用范围、版本/来源指纹及可选的逐卡素材选择建议。参见[映射格式](../skills/skills/tweet-drama-core/references/match-preview.md#集中复用与分镜预检)。沿用 `select_assets` 构造器检查图片身份和 Prompt 顺序；建议按 `materialKey` 比较原素材与提议素材，保留每项未选素材的全部字段，以及模型、Prompt 和提供方字段。仅改变素材行物理顺序允许，未选素材缺失、重复或发生变化则阻断。人物需求未提供 `character_id` 时可按已核验 `stable_id` 归组，两种身份类型不会相互混用。图片需求映射到音频占位符时返回 `IMAGE_MAPPING_TARGETS_AUDIO` 并阻断。首张预检失败后停止后续预检；重复预览不执行绑定。

流程为匹配预览 → 复用建议 → 用户确认 → 模型调用原有 `jubian_storyboard.select_assets`。`reuse_ready`、`already_bound` 和指纹是观察结果，不是授权。`apply_allowed=false` 表示预览不授予写入权限，不禁止模型取得真实用户授权后使用原有绑定工具。逐卡ID和有序 selections 来自 `shots`；来源、身份、版本或范围变化后重新审核。声线继续走 `audio_preview → audio_apply`。本包不新增绑定执行器或审批签发，既有工具继续保留授权、身份、顺序、幂等和回读检查。

### 判定口径

| 证据字段 | 含义 |
|---|---|
| `source` | 两次远端读取各返回多少行、有多少资产存活（`delFlag == "0"`）、多少已选用（`isUsed == 1` 且 `hsAssetStatus == "Active"`） |
| `manifest` | 清单声明了什么：`items`、`lead_readonly_records`，以及去重后的资产 ID |
| `matched` | 远端已选用且清单里也有的资产数 |
| `unregistered` | 远端已选用但清单里没有的资产，带材质的 id、名字、类别、URL 与创建时间 |
| `dangling` | 清单里有、但远端项目没有的资产 ID |
| `issues` | 清单自身声明的每一处问题，各带稳定的 `code` 与修法：没有 `items`/`assets` 数组、资产数组写在 `assets` 键下、没有 `lead_readonly_records` 数组、某条记录不是对象。相对证据文件原有字段是增量的：两个外部读取方会忽略它们不认识的键 |
| `disposition` | 每条未登记资产一个 `{status, note}`，跨次运行保留 |
| `blocking` | 还没有 `registered` 或 `ignored` 决定的未登记资产 ID |
| `ignored_without_note` | 判为 ignored 但 note 为空的资产 ID |
| `ready` | `issues`、`blocking` 与 `ignored_without_note` 是否都为空 |
| `policy` | 钩子读到的付费策略：KU_AI 每张 0.12 元、最多 3 次、最坏 0.36 元 |

两条规则闭环。某人登记进清单的资产会在下次 `reconcile` 被认出来，处置自动变成 `registered`，并保留它原来的 note。某条资产已被选用、材质仍是 `Active`，但资产行的 `delFlag` 不是 `"0"`，那它就不是资产：只有存活的行参与比对。

清单读不全时本包**报告而不拒绝**。`jubian_organize` 读同一个文件，数组找不到就抛 `CONTRACT_CHANGED`；`reconcile` 改成返回 `ready: false` 加一条结构化 `issues`，因为这个文件由模型写、也由模型修——报错会结束这次调用、把其余发现全部藏起来，而报告出来的问题会连同完整的 `unregistered` 与 `dangling` 一起送到。读得出来的行仍然参与比对：老清单把资产数组写成 `assets` 时，比对的是它真正声明的那些行，而不是把远端已有的资产整批报成未登记。只有三件「根本没得比」的事仍然让调用失败：文件读不到、不是 JSON、缺整数 `script_id`。

工具结果不是证据文件。文件按流水线自己的写法——提供方没给的字段是 JSON `null`——而工具结果把同一件事写成空串或 `0`，因为工具 schema 没有可空标量。`0` 不是提供方会发出的类别号，所以 `asset_type: 0` 读作「没有类别号」。

`ready` 是 `issues`、`blocking` 与 `ignored_without_note` 三者一起判：本地一侧读不全的比对，会把远端已有的资产报成未登记，而付费生成正是拿这个结论去做决定。`dispose` 沿用证据里已有的 `issues` 而不重算，所以一次处置不可能把这个结论又翻回 ready。宿主钩子还要求 `ran_at` 新鲜，而 `dispose` 不写它：一个项目如果只有一条裸 `dispose` 结果，工具会报 `ready: true`，钩子仍会以「证据不可用」拒绝它。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部——点击展开</summary>

本节说明一次调用是怎么判定的、代码在哪里；可观察行为在[使用本包](#use-this-package)里已经写全。

### 对账设计

这个包建立在三条承诺上：

- **证据文件是契约，不是输出。** 生产工作间里的 `_tools/asset_reconcile_report.py` 与宿主侧的 `reconcileFirst` 钩子都读它。字段名、类型与语义由这两个读者定死，所以本包是移植它们而不是自己设计；这里写错 schema，就是那个专门用来拦住静默失败的检查自己静默失败。
- **远端只读，本地只写一个文件。** 两次剧变调用都是提供方的列表接口。没有写方法、没有计费方法，也没有第二个文件：一个还没对账的项目不该变成一个清单被写了一半的项目。
- **比对自己负责顺序。** `unregistered` 按资产 ID 升序写出，与流水线自己的报告一致，所以同一项目的两次运行产出可比的文件。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、凭据解析、参数 schema 与描述，以及结果的两种写法 |
| [`src/remote.ts`](src/remote.ts) | 两次远端读取：翻页、读者校验过的行，以及读者没有映射的提供方字段 |
| [`src/manifest.ts`](src/manifest.ts) | `assets_manifest.json` 的读取与已声明资产 ID |
| [`src/matching.ts`](src/matching.ts) | 只读身份、条件、声线/来源校验与完整匹配列表读取 |
| [`src/reuse.ts`](src/reuse.ts) | 集中归组、证据指纹和保留原卡的预览；没有确认或写入执行器 |
| [`src/reconcile.ts`](src/reconcile.ts) | 比对、处置继承、判定、证据写入，以及 `dispose` |
| [`src/types.ts`](src/types.ts) | 只有类型：证据文档、远端行与清单 |
| — | 不发布运行时 invariant 伴生模块：本包在调用之间不持有状态、不暴露快照，每个答案都是它读到的文件与两次远端列表的函数。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-drama-assets) —— 模型实际收到的 `drama_assets` schema 与描述原文。
- [工具子系统参考](../../../docs/subsystems/tools.zh.md) —— 参数 DSL、规范化输出值与每次调用进入的流水线。
- [drama 组地图](../README.zh.md) —— 短剧流水线的同级包。

-----

<a id="model-experience"></a>
## 模型体验

### `drama_assets` 工具 schema

#### 模型看到什么

请求收到一个名为 `drama_assets` 的工具，其描述及参数／结果 schema 见生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-drama-assets)。每个结果都是包含该方法专用字段的对象；方法未报告的字段会省略，而不是填入默认值。渲染内容是同一对象的美化 JSON。

#### Token 影响

有条件、且随项目规模有界：schema 与描述是固定的，结果随 unregistered 与 dangling 列表增长——各一行，每行带提供方自己的名字、类别、URL 与创建时间。没有待处置项的项目返回最短的有用答案。

#### KV Cache 影响

只追加。工具注册带着稳定的名字、描述与 schema，所以已挂载的行保持请求前缀可复用；只有改动本包的描述或 schema 才会让它失效。一次调用的结果作为那次调用自己的工具结果追加，不改写更早的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了这个包是什么、不是什么。它们是当前约束，不是待办清单。

- **比对只用一个页大小** —— 两次读取都按提供方文档规定的上限 1000 行请求，并按声明的总数继续翻页，所以比这更大的项目每 1000 行多一个请求。翻页本身没有上限。
- **token 可能来自工作间文件** —— `workspaceSecrets` 打开时，凭据库没有值的场合由最近的 `.agents/secrets/pipeline.env` 顶上。那个文件是流水线自己的密钥存放处，不归本包管理。
- **`dispose` 不重新比对** —— 它改的是它找到的那份证据里的处置。上次 `reconcile` 之后才在远端被选用的资产不在那份证据里，所以对它的处置会被记下来，但要等下次 `reconcile` 才会被列出来。
- **`dispose` 可以写出没有比对的证据** —— 在一个没有任何证据的项目上，`dispose` 会新建一份只含 disposition、`blocking`、`ignored_without_note` 与 `ready` 的文件。宿主钩子仍然会拒绝它，因为它要求只有 `reconcile` 才会写的、新鲜的 `ran_at`。
- **清单是唯一的本地一侧** —— 记在别处的资产（`matches/*.json`、流水线状态文件）不算已登记。登记一条资产意味着 `assets_manifest.json` 里有一行带整数 `jubian_asset_id` 的记录。
- **字符串形式的 `jubian_asset_id` 算已声明** —— 清单读者只留整数 ID，所以 ID 写成字符串 `"83840"` 的行不算已声明；它也不算悬空，因为悬空判定用同样的读法读同一个字段，于是这一行对两张清单都不可见。
- **`cross_project_note` 只被继承，从不被写入** —— 该字段从上一份证据原样保留并返回；跨项目检索本身属于 `jubian-asset-library` 技能。
- **写入不是跨进程事务** —— 临时文件加改名让一次写入是原子的，但同一个项目上两个并发的 `dispose` 仍可能交错各自的读-改-写。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

这份 Dev Note 是维护者的工作上下文：还没定的问题与方向。它明确不是权威——已发布的行为、限制与已接受的取舍在上面的章节、包代码与链接文档里。

这次比对是流水线 `_tools/asset_reconcile.py` 的移植，而且是逐字段移植。那个脚本留在生产工作间里，仍是证据文件字节布局的参照；本包是不需要在用户机器上装 Python 的那条路。`ready_reason` 是 Python 工具会写、本包不写的唯一字段：它是推导出来的，宿主钩子自己算一份，`reconcile` 改成在工具结果里返回同一句话。

token 解析使用[剧变共享工作间函数](../../jubian/jubian/README.zh.md)，包括工作间密钥回退。`readAssetList` 与 `readMaterialList` 仍然是「一页是什么」的权威，但本包从它们接受的行里读出 `delFlag`、`createTime` 与两种名字拼写——映射不带这些字段，而证据 schema 需要它们。
</details>

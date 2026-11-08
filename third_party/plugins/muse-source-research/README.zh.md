---
description: "为配置层提供不可覆盖的红果与七猫选材证据、同口径变化和选材日报。"
kind: "package-bundle"
---
# muse-source-research

[English](README.md) | 中文

## 摘要

Muse 创作预设通过此配置层采集公开来源元数据、保留不可覆盖的证据并生成选材日报。本包负责 `source_snapshot`、`source_report` 和经人工审核的 `work_mapping`；红果与七猫客户端负责访问网站。全局补丁保持禁用，由支持的创作预设在自己的作用域内启用。报告区分请求页面覆盖、未知指标和同口径测量。作品关系须有明确证据和人工决定；标题不能确立身份。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 激活与采集

[自有包清单](../owned-downloads.json)连同两个客户端依赖分发此配置层。向配置安装归档包后会添加禁用的全局补丁，由创作预设在局部启用该提供器。仅安装不会暴露全局选材工具。自定义组合须提供 `tools`、`agents`、`fs` 和 `userQuestions`；使用沙箱文件系统时还须提供 `sandboxPolicy`。

让 Muse 采集红果或七猫选材快照，与先前快照比较，再生成选材日报。提供器将 `project` 限定在发起 Session 的目录内，默认使用该目录。`collect` 接受平台和 `request.operation:rankings`，仅将校验后的榜单参数传给真实客户端，不接受模型提供的来源结果。红果参数为 `boards` 和 `refresh`；七猫参数为 `source`、`channels`、`boards`、`periods`、`pages` 和 `refresh`。七猫榜单翻页尚未核验；`pages` 仅适用于公开筛选书库。[七猫包](../muse-qimao-data/README.zh.md)说明该筛选条件，[红果包](../muse-hongguo-search/README.md)说明榜单覆盖范围。

`source_snapshot` 还接受 `import_legacy`（提供项目内 JSON 的 `path`）、`list`、`read`（提供 `snapshotId`）和 `compare`（提供 `beforeId`/`afterId`）。导入支持现有 `{platform,collectedAt,source,coverage,items}` 文件，保留源文件的精确哈希和完整解析文档。导入的 `popularity` 和 `reads` 保留旧字段名称与未明确单位，不改称当前在读。缺失或不明确的十进制字符串 ID，以及显式平台冲突的记录，保留在 `unidentifiedItems` 和原始证据中，不进入统计。

`source_report` 接受 `build`（提供 `snapshotIds`，可选 `baselineIds`）或 `read`（提供 `reportId`）。报告记录每个输入 ID、精确 SHA-256、范围、缺页、未知指标和同口径变化。产物路径为 `.muse/source-research/snapshots/v1/<id>.json`、`.muse/source-research/reports/v1/<id>.json` 和 `deliverables/选材日报/<date>-<reportId>.md`。JSON 不可覆盖并按内容寻址；相同内容可以复用，不同内容不能替换已有产物。只读模式会在 HTTP 或发布前拒绝采集、导入和报告生成，仍可读取和比较。

### 比较与收据

统计使用平台加来源 ID，不按标题匹配。所有原始来源结果和观察记录保持完整。比较要求平台、证据类型、请求范围、指标语义、标签、单位和测量窗口均相同。缺失值保持未知；缓存测量保留原时间。负变化保持为负。同一时间的不同数值视为观察冲突；时间倒序时排除。部分来源仅比较共有已知字段；单侧出现的 ID 不证明新增或退榜。

新快照使用 `adapterVersion:1.0.1`。红果缺失指标原因取自与所选原始值匹配的观察记录：不支持的非空文本保持 `unparseable`，未展示文本保持 `not_displayed`。七猫保留指标自身的原因。读取现有 `adapterVersion:1.0.0` 快照时使用原规范化规则校验，保留精确字节、ID 及历史缺失原因。重新采集会把修正后的证据保存为新快照。旧版插件读取器不能读取新适配器版本；报告和映射继续使用 `adapterVersion:1.0.0`。

快照收据提供实际路径、哈希、覆盖范围、观察时间区间和可统计/无身份记录数。报告 JSON 保存可移植的输入 ID 与哈希，不保存文件系统版本。JSON 发布成功但 Markdown 发布失败时，`status:partial` 返回已保存 JSON 的收据和 Markdown 失败原因，不声称已全部完成。读取完整报告时会核验 Markdown 哈希。来源标题、标签和文本仅作为数据；Markdown 输出会转义其格式和 HTML 语法。

### 人工审核作品关系

`work_mapping.propose` 接受仅包含 `{snapshotId,itemId}` 的 `left` 和 `right` 引用、`relation` 及明确未核实的模型 `reason`。工具读取已保存的红果/七猫快照，取得真实平台、ID、标题、来源 URL、存在时的作者/简介、证据类型和精确快照 SHA。展示的来源 URL 须使用官方 HTTPS 源、默认端口和精确来源 ID：七猫 `/shuku/<ID>/` 或红果 `/detail?series_id=<ID>`，不接受歧义参数或凭据；不支持的 URL 保留在原始证据中，展示为未知。来源缺失字段保持未知。关系为 `same_work`（同作）、`same_series`（同系列）、`adaptation_of`（左侧改编自右侧）和 `sequel_of`（左侧是右侧续作）。同系列不等于同作，来源未提供的季数仍未知。提案不会合并指标、推导传递关系或增加其他平台采集支持。

`read` 接受 `mappingId`；`list` 读取当前项目的提案；`lookup` 恰好接受 `mappingId`、精确 `sourceRef` 或类似 `qimao:195958` 的 `sourceKey` 之一。来源键查询仅返回同平台 ID 的历史直接提案、原快照证据和 `historyOnly:true`，不把旧确认应用于新快照。未审核提案返回 `needs_human_review`。初次决定使用 `review`，把返回的 `proposalSha256` 作为 `expectedProposalSha256`，并传 `expectedRevision:0`。真实提问服务向精确存活的根 agent 所属用户展示不可变提案与两侧来源引用。只有精确单选 `确认关系`、`不同（拒绝该关系）` 或 `待核实` 才记录 `confirmed`、`rejected` 或 `deferred`。空白、自定义、外来或多选回答，以及无回答服务、子调用者和发布前取消，均不写决定。已经完成原子发布时保留实际收据。模型传入 `confirmed` 或 `decision` 字段会被拒绝。

`supersede` 须提供同一提案文件哈希及最新修订号，并重新提问。更改关系、证据或模型理由须新建提案。问题绑定完整提案文件 SHA 和预期修订号；等待时不持有发布锁，发布前再次校验快照、最新修订和重新解析的 Session 沙箱策略。等待回答时切换为只读会阻止决定写入。旧回答不能替换新决定，也不能覆盖另一个服务实例的竞争写入。提案保存于 `.muse/source-research/mappings/v1/<mappingId>/proposal.json`；决定追加为 `revisions/000001.json` 及后续编号文件。`mappingId` 使用完整提案主体 SHA，`proposalHash` 是该主体摘要，`proposalSha256` 则对完整提案文件求哈希。每个修订保留前序 SHA、回答、问题 ID、审核时间和真实审核 Session ID。读取核验提案身份、来源快照及连续的修订校验链，不覆盖已有文件。

`source_report.build` 可选接收 `mappingIds`，与其他输入共用 `maxReportInputs` 上限。只有明确引用时才增加 `mappingReceipts` 和作品关系审核章节，保存构建时的每项决定、修订、哈希、方向和证据。不传 `mappingIds` 时保留原有报告字段与 Markdown。后续改判不改变旧报告。确认只确立所选关系与证据；映射或类别未命中仅表示本证据范围未观察到，不能证明全平台无 AI 或无第二季。

### 配置

所有限制均为正整数，超限使整次操作失败，不静默截断：`maxJsonBytes` 默认每个旧文件/快照/报告 JSON 16 MiB，`maxItems` 为 20,000 条原始来源记录，`maxSnapshots` 为每类产物目录 1,000 个文件，`maxReportInputs` 为快照、基线和映射合计 40 个 ID，`maxComparisonPairs` 为 100，`maxReportInputBytes` 为 64 MiB，`maxListEntries` 为 5,000 个目录项，`maxReportBytes` 为 4 MiB Markdown，`toolTimeoutMs` 为 300,000。嵌套 `hongguo` 和 `qimao` 设置使用相应客户端校验器，包括请求、页数、速率和缓存限制。无效设置在插件激活时失败。

映射限制为 `maxMappings`（默认 1,000 个提案）、`maxMappingRevisions`（每提案 100 次）、`maxMappingReasonChars`（2,000）、`maxMappingExcerptChars`（每个来源字段展示 500 字符）、`maxMappingHistoryBytes`（提案及修订共 16 MiB）和 `maxMappingListBytes`（扫描映射状态共 64 MiB）。映射 JSON 同时受 `maxJsonBytes` 限制；每个提案与修订都经过有界文件读取和规范化项目包含检查。只读模式会在提问前拒绝提案与人工审核。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[作用域入口](src/index.js)负责工具参数、通用读写卡片和可释放注册。[服务](src/service.js)负责真实客户端、请求范围解析、报告组合及可取消的先进先出发布。Host 根作用域服务协调共享文件系统服务作用域、规范项目标识和产物类别的 Session 发布准入；队列完成后释放对应记录。释放一个 Session 时只等待其自身调用和发布完成，包括取消处理，不等待其他 Session 的队列。[存储层](src/store.js)仅通过 `ctx.fs` 访问项目数据，校验规范化路径包含关系，以完整字节读取限制和前后版本检查读取文件，并通过 `createIfAbsent` 和每次调用的沙箱策略发布。快照与报告容量会在发布准入时再次检查。

[规范化与报告](src/canonical.js)保留来源指标和观察记录，未知时间保持未知，仅比较共有已知测量。[作品映射](src/mappings.js)负责有来源依据的提案、真实人工提问和只追加决定。读取会拒绝不支持的格式版本或内容 ID 不匹配，不重写旧代文件。[公开类型](src/index.d.ts)为产物 ID 添加品牌类型。[打包](scripts/pack.mjs)将已审查文件复制到私有暂存目录，在 `SOURCE.json` 记录源码哈希、依赖版本和匹配的 Host 版本；依赖源码保留在各自所属包。

从仓库检出目录运行聚焦文件系统/解析测试和语法检查：

```sh
pnpm --dir third_party/plugins/muse-source-research run test
pnpm --dir third_party/plugins/muse-source-research run check
pnpm --dir third_party/plugins/muse-source-research run package -- --out /tmp/muse-source-research-package
```

</details>

-----

<a id="model-experience"></a>
## 模型体验

启用的作用域增加三个工具描述、对象参数和原始 JSON 结果。模型收到证据收据、明确的范围/指标排除信息，以及区分提案与人工审核的关系状态，不收到推断的市场总量。`read` 返回的完整来源数据仍属于不可信来源内容。工具调用与结果沿用正常日志执行路径，本包不增加隐藏提示输入或独立模型调用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

网站访问可能失败或只提供部分元数据；快照保留这些限制，不用旧数据补齐缺页。小说正文、媒体下载、App 专有在读/金选数据、自动身份匹配、市场密度和自动 AI/S2 分类不在本包范围内。人工审核映射仅覆盖明确引用的现有红果/七猫快照，不对所有作品分类或核验权利。旧文件证据证明导入文件记录了什么，不证明原采集器的可靠性或完整性。报告供选材审核使用，不核验改编权。发布准入不协调独立 Host、进程或隔离的文件系统提供器，因而不能约束这些写入方的合计容量；每个文件仍使用提供器的原子 `createIfAbsent`。版本目录明确区分；未来格式须使用独立读写版本，不得覆盖已提交的 v1 产物。

<a id="dev-note"></a>
## 开发说明

<details>
<summary>维护上下文</summary>

测试使用临时项目目录和真实本地文件系统后端，精确匹配官方 URL 的元数据样例通过真实客户端解析。映射测试使用真实 agent、提问服务和所属回答器。生产项目目录和凭据不作为测试数据。无密钥 Session 场景负责端到端工具发现、日志结果、人工审核归属和报告产物。

</details>

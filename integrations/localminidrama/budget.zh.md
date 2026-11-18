---
kind: reference
description: "按账号隔离的项目金额授权、配置价格与原生制作账目。"
---

# 项目预算与制作账目

[English](budget.md) | 中文

主剧变工作区使用 Host 原有 Token 和受维护的剧变原生费用审批。其提供方费用、原任务回执不能与此历史制作平台账目混合。以下控制属于保留的原生/独立项目，列出或编辑剧变项目无需配置这些控制。历史 LTV 记录仅供读取，不能转换成 CNY 授权。

## 范围

已鉴权制作平台在每个账号的 SQLite 数据库中保存预算与金额账目。支持的原生制作、独立 TTS 和剧变视频请求须有明确项目、币种和总授权。缺少项目归属、价格过期或余额不足时拒绝付费提交。剧变还要求已登记 Host 和一次性服务器费用挑战；页面准备、公司额度或预算增加均不是本次收费批准。网关既有登录与 Origin 检查仍然生效。

实际执行的比较是 `人工确认的账单金额 + 每笔未结预占 + 新预占 <= 项目上限`。估价控制本地准入，不会替供应商设置消费硬上限。按配置 Token 费率计算的是估计，不是已核验账单。不透明 Agent 任务没有可验证的模型调用次数、完整用量或最终价格；单独接受的整任务预占也无法限制上游 Agent 最终消费。

## 页面操作

Muse 可通过 `localmini_budget.request_increase` 在对话内请求提高项目上限。原生授权问题列出项目、单位、当前承诺金额、新增估价、请求总上限与原因。只有明确同意才更新该项目预算；拒绝或取消不修改预算，也不发起生成。Muse 在批准后再次检查账号、数据库、预算修订、承诺金额和报价。输入变化需要重新请求。提高预算不代表批准付费重试，也不修改管理员最大值、模型价格或既有支出。`read` 和 `quote` 只做免费读取。

在项目顶部打开“项目预算与账目”。先设置总授权，再明确选择本项目是否接受模型估价。未知整任务预占需要另一项独立风险选择；两项默认均关闭。总上限不能降至既有账单与未结承诺之和以下。不同币种不自动换算。金额以配置币种的整数百分之一计数；表单最多接受两位小数。

剧变视频要求 `CNY` 预算，金额以人民币分保存。旧 `LTV` 账目、积分单位与未结预占继续保留供追溯，不转换为人民币，不授权新的剧变调用。已保存项目不能直接更换币种；遇到旧积分预算时停止并由管理员明确处理人民币授权，不能改写原账目绕过限制。

同一窗口列出已配置模型资料与价格。除非部署管理员锁定本人估价，账号所有者可新增或编辑估价。可选择既有 API 配置的公开资料，也可填写实际 service、provider、model 与 API Origin。资料选择器不读取供应商密钥。填写预占金额、公开价格来源或 `operator-entered`、生效及过期时间。模型能力与可选 Token／字符费率均属于配置观测，不证明供应商支持。存在多份相同有效价格时拒绝派发，不静默选择。`agent-task` 使用整任务风险预占，不能视为一张图或一条视频的价格。

全局 API 配置页也提供项目选择与该项目预算窗口。媒体／TTS 配置格式检查仍免费，不宣称已验证生成权限。真实文本连接测试要求明确选择项目、稳定原生提交标识及有效金额授权；只有预算批准后才真实请求供应商。

账目保留原操作、不可变价格快照、数量与未确认金额。任务完成或失败不代表供应商免收费用。只有已知终态任务，或明确区分的“用户确认 Agent 结束”，才能人工核销最终账单。输入准确金额与不含密钥的账单依据，再明确确认最终账单。零元同样需要确认。结果仍标为 `operator-confirmed-invoice`、`supplier_verified: false`；已发生的超额费用会如实记账并阻止新增预占。未知结果不能人工核销或自动释放。

## 记账与恢复

预算和价格编辑、账单核销及新增预占使用 SQLite immediate 事务。修改使用稳定操作标识与不可变回执；预占唯一键为 `(source, operation_id)`。重放预占返回 `dispatch_allowed: false`，不会再次占用金额。同标识改输入会拒绝；未解决的相同请求哈希换新标识也会拒绝。原生提交还保留原请求及明确授权新版本的规则。

重放预算修改返回原回执，不覆盖后续修改。报告当前上限或继续制作前须重新读取项目；保存的回执不是实时余额。提高上限保留全部未结预占和已核销账单，生成仍须重新报价并通过既有原子预占检查。

私有 `muse_budget_schema` 从版本 1 开始，拒绝不支持的版本。每个数据库有独立 UUID。预算、价格、报价和账单 HTTP 写入均要求该 UUID，防止旧页面误改数字项目 ID 与修订号相同的新账号数据库。重启将未完成预占结果改为 unknown，保留全部金额。超时、取消、媒体验证失败与任务错误均不自动释放金额。准备 TTS 与 Fal 记录时在其既有 SQLite 插入事务内预占；插入失败同时回滚预占。

原生文本和图片检查实际配置及预占。供应商用量保留在原调用下，缺失字段保持未知；TTS 字符费率可提高提交前预占。剧变先绑定、查询实时目录和免费准备；只有已登记 Host 的逐次原生确认及服务器核验才可提交，旧原生视频入口仍拒绝。Fal 新提交与继续执行均停止，直至接入真实货币报价及原生费用审批；已有任务仍可免费检查、读取、下载和明确采用。未知结果保留原预占，不授权重试。

## 部署

在提交准入、音频、后期及制作包 planner 之后注册 `planMuseBudget(root, readSource)`。它生成服务、路由、客户端 helper 与 Vue 窗口，并修改暂存派发函数。账号 Worker 须允许 `/api/v1/muse/budget/*`。启用此 planner 会改变付费制作准入：连接 API 本身不等于批准支出。此前供应商历史费用不会补记为零。

可选私有 `muse_budget` 设置包括 `currency`（默认 `CNY`）、`max_project_limit_minor`、`allow_owner_prices`（默认 true）及 `prices`。管理员最大值约束所有者修改项目上限，不会虚构价格或免除明确项目授权。管理员价格与本人估价使用相同公开字段：`id`、`service`、`provider`、`model`、精确 `origin`、可选 `config_id`、`currency`、`reserve_minor`、`estimate_kind`、`source`、`effective_at`、`expires_at`，以及可选 `rates` 与 `capabilities`。服务类型是 `text`、`image`、`video`、`tts`、`postproduction`、`agent-task`。原生模型使用 `per-dispatch-estimate`；Agent 任务必须使用 `operator-task-envelope`。所有账目显示配置来源、有效区间和未核验状态。

费率是可选的非负整数百分之一币种金额，以每百万输入／输出／总 Token 或每千请求字符为单位：`input_per_million_minor`、`output_per_million_minor`、`total_per_million_minor`、`characters_per_thousand_minor`。明确的总 Token 费率优先于输入／输出费率。缺失总 Token 不用输入加输出虚构。可选能力为 `maxDurationSeconds`、`maxReferenceImages`、`resolutions`、`supportsMultiVoice`；未知保持 null 或空分辨率列表。实际参数验证仍由原生模型适配器负责。

## API 接入

| 方法 | `/api/v1` 下相对路径 | 操作 |
|---|---|---|
| GET | `/muse/budget/catalog` | 公开价格、配置资料与数据库 UUID |
| PUT | `/muse/budget/catalog/:id` | 明确的本人估价、预期修订及稳定修改标识 |
| GET / PUT | `/muse/budget/projects/:id` | 读取或明确更新一个项目授权 |
| GET | `/muse/budget/projects/:id/entries?limit=50&before=...` | 项目总计与分页账目，每页最多 100 笔 |
| POST | `/muse/budget/quote` | 读取配置估价，不派发任务 |
| POST | `/muse/budget/entries/:id/reconcile` | 使用预期账目修订明确核销最终账单 |

本人价格写入要求 `operator_accepted: true`。上限写入要求 `expected_revision`、`currency`、`limit_minor`、`allow_estimates`、`allow_task_envelopes`、`operation_id`。核销要求 `expected_revision`、`amount_minor`、`source: 'operator-confirmed-invoice'`、`reference`、`final_invoice_confirmed: true`、`operation_id`。每项 HTTP 修改还要求 `database_id`；直接服务 helper 属于受信任的同进程调用。

项目读取返回 `budget_review_version: 1`，表示上限写入支持按人工审批时的状态核验。此类写入可携带 `expected_reserved_minor`、`expected_settled_minor` 及 `expected_quote: { spec, quote }`；`spec` 保存原报价选择参数，不含项目 ID，`quote` 保存完整报价响应。更新在同一个 SQLite 事务内核验承诺金额并重新报价，再修改上限。金额、价格变化或报价过期时返回 `budget_review_changed`，不保存修改；已提交的相同操作仍返回原回执。要求这些核验的调用方须拒绝未声明该版本的服务；省略可选条件的既有写入仍只核验预算修订。

接入任务使用稳定操作 ID、项目、请求哈希、实际供应商与模型、准确 Origin 和数量预占。只有首次返回 `dispatch_allowed: true` 才允许派发。剧变的 `prepare` 冻结原制作包修订、准确模型规格、参考图版本与人民币估价；`run` 读取原准备输入，取得绑定账号、修订、请求、连接及报价的服务器挑战，在 Muse 原生卡确认后由 Host 私钥签署；服务器一次使用。管理员额度不是人工审批证明。输入或价格变化需要重新确认，未知提交必须读取原操作，不能换编号重发。浏览器不提供宣称供应商完成或自动释放未知预占的接口。

公司准入另检查公司、成员与项目额度及并发权限，必须由管理员在网关配置。预算提高与生成付款是两次不同授权；保留的历史供应商账目只作读取。模型返回、标准输出或媒体解码都不是供应商最终账单，不得将未回报费用记录为零。

## 剧变保证对应与验收

| Muse／剧变保证 | 制作平台实现 |
|---|---|
| 明确的项目总授权 | 所有者提交预算、修订核对及可选管理员最大值 |
| 支出加未结意图加报价不超限 | SQLite immediate 预占，累计已确认账单与全部未结金额 |
| 项目或报价缺失时拒绝支出 | 项目归属检查与精确有效价格匹配 |
| 所有者估价始终可区分 | 独立估价／整任务授权与不可变来源资料 |
| 未知意图继续占预算 | 跨重启预占，不因取消或失败自动退款 |
| 重放不重复支出 | 原生／TTS／Fal 原标识、预占唯一键和不可变修改回执 |

运行 `node --test integrations/localminidrama/tests/muse-budget.test.mjs`。测试使用真实 SQLite、HTTP、持有写锁的独立进程与真实 Vue／Element Plus 浏览器，验证金额竞争、重试、重启回执、数据库身份改变、明确账单核对与 390 像素窗口，不接触既有账号或付费供应商。本地预期回执区分估价、未知预占和人工账单确认。所选供应商仍需要经过授权的真实 API、价格、最终账单及质量验收；配置资料和无密钥测试不能证明这些事实。

# Agent Note：为 workflow 扇出失败归因，并守住已完成子 agent 的返回约定

Status: implemented

[English](2026-09-27-workflow-agent-settlement-identity.md) | 中文

## 问题

一次有记录、31 个子 agent 的生产扇出，因同一个原因丢掉了两个子 agent，而 harness 从未报告过它。父脚本按集调用 `agent(prompt, { schema })`，并在同一条提示词里告诉每个子 agent「只返回一行 JSON」；子 agent 自己的请求同时带着与之匹配的 `structured_output` 工具、它的 schema，以及末尾的系统提示词段 `When you have your final answer, you MUST report it by calling the structured_output tool…`。子 agent 按任务正文的要求用散文加一行 JSON 作答，运行就把该子 agent 记为失败。

这一结果由三个彼此独立的缺陷共同造成。

一个正常结束自己的轮次、却始终未提交所请求结构化值的子 agent，被进程内驱动器压平成 `stopReason: 'error'`，于是 workflow 引擎无法区分「子 agent 失败」与「子 agent 跳过了返回通道」，脚本只拿到一个光秃秃的 `null`。引擎自己知道的失败原因——结构化结果缺失——没有进入任何持久记录，也没有到达任何观察者。

持久化的 `tool-workflow/agent-end` 记录只携带 `runId`、`seq` 与 `outcome`。在那次会话中，`label` 与 `childId` 只出现在 31 条成员结算中的 2 条上，而且只是因为操作者手工找出了这些成员；记录本身没有说明哪个子 agent 失败、为什么失败。

`outcome: 'completed'` 只表示子 agent 的轮次结束。三集已完成的分集随后因内容不可用被判废，因此读 `completed` 的消费方无法区分可用产物与仅仅结束的轮次。

## 决定

**跳过的返回通道成为独立的结束原因。** `SubagentStopReasonMap` 新增 `structured-output-missing`：当轮次以 `completed` 结算、而请求的 `outputSchema` 始终未被捕获时，进程内驱动器报告该原因，并附带既有的诊断信息，指明子 agent 从未发起的工具调用。因自身原因失败的轮次保留自己的结束原因。`run-settlement.ts` 通过其可合并扩展的默认分支映射该新变体，因此 one-shot 后台路径报告失败而非完成。

**每次失败的结算都说明原因。** `WorkflowAgentEndInfo` 携带 `reason: WorkflowAgentFailureReason`，一个封闭联合：`child-failed`、`missing-structured-output`、`invalid-structured-output`（带产物详情）、`infrastructure-fault` 与 `cancelled`。PTC 宿主校验 guest 报告的原因，JSON 桥把它交给引擎的观察者。脚本仍然拿到 `null`，这是它对脚本的承诺；但这次失败不再与其他任何失败无法区分。

**`completed` 现在要求该调用所声明的产物。** PTC 宿主保存每个子 agent 请求声明的 schema，并在运行时读到该值之前检查捕获值：值必须是 JSON 对象，且 schema 顶层 `required` 列表中的每个属性都必须存在。只有通过检查才产生 `completed`；未通过则报告 `invalid-structured-output`，并指明缺失的属性。该检查按设计只做结构判断——schema 可以要求存在 `dialogue` 数组，但无法要求它非空——语义验收仍归调用方。

**持久化的成员结算重复成员身份。** `tool-workflow/agent-end` 写入其开始记录已确立的 `label` 与 `childId`，并在成员失败时写入原因，因此单条结算记录即可归因 fan-out 失败并定位失败的子会话，无需按序号回连开始记录。两个身份成员在载荷中都是可选的：此前写下的日志仍可读取并保持原意。

**schema 调用会把返回约定加到任务正文之前。** 对每次 `agent(prompt, { schema })` 调用，`STRUCTURED_RETURN_NOTICE` 都位于脚本提示词之前，说明子 agent 以调用 `structured_output` 收尾、只有该调用携带结果、纯文本作答会被丢弃。任务正文自述的返回格式描述的是 schema 已经声明的载荷，而不是与之竞争的指令。`workflow` 工具描述在脚本作者阅读的位置陈述同一条规则。

## 考虑过的替代方案

**接受子 agent 最终文本中符合 schema 的 JSON 对象。** 那两个丢失的子 agent 确实输出了与其 schema 完全一致的对象，因此从文本中恢复它本可让两者都完成。但这也移除了子 agent 调用 `structured_output` 的唯一机械理由，以及该调用安装的终态防护——一旦捕获，后续工具调用无法重新开启该运行。返回通道正是子 agent 结果可被机器校验的原因，因此这里保留通道要求，改为修正对它的陈述。

**保留结算形状，让操作者自行把开始与结束连起来。** 开始记录本就携带身份，读取方可以按 `(runId, seq)` 还原。这正是被复盘会话做不到的连接：`agent-end` 出现了 29 次却没有任何可归因对象，两个失败成员是靠手工检索子会话找到的。

**把扇出成功的门禁放进 workflow 脚本。** 脚本可以对返回值做任意校验，被记录的父脚本也确实记录了自己的逐集失败。脚本自有的门禁无法让 `completed` 对任何其他消费方意味着可用产物——UI、阅读会话日志的操作者，或之后的回放。

**把重复身份改为必需。** 必需成员会让本次变更之前写下的每条日志，被要求该成员存在的载荷校验器判为不可读，其中就包括促成这次变更的那次复盘会话。

## 后果

仅凭持久记录即可归因 fan-out 失败：`tool-workflow/agent-end` 说明成员、其子会话与原因。把 `completed` 读作「子 agent 交付了该调用所声明的值」的消费方，对这一断言的**结构**部分是正确的，其余内容校验仍需自行完成。

提示词前缀为每次带 schema 的 `agent()` 调用增加约 90 个 token。普通 `agent()` 调用不变：没有 schema、没有前缀，子 agent 的最终文本仍是结果。

若某个提供方声称支持 `outputSchema`，却仍把未捕获的干净轮次报告为 `completed`，引擎自身的检查仍会处理它；新的结束原因让该提供方的报告变得准确，而不是承重。

[持久化记录](../../../../docs/persistence-changes/2026-09-27-workflow-agent-settlement-identity.zh.md) 同时确认了同一工作树中并行工作为 `event:request/header` 新增的可选成员 `config.responseFormat`。该条目不属于本次决定，记录中已写明哪个根属于哪项变更。

## 测试

`packages/workflow/workflow-ptc/tests/integration.spec.ts` 驱动真实进程内栈：一个用散文作答的 schema 子 agent 让脚本的 `agent()` 解析为 `null`，并恰好发出一个 `workflow/agent-end`，其 `childId` 等于 `workflow/agent-start` 记录的那个，其 `label` 非空，其原因为 `missing-structured-output`。`packages/workflow/workflow-ptc/tests/guest.spec.ts` 固定了失败子 agent、结构化值缺失、以及被产物检查拒绝并带详情文本的捕获值这三种原因。`packages/workflow/tool-workflow/tests/tool-workflow.spec.ts` 固定已完成后成员的记录载荷。`packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` 固定新的结束原因及其诊断。这些测试与 `packages/session/session-format-v0-to-v1/tests/` 一起通过了九个文件中的 217 项测试。

[会话日志版本机制决定](../architecture/2026-08-10-session-log-version-mechanism.zh.md) 说明了为什么三个可选载荷成员不需要版本提升；[其持久化记录](../../../../docs/persistence-changes/2026-09-27-workflow-agent-settlement-identity.zh.md) 是这次确认。两者均未被取代。

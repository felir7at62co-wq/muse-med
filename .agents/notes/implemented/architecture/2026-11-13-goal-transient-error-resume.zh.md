# Agent Note: 瞬时模型错误后可选启用的目标自动恢复

Status: implemented

[English](2026-11-13-goal-transient-error-resume.md) | 中文

## 问题

无人值守的 goal 在任何轮次错误后都会停止，直到有人手动 resume。2026-11-13 的一次桌面端转写运行中，上游 `SERVER`（HTTP 502）错误持续时间超过了单次请求的提供方重试；每个失败的 goal Round 都停用了续行，其中一次停止持续了 10.5 分钟。夜间桌面运行和云端 worker 没有人可以点击恢复。

## 决策

`dsh-goal-round-driver` 提供可选启用的 `transientErrorResume { maxAttempts, delayMs, codes }` 选项，默认关闭。驱动器在 `agent/error` 监听器中做判断：已准入、未完成的 goal Round 若以 `LlmError` 失败且代码在 `codes` 中（默认 `SERVER`、`TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED`），只做标记，不停用续行。在下一次 idle 时，驱动器记录一个 `timer` goal 等待，其消息写明错误代码和 `n/maxAttempts` 形式的尝试次数，会话日志因此能解释下一个 Round 的来源；失败 Round 中模型已记录的等待会保留。完成一个 goal Round，或编辑、resume goal（两者都会提升修订号），都会重置内存中的计数。连续自动恢复 `maxAttempts` 次后，驱动器停用续行，并记录一个 `input` 等待，其消息说明停止原因，Web 端目标栏把它作为提示文字显示。提供方重试策略仍是单次请求内的第一道防线。用户中止、策略阻塞、Round 上限、no-tools 与任务等待、其他代码、非模型错误，以及发生在已准入 goal Round 之外的失败，仍遵循用户授权 resume 规则，会话启动边沿也是如此。

## 考虑过的替代方案

**把自动恢复记录为 operation 为 `resume` 的 `goal/change`。** `resume` 是用户授权的状态转换：它会提升修订号，从而触发尝试栅栏，日志也会把自动恢复显示成人工恢复。新增原因字段还会让同一会话格式下的旧读取方在严格的 `goal/change` 读取中失败。现有 `goal/wait` 的 timer 与 input 等待无需改变持久化类型就能记录原因。

**新增 `transient-error` 等等待原因。** 等待原因是封闭枚举，旧读取方回放时会拒绝新值；带消息的 `timer` 已具备所需含义和界面。

**在 `turn/end` 时判断。** 循环写入 `turn/end` 的 `LlmError` 失败代码与 `agent/error` 携带的代码相同，且 `agent/error` 先触发，因此在这里判断不需要额外的跨监听器状态。同一轮次的第二次非瞬时报告仍会停用续行。

**用单独的插件在错误轮次后恢复。** 它看不到驱动器私有的尝试状态，而且会在驱动器已经停用续行之后运行，只能使用人工 `resume` 操作。

**持久化尝试计数。** 续行启用状态只在进程内，会话启动边沿本来就会停用续行，持久计数没有使用方。

## 影响

每次恢复的 Round 都消耗一个 goal Round，因此 `maxGoalRounds` 仍限制总数。被报告为 `SERVER` 的确定性错误在每个修订中最多重试 `maxAttempts` 次。未配置该选项的组合保持原有文档行为。headless 单次运行在首次 idle 时退出，因此不受益；长期运行的服务端配置需要相同的选项行。goal 消息进入历史之前的瞬时失败（例如 Round 首个步骤中失败的压缩请求）仍会停用续行。冷却期间进程重启后，持久的定时等待仍在，但 goal 保持停用续行，直到用户 resume。[驱动器 README](../../../../packages/goal/goal-round-driver/README.zh.md#compose-it) 说明了该选项。

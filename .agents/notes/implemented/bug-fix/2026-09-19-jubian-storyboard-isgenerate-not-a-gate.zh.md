# Agent Note: 剧变分镜的 isGenerate 不是门禁

Status: implemented

[English](2026-09-19-jubian-storyboard-isgenerate-not-a-gate.md) | 中文

## Problem

剧变包里有三处把分镜字段 `isGenerate` 读成"这个分镜已经生成过了"：`withGenerationEnabled()` 只有在快照读到 0 时才肯拼出那次计费 PUT，`select_assets` 只有在回读读到 0 时才不抛 `CONTRACT_CHANGED`，而 `buildSubjectSelection()` 只有在读到 0 时才报告 `already_applied`。提供方对它持有的每个分镜都存 1——已经出过片的、从没生成过的、素材为空的占位分镜都一样——于是 `jubian_storyboard generate` 在任何请求发出之前就失败，分镜原生的主体视频通道在第一步 `select_assets` 就断掉，`already_applied` 永远不可达，每一次选择调用都多发一次并不需要的 PUT。

## Decision

没有任何读取器或变换以 `isGenerate` 为条件：提供方响应的是调用方写进请求体里的 `isGenerate`，不是库里存的值，因此计费路径唯一的前置条件就是已保存的 `modelConfig.duration` 等于所请求的内容时长加一秒。`select_assets` 保留回读与计费安全审计，一次"仅保存选择"却产生了视频任务时仍然返回 `billing_safety_violation`；`already_applied` 这个空操作现在只看保存下来的素材是否与计划一致。`readStoryboard()` 仍然拒绝既不是 0 也不是 1 的值，也仍然报告 `is_generate`，所以调用方依旧能看到提供方说了什么。

`jubian-api` 与 `tool-jubian` 的测试夹具改用 `isGenerate: 1`，也就是提供方真正返回的值；工具测试里的假提供方无论 PUT 体带了什么，都继续存 1。

## Alternatives considered

**把库里的 1 当作"正在生成"并报错。** 这个字段于是会拒绝这个提供方能回答的每一个请求，那是缺陷本身，不是修复。

**与调用前的快照做比较。** 用状态跃迁来判断需要一个库里的 0 作为起点，而提供方从不存 0，所以这个比较没有可检测的失败情形。

**从项目的视频任务列表里判断是否生成过。** 那些记录不带分镜 ID，靠推导出来的任务名去匹配等于猜一个提供方并未发布的关系；而账本的幂等键已经阻止了同一次提交被派发两次。

## Consequences

`generate` 会把那一次 PUT 发出去，计费路径在这个提供方版本上才真正可用。被删掉的检查从未触发过，所以没有放弃任何曾经生效的保护：仍然站着的是时长前置条件、账本幂等键，以及 `submit_video` 的任务双快照加身份比对。如果库里那个值将来真的成为信号，这个检查应当只在一个地方加回来。

`packages/jubian/jubian-api/tests/storyboard.spec.ts` 钉住两种存量值都产生同一个计费请求体，`packages/jubian/jubian-api/tests/selection.spec.ts` 用提供方自己的值钉住那个空操作，`packages/jubian/tool-jubian/tests/native.spec.ts` 钉住一次回读仍读到 1 的选择保存。

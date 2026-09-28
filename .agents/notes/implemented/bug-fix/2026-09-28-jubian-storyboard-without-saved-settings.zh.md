# Agent Note：读取一个没有保存过设置的分镜

Status: implemented

[English](2026-09-28-jubian-storyboard-without-saved-settings.md) | 中文

## Problem

2026-09-27 的现场报告列出 `storyboard get` 与 `prepare_video` 对**任意** ID 都失败，报错是 `Jubian response did not match the expected envelope`；其中包括报告者刚通过 `jubian_storyboard create` 建出来的桩件 `1699732`，而同一账号的工作台里能看到这个分镜。对那次读取的 `DSH_JUBIAN_DEBUG_DUMP` 取样定下了到底是哪一层在拒绝：HTTP 200、应用码 200、一份 426 字节的普通对象载荷，而里面 `modelConfig: null`。信封从来不是成因。`@deepseek-ai/dsh-jubian-api` 的 `readStoryboard()` 要求 `modelConfig.ratio`、`modelConfig.resolution`、`modelConfig.genNum === 1` 与整数 `modelConfig.duration`，`storyboardMaterials()` 则拒绝既不是数组也不是 JSON 文本的 `storyboardMaterialList`。模型设置是**有人保存下来的选择**，所以一个没人配置过的分镜根本不返回 `modelConfig`：读取器拒绝的是提供方合法持有的载荷，而拒绝只说了它没能匹配上哪个信封。报告里其他失败读调用唯一幸存下来的详情 `Expected a JSON object`，正是 `tool-jubian/src/model-settings.ts` 里的 `object()` 对"不是对象的 `modelConfig`"给出的结论，说明至少有一次真实读取已经拿到了这样的值。

## Decision

**缺失的设置顶替后如实上报；提供方确实返回了的值必须可用。** `modelConfig` 缺失、为 `null` 或为空串时 `readStoryboard()` 继续读取，用 `ratio: '9:16'`、`resolution: '720p'` 与 `genNum: 1` 顶替，并把每一处顶替按"线上字段 → 顶替值"记进新增的 `StoryboardView.model_config_defaults`。提供方确实返回了的字段仍然校验：空标签、不为 1 的 `genNum`、读不了的 `modelConfig` 字符串都会被拒绝。`duration` 永不顶替，因为视图把它作为 `content_duration_ms` 上报、计费路径又拿它与请求的整包时长比对；它缺失时 `content_duration_ms` 为 null。

**计费路径只拒绝"提供方必须保存过"的东西，并且把话说完。** `withGenerationEnabled()` 交回的是提供方自己的快照，因此提供方依据的是它存下的 `modelConfig`，永远不会是本读取器顶替出来的值。`PAID_CONFIG_FIELDS` 点名它据此行动的字段——`ratio`、`resolution`、`genNum`、`duration`、`modelId`——已保存配置缺其中任何一个就抛 `INVALID_ARGUMENT`：被顶替的标签是本读取器的默认值，而缺 `duration` 或 `modelId` 会让提供方自己去挑长度或通道。拒绝报文写明期望的线上字段、提供方没有返回的那些、实际收到载荷的脱敏结构（`describeRejection()`，也就是每个读取器都经由的那份摘要）以及修法 `jubian_model preview → apply`；它不再把调用方送去 `prepare_video`，因为那条路读的是同一个 `modelConfig`，会因同样的理由拒绝。

**提供方合法给 `null` 的字段永远不是拒绝理由。** 取样到的响应体里，`episodeCount`、`scriptName`、`remark`、`updateBy`、`updateTime` 与 `videoSubTaskList` 都是 `null`，旁边是一个空的 `storyboardMaterialList`，而这些全都是合法的。读取器只要求"被问的那一行的身份"和"它自己那个问题所问的字段"：`readStoryboard()` 要求 `id`、`scriptId`、`isGenerate` 与可读的素材键；`readTaskPage()` 只要求任务 ID，`scriptId`、`episodeId`、`episodeCount`、`taskStatus`、`taskName` 与三个费用字段一律按可空读。正因如此，报告里那条 `video task`（`1032840`）**不是**这个缺陷：它的读取器从未把可空字段当成必填，而取样显示分镜那次读取拒绝的载荷，其信封是完好送达的。

**`storyboardMaterialList` 是选填的，且两种形式都读。** `null`、键不存在与空串是该提供方对"还没有素材"的写法，一律读成空列表。内联数组与 JSON 文本都读，与 `native.ts` 里的 `storyboardMaterials()` 一致；两者都不是的列表会被点名拒绝，而不是像此前 `Array.isArray(...) ? ... : []` 那样静默报成空——同一个字段 `prepare_video` 走的是严格读取。

**每一处拒绝都点名它读不了的字段。** `storyboard.ts` 的 `invalid()` 现在接收 detail，因此拒绝会写出 `scriptId is not a positive integer`、`modelConfig.duration is not a positive whole number of seconds` 或 `storyboardMaterialList[0].materialKey is not a nonempty key`。读取器名称与脱敏后的载荷结构由[那次诊断改动](2026-09-28-jubian-unreadable-response-diagnostics.zh.md)的 `readPayload()` 追加，两层因此不可能对同一个响应体给出不同说法。`native.ts` 的 `storyboardMaterials()` 与 `validatedVideoMaterials()` 也会点名卡住准备流程的字段，于是 `prepare_video` 会说清分镜是没有可读素材，还是没有已保存的配置。

## Alternatives considered

**连 `duration` 一起顶替。** 否决：`content_duration_ms` 是给调用方看的值，计费路径还拿它与请求的整包时长比对，顶替出来的时长是编造的视频长度，而不是降级字段。用 null 陈述缺失。

**保留 `ratio`、`resolution`、`genNum` 必填，把这种分镜报成读不了。** 否决：这几个标签只影响生成规格，与这次读取存在意义完全无关。把它们设为必填，使每一个"建好但还没配置"的分镜都无法读取——而那正是 `jubian_storyboard create` 留下的状态。

**把空 `ratio` 当作未设置。** 否决：提供方确实送来了一个值，为一个本读取器用不了的值做顶替，等于悄悄替换掉一个损坏的已存设置，而不是把它报出来。只有"缺失"才顶替。

**保留静默的空素材列表。** 否决：它会把一个已有主体的分镜报成一个主体都没有的分镜。

**已保存的 `duration` 缺失时，按请求的整包时长生成。** 否决：`content_duration_ms` 是调用方对"要生成多长"的陈述，但提供方是从它存下的 `modelConfig` 推导长度的，而计费路径在开启生成前要拿保存时长与请求整包比对。写进一个用户从未保存过的时长，等于拿本库挑的规格去花钱；而且它仍然没有可购买的 `modelId`——真正卡住这次调用的正是那个字段。

## Consequences

`packages/jubian/jubian-api/tests/storyboard.spec.ts` 钉住取样响应体的结构（只删掉报告者的账号字段 `createBy`、`userId`、`companyId`、`mainDeptId`、`secondDeptId`，其余一字未改）：`modelConfig: null` 与空 `storyboardMaterialList` 并存、六个可空同类字段全为 `null`，照样读通并给出 `model_config_defaults`、`model_config_notes` 与 null 的 `content_duration_ms`；不完整的已保存对象（内联与 JSON 文本两种形式）同样顶替；不存在的 ID 返回 null 载荷时，报文陈述实际收到了什么；免费保存照旧回吐提供方快照；计费路径拒绝时带出期望字段、缺失字段与它所拒绝响应体的顶层键。`pnpm vitest run packages/jubian` 覆盖两个包。

这次改动没有增加的东西：第二处"已保存模型设置"的来源。提供方存在分镜上的那个 `modelConfig` 是唯一存放"选定的通道与时长"的地方——`packages/drama/drama-settings` 的短剧设置段锁定的是生图行与预算，不是视频通道——所以读到 `modelConfig: null` 的调用方必须先通过 `jubian_model preview → apply`（或在工作台里为这个分镜选定模型）保存设置，两条计费路径才可能运行。`prepare_video` 与 `submit_video` 经 `validatedVideoMaterials()` 读的是同一个字段，因此这是每个分镜修一次，而不是每个方法各修一次。

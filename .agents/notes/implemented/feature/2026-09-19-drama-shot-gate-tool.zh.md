# Agent Note: Short-drama shot-script gate as a tool

Status: implemented

[English](2026-09-19-drama-shot-gate-tool.md) | 中文

## Problem

短剧流水线的硬规则——单镜 1–4 整数秒、9 有效字/秒、36 字上限、没有旁白轨、必须用正式资产、每包内容最多 14 秒——原本写在 `tweet-drama-early-shot-script` skill 正文里，由 skill 让模型运行的一个 Python 脚本执行。跳过 skill、或用错参数运行脚本的模型，仍然可以写出一份违规的镜头脚本，而问题要等付费提供方渲染出错误字幕、或打包时丢掉一个镜头才暴露。仓库的规矩是「决定要在做这件事的操作里强制执行」；这些规则都是可判定的——脚本正文、资产清单与打包预算能判定每一条——所以提示词正文是错误的归属地。

## Decision

[制作策略与结果证据决策](2026-09-21-drama-policy-and-result-evidence.zh.md) 部分取代本文记录的创作限制与固定时长预算。本文保留独立的工具归属理由；原先支持创作检查直接判失败的论证不是当前策略。

新的 `drama/` 包组承载 `@deepseek-ai/dsh-tool-shot-script`，它注册一个模型可见的工具 `drama_shot`，含三个方法。`validate` 读取脚本，逐镜给出推导时长及其来源、有效字数、发声类型、画外音是否合法、以及资产绑定，并把硬失败与警告分成两个列表。`preview` 在不落盘的前提下补上打包方案。`compile` 写入 `prompts/<集号>.txt`、`matches/<集号>.matched.json` 与 `episode_packages/<集号>/` 目录树（`package.json`、`shot_script.txt`、`matched.json`、`episode.txt`，以及每个本地存储的绑定资产各一份拷贝），并回传每包的 `content_seconds`、`content_duration_ms`、`submit_seconds` 与按提示词顺序去重的 `material_keys`。

任何 failure 级问题都会让脚本带着这份失败清单返回、一个文件都不写：编译器在写第一个字节之前先解析分集正文与每个本地资产图片，被拒的编译让项目保持原样。脚本问题是业务结果，承载在规范返回值里；只有环境问题（文件不存在、清单不是 JSON）才抛错。

有四处规则与被移植的 Python 编译器不同。写作阈值是 15 有效字、硬上限是 36：16–36 给警告，超过 36 判失败。`台词：无`、`台词：无。` 与空台词行判失败，而不是编译出一条写着「无」的字幕。`出镜人物：无` 判失败；零人物绑定的镜头整行省略该字段。每个无声镜可以声明 `动作复杂度：简单/一般/较复杂/复杂`，分别向打包预算计入一、二、三、四秒，而没有该标签的无声镜取插件的 `actionShotSeconds`（默认 2）。其余规则照搬：1–4 整数秒、9 有效字/秒、导演格式要求的固定负面提示、旧 `时长` 字段的读取比对与剥离、镜头号连续、official 且信息完整的资产门禁、以场景为连续性键、每包最多 14 秒内容加 1 秒自然收束，以及 version 4 的 matched payload 布局。

判定刻意不放进 skill：镜头怎么读、剪辑什么感觉、台词怎么措辞都判定不了，所以短剧 skill 继续管这些，而本工具只拒绝格式能判定的部分。

## Alternatives considered

**把规则继续留在 skill 与 Python 编译器里。** 这正是被替代的状态：一条要靠模型记住的规则，加一个要在 shell 里带对参数启动的脚本。工具调用的参数留在记录里、缺参数就失败，也不存在「记了一半」。

**改在 guard 拦截里强制。** `drama-gate` 会拦下内容违规的 `write`/`edit`，覆盖那些从不编译任何东西的会话。它报不出一份脚本的全部问题、算不出打包预算，也产不出产物——拒绝不等于编译。两者互补：guard 拦住写进来的坏文件，工具才是产出分集的那次操作。

**继续用 Python。** 脚本格式、资产清单与 matched payload 本来就由 Python skill 读写，所以移植没有必要性。但它也无法把结构化结果交回模型、无法被本仓库的门禁覆盖，而且活在会话实际挂载的组合之外。

**把包放进 `guard/` 或 `jubian/`。** guard 组拦截调度；本包注册工具、判定格式。Jubian 组适配远端 API；本包从不联网。开一个新组才诚实说明了归属——短剧流水线自己的格式——即使它一开始只有一个包。

## Consequences

流水线的可判定规则现在有了唯一的可执行归属，并带一组稳定的问题代码（`no_shots`、`speech_too_long`、未登记资产等等，见包 README 的表格），修复循环可以据此判断。代价是过渡期存在第二份格式实现：matched payload 的字节布局仍以 Python 编译器为准，skill 正文在会话迁移完成前也仍然描述同一批规则。

有三条限制是有意为之，并记录在包 README 里：连续性键只有场景，因此同一场景内的时间或服装变化在脚本未标 `子任务边界：是` 时会打进同一个包；`actionShotSeconds` 可能低估提供方实际渲染的时长，所以包数是下界而不是账单承诺；一次 compile 不是跨进程事务。

本包不在调用之间保存状态，也不发布 invariant 伴随包（companion）：所有答案都是它所读文件的纯函数，没有会独立变化的观察对象可供检查。

## Testing

`packages/drama/tool-shot-script/tests/` 覆盖解析器、绑定器、打包器，以及通过其执行器调用的已注册工具；`npx vitest run --coverage` 对五个源模块报告逐文件 100% 的 statements、branches、functions 与 lines。工具测试会用工具自己的 `output.schema` 校验每个返回值，因此规范返回值与声明 schema 的漂移会在这里失败，而不是在会话里失败。

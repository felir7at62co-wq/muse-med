---
description: "把短剧流水线的镜头门禁与单集编译做成一个模型可见的工具：校验导演格式镜头脚本、预演 14 秒打包预算、编译 matched JSON 与单集 package，供运行剧变短剧流水线的使用者与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shot-script

[English](README.md) | 中文

## Summary

当短剧会话必须编译导演格式镜头脚本、又不能靠提示词自觉遵守格式时，用这个包。工具 `drama_shot` 就在产出产物那一步判定并编译：`validate` 逐镜给出推导事实并把硬失败与警告分开，`preview` 在不落盘的前提下补上打包预算，`compile` 只在脚本通过后才写入 matched JSON 与单集 package。一条规则只有在脚本正文、资产清单与打包预算三者能判定它时才留在这里；镜头怎么写好看留在短剧 skill 里。

## Table of Contents

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件作为短剧预设的一行挂载；它只需要工具注册表：

```yaml
- id: tool-shot-script
  name: '@deepseek-ai/dsh-tool-shot-script'
  config:
    actionShotSeconds: 2   # silent shot without 动作复杂度; 1–4, default 2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `actionShotSeconds` | `2` | 未声明 `动作复杂度` 的无声镜在打包预算里按几秒计（1–4）。加载时校验，超出范围直接失败。 |

### 三个方法

| 方法 | 读取 | 写入 | 用途 |
|---|---|---|---|
| `validate` | 脚本；给了 `assets` 时也读资产清单 | 无 | 在动项目之前读完每个镜头的推导事实与全部违规 |
| `preview` | 脚本与资产清单 | 无 | 提交前看清打包预算：内容秒数、提交时长与素材键顺序 |
| `compile` | 脚本与资产清单 | matched JSON、编译后的提示词、单集 package | 产出流水线要提交的产物 |

| 参数 | 何时必填 | 含义 |
|---|---|---|
| `method` | 始终 | `validate`、`preview` 或 `compile` |
| `script` | 始终 | 镜头脚本路径，绝对路径或相对当前工作目录 |
| `assets` | `preview`、`compile` | `assets_manifest.json` 路径；`validate` 只在给了它时才判定资产绑定 |
| `project` | `compile` | 项目根目录，含 `episodes/`、`prompts/`、`matches/`、`episode_packages/` |
| `episode` | `compile` | 集号，正整数，写入时补成两位 |

某个方法缺自己必填的参数会在打开任何文件之前失败；脚本存在硬失败则一个文件都不写——结果里带的是失败清单而不是错误，一次调用就能给出模型需要修的全部内容。

### 判定规则

脚本按镜头写成 `【镜头N】` 块，每块前一行是 `真人短剧写实风格`；这一行加整块就是该镜的提示词正文。脚本与提示词里都不出现时长，时长由编译器推导：

| 规则 | 判定 |
|---|---|
| 有发声的镜头：`ceil(有效字 / 9)` 秒，1–4 | 据此推导；超过 15 有效字给警告，超过 36 有效字判失败 |
| 无声镜：`发声类型：action` 加 `动作复杂度：简单/一般/较复杂/复杂` | 分别计 1/2/3/4 秒；没写复杂度就按 `actionShotSeconds` 计 |
| 单镜时长不是 1–4 整数秒 | 失败 |
| `台词：无`、空台词行、没有任何有效字的台词行 | 失败——无声镜整行省略台词行 |
| `出镜人物：无`（旧写法 `出镜人物【无】` 同样） | 失败——零人物绑定的镜头整行省略该字段 |
| 旁白/解说/心声/画外声/叙述/OS | 失败——本格式没有旁白轨 |
| `台词：角色名（画外音）：原文` 或裸 `画外音` 标签 | 允许：同场画外音，照样出字幕、照样计字 |
| 镜头正文里还留着 `数字秒` | 失败——提示词里不得出现时长 |
| 绑定资产不是 `official: true`，或缺 `jubian_asset_id`、`jubian_material_id`、URL | 失败 |
| `核心场景` 写了资产清单未登记的名字 | 失败 |
| 镜头没有绑定任何场景 | 警告 |
| 打包 | 同场戏的连续镜头，每包内容最多 14 秒，另加 1 秒不新增台词的自然收束 |

有效字只数汉字、字母和数字：标点与空格不计。老脚本里的 `时长：N秒` 仍会被读取、与推导秒数比对，并从提示词里剥掉。

### 问题代码

每条失败与警告都带稳定的代码。`validate` 会打印它们，修复循环以它们为准。

| 代码 | 级别 | 含义 |
|---|---|---|
| `no_shots` | 失败 | 脚本里没有任何 `【镜头N】` 块 |
| `shot_numbering` | 失败 | 镜头号不是 1..N，有跳号或重复 |
| `missing_style_line` | 失败 | 某个镜头块前没有 `真人短剧写实风格` |
| `seconds_in_shot_body` | 失败 | 旧时长字段之外出现了 `数字秒` |
| `legacy_duration_invalid` | 失败 | 旧 `时长` 值不是 1–4 整数秒 |
| `legacy_duration_mismatch` | 失败 | 旧 `时长` 与推导秒数不一致 |
| `missing_negative_prompt` | 失败 | 导演格式镜头缺少 `无噪点，无跳帧，五官稳定不变形` |
| `narration_marker` | 失败 | 出现旁白、心声或叙述标记 |
| `multiple_speech_lines` | 失败 | 同一镜出现多条发声原文 |
| `empty_dialogue_line` | 失败 | 台词行没有任何有效字 |
| `placeholder_dialogue` | 失败 | 台词原文是 `无` |
| `missing_voice_type` | 失败 | 无发声的镜头没有标 `发声类型：action` |
| `action_voice_with_dialogue` | 失败 | 同一镜既写 `action` 又写台词行 |
| `speech_too_long` | 失败 | 单镜有效字超过 36 |
| `speech_above_writing_threshold` | 警告 | 有效字超过 15；建议按原文语义拆句 |
| `unknown_action_complexity` | 失败 | `动作复杂度` 不是四个合法取值之一 |
| `action_complexity_on_speaking_shot` | 失败 | 有台词的镜头（时长已由字数决定）又写了 `动作复杂度` |
| `characters_placeholder` | 失败 | `出镜人物` 用了 `无` 占位 |
| `unregistered_scene` | 失败 | `核心场景` 写了清单未登记的名字 |
| `no_scene_bound` | 警告 | 该镜没有绑定场景资产 |
| `unconfirmed_asset` | 失败 | 绑定资产的 `official` 不是 `true` |
| `incomplete_asset` | 失败 | 绑定资产缺剧变 asset ID、material ID 或 URL |

### compile 写什么

`compile` 按项目自己的目录结构写入，并回传它写的每个路径：

| 路径 | 内容 |
|---|---|
| `prompts/<集号>.txt` | 作为提交提示词的脚本；源文件不是它时复制过来 |
| `matches/<集号>.matched.json` | matched JSON：逐镜一行，含时间轴位置、绑定资产，以及每包一条 video task |
| `episode_packages/<集号>/package.json` | 同一份 JSON，让单集 package 自洽 |
| `episode_packages/<集号>/shot_script.txt` | 编译后的提示词 |
| `episode_packages/<集号>/matched.json` | 同一份 JSON |
| `episode_packages/<集号>/episode.txt` | 来自 `episodes/<集号>.txt` 的分集正文 |
| `episode_packages/<集号>/assets/<类型>/<文件名>` | 每个本地存储的绑定资产，按资产去重复制一次 |

结果还会回传每包的 `content_seconds`、`content_duration_ms`（就是 `jubian_storyboard` `generate` 要的值）、`submit_seconds`（内容加 1 秒收束）、按提示词 `@[名称](key)` 出现顺序去重的 `material_keys`，以及 `material_names`。本地资产图片或分集正文不存在时，调用在写入第一个字节之前就失败。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

本节说明一次调用如何被判定、代码在哪里；可观察行为在[使用本包](#use-this-package)里已经写全。

### 设计取舍

这个包建立在四条承诺上：

- **在产出产物的那一步强制判定。** 决定脚本能否编译的规则，写在真正写入产物的那次调用里，而不是在 skill 里再讲一遍。跳过 skill 的模型依然编译不出一条旁白字幕或一个 40 字的镜头。
- **只做可判定的规则。** 一条规则只有在脚本正文、资产清单与预算能判定它时才留在这里。措辞、构图、表演与剪辑节奏判定不了，留给教它们的 skill。
- **脚本问题靠报告，不靠抛错。** 脚本不合规是业务结果：解析器收齐每条问题并带上行号与镜头号一起返回，一次调用就是一份修复清单。只有环境问题——文件不存在、清单不是 JSON——才抛错。
- **失败时一个字都不写。** 打包方案先算出来，所有输入先校验，然后才写第一个字节；被拒的 compile 让项目保持原样。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、参数解析、方法分发，以及 `drama_shot` 的 schema 与描述 |
| [`src/script.ts`](src/script.ts) | 解析器与全部脚本规则：分块、有效字、发声与旁白判定、时长推导 |
| [`src/assets.ts`](src/assets.ts) | 资产清单读取与镜头绑定，含 official 且信息完整的资产门禁 |
| [`src/episode.ts`](src/episode.ts) | 打包、matched payload、素材键顺序与单集写入 |
| [`src/report.ts`](src/report.ts) | 规范结果：逐镜与逐包一行，失败与警告分开 |
| [`src/types.ts`](src/types.ts) | 只有类型：解析出的镜头、绑定资产、打包任务与模型可见结果 |
| — | 不发布 runtime invariant 伴随包（companion）：本包不在调用之间保存状态、不暴露快照，所有答案都是它所读文件的纯函数。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页面。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shot-script) —— 模型实际收到的 `drama_shot` schema 与描述。
- [工具子系统参考](../../../docs/subsystems/tools.zh.md) —— 参数 DSL、规范输出值与每次调用进入的流水线。
- [drama 组地图](../README.zh.md) —— 短剧流水线的同组包。

-----

<a id="model-experience"></a>
## 模型体验

### `drama_shot` 工具 schema

#### 模型看到什么

请求的工具列表里多一个名为 `drama_shot` 的工具：本包的 `description`、五个参数，以及结果的 JSON schema，三者在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shot-script)里都有原文。描述里写明三个方法、9 字/秒的推导与 1–4 秒规则、15/36 有效字阈值、无声镜必须写 `发声类型：action` 及其 `动作复杂度` 取值、判失败的四类写法（`台词：无`、空台词行、`出镜人物：无`、旁白类标记）、仍然合法的同场画外音、脚本与提示词都不得出现时长、official 且信息完整的资产门禁，以及每包 14 秒内容加 1 秒收束的预算。结果 schema 声明 `method`、`ok`、`script`、`assets_manifest`、`assets_checked`、`shots`、`packages`、`failures`、`warnings`、`written` 与 `summary`；渲染出来的内容就是同一份值的美化 JSON。

#### Token 影响

视脚本而定且有界：schema 固定，结果随镜头数与问题数增长——每个镜头贡献一行 `shots`，每个包贡献一行 `packages`。每条失败与警告各带一句中文说明，硬失败时不产出打包方案，因此被拒的调用返回的是最短可用的答复。

#### KV Cache 影响

追加式。工具注册的名字、描述与 schema 稳定，已挂载的行让请求前缀保持可复用；只有本包的描述或 schema 变化才会让缓存失效。一次调用的结果作为该次调用自己的工具结果追加在后面，不改写更早的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些边界界定本包是什么、不是什么。它们是当前约束，不是待办清单。

- **只做本地编译** —— `compile` 只写 matched JSON 与单集 package，从不向剧变提交任何东西。计费提交仍由 `jubian_storyboard` 负责，所以结果回传的是 `content_duration_ms` 与素材键顺序，而不是替你提交。
- **包数不是提交预算** —— 当 `actionShotSeconds` 为 2 时，某镜计入的秒数可能少于提供方实际渲染的时长，一个包因此可能超过 14 渲染秒；包数是下界，不是账单承诺。
- **连续性键只有场景** —— 解析出的场景变化或某镜写了 `子任务边界：是` 才会切包。同一场景但时间或服装不同的两镜，除非脚本自己标了边界，否则留在同一个包里。
- **只写了不匹配字符串的人物不绑定任何东西** —— 绑定是对清单名字做子串匹配：`出镜人物：苏晚` 只会绑定清单里名字出现在该字段或提示词正文中的资产；找不到对应资产的名字不会报错。
- **没有场景只是警告，不是失败** —— 省略 `核心场景` 且提示词里没有已登记场景名的镜头，会以空场景编译通过。
- **不改写提示词** —— 编译出的提示词就是脚本原文：风格行、标记行与镜头正文，只剥掉旧时长行。本包不规范化任何措辞、顺序或空白。
- **旧 `segments` 校验没有移植** —— 旧编译器那个可选的前置旁白段交叉核对，在当前流水线里没有消费者，也不属于任何方法。
- **一次 compile 不是跨进程事务** —— 写入前已校验且顺序固定，但同一集并发编译仍可能交错写文件。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确不是权威——已发布行为、限制与已接受的取舍在以上各节、包代码与链接文档里。

规则集移植自流水线的 Python 编译器（`tweet-drama-early-shot-script/scripts/compile_director_shots.py`），并有意保留四处差异：15 有效字是写作阈值、36 有效字是硬上限；`台词：无` 与空台词行判失败；`出镜人物：无` 判失败；`动作复杂度` 让每个无声镜有自己的预算，而不是一个全局值。matched payload 的字节布局仍以那份 Python 编译器为准。

剩下的重复是有意的：随着会话迁移到这个工具，同一批规则正在从 skill 正文里移除，过渡期内两边同时存在。
</details>

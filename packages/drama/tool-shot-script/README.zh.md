---
description: "校验镜头脚本、报告创作建议，并按明确的分镜时长预算编译带资产绑定的单集包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shot-script

[English](README.md) | 中文

## 概述

使用 `drama_shot` 校验导演格式脚本、预演打包时长或编译 matched JSON 与单集文件。长镜头、慢台词、旁白与心声可以通过，并附建议性警告。字段格式错误、已绑定资产未确认或信息不完整、超过项目自己声明的每镜上限，以及超出调用方明确时长预算的包仍阻止编译。工具保留台词原文与说话人身份，不调用提供方。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在短剧预设中把插件挂载到工具注册表旁。`actionShotSeconds` 默认 2，接受 1–4 整数秒；它用于估算没有明确时长或复杂度的无声镜，不是镜头时长上限。

| 方法 | 必填输入 | 结果 |
|---|---|---|
| `validate` | `script`；可选 `assets`、`project` | 只读镜头事实、失败与警告 |
| `preview` | `script`、`assets`、`max_submit_seconds`；可选 `project` | 只读打包方案 |
| `compile` | preview 输入加 `project`、`episode` | matched JSON 与单集文件；校验失败不写入 |

`max_submit_seconds` 是目标分镜实际请求的总时长，包含一秒自然收束。它必须已在所选模型确认支持的范围内。分镜配置为 8 秒就填 8，即使模型支持 30 秒。既有 15 秒分镜明确传 15；配置为 30 秒的分镜可以传 30。编译器不读取提供方能力，也不静默假定 14 秒内容上限。

### 项目自己的要求

每个方法都会读取所属项目自己的要求：调用给了 `project` 就用它，否则从脚本所在目录向上找最近的 `project_config.json`（最多四层）——与流水线自己的脚本定位项目根的方式一致。目前读取的唯一要求是 `delivery.max_effective_chars_per_shot`，即项目自己声明的每镜有效字上限。它的效力高于本工具的内建数值：超过它判失败而不是警告，因为项目写明的要求不是建议；拒绝文案同时给出两条正当出路——按原文语义拆句，或改掉该项目的这条要求。项目配置没有这个键、或根本解析不了时，内建数值仍然只作建议。键存在但不是正整数时会直接让本次调用失败，而不是被忽略。

### 脚本与时长

镜头使用连续编号的 `【镜头N】` 块。可选 `时长：N秒` 声明安全正整数时长，优先于估算。省略时，有发声镜按 `max(1, ceil(有效字 / 9))`；无声镜按 `动作复杂度：简单/一般/较复杂/复杂`（1/2/3/4 秒），再回退到配置默认值。有效字数汉字、拉丁字母与数字，不数标点与空格。明确时长行不进入 matched 镜头的画面提示词。

结果区分 `failures` 与 `warnings`；只有失败阻止打包方案与写入。

| 检查 | 结果 |
|---|---|
| 超过 15 或 36 有效字；声明时长偏离估算 | 警告：核对节奏与实际发声，不强制拆镜 |
| 超过项目 `project_config.json` 里声明的 `delivery.max_effective_chars_per_shot` | 失败（`speech_exceeds_project_limit`）：按原文语义拆句，或改掉该项目的这条要求 |
| 旁白/心声声明 | 警告；以 `vo` 保留包括冒号在内的完整正文，用 `说话人` 指定发声角色 |
| 缺少建议的写实风格或固定负面词 | 警告；不自动补入任何一句 |
| 画面正文或台词里的秒数表达 | 警告；保留文字，不从正文推导时长 |
| 缺少镜头块、编号不连续、明确时长格式错误 | 失败 |
| 空/占位台词、多条台词、action 同时带台词 | 失败；不静默丢弃含糊的发声内容 |
| 无声镜复杂度未知或人物占位 | 失败 |
| 台词与动作复杂度并存 | 警告：明确时长优先；否则复核发声估算时长 |
| 明确场景未登记、绑定资产未确认或不完整 | 失败 |
| 未绑定场景 | 警告 |
| 单个不可拆镜头超过 `max_submit_seconds - 1` | 失败（`shot_exceeds_package_budget`），绝不截断镜头 |

打包保留完整连续镜头，在场景变化或 `子任务边界：是` 时切包，并确保内容加一秒收束不超过明确预算。提交前用实际分镜核对 `submit_seconds`；编译不会修改分镜已存时长。

### 文件

编译写入 `prompts/<episode>.txt`、`matches/<episode>.matched.json`，以及含 `package.json`、`shot_script.txt`、`matched.json`、`episode.txt` 和本地绑定资产的 `episode_packages/<episode>/`。集号补成两位。提示词文件是源文件副本；matched 镜头画面去掉时长字段。分集正文或本地资产文件缺失会在写入前失败。结果列出全部写入路径、逐镜时长、包时长与有序素材键。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

解析器收集结构失败与创作警告；资产绑定检查清单；打包器执行明确的内容预算。注册工具通过校验与编译共用的规范 JSON 报告返回这些问题。见 [`src/script.ts`](src/script.ts)、[`src/assets.ts`](src/assets.ts)、[`src/episode.ts`](src/episode.ts) 与 [`src/index.ts`](src/index.ts)。不发布运行时不变式伴随组件：本包没有在调用间独立变化的观测。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### `drama_shot` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shot-script)记录方法 schema。结果暴露 `shots`、`packages`、`failures`、`warnings`、`written` 与汇总计数。警告带可执行建议，从不要求删改台词原文。`duration_source: declared` 表示明确声明的时长。

#### Token 影响

schema 固定；结果随镜头、包与问题数增长。失败时不打包、不写入，但保留诊断行。

#### KV Cache 影响

工具结果追加，不改写已有消息。工具描述或 schema 改动会改变可复用请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 编译只在本地进行。调用方提供已确认的分镜预算；计费提交必须独立校验实际模型设置与主体身份。
- 估算不是实测音频时间。最终剪辑交付前核对录制的发声。
- 资产匹配依据字段与正文中的清单名字。未匹配人物名不报错；本工具不核验远端项目归属。
- 场景是连续性键；时间/服装变化需要明确切包标记。
- 写入前会预检，但不是跨并发进程的事务。

<a id="dev-note"></a>
### 开发备注

无。

---
description: "配置可多重归属的能力组、按需工具发现、中英文元数据检索及随会话恢复的加载状态，同时保持权限不变。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discovery

[English](README.md) | 中文

## 概述

让专业工具定义不进入初始请求，同时向 agent（智能体）展示简短的获准能力目录与发现指引。配置常驻工具，浏览能力组或以中文、英文搜索元数据，并在下一步展示匹配定义。成功发现的加载状态可随会话恢复，不会增加权限。发现会增加一次搜索步骤，字面匹配也不保证找到最合适的能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 `tools`、`agents` 与 `sessionProjections` 的 Host 组合中统一挂载本插件一次。它注册 `tool_search` 与 `tool_context`，并通过[工具注册表](../tools/README.zh.md#select-model-facing-definitions)选择模型可见定义；不会替换工具实现或授权。

### 配置常驻工具与能力组

```yaml
- id: tool-discovery
  name: '@deepseek-ai/dsh-tool-discovery'
  config:
    alwaysLoad: [read, write, edit, skill]
    keywords:
      video_inspect: [抽帧, 人物动作, 切镜]
    capabilities:
      - id: video
        title: 视频理解
        description: 提取对白、查看画面与人物动作
        tools: [audio_transcribe, video_inspect, video_ocr]
      - id: screenplay
        title: 剧本与分镜
        description: 编写剧本、核对动作与整理分镜
        tools: [manuscript_revision, drama_*, video_inspect]
```

`alwaysLoad` 使用精确工具名，可以列出提供方稍后才会注册的名称。`tool_search` 与 `tool_context` 始终包含在内。只有调用 agent 当前获准使用的工具才会被展示或搜索；在此列出受限工具不会授予访问权限。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `alwaysLoad` | 必填 | 搜索前即展示的定义 |
| `maxResults` | `8` | 单次搜索最多加载的工具数，范围为1至32 |
| `maxDescriptionChars` | `320` | 每项结果描述的 Unicode 字符上限，范围为1至2048 |
| `k1` | `1.2` | BM25 词频饱和参数，范围为0.01至10 |
| `b` | `0.75` | BM25 文档长度归一化参数，范围为0至1 |
| `keywords` | `{}` | 以精确工具名为键配置的附加搜索短语 |
| `capabilities` | `[]` | 可多重归属的能力组，包含 `id`、`title`、`description` 及工具名模式 |
| `maxResultChars` | `6000` | 序列化后的完整 JSON 结果预算，范围为256至65536个字符 |
| `maxDirectoryChars` | `2000` | 初始目录 JSON 预算，不含固定指引，范围为256至16384个字符 |

每个能力组使用非空且唯一的 `id`；`uncategorized` 保留给尚未配置归属的获准延迟工具。其 `tools` 条目可以是精确名称，或末尾带一个 `*` 的前缀；其他位置的通配符会被拒绝。同一工具可以属于多个组，如上述 `video_inspect`。能力组描述用途，不划分权限：全局搜索可跨组进行。目录来自当前获准的注册表，包括稍后注册的工具；未分组的延迟工具自动进入 `uncategorized`，不要求部署方逐项分类。目录不显示空组，各组分别统计匹配工具数。初始发现段展示 id、标题与描述首行预览，不加载工具；它先保留完整分类名称，再分配剩余描述预算，并报告被省略的分类。全局搜索仍覆盖裁短目录中未展示的能力组。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-discovery)是完整配置参考。

### 浏览能力组或搜索工具

`tool_search` 接受可选的 `query`、`capability`、`limit` 及从零开始的 `offset` 参数。查询覆盖获准工具的名称、描述、参数名称与描述、字符串枚举值、配置的关键词及所属能力组的 id 与标题。归一化后精确相同的工具名排在最前，其次是长句中完整提到的工具名和配置的关键词短语。其余结果按字面相关性排序，同分时按名称确定顺序。未匹配时不补入无关工具，agent 可以换词重试。

| 参数 | 结果 |
|---|---|
| 不提供 `query` 和 `capability` | 列出能力组摘要，不加载工具 |
| 仅提供 `capability` | 浏览该组工具，并加载至配置或请求的数量上限 |
| 同时提供 `query` 和 `capability` | 先在该组内搜索，零命中或明确提到其他组的工具名或配置别名时重试全局搜索 |
| 仅提供 `query` | 搜索全部获准工具，包括未分类工具 |

未知能力组 id 会返回可用目录，不加载工具。未配置能力组时，目录通过 `uncategorized` 展示未分组工具，带 query 的搜索覆盖全部获准目录。`limit` 必须在1至 `maxResults` 之间，目录请求也适用。`offset` 默认为零，必须是非负安全整数。浏览和查询可沿用同样的 query 与 capability，使用 `next_offset` 继续翻页；每页仅加载该页返回的工具。目录与配置不变时，结果顺序保持稳定。

结果中的 `loaded` 条目包含名称、有长度限制的描述预览及所属全部能力组 id；`capabilities` 包含目录条目，其字段为 `id`、`title`、`description` 与当前获准的 `tool_count`。`search_scope` 标明 `directory`、`capability` 或 `global`；`global_fallback` 记录因分类零命中或明确提到组外工具名或别名而触发的全局重试。只有部分词语重叠时，不会扩大已有结果的分类搜索。`matched` 统计应用上限前匹配的工具数，`omitted` 统计不在本页的全部匹配工具数，`omitted_capabilities` 统计未返回的目录条目数。序列化后的完整 JSON 保持在 `maxResultChars` 以内；必要时会清空描述或省略条目，保持名称和 JSON 完整。`next_offset` 指向下一页，在最后一条匹配返回后或预算连一条记录都容纳不下时省略。没有条目能放入预算时，应缩小查询范围或提高配置的预算。

只有成功结果中 `loaded` 数组里的名称才会被选中。下一次组装展示这些工具当前的完整定义，包括参数 schema。加载状态在该会话中保留，不会在每次调用后失效。发现本身不执行工具、不改变既有审批，也不阻止已经获准的工具在发现前执行。

### 管理会话加载与 Bot 常驻偏好

`tool_context` 接受 `operation` 及可选的精确名称数组 `tools`。基础工具不能修改。`load` 与 `pin` 要求工具当前获准使用；收起也能删除已存储但暂不可用的名称。修改在下一次请求生效，不执行工具，也不删除模型历史中先前的定义和结果。

| 操作 | 效果 |
|---|---|
| `status` | 查看所选和常驻名称；省略 `tools` |
| `load` | 为当前会话加载名称 |
| `pin` | 加载名称并保存未来会话的常驻偏好 |
| `release` | 删除当前加载及常驻偏好；之后仍可搜索加载 |
| `unpin` | 取消未来会话的常驻偏好，保留当前加载 |

成功回执记录已应用操作及完整的受影响名称。有长度限制的 `loaded`、`pinned` 预览通过 `omitted_loaded`、`omitted_pinned` 统计省略项。如果受影响名称回执本身超过 `maxResultChars`，操作在保存前失败；应减少单次修改的名称。无效或不可用的新增名称及基础工具修改均不会部分应用。

没有外部所有者时，常驻状态由会话记录派生，可随恢复或含历史的分叉保留。要让 Bot 的新会话继承常驻偏好，注册 `ctx.toolDiscovery.registerResidency({ matches, read, write })`。提供方负责验证已存名称及持久化写入。`read(agent)` 返回完整常驻名称；`write(agent, names)` 保存其替换集合。不可用的已存名称保持休眠，不因其他修改而丢失。多个所有者同时匹配会明确失败。注册可撤销；晚注册或外部修改后需调用 `await ctx.toolDiscovery.refresh(agent)`。agent 创建会等待初始读取，在首次组装前生效。所有者写入失败时，工具返回失败结果，当前选择保持不变。

`ctx.toolDiscovery.state(agent)` 返回独立且按当前授权过滤的 `loaded`、`pinned` 数组。服务与目录共享，选择按 agent 隔离，提供方决定各 agent 属于哪个 Bot。角色提示词不会授予工具权限。

### 恢复加载状态并保持隔离

会话投影从成功的搜索和管理结果派生加载与常驻偏好，也支持 PTC 分发。恢复的会话从日志重建这些名称；包含该历史的 fork 会继承它们。新的子会话独立积累发现结果，父 agent 的选择不会限制子 agent 可以加载的能力。展示或执行定义时仍应用当前授权。卸载插件会移除其搜索工具与展示筛选，原有能力继续注册。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

索引以 TypeScript 独立实现标准 BM25，并采用 MIT 许可证。中文分词和标识符归一化支持本地元数据查找，无需额外请求语言模型。搜索读取调用 agent 获准的注册表，在目录未变化时复用索引。会话投影保存已加载名称而非可执行定义，因此当前注册和授权始终决定可用能力。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 搜索工具、配置、持久加载投影与作用域展示 |
| [`src/search.ts`](src/search.ts) | 中英文分词、元数据索引与 BM25 排名 |
| [`src/capabilities.ts`](src/capabilities.ts) | 能力组多重归属与获准目录摘要 |
| [`src/guidance.ts`](src/guidance.ts) | 稳定发现指引与有预算限制的初始目录 |
| [`src/residency.ts`](src/residency.ts) | 按 agent 隔离的常驻服务及可选的 Bot 持久化所有者 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../tools/README.zh.md)——展示选择与执行权限。
- [会话投影](../../session/session-projection/README.zh.md)——从会话事件重建派生状态。
- [LLM 适配器](../../llm/llm/README.zh.md)——提供方各自的工具更新行为。
- [Codex 参考 fork](https://github.com/felir7at62co-wq/codex)——上游架构参考，不是运行时依赖。
- [所参考的 Codex 发现指引](https://github.com/openai/codex/blob/c6fce1caceaae6c4b2896e5c5ae456b5be3bf501/codex-rs/core/src/tools/handlers/tool_search_spec.rs)——发现说明与来源摘要的上游参考；[NOTICE](NOTICE) 记录署名。

-----

<a id="model-experience"></a>
## 模型体验

### 搜索工具与所选定义

#### 模型看到什么

模型初始看到获准的基础工具、`tool_search`、`tool_context`，以及一个 `tools:discovery` 提示词段。该段解释延迟能力，建议在自行编写 shell 或网页替代方案前先搜索，并附有预算限制的获准目录。缺少初始定义或本地脚本不代表能力不存在。工具定义说明查询与浏览操作，不重复目录。搜索结果为下一步选择完整定义；原生 schema 与生成的 PTC SDK 使用相同选择。现有 system-message 日志保留该段以供回放。完整提示词覆盖可抑制该段。

#### Token 影响

当前组装省去未选中的注册表定义。固定指引与有预算限制的目录在首次发现调用前出现。每次目录或发现请求增加一次调用及有预算限制的 JSON 结果；只有发现会在会话中累积已加载定义。所选工具仍保留完整参数 schema。本插件不会删除既有历史。

#### KV Cache 影响

获准目录与配置不变时，加载、常驻和收起工具不会改变发现段。权限或能力元数据变化可能更新该段。所选定义仍会改变请求头；缓存复用取决于模型适配器，本插件不保证跨提供方仅追加更新或保留缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制区分工具发现、访问控制与语义任务路由。

- **仅筛选注册表投影：** 独立贡献的系统提示词段与工具 schema 提供方不会被过滤，因此单靠工具发现无法移除全部无关说明。
- **字面检索：** 中文分词、名称、能力组元数据与关键词有助于匹配，但不能证明语义相关或任务完成；agent 可能需要换词搜索。
- **agent 自主选择：** 发现指引不强制搜索、不阻止 shell 使用，也不证明任务准确。加载状态持续到 agent 主动收起；插件不自动分类工作阶段。Bot 跨会话常驻偏好需要注册持久化所有者。
- **缓存取决于提供方：** 初始定义减少不能证明所有模型路由的总费用、耗时或缓存复用都会改善。
- **元数据生命周期：** 恢复的名称使用当前定义；投影不会冻结旧 schema，也不会恢复已移除的工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

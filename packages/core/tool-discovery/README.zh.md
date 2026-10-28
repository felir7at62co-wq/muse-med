---
description: "配置可多重归属的能力组、按需工具发现、中英文元数据检索及随会话恢复的加载状态，同时保持权限不变。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discovery

[English](README.md) | 中文

## 概述

让专业工具定义不进入初始请求，同时允许 agent（智能体）在需要时自行查找并加载。配置常驻工具，浏览能力组或以中文、英文搜索获准元数据，并在下一步展示匹配定义。成功发现的加载状态可随会话恢复，不会增加权限。发现会增加一次搜索步骤，字面匹配也不保证找到最合适的能力。

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
        tools: [manuscript_work, drama_*, video_inspect]
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

每个能力组使用非空且唯一的 `id`。其 `tools` 条目可以是精确名称，或末尾带一个 `*` 的前缀；其他位置的通配符会被拒绝。同一工具可以属于多个组，如上述 `video_inspect`。能力组描述用途，不划分权限：全局搜索可跨组进行，未分类的获准工具仍可被搜索。目录不显示当前没有获准工具的组，各组分别统计匹配工具数。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-discovery)是完整配置参考。

### 浏览能力组或搜索工具

`tool_search` 接受可选的 `query`、`capability` 和 `limit` 参数。查询覆盖获准工具的名称、描述、参数名称与描述、字符串枚举值、配置的关键词及所属能力组的 id 与标题。归一化后精确相同的工具名优先；其余结果按字面相关性排序，同分时按名称确定顺序。未匹配时不补入无关工具，agent 可以换词重试。

| 参数 | 结果 |
|---|---|
| 不提供 `query` 和 `capability` | 列出能力组摘要，不加载工具 |
| 仅提供 `capability` | 浏览该组工具，并加载至配置或请求的数量上限 |
| 同时提供 `query` 和 `capability` | 在该组内搜索并加载匹配工具 |
| 仅提供 `query` | 搜索全部获准工具，包括未分类工具 |

未知能力组 id 会返回可用目录，不加载工具。未配置能力组时，带 query 的搜索仍覆盖全部获准目录。`limit` 必须在1至 `maxResults` 之间，目录请求也适用。

结果中的 `loaded` 条目包含名称、有长度限制的描述预览及所属全部能力组 id；`capabilities` 包含目录条目，其字段为 `id`、`title`、`description` 与当前获准的 `tool_count`。`matched` 统计应用上限前匹配的工具数，`omitted` 统计未返回的匹配工具数，`omitted_capabilities` 统计未返回的目录条目数。序列化后的完整 JSON 保持在 `maxResultChars` 以内；必要时会清空描述或省略条目，保持名称和 JSON 完整。结果有省略时，应缩小查询范围。

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
| [`src/residency.ts`](src/residency.ts) | 按 agent 隔离的常驻服务及可选的 Bot 持久化所有者 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../tools/README.zh.md)——展示选择与执行权限。
- [会话投影](../../session/session-projection/README.zh.md)——从会话事件重建派生状态。
- [LLM 适配器](../../llm/llm/README.zh.md)——提供方各自的工具更新行为。
- [Codex 参考 fork](https://github.com/felir7at62co-wq/codex)——上游架构参考，不是运行时依赖。
- [所参考的 Codex 搜索处理器](https://github.com/openai/codex/blob/7ac6081623928adead75caa2882e307444edad82/codex-rs/core/src/tools/handlers/tool_search.rs)——已检查的上游实现；本包未内置该 Rust 源码副本。

-----

<a id="model-experience"></a>
## 模型体验

### 搜索工具与所选定义

#### 模型看到什么

模型初始看到获准的基础工具、`tool_search` 与 `tool_context`，其定义说明能力组浏览、跨组查询与下一步加载方式。目录调用返回能力组摘要；搜索或组内浏览返回选中的名称、描述、能力组归属及省略计数。后续请求在基础工具之外，展示已加载或设为常驻的定义；管理操作可再次收起它们。原生 schema 与生成的 PTC SDK 声明使用相同选择。独立提示词段保持不变。

#### Token 影响

当前组装省去未选中的注册表定义。每次目录或发现请求增加一次调用及有预算限制的 JSON 结果；只有发现会在会话中累积已加载定义。所选工具仍保留完整参数 schema。本插件不会删除既有历史。

#### KV Cache 影响

所选集合稳定时，定义保持稳定；发现工具会改变后续请求头。缓存复用取决于当前模型适配器对工具更新的支持；本插件不保证跨提供方仅追加更新或保留缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制区分工具发现、访问控制与语义任务路由。

- **仅筛选注册表投影：** 独立贡献的系统提示词段与工具 schema 提供方不会被过滤，因此单靠工具发现无法移除全部无关说明。
- **字面检索：** 中文分词、名称、能力组元数据与关键词有助于匹配，但不能证明语义相关或任务完成；agent 可能需要换词搜索。
- **agent 自主选择：** 加载状态持续到 agent 主动收起；插件不通过自动阶段分类替 agent 选工具。Bot 跨会话常驻偏好需要注册持久化所有者。
- **缓存取决于提供方：** 初始定义减少不能证明所有模型路由的总费用、耗时或缓存复用都会改善。
- **元数据生命周期：** 恢复的名称使用当前定义；投影不会冻结旧 schema，也不会恢复已移除的工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

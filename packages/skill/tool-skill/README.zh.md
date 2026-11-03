---
description: "面向模型的 skill（技能）目录与加载工具，供希望了解 agent（智能体）看到的内容或配置会话 skill 目录的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

[English](README.md) | 中文

## 概述

agent 可以在会话期间发现并加载 skill。如果存在模型可调用 skill 且 `skill` 工具可见，持久目录会在首次请求前列出名称与有长度上限的描述。目录默认完整；可选的来源限额只筛选摘要，不限制调用权限。用户可以用 `/name` 调用用户可调用的 skill，把完整指令注入该步骤。条目或展示模式变化会追加替换目录；空目录会停用旧名称。

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

与 skill 注册表一起挂载该插件，即可让 agent 拥有会话 skill 目录和 `skill` 加载工具。它需要 `ctx.agents`、`ctx.tools` 与 `ctx.skills`。

### 何时选择

当 agent 应在会话期间发现并加载 skill 时使用它。当 skill 加载由其他消费方处理或完全不需要时，请跳过——没有它，提供方与注册表仍可工作，但不会有任何东西为模型渲染目录或工具。

### 挂载与配置

与 skill 注册表和至少一个提供方一起加载该插件。下方配置项控制目录描述长度、可选的来源限额与作用域 loader 的目录所有权。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | 会话目录中渲染的规范化描述最大长度；最小为 3 |
| `scopedCatalogOwner` | `false` | 让本作用域 loader 在其他 tool-skill 实例存在时拥有自己的目录，并在发现结束后复核其可见性 |
| `catalogSourceLimits` | `{}` | 按精确 skill 来源设置展示摘要的可选正整数限额；未指定的来源不设限额 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-skill)是每个受支持字段的穷尽式真源。

来源限额需要显式启用。[Muse Desktop 组合](../../../apps/desktop-host/config/desktop.cordis.patch.yml)设置 `catalogSourceLimits: { muse-market: 3 }`，因此最多展示三条市场摘要，同时保留其他来源中所有符合条件的摘要。它限制的是模型目录展示，不是权限：工具仍可按精确名称加载未列出的模型可调用 skill。面向用户的 [`skills/list` 目录](../../api/session-controller/README.zh.md)仍完整列出会话中的用户可调用 skill，不应用这些限额。零、负数和小数限额会在配置校验时失败。

### 模型得到什么

- **会话目录。** 当存在模型可调用 skill 且 `skill` 工具可见时，agent 会在首次请求前收到一条持久的用户角色消息，列出选中的 skill 名称与有长度上限的描述；该消息告诉模型在着手任务前先用工具加载 skill，且绝不能仅凭摘要推断指令。未设置来源限额时，所有符合条件的摘要都会选中。
- **加载工具。** 模型以精确的 skill 名称调用 `skill`，并收到完整指令正文以及规范的 `<skill_content>` 块中的资源指引；该结果作为普通工具历史保留。
- **用户显式调用。** 本插件的精确 `skill` 工具可见时，直接用户输入中的 `/name` token 若指名某个用户可调用 skill，会把该 skill 的指令注入该步骤，而无需模型自行加载。
- **实时目录更新。** 后续成员关系、描述、可见性、任务选取或展示模式变化会追加替换目录；删除全部 skill 时会追加空目录，停用较早的名称。有限额目录会明确说明条目是选出的摘要，而不是完整的权限列表。

### 可观察的成功与失败

加载列出的 skill 会返回其完整指令；无论加载来自工具还是用户的显式调用，模型看到的都是同一种规范形态。无效名称会报告 `Error: invalid skill name "<name>"`，未知名称会报告该 skill 未知或已不可用，被禁用模型调用的 skill 会报告其不可用于模型调用。如果从未发布过目录，并且不存在模型可调用 skill，或 `skill` 工具被隐藏或遮蔽，则会整体省略目录；目录发布后，无论可见性丧失——`skill` 工具被隐藏或被同名作用域工具遮蔽——还是删除全部 skill，都会改为追加空目录来停用旧名称。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释目录与调用边界如何构建；可观察行为已在[使用本包](#use-this-package)和下方模型体验章节中完整说明。

### 设计理念

目录是一种持久投影，其 digest 覆盖已发布条目和有限额展示模式，而不包含渲染后的正文。消费方读取已记录条目，不解析 `<available_skills>`。工具结果与用户显式注入共用 `dsh-skill` 的 `renderSkillContent` 规范渲染，因此两条加载路径会生成相同的 `<skill_content>` 指令。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、目录与手势 pre-step 监听器、渲染与 digest |
| [`src/catalog-selection.ts`](src/catalog-selection.ts) | 按来源限额筛选摘要，以及共享的显式手势解析器 |

### 目录生命周期

在每次符合条件的 `agent/pre-step`，插件都会快照调用会话的 skill，检查 `skill` 工具的精确可见性，过滤出模型可调用的 skill，再应用已配置的来源限额。它把条目和展示模式与会话日志中最新可见的 `skill-catalog` 消息做比较。digest 变化时，会向 `enter` 决策贡献一条持久替换；空替换会显式停用较早的名称。提供方快照不完整时会保留仍可见的最后一份可用目录。没有可用目录时，准备阶段会在派发模型请求前失败；用户下次重试会重新尝试发现。

可见性检查比较已注册的精确工具定义，因此无关的作用域内同名遮蔽项会同时移除 schema 及其指引。启用 `scopedCatalogOwner: true` 的可见活跃 loader 拥有其注册表的目录，并在发现结束后复核可见性；其他实例不会移除该目录。未显式启用时，祖先实例会把嵌套 loader 视作同名遮蔽项。该插件既可全局挂载，也可挂在单个 agent 的组合内。

配置来源限额时，持久来源会携带可选的 `bounded: true`，即使所有摘要都能容纳也一样。该字段缺省时表示完整目录，并兼容较早的记录。其他持久值不会被视为可用目录。切换有限额模式时，即使条目没有变化，也会重新发布目录；[持久化确认记录](../../../docs/persistence-changes/2026-11-02-bounded-skill-catalog.zh.md)说明了这个可选字段的兼容性。

### 摘要选取

每个有限额来源独立筛选。最近一条已接受的直接用户消息提供词面意图。该消息中的显式 `/name` 手势优先，随后根据名称和描述的确定性匹配选取其余摘要。只有工具续步时，保留最近一份持久目录中仍符合条件的名称，并按注册表顺序补齐空位，即使压缩隐藏了原始用户消息也不漂移。没有既有目录时，才回退到可见的直接用户历史。匹配会规范化大小写和字符宽度，并包含相邻汉字对；同分项和最终目录保持注册表顺序。Host 注入和助手文本不会提供排序意图。选取不会加载正文、进行语义搜索或依赖进程内状态，因此恢复相同历史与注册表会得到相同结果。

### 调用边界

`/name` 手势监听器仅在本插件的精确 `skill` 定义可见时扫描每条已认领的直接用户消息：若某个以空白为界、指名工作区目录中用户可调用 skill 的 token 出现，则把同一份 `<skill_content>` 渲染作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后。来源限额不限制显式调用正文的数量。监听器在加载后重新检查工具可见性，使被隐藏或遮蔽的消费方无法注入陈旧指令。未知名称与用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录与 `skill` 工具永不暴露这类 skill。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从目录背后的注册表词汇逐步进入精确工具 schema 与设计依据。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——目录背后的注册表与提供方词汇。
- [skill 包](../skill/README.zh.md)——注册表与共享的 `renderSkillContent` 渲染。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)——模型接收的精确 `skill` schema。
- [有限额目录持久化确认记录](../../../docs/persistence-changes/2026-11-02-bounded-skill-catalog.zh.md)——可选展示模式元数据与较早记录的兼容性。
- [用户显式 skill 调用 Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md)——`/name` 手势设计。

-----

<a id="model-experience"></a>
## 模型体验

### 会话目录

#### 模型看到什么

如果存在模型可调用 skill，且可见的正是这个 `skill` 工具，agent 会在第一个请求前收到一条持久的用户角色目录。下方默认模板包含所有符合条件的摘要。配置来源限额时，改用有限额模板，为每条选中摘要渲染一条随数据而定的目录行。变化会追加替换目录；空替换会显式停用较早的名称。每个模板都会告诉模型遵循用户调用的 `<skill_content>` 块，而不是再次加载该 skill。

##### Skill 目录模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

##### 有限额初始目录模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following is a selected set of skill summaries for this task, not the complete directory of permitted skills:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
Other permitted skills may be loaded by an exact name supplied by the user. Do not invent skill names; ask the user to choose another skill if these summaries do not match the task.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

##### 有限额替换目录模板

```markdown
<system-reminder>
The selected skill summaries changed. This selection replaces earlier recommended summaries; it is not the complete directory of permitted skills:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

These are selected summaries, not all permitted skills. Use a listed skill when it matches the task; another permitted skill may be loaded by an exact name supplied by the user. Do not invent skill names.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

##### 清空后的有限额替换目录模板

```markdown
<system-reminder>
The selected skill summaries changed. This selection replaces earlier recommended summaries; it is not the complete directory of permitted skills:

<available_skills>
</available_skills>

No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.
A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.
</system-reminder>
```

#### Token 影响

重复输入成本随展示摘要数量和 `catalogDescriptionMaxLength` 增长；来源限额只约束各自的摘要，不约束其他来源或已加载正文。列表为空或工具被隐藏或遮蔽时，不会发送初始目录 token。选取结果或展示模式变化时，会添加一条保留的替换消息。

#### KV Cache 影响

初始持久目录位于现有可重用前缀之后。条目或有限额模式变化时追加历史，保留较早的可重用 token，并形成新后缀。未变化的工具续步和恢复历史不会重复发布同一目录。digest 变化可能从新追加的目录位置起影响缓存重用。

### 工具 schema

#### 模型看到什么

默认情况下，模型会看到生成的 [`skill` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)。有限额模式将工具描述改为 `Load the full instructions for a permitted skill. Use an exact name from the selected summaries or supplied by the user before acting on the task.`，并将 `name` 参数描述改为 `The exact skill name from a listed summary or supplied by the user.`。接受的参数和调用权限保持不变。

#### Token 影响

工具可见时，每次请求都有固定的 schema token 开销。

#### KV Cache 影响

工具定义和可见性不变时，前缀稳定。遮蔽、限制或插件生命周期变更可能从该 schema 起使重用失效。

### 工具结果

#### 模型看到什么

成功调用使用下方结果模板，以及提供方管理的资源指引、目录资源指引、URL 资源指引或不透明资源指引。

##### Skill 结果模板

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### 提供方管理的资源指引

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### 目录资源指引

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL 资源指引

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### 不透明资源指引

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token 影响

已加载指令是取决于数据的工具结果 token，并在后续步骤中重新发送，直到压缩；不会制作重复的 `agent.inject()` 副本。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到什么

无效或陈旧选择会精确返回 `Error: invalid skill name "<name>"`、`Error: skill "<name>" is unknown or no longer available` 或 `Error: skill "<name>" is not available for model invocation`。提供方抛出的查找文本取决于数据，并套用同一个 `Error: <message>` 包装层。

#### Token 影响

只有失败调用会添加这些已保留 token。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 用户显式调用注入

#### 模型看到什么

已认领用户消息中任意位置、以空白为界、指名工作区目录中某个用户可调用 skill 的 `/name` token，会把该 skill 的完整 `<skill_content>` 渲染（与上文结果模板完全相同的形态）作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后——背景在前，模型要着手处理的材料在最后。本插件的精确 `skill` 工具须在整个加载期间保持可见；被隐藏或被同名工具遮蔽时不贡献调用指令。只扫描直接的用户输入，检查在已加载定义上进行，未知名称和用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录和 `skill` 工具永不暴露这类 skill；目录的结尾一句会告诉模型遵循注入块，而不是重新加载它。

#### Token 影响

每次手势会把一份渲染后的 skill 正文作为注入上下文加进该轮次——尺寸与同一 skill 的工具结果相同，该成本会随用户请求必然产生，而非由模型自行决定。同一步骤内对同一 skill 的重复手势只注入一次。目录来源限额不限制这些正文。

#### KV Cache 影响

仅追加；注入落在该步骤的消息批次中、可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明目录或加载器何时不合适。它们是当前包约束，不是任务积压。

- **目录省略 `whenToUse`、来源和提供方元数据**——路由只基于名称和有长度上限的描述；`whenToUse` 仍是提供方元数据，加载后的包装层也不渲染它。
- **有限额选取是词面匹配，不是语义检索**——同义词或间接任务描述可能使相关摘要未被选中。工具不提供目录搜索操作；用户可以从完整的人类目录选取 skill，或给出精确名称。展示限额不是调用授权。
- **已加载指令正文没有大小上限**——提供方可返回足以占用大量下一步上下文的 skill；只有目录描述会被截断。
- **资源是指引，而非附件**——工具报告基础目录/URL/不透明提示，但既不列举也不为模型获取引用文件。
- **加载是一次性文本**——远程提供方缓慢或 skill 正文很大时，不提供部分内容、流式输出或缓存内容句柄。
- **目录替换采用全量列表**——选取结果、描述或有限额模式变化时，会追加当前展示的每条摘要；token 成本仍与该目录大小成正比。
- **正文不做版本化**——仅修改正文不会改变目录 digest，也不会通知模型；后续工具调用会读取提供方的当前内容，而先前工具结果仍是历史事实。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

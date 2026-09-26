---
description: "组合守卫插件：当一次热加载把正在运行的会话已有的工具撤掉时立刻发现并报告，供用户与维护者诊断丢失了工具的会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-composition-guard

[English](README.md) | 中文

## 概述

用这个包，可以在一个正在运行的会话悄悄失去它的组装所赋予的工具时立刻知道。DSH 可以热加载 profile 补丁；当某个 Host 平面配置行在一个运行中的 Host 之下被改动时，改动之前就已发布的 agent 可能失去它通过作用域链解析到的工具，而 DSH 从不会在进程内重新组装一个常驻挂载。本守卫把这一种形态——工具没了，而该 agent 的预设没有变——说出来：一行日志，外加一条进入该对话的消息，并写明恢复方式：重启宿主。它无法把工具放回去。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 Host 平面挂载一次即可，没有需要学习的东西：它只是看着，直到一次组合变更把工具从一个正在运行的会话里撤走才会开口。

### When to choose it

当部署会在会话仍在运行时重载组合时选它——随附的 `web` profile 默认就是 live 重载补丁——而一个悄悄失去文件或 shell 工具的会话若要等到模型报告"什么也编辑不了"才被发现，就太晚了。不要指望它做修复：进程内不会重新组装一个已经跑过回合的 agent，因此本守卫的全部贡献就是把发生了什么、该怎么办告诉某个人。

### Setting it up

把它挂到 Host 组装里，和已经在那里随附的守卫放在一起：

```yaml
- name: '@deepseek-ai/dsh-composition-guard'
  config:
    announceInSession: true   # also deliver the notice into the affected conversation
    maxAgentsPerUpdate: 64    # cap on live agents inspected per loader update
```

| Field | Default | Meaning |
|---|---|---|
| `announceInSession` | `true` | 受影响会话是否同时在自己的对话里收到通知；日志行始终会写 |
| `maxAgentsPerUpdate` | `64` | 一次 loader 更新检查多少个存活 agent；超出上限的 agent 由下一次更新检查 |

非法的 `maxAgentsPerUpdate` 会在加载时以明确报错失败，而不会回落到默认值。两个字段都带 JSDoc（见 {@link Config}），生成配置目录读的就是它。

### What you get

当一次 live 重载从一个预设未变的会话里撤走工具时，宿主会记下一行日志，写明会话、它的预设，以及缺失的工具名；同时该对话会收到一条简短通知，写明缺少哪些工具以及恢复方式。同一次回归只播报一次：后续更新保持沉默，直到名字回来；名字回来之后，再发生回归就又是新消息了。换了预设的会话属于合法的重新组装，永远不会被报告——新的组装直接成为基线。

把它挂进一个已经在运行的宿主正是它的用途：守卫激活时已存在的会话，会以它们当下的组装被收养，因此从那一刻起就在被看着。守卫刻意唯一不做的事，是播报一个它在到达时就已经不完整的组装：它没有更早的观测可供比较，而一条每次启动都会触发的通知比沉默更糟。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本节解释守卫如何记录基线、何时重新比对、以及如何报告；可观察行为已在 [Use this package](#use-this-package) 中完整覆盖。

### Design philosophy

守卫建立在五条承诺之上：

- **只检测，绝不修复。** 框架不会重新组装一个已存在的常驻挂载，因此诚实的贡献就是一份报告；一个假装修复了组装的守卫，只会成为关于该组装的第二个真相来源。
- **基线取自创建派发。** `agent/created` 在工厂 setup 组装完该 agent 之后、任何东西启动它之前运行，所以那里记录的名字就是该 agent 的历史将要被产出时所用的组装。
- **收养已经在运行的东西。** 守卫是被挂进一个运行中的宿主的，因此激活时会枚举 `ctx.agents.list()` 并为每个已存在的 agent 记录基线，并把它们标记为"收养"而非"在本插件之下出生"。
- **只报告无法解释的损失。** 消失的名字只有在所组装预设未变时才被报告；预设变了就是一次重新组装，守卫改为重建基线。
- **容错一切失败。** 一个把宿主搞坏的守卫比它要报告的那个缺陷更糟，因此每次检查都被包裹，并且每个 agent 至多自我报告一次。

### How a scope's visible tools are read

一个 agent 的可见工具名来自 `ctx.tools.schemas(scope)`——注册表对某个作用域可见工具的文档化枚举，每个可见名一个 schema，且已计入 restriction、作用域遮蔽与 PTC 传输层，正是模型将会被提供的那些。它的参数是 `ScopeKey` 而不是 Agent：守卫传入 `scopeOf(agent.ctx)`，即该 agent 自己的键，因此读到的是该 agent 看到的视图，而不是进程全局视图。没有作用域的 agent 没有可比的 agent 视图，因此被跳过，而不是拿去和全局层比较。

### When the comparison runs

触发点是 loader 的配置更新 `ctx.on('internal/update', …)`——`dsh-app-boot` 与 Loader 在某个 fiber 的配置被应用、其插件在背后重启时观察的同一条瀑布。守卫以 global 注册，因为被改动的行不一定是它的祖先；它也绝不 prepend，因此位于 Cordis 自己的 `internal/update` 链式驱动器下游：`next()` 于是返回这次更新所驱动的重启，比对看到的是重载之后的状态，而不是重载即将替换掉的状态。失败的重载同样会扫描，因为被撤走的行一样是没了，恢复方式也一样。

两个细节让这次检查保持诚实。比对是逐 agent 对它自己的基线进行的，绝不拿另一个 agent 作比；预设则在每次比对时从 roster 重新读取（`ctx.get('agentPresets')?.composedPreset(agent.ctx)`，可选，因为无 roster 的部署也是一种受支持的组装）。记录以会话 id 为键，并在注册表发布 `agent/disposed` 时删除；整份记录集由守卫自己的 context effect 持有，因此卸载该行——包括整树拆除——会把它丢掉。

### Reporting once per regression

每条记录带着"当前这次回归已经播报过的名字"。一次没发现缺失的比对会重新武装该记录，因此之后再发生回归还会播报；一次发现同一回归已播报过的比对则静默返回。只有在某个渠道接受之后才会标记为已报告，因此一条谁也没收到的播报会在下一次更新时重试，而不是被当作已送达。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、基线记录、收养、`internal/update` 扫描，以及两条播报渠道 |
| [`src/baseline.ts`](src/baseline.ts) | 逐运行时记录集及其状态迁移；打进包入口，因此伴生检查共享它而不是第二份拷贝 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生：每个面向模型组装的 agent 都必须是已组装的守卫握有基线的那个 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当包级契约不够用时读这些页面。它们从守卫所读的作用域模型，走到它存在的理由，再到守卫家族地图。

- [Tools subsystem reference](../../../docs/subsystems/tools.zh.md) — `ctx.tools.schemas()` 所解析的注册表视图与作用域层。
- [Agent presets package](../../preset/agent-presets/README.zh.md) — 被冻结的 agent 可能失去其注册的常驻挂载。
- [Live-reload port traps Agent Note](../../../.agents/notes/implemented/architecture/2026-09-17-product-capability-plane-and-port-traps.zh.md) — 实测到的缺陷、其证据，以及为什么恢复方式是重启。
- [Composition guard Agent Note](../../../.agents/notes/implemented/architecture/2026-09-17-composition-guard-detects-live-tool-withdrawal.zh.md) — 本守卫能做与不能做什么，以及它否决的备选方案。
- [guard group map](../README.zh.md) — 兄弟守卫包与 loop-hygiene 家族。

-----

<a id="model-experience"></a>
## Model Experience

### Withdrawn-composition notice

#### What the model sees

当一次 live 组合重载从一个预设未变的会话里撤走工具时，该 agent 的对话会收到一条 user 角色的消息，归属本插件（`{ kind: 'plugin', plugin: 'composition-guard', form: 'notice' }`）。缺失的工具名依赖数据，其余文字固定。折叠后的记录行显示有界摘要 `工具被热加载撤掉：缺少 <toolNames>`。

##### Withdrawn-composition notice

```markdown
这个会话的部分工具被一次配置热加载撤掉了（缺少：<toolNames>）。**重启一次 DSH 宿主**即可恢复；已经打开的会话不方便重启时，可新开一个会话继续。
```

#### Token effect

在检测到回归之前是零 token：本插件不添加提示词段落、不添加工具 schema，也不向健康会话添加任何文字。一次检测到的回归添加一条简短的保留消息，最多列出被撤走的工具名；再次武装后的回归再多一条。

#### KV Cache effect

追加式；该通知添加在可复用的请求前缀之后，不会让已有的 KV Cache 条目失效。设置 `announceInSession: false` 会完全去掉这条消息，只留下日志行作为唯一记录。

## Known Limitations and Deferred Work

这些限制界定了本守卫是什么、不是什么。它们是当前的包约束，不是任务清单。

- **只检测，不修复** — 框架不会重新组装一个已存在的常驻挂载，因此被撤走工具的会话会一直如此，直到宿主重启。守卫的贡献是报告与写明的恢复方式。
- **激活时就已不完整的组装不会被播报** — 基线来自观测，而守卫收养的 agent 没有更早的观测可比。可选的推迟方案是从会话日志记录的请求头重建一份持久预期；守卫刻意不猜，因为每次启动都发通知比沉默更糟。
- **只比较工具名** — 一次从被冻结 agent 撤走提示词段落、skill 或 projection 的重载不会被报告；把同名工具换成另一个实现的重载也看不见。
- **每个运行时只挂一个守卫行** — 第二个实例的基线是同一个问题的第二个答案，因此最新记录替换前一个，伴生检查只读最新的那份。
- **只在内存中** — 基线随宿主进程生灭，因此一次重启会让每个 agent 从一次全新观测开始。
- **通知文本是中文** — 它是写给那个失去工具的人看的；仓库的客户端文案归 locale 所有，而这是发给对话的宿主侧消息。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：未决的开放问题与方向。它明确非权威——已发布的行为、限制与已接受的理据在上文各节、包代码与所链接的 Agent Note 中。

底层缺陷的持久修复——live 重载撤走 Host 平面配置行却不给已经物化的 agent 重新注册——属于 harness 核心对重载路径的补丁，不由本包拥有。如果那个补丁落地，本守卫的检测就从一个唯一信号变成一个范围更窄的兜底。

`tools/change` 是注册表自己关于"某作用域可见集合变了"的通知，它恰好也会在本守卫关心的撤走发生时触发。它被刻意不作为触发点：它也会为每一次作用域内注册与遮蔽而触发，因此拿它做比对会远比"必须被解释的那次更新"跑得频繁。如果某条重载路径不再发出 `internal/update`，再重新考虑触发点。

本 README 尚未链接本包在生成配置目录中的锚点小节：重新生成该目录目前被若干无关包挡住——它们的配置字段没有 JSDoc 散文，因此锚点还不存在。等 `pnpm run doc-sync` 能干净地重生成配置目录时，再把链接加回来。

</details>

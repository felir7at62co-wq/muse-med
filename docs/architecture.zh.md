# DeepSeek Harness 架构

[English](architecture.md) | 中文

改动 `packages/` 前先阅读本文；若不熟悉 Cordis，请从[入门](cordis-primer.zh.md)或[教程](cordis-tutorial/index.zh.md)开始。

## Cordis

[Cordis](cordis-primer.zh.md) 插件向共享上下文贡献服务、类型化事件和可逆副作用。模型适配器、工具、Session 日志和 agent loop（智能体循环）都是可通过配置替换的插件。

通过挂载插件扩展 dsh，无需修改特权内核。注册会在所属插件卸载时撤销。

## Profile 与组合包

运行中的 `dsh` 是一棵插件树，由启动时按序叠加的各层组合而成。

**profile** 存放在 Harness home 中，列出其组合包、存放已安装的树外插件，并保存用户的 `cordis.patch.yml`。随附模板包括 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp`。

**组合包**分发 Cordis 配置项及其代码，后续层可以对它们应用 patch。

各自的 `package.json` 通过 `dsh.profile` 声明组合包列表，通过 `dsh.bundle` 声明 patch 路径。

[`dsh-base`](../packages/bundle/base/README.zh.md) 为 `web`、`headless`、`sdk` 和 `acp` 提供模型适配器、工具、持久化、沙箱与审批策略、设置、凭据及遥测。它们的后续层分别提供[浏览器应用](../packages/bundle/web-app/README.zh.md)、[无服务器的一次性运行器](../packages/bundle/headless/README.zh.md)、[SDK JSON-RPC 服务器](../packages/bundle/sdk-app/README.zh.md)和[仅用于自动化的 ACP 服务器](../packages/bundle/acp-app/README.zh.md)。[`dsh-sdk-minimal`](../packages/bundle/sdk-minimal/README.zh.md) 则独立拥有完整 SDK 树，不应用 `dsh-base`。

各层依次应用在空条目列表之上：profile 中有序的组合包、其 `cordis.patch.yml`、home patch，最后是 `--patch` overlay。一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。`preset` patch 在目标声明的 `config.plugins` 内应用这些操作，沿用相同的层优先级。

YAML 控制 HMR：base 启用仅监视配置的 `dsh-hmr`；Headless、SDK 和 ACP 禁用它；`sdk-minimal` 不包含它。Profile patch 覆盖这些默认值。HMR 协调监听和重载；启动器提供 profile 数据和就绪信号。

base 提供用于 Web 和 Agent 的[插件管理器](../packages/boot/plugin-manager/README.zh.md)。

要查看你的机器启动的配置树：

```sh
dsh --profile web --dump-config
```

它打印出的任何条目，都可以由你自己的 patch 替换。

组装机制见 [app-boot](../packages/boot/app-boot/README.zh.md#profiles)；配置字段见生成的[配置目录](config-catalog.zh.md)。

## 应用启动

Node 应用通过 `dsh --profile <name>` 或 `dsh <name>` 启动随附 profile。由于 `plugin` 表示管理命令，同名 profile 必须用 `--profile plugin` 选择。TypeScript SDK 从其同版本 `dsh` 依赖选择 `sdk`。自定义组合使用 profile 与有序 patch，而不是另一个可执行文件或内联应用树。同一 launcher 运行仓库自有的 `sdk-minimal` 组合包，不接受调用方提供的 Cordis 配置树。

Vendored CLI、仅用于构建和测试的可执行文件、进程内直接挂载插件以及私有浏览器 WebWorker 预览都不属于 Harness 应用启动器。[`verify-application-entrypoints`](../scripts/verify-application-entrypoints.ts)将每个包 bin、可执行源码、根 demo 以及根脚本 `start:web` 与 `dev:web` 归入显式类别，并拒绝任何绕过 `dsh` 的 Node 应用路径。

Python 运行时 wheel 将 `dsh` 打包为 `deepseek-harness-sdk-runtime-<platform>-<arch>`。客户端默认以显式 Harness home 启动 `dsh --profile sdk`，极简示例选择 `sdk-minimal`。Python 暴露 profile 与有序 patch，而不是完整 Cordis 树；`dsh plugin` 安装持久外部插件。已删除的私有直读配置载体没有兼容 bin 或回退 parser。

## 桌面应用

[Electron 应用](../apps/desktop/README.zh.md)在签名资源中携带精确匹配的 dsh 生产运行时，并拥有保留的 `$DSH_HOME/profiles/desktop`。共享 helper 初始化 profile，协调组合包与依赖，不替换 pnpm 拥有的包。Desktop 与 npm CLI 共享产品数据，但包、启用选择和锁文件独立。内置 CLI 管理 Desktop 插件。

Electron 使用 Electron Node 模式启动私有 Desktop Host。Host 调用共享 CLI profile runner 与完整 Web 应用。窗口立即加载打包 Web 资源，等待启动注入后在同一文档中激活客户端插件。Web 负责 RPC 与流；桌面载体将本地页面连接到已认证的 Host。Node IPC 承载启动注入、就绪、致命错误与关闭。Desktop 默认监听系统分配的端口，profile 配置可覆盖。壳拥有的 UI 通过内置 pnpm 执行插件事务，并遵循正常用户与 profile 配置。

## 核心包

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| [`core/session`](subsystems/session.zh.md) | 仅追加的 `SessionEvent` 日志和内存存储 | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.zh.md) | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.zh.md) | 作用域化的工具注册表和带把关的执行流水线 | `ctx.tools` |
| [`core/agent`](subsystems/core.zh.md) | `Agent` 接口、活跃 agent 注册表和 `agent/*` 事件 | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.zh.md) | 实现该接口的默认驱动器 | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.zh.md) | 按 agent 划分作用域的注册原语 | 库，无 ctx 键 |
| [`llm/llm`](subsystems/llm-streaming.zh.md) | 消息与流式词汇表，以及适配器 seam | `ctx.llm` |

<a id="events"></a>

## 事件

事件就是扩展点，而选对事件域是大多数改动的第一个决定。

- **会话事件**是追加到日志并通过 `session/event` 广播的持久事实。当某个事实必须在重新加载后仍然存在时，使用它。
- **Agent 事件**（`agent/*`）携带活跃 `Agent`：inbox、步骤、状态、请求、验证、续跑。要观察或拦截进行中的工作时，使用它。
- **能力事件**无需导入循环即可向某个 seam（`fs/*`、`tools/*`、`telemetry/*`）附加策略和适配器。

AgentLoop 初始化 Agent，失败则回滚，并在启动已排队工作前等待串行 `agent/created`。卸载在 Agent teardown 期间保留所需资源；[agent-loop](../packages/core/agent-loop/README.zh.md#understand-the-implementation)定义顺序。

[事件映射](event-producer-consumer.zh.md)列出每个事件的生产方与消费方。

<a id="turn-flow"></a>

## 轮次流程

一个**步骤**是一次模型请求加上它调用的工具。一个**轮次**包含零个或多个步骤：它在领取首条输入之前打开，并在不再欠下任何工作时关闭。

```text
turn/start
  claim next-step input plus one queued message
  snapshot Session model selection; assemble prompt sections + step-admitted tool schemas
  -> agent/pre-step; project runtime context at fallback
                                     reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     agent/request -> prepareCall (cancellation commits neither system nor users)
     reconcile system/message using the prepared call capability
     append entered messages as user/message; reconcile retained runtime context
     log request/header and request/context as needed
     derive and freeze model history from the log
     stream the bound prepared call -> llm/stream -> agent/assistant-stream start
       agent/assistant-stream chunk*
       assistant/message | assistant/attempt -> agent/assistant-stream end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt` 和 `tool/*` 是持久会话事件；其余是分属三个事件域的实时扩展点。`agent/assistant-stream` 发布进程本地 start、瞬态 chunk 与 end frame。loop 会在 committed end frame 前把完整紧凑 stream 提交为一个 message 或仅日志 attempt；Web Session-follow adapter 是该 live event 唯一的远程消费方。`agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件是 waterfall（瀑布式事件），其监听器必须调用 `next()` 才能委托下去；`agent/turn-stopping` 是 serial 事件，没有 `next()`。

工厂 setup 在 Session 进入 SessionStore 并完成 `session/created` 之后、`agent/created` 之前运行；收尾事件在移除之前提交。

输入通过同一个 inbox 到达驱动器。注入的上下文等待一条唤醒消息。AgentLoop 的持久 `inbox` 投影使待处理输入在没有活跃 Agent 时仍可读取。恢复时先校验已记录消息的 JSON，再重放。Agent 恢复后，负责投递的插件可调用 `wakePending(messageId)`，为已经排队的消息唤醒驱动器，避免重复入队。

循环在组装前将 Session 模型选择快照到 `AssembleContext.modelSelection` 与 `agent/pre-step.modelSelection`；重试保留该选择，省略推理强度时使用适配器默认值。`agent/pre-step` 监听器接纳、改写或拒绝已领取消息；首次领取被拒绝或为空时，关闭不含步骤的持久轮次。enter 决策可设置 `startsRequestSeries`：循环记录新的 `request/header`（原因为 `series`，或在封装同时变化时为携带 `startsSeries: true` 的 `change`）。包装监听器通过 `{ ...decision, messages }` 保留该声明。组装与 `step/start` 之后，已弃用的 `agent/request` hook 在不改变提供方、模型或推理强度选择的前提下调整控制参数，`prepareCall()` 绑定适配器，再提交系统提示词与已接纳用户消息；在任一异步阶段取消都不会提交这两者。提示词准入依据已准备调用的能力，而非先前的 `request/context`。每次尝试刷新已注册运行时事实、协调绑定的提示词、仅接纳一次用户消息并恢复被移除的运行时上下文、按需记录 header/context，再冻结请求并通过绑定调用发起流式请求。重试不重复组装或 `agent/pre-step`。附接后的 surface 替换和图片省略决定开启新请求序列，包括恢复后的首次 pre-step 中发生的替换；未变化的恢复延续序列。系统提示词通过 `system/message` 历史传递：空文本清除提示词，具备能力的路由追加更新，其他路由将其归并到首个系统节点。[Agent-loop](../packages/core/agent-loop/README.zh.md#understand-the-implementation) 说明提示词准入与替换的细节。

循环发送不可变请求，同时保持取消有效，仅对完全冻结的对象复用冻结证据；[agent-loop](../packages/core/agent-loop/README.zh.md) 负责请求构建与取消原因。

失败步骤会[记录缺失的工具结果](../packages/core/agent-loop/README.zh.md#understand-the-implementation)。

详情见[时序图](agent-lifecycle.zh.md)、[工具流水线](tool-execution-pipeline.zh.md)和[取消与错误恢复](subsystems/core.zh.md#the-agent-handle)。

[`ctx.tools.execute()`](subsystems/tools.zh.md) 接收原始调用批次和并发上限。

## 会话日志

会话日志是模型所见上下文的来源。`deriveMessages()` 从中投影出模型历史。每个 `assistant/message` 都嵌入产生其组装内容的精确紧凑带时间 stream；`assistant/attempt` 保留已到达 settlement 的失败、重试、取消与 stream error attempt，且不添加模型历史。fork、恢复、transcript（文本记录）、遥测与持久化都从这些持久 settlement 派生，实时 UI 增量则来自 `agent/assistant-stream`；如果进程在 settlement 前硬中断，则不会留下持久 attempt stream（见[决策](../.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.zh.md)）。

Session 消费方只了解当前逻辑格式。仅 header 的 `stat` 与 `list` 会重新扫描每个 Session 目录，选择数值最高的规范 generation，并在不加载事件或发布后继的情况下转换受支持的历史 header。已存储 Session 的 `open` 选择同一 generation，拒绝未来版本，或只 Decode 并组合一次构建时静态确定的相邻迁移链，再返回经过校验的当前逻辑事件。只读 open 直接使用这份内存结果，不发布后继；写 open 则先编码、校验并在未改变源的旁边排他发布最终版本命名的后继。未被后续事件封住的普通中断尾部仍由句柄消费方修复；只有在后续 `turn/start` 已经封住一种有限的已发布 restart 时，migration 才会插入缺失的 interrupted `turn/end`。JSONL v0 使用 `session.jsonl[.zstd]`，v1 及后续版本使用小写 `session.vN.jsonl[.zstd]`；已提交 generation 路径绝不重命名、替换或删除。JSONL provider 负责物理 framing、压缩、generation 选择与排他发布，每个相邻迁移包只负责一个 `vN -> vN+1` 步骤（[决策](../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)）。

**模型可见即已记录。** 每个模型请求都必须能从日志重建。新增模型可见输入需要会话事件。修改现有消息内容的插件注册[纯消息投影](subsystems/session.zh.md#plugin-owned-message-projections)，独立读取器显式传入相同的处理器。 工具变更不依赖能力；[Session 工具历史](../packages/core/session/README.zh.md)提供提供方声明。

**投影 seam。** `dsh-session-projection` 提供 `ctx.sessionProjections`：已注册单元折叠已提交事件，载体通过 `snapshot()` 读取选定的客户端视图。领域服务等待注册完成，在内部保留句柄，并提供业务方法（[注册生命周期](../packages/session/session-projection/README.zh.md)）。`AgentRegistry` 通过 `turnBoundaryOf(session)` 提供轮次和步骤状态。`AgentLoop` 持有 `modelSelection` 和 inbox 状态（[Loop 生命周期](../packages/core/agent-loop/README.zh.md)）。

[工作目录](subsystems/working-directory.zh.md) 提供用户上下文和执行路径，不改变原始项目标识、沙箱写入根目录或已有进程目录。

## 能力 seam

一个 **seam** 是一项可替换能力，包含三种角色：声明接口的 **Service Definition**、实现它的 **Service Provider**，以及使用它的 **Consumer**（通常是面向模型的工具）。一个包可以合并承担多个角色，但单一角色本身不是 seam；添加一项能力意味着把三者一并设计（[能力图](capability-seams.zh.md)）。

seam 正是替换一个提供方就能改变整个产品的原因。文件系统与进程提供方共享同一个执行世界，因此把它们指向远程沙箱，也就把 Bash、PTY 和 LSP 一并搬了过去，无需提供方专用 fork。[subagent 提供方](subsystems/subagent.zh.md)在同一个接口之后同样千差万别，从新建一个子 agent，到把一个轮次委派给另一个产品。

[实验性 Agent Teams](subsystems/agent-team.zh.md) 通过显式启用的 `ctx.agentTeams`，在可继续 subagent 之上提供持久 roster、任务状态和直接 inbox 消息协作。

## 新行为的归属位置

新行为附加到已有文档记录的扩展点。改动循环本身时，本映射随之更新。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册其适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册；其 schema 加入提示词组装 |
| 让某个会话拥有不同的能力集合 | 组装一个 agent preset；其中的服务行需要 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn 进程 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端和 `dsh-tool-terminal` |
| 添加用户命令 | 在 `ctx.commands` 上注册；它无需模型轮次即可分派 |
| 管理后台任务 | 在 `ctx.jobs` 上注册；`job_*` 工具读取或停止任务 |
| 从外部 webhook 启动 Session | 在 `ctx.webhookRuntime` 上注册可信规则，并挂载提供方适配器 |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在启动进程前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 会停止轮次 |
| 添加模型可见上下文 | 调用 `agent.inject()`；它会落到下一次获准的请求中 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `agent/*` 续跑 |
| 在轮次边界 fork 会话 | `ctx.agents.create({ sessionId, seed, inheritedEventCount, meta: { isSeeded: true } })`——只有经 agent-loop 发布的会话才会持久化 |
| 在新后端存储会话 | 基于共享的句柄脚手架实现 `SessionPersistence`（`create`/`open`/`stat`/`list`/`export`） |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

[扩展实操手册](cookbook/extension-cookbook.zh.md)将功能映射到能力，并索引[包](cookbook/adding-a-package.zh.md)、[工具](cookbook/adding-a-tool.zh.md)、[LLM（大语言模型）适配器](cookbook/adding-an-llm-adapter.zh.md)和[设置页](cookbook/adding-a-settings-card.zh.md)的分步指南。[Conversation 子系统](subsystems/conversation.zh.md)负责 Chat node 组装。

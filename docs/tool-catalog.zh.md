<!-- 英文源文件由 scripts/gen-tool-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-tool-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/tool-catalog.md` 重新记录配对。 -->

# 工具 Schema 目录

[English](tool-catalog.md) | 中文

已发布插件向 `ctx.tools` 提供的所有面向模型的工具：模型通过系统提示词组装获得的 `name`、`description` 和 JSON Schema `parameters`。本目录是[子系统页面](subsystems/core.zh.md)（类型及每页生成的 `cordis-surface` 接线区域）的补充；本页列出的是向 agent（智能体）提供的*工具*。

英文源文件由系统**生成**，并通过 `pnpm run verify-tool-catalog`（`doc-sync`（文档同步门禁）的一部分）验证新鲜度；本中文文件作为经评审对侧通过双语配对维护。与 Cordis 目录（纯源码 AST 处理）不同，英文生成器会在真实上下文中**启动**每个工具插件并读取 `ctx.tools.schemas()`，因为工具 schema 无法通过静态分析完全确定，例如运行时展开的枚举、拼接的描述、由配置决定的名称以及使用原始 JSON Schema 的 MCP 工具。完整性守卫会 glob 匹配 `packages/*/tool-*`；如果生成器的启动 manifest（元数据清单）遗漏任何包，检查就会失败，因此新工具不会在无人察觉的情况下缺少文档。

范围：`packages/*/tool-*` 下已发布的产品工具，以及 `perception-bgm` 等显式列出的工具提供方，每个工具均使用其**默认**配置启动；但如果某个 Config 字段是**必填项**且没有默认值，生成器就必须作出选择，对应包的说明会记录本页展示的是哪个分支。注册的工具**名称**可以是加载时配置，例如 `tool-subagent` 的 `toolName`，因此部署可能以不同名称或额外名称提供某个包；如果存在随产品发布的别名，对应包的说明会予以记录。`examples/` 中的演示工具（例如 `echo`）不在范围内，这与 Cordis 目录仅涵盖包的范围一致。

<a id="tool-package-map"></a>

## 工具包映射

下表将模型可见的工具名称与其背后的插件包和服务 seam 对应起来。各包章节随后给出确切的 JSON Schema。

| 工具包 | 模型可见名称 | 依赖 | 写入／影响 | 随产品发布的别名 | 部署说明 |
| --- | --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-tool-audio-transcribe` | `audio_transcribe` | `ctx.tools`、`ctx.museAccount`、PATH 中的 FFmpeg 与 FFprobe | `tool/call`、`tool/result`，`transcript/jobs` 中的任务收据，`transcript/raw` 中的 TXT 与 JSON | - | start 使用已登录的 Muse 账号上传压缩音轨并提交云转写；status 根据收据查询同一任务，完成后保存带时间戳的结果。需要可读取的本地音视频与服务端转写配置。 |
| `@deepseek-ai/dsh-plugin-manager` | `plugin_manager` | `ctx.tools`, `ctx.pluginManager`, `ctx.sandboxPolicy` | `tool/call`, `tool/result`, `user/message` | - | - |
| `@deepseek-ai/dsh-mcp-resources` | `list_mcp_resource_templates`, `list_mcp_resources`, `read_mcp_resource` | `ctx.tools`, `ctx.mcpResources` | `tool/call`, `tool/result` | - | - |
| `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` | `stagehand_act`、`stagehand_extract`、`stagehand_navigate`、`stagehand_observe`、`stagehand_screenshot`、`stagehand_tabs` | `ctx.browserUse`、`ctx.agents`、`ctx.tools`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | - |
| `@deepseek-ai/dsh-tool-ask-user` | `ask_user_question` | `ctx.tools`、`ctx.userQuestions` | `tool/call`、`tool/result after a UI/provider answers the question` | - | ask_user_question 会暂停工具调用，直到当前 UI 提供方返回人类答案。 |
| `@deepseek-ai/dsh-tools` | `run_code` | `ctx.tools`、`ctx.ptcRuntime (execution time)`、`ctx.systemPrompt` | `tool/call`、`one tool/ptc-dispatch-start + tool/ptc-dispatch pair per bridged sub-call`、`tool/result` | - | 在 `mode: ptc`／`mode: both` 下，它由工具注册表所有，作为可过滤能力层之外的保留传输机制（参见 PTC mode Agent Note）。在 `ptc` 下，它是注册表对协议格式（wire format）的唯一贡献；其他可见能力在使用已加载运行时语言生成的 SDK 章节中声明。程序通过 binding 调用这些能力，调用按照原生并发约定调度：启动顺序和策略遵循提交顺序，并发安全的函数体最多重叠执行 `maxParallelSubCalls` 个。调用会重新进入完整且受守卫保护的工具流水线，并将每个嵌套执行关联到此外层结果。 |
| `@deepseek-ai/dsh-plan-mode` | `exit_plan_mode` | `ctx.tools`、`ctx.systemPrompt`、`ctx.userQuestions (execution time, opportunistic)` | `tool/call`、`plan/mode inactive on an approved review`、`tool/result` | - | 规划未激活时，exit_plan_mode 仍保留在面向模型的 schema 中，这样状态转换不会在规划策略变更之外额外造成工具目录变动。其执行路径会拒绝规划模式之外的调用；在规划模式下，它通过用户交互 seam 提交计划（批准／根据反馈继续规划），批准后会在步骤边界记录规划模式已停用。 |
| `@deepseek-ai/dsh-tool-bash` | `bash` | `ctx.tools`、`ctx.shell`、`ctx.systemPrompt`、`ctx.shellEnv`、`ctx.jobs for run_in_background and the job-backed foreground path` | `tool/call`、`tool/result` | - | bash 工具是 bash 执行器 seam 面向模型的消费方。组合中有 job 注册表时，每次调用一启动就注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具（来自 `@deepseek-ai/dsh-tool-jobs`）收集／停止；没有注册表或 `enableRunInBackground: false` 时，工具注册不带 `run_in_background` 参数的纯前台 schema。 |
| `@deepseek-ai/dsh-tool-present` | `present` | `ctx.tools`, `ctx.fs`, `ctx.sessionProjections` | `tool/call`, `deliverables/presented 在成功的最终结果之后`, `tool/result` | - | 交付归调用方 Session 所有；Web ui-deliverables 提供源文件打开与卡片。 |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` | `ctx.tools`、`ctx.shell`、`ctx.systemPrompt`、`ctx.shellEnv`、`ctx.jobs for run_in_background and the job-backed foreground path` | `tool/call`、`tool/result` | - | pwsh 工具是 Windows 组合中 bash 执行器 seam 的 PowerShell 方言消费方（由 `@deepseek-ai/dsh-pwsh-local` 等 PowerShell 执行器为 `ctx.shell` 提供后端）；除沙箱接口外，它逐项对应 bash 工具调用。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具收集／停止；托管的 `DSH_*` 环境来自 `@deepseek-ai/dsh-shell-env`。每次调用都在新进程中运行，不使用持久 PTY 会话。路径采用原生 `C:\...` 形式，变量采用 `$env:NAME`。 |
| `@deepseek-ai/dsh-tool-cordis` | `cordis_inspect_list`, `cordis_inspect_query` | `ctx.tools`, `ctx.cordisInspect` | `tool/call`, `tool/result` | - | 创造模式提供两个只读运行时检查工具。Cordis host runner 提供检查注册表；Client 查询需要已连接页面。持久化变更编写为组合包，再通过 plugin_manager 安装。 |
| `@deepseek-ai/dsh-tool-bash-persistent` | `bash` | `ctx.tools`、`ctx.terminals`、`an owning Agent at execution time` | `tool/call`、`PTY shell state`、`tool/result` | - | 一个按所有者隔离的持久 bash 工具；部署组合提供 PTY 后端，并可覆盖面向模型的环境描述。 |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | `pwsh` | `ctx.tools`、`ctx.terminals`、`an owning Agent at execution time` | `tool/call`、`PTY shell state`、`tool/result` | - | 一个按所有者隔离的持久 pwsh 工具，持久 bash 工具的 Windows 对应物；部署组合提供 pwsh 方言的 PTY 后端，并可覆盖面向模型的环境描述。 |
| `@deepseek-ai/dsh-tool-str-replace-editor` | `str_replace_editor` | `ctx.tools`、`ctx.fs` | `tool/call`、`fs/observed after view presence/absence, edit absence, or successful mutation`、`tool/result` | - | 基于文件系统 seam 的独立查看／创建／唯一字面量替换／按行插入工具；可与任何 shell 或终端接口组合。 |
| `@deepseek-ai/dsh-tool-fs` | `edit`、`read`、`read_image`、`write` | `ctx.tools`、`ctx.fs`、`ctx.systemPrompt`、`ctx.attachments (image-tool registration)`、`ctx.llm + an image-capable route (image-tool execution)` | `tool/call`、`fs/write-intent or fs/edit-intent for mutations`、`fs/observed after read presence/absence or successful file operation`、`durable attachment (read_image)`、`tool/result` | - | 先读后写／编辑策略由 `@deepseek-ai/dsh-fs-observation-policy` 添加；它是一个 `fs/*` 事件门禁插件，不会改变 schema。加载这些工具的部署按预期也应加载该插件。没有 `ctx.attachments` 时图片工具不会注册；其 schema 与路由无关，执行时除非确切路由的模型声明图片输入，否则拒绝。 |
| `@deepseek-ai/dsh-tool-fs-search` | `glob`、`grep` | `ctx.tools`、`ctx.subprocess`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | glob 和 grep 是无条件可用的发现工具，通过 ctx.subprocess spawn 随包提供的 ripgrep 二进制文件（`@vscode/ripgrep`），并作为普通前台调用运行，绝不作为后台任务；无需在宿主机安装 `rg`，也不经过 shell 层。本目录使用 `sampleOverCapGlobResults: true`；部署必须显式选择该行为。结果超过上限时，会通过可选的 ctx.spillStore 后端保存完整的格式化列表；在共置部署中，如果后端公开本地路径，返回的定位信息可供后续读取／搜索。 |
| `@deepseek-ai/dsh-tool-terminal` | `terminal_close`、`terminal_list`、`terminal_open`、`terminal_read`、`terminal_send`、`terminal_signal` | `ctx.tools`、`ctx.terminals`、`ctx.systemPrompt`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | 这 6 个终端工具需要选择启用，用于补充一次性 bash／文件系统工具。`terminal_send(run_in_background: true)` 会注册到 `ctx.jobs`；schema 不包含 TUI、具名按键序列、BEL、调整尺寸、自动启动和跨 agent 共享。 |
| `@deepseek-ai/dsh-tool-goal` | `create_goal`、`get_goal`、`update_goal` | `ctx.tools`、`ctx.agents`、`ctx.goals`、`ctx.systemPrompt`、`a calling Agent in an authorized open turn` | `tool/call`、`goal/change for mutations`、`tool/result` | - | create、edit、pause 和 resume 要求直接来自人类的根权限；complete 和 blocked 也接受确切的当前 Goal Round。blocked 的默认下限是 3 个获准的 Round。 |
| `@deepseek-ai/dsh-schedule` | `schedule_create`、`schedule_delete`、`schedule_list`、`schedule_update` | `ctx.tools`、`ctx.schedule`、live 根 Agent | `tool/call`、Schedule storage domain 创建、更新或删除、`tool/result` | - | Schedule 服务加载期间，在 live 根 Agent scope 内注册。接受 after_seconds、显式绝对 at、有界固定速率 every_seconds、带显式 IANA 时区的每日与每周本地时间，以及作为五字段表达式的 cron。管理使用宿主 storage domain；到期消息会恢复原 Session。 |
| `@deepseek-ai/dsh-tool-lsp` | `lsp` | `ctx.tools`、`ctx.lsp`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | lsp 工具将提供方选择和语言服务器子进程置于 ctx.lsp 之后，因此其模型可见 schema 在更换提供方时保持稳定。运行时要求已注册提供方，例如 `@deepseek-ai/dsh-lsp-stdio`；如果没有提供方，查询会返回结构化 `LSP_UNAVAILABLE` 错误，而不会改变 schema。 |
| `@deepseek-ai/dsh-tool-ralph` | `ralph` | `ctx.tools`、`ctx.workflowEngine`、`ctx.subagents`、`ctx.systemPrompt`、`a calling Agent (exec.agent parents every fresh round)` | `tool/call`、`tool/result`、`workflow and child session events during execution` | - | 固定的前台工作流会在每个 Round 启动一个全新的结构化子级；模型只能选择不可变目标和可选的 Round 上限。 |
| `@deepseek-ai/dsh-tool-skill` | `skill` | `ctx.tools`、`ctx.agents`、`ctx.skills` | `tool/call`、`tool/result`、`user/message replacement catalogs via agent.inject()` | - | - |
| `@deepseek-ai/dsh-tool-session-query` | `session_event_read`、`session_event_search`、`session_event_trace`、`session_search`、`session_trace` | `ctx.tools`、`ctx.systemPrompt`、`ctx.sessionQuery`、`a calling Agent for workspace authority` | `tool/call`、`tool/result` | - | 这 5 个只读工具会隐藏提供方游标，并根据不可变的调用 agent 会话为每个结果授权。该包需要选择启用；需要强制截止时间或限制行内输出的组合还会挂载通用超时或 spill 策略。 |
| `@deepseek-ai/dsh-tool-subagent` | `list_subagent_models`、`subagent` | `ctx.tools`、`ctx.subagents`、`ctx.systemPrompt`、`用于模型发现和所选路由校验的 ctx.llm` | `tool/call`、`tool/result`、`child session events through the chosen provider` | `subagent`、`subagent_fork` | 注册的委派工具名称取决于加载时 `toolName` 配置（默认为 `subagent`）；上述默认 schema 关闭模型选择，而发现 schema 则展示为已启用 Session 中可用的固定配套工具。Web preset 会在每个新顶层 Session 创建时读取插件页偏好，并为其子 Session 保留该决定；`subagent_fork` 始终使用固定路由。每个实例通过 `modelSelectionSettings`、`backgroundMode` 与 `enableRunInBackground` 独立控制是否读取模型选择设置及其后台行为。 |
| `@deepseek-ai/dsh-tool-subagent-control` | `interrupt_agent`、`list_agents`、`send_message` | `ctx.tools`、`ctx.subagents`、`ctx.agents and ctx.sessionProjections (list_agents only)` | `tool/call`、`tool/result`、`child session events through ctx.subagents` | - | 这些是控制可继续后台 subagent 的全局命名工具：绑定提供方的 `tool-subagent` 实例注册不同的委派工具；本包注册一次 `send_message` 和 `interrupt_agent`，另由 `list_agents` 通过单独加载的 `/list-agents` 插件提供，其目录行使用 sessionProjections 和实时 Agent 注册表。 |
| `@deepseek-ai/dsh-tool-jobs` | `job_kill`、`job_list`、`job_output` | `ctx.tools`、`ctx.jobs`、`ctx.systemPrompt` | `tool/call`、`tool/result`、`user/message via agent.inject() for background completion notices` | - | 与任务种类无关的后台任务控制器：后台 bash 命令、PTY 发送和 subagent 都通过相同的 3 个工具读取、列出和终止。加载该插件会挂接控制器，从而启用生产方的 `ctx.jobs.start()`。 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | `interrupt_agent`、`list_agents`、`send_message`、`spawn_teammate`、`team_task_create`、`team_task_get`、`team_task_list`、`team_task_update`、`wait_agent` | `ctx.tools`、`ctx.systemPrompt`、`ctx.agentTeams`、`an exact live Team member Agent` | `tool/call`、`team/member`、`team/message/queued`、`team/message/delivered`、`team/task`、`tool/result` | - | 这 9 个工具限定于隐式 Team Lead 与持久 teammate 作用域。随产品发布的 dsh-base bundle 默认禁用该包；文档中的 Agent Teams profile patch 会启用它，并禁用旧 continuable child 的同名控制工具。 |
| `@deepseek-ai/dsh-tool-todo` | `todo_write` | `ctx.tools`、`owning Agent session` | `tool/call`、`todo/write`、`tool/result` | - | todo_write 是会话所有的状态；UI 将最新的 todo/write 事件渲染为检查清单。`allowParallelInProgress` 是没有默认值的必填项，因此本目录明确选择 `true`，对应描述允许同时存在多个 `in_progress` 项。选择 `false` 的部署会获得同一工具，但描述会要求只能有 1 个活动任务。 |
| `@deepseek-ai/dsh-tool-workflow` | `workflow` | `ctx.tools`、`ctx.workflowEngine`、`ctx.systemPrompt`、`a calling Agent (exec.agent parents the script children)` | `tool/call`、`tool/result` | - | - |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | `load_workspace_dependencies` | `ctx.tools` | `tool/call`, `tool/result` | - | - |
| `@deepseek-ai/dsh-tool-web` | `web_fetch`、`web_search` | `ctx.tools`、`ctx.web`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | web_search 和 web_fetch 将提供方选择置于 ctx.web 之后，使模型可见 schema 在更换后端时保持稳定。 |
| `@deepseek-ai/dsh-tool-jubian` | `jubian_asset`、`jubian_catalog`、`jubian_claim`、`jubian_find`、`jubian_media`、`jubian_model`、`jubian_organize`、`jubian_snatch`、`jubian_storyboard`、`jubian_video`、`jubian_watch` | `ctx.tools`、`ctx.credentials`、抢本任务所需的 `ctx.jobs` | `tool/call`、`tool/result`、按配置目录保存的剧变两阶段写入账本 | - | 计费写入均需调用方提供独立的 `idempotency_key`，批量方法逐项提供；`image_generate_batch` 先检查整批再有界并行提交；`submit_video_batch` 检查本次清单中的全部预览并预约总预算后有界并行提交；去字幕与转高清受理后通过 `subtasks` 回读。抢本仅认领已明确授权的目标或时段。 |
| `@deepseek-ai/dsh-tool-shot-script` | `drama_shot` | `ctx.tools`, `the project layout it reads and writes (episodes/, prompts/, matches/, episode_packages/)` | `tool/call`, `tool/result`, `on compile: the compiled prompt, the matched JSON, and the episode package under the project root` | - | The three methods share one schema: `validate` and `preview` only read, and `compile` writes the matched JSON and the episode package, returning each package's `content_duration_ms`, its submitted whole-second length, and the prompt-ordered `material_keys` that `jubian_storyboard` `select_assets` must match. A script with any hard failure returns that failure list and writes nothing. |
| `@deepseek-ai/dsh-perception-bgm` | `bgm_match` | `ctx.tools`、本地曲目索引或配置的公开目录；仅 index/inspect 需要 Python 和模型资源 | `tool/call`、`tool/result`、index 写本地情绪索引；download 在配置的缓存中写入经校验的音频 | - | `match` 排序候选，不代替选曲；公开库模式返回 ID 与 URL，不自动下载。`download` 接受选定的目录曲目 ID，返回经校验的本地文件。默认使用本地索引；公开库匹配需由部署配置。`index` 和 `inspect` 仅在执行时启动 Python，收集 schema 时不会启动。MERT 分析骨干仅限非商业用途（CC-BY-NC-4.0）；音频权利须另行确认。 |
| `@deepseek-ai/dsh-tool-bgm-compose` | `drama_bgm` | `ctx.tools`、`ctx.subprocess`、`PATH` 上（或配置的）ffmpeg 与 ffprobe、单集时间线与明确 BGM 计划 | `tool/call`、`tool/result`、`compose` 时写项目内的 48 kHz 双声道 PCM WAV 及相邻生成报告 | - | `preview` 校验剧情完整覆盖并回报源哈希、偏移、实测平均音量与增益，不发布产物；`compose` 交叉淡化选定曲目，暂存 WAV 通过 ffprobe 后才发布；`verify` 测量已有 WAV，不重写它。工具不选曲，也不调用 `bgm_match`；剧情解读与最终选曲归 Agent。 |
| `@deepseek-ai/dsh-tool-episode-render` | `drama_render`、`drama_video` | `ctx.tools`, `ffmpeg and ffprobe on PATH (or configured), the project layout it reads and writes (video/, audio/, editing/, exports/)` | `tool/call`, `tool/result`, `on prepare: video/<episode>/shot_00N.mp4, audio/<episode>.wav, editing/<episode>-timeline.json, editing/<episode>.srt`, `on render: the delivered MP4 and the render log under exports/.render_cache/<episode>/`, `drama_video ban/unban 写入项目内 video-bans.json；媒体字节不变` | - | `drama_video` 记录带标签、可逆的 SHA256 禁用决定，不要求审核证据；解除禁用不等于批准。`drama_render` 在 `prepare`/`render` 中拒绝已禁用的选用字节，`verify` 则报告风险，不删除媒体。其三个方法：`prepare` 构建渲染输入但不编码画面，`render` 出片并回报实测的分辨率、帧率、码率、时长、大小与编码器，`verify` 检查成片。交付样式固定——1440x2560@60、24M 目标码率与 30M 上限、4.6 Mbps 下限、SimHei 68 字幕加右下角唯一的 AI 标记，以及用最后一镜经过证明的真实尾帧定格的 2 秒片尾。无法进行下去的渲染会抛错并给修法；不符合规格的成片返回 `ok: false` 与逐项修法。 |
| `@deepseek-ai/dsh-tool-drama-assets` | `drama_assets` | `ctx.tools`, `ctx.credentials`, `the project layout it reads and writes (assets_manifest.json, _probe/asset-reconcile.json)` | `tool/call`, `tool/result`, `on reconcile: _probe/asset-reconcile.json under the project root` | - | Two methods over one evidence file: `reconcile` reads the remote project’s asset and material lists and the manifest and writes the evidence the host’s reconcile gate reads, and `dispose` records one disposition in it without any remote read. The tool never calls a Jubian write method and never bills; the disposition verdicts (`blocking`, `ignored_without_note`, `ready`) are the gate’s inputs. |

<a id="deepseek-aidsh-plugin-manager"></a>

## `@deepseek-ai/dsh-plugin-manager`

### `plugin_manager`

列出当前 profile 中的插件或组合包，启用或禁用它们，安装组合包或移除已安装的组合包。每项操作都要求 danger-full-access 权限或本次调用的批准。批准不改变会话权限模式。变更影响该 profile 的所有会话。先列出条目以获取准确标识。包安装可能运行已获批准的构建脚本。支持热更新的 profile 立即应用变更；仅启动时加载的 profile 需要重启。不兼容的 DSH peer 依赖会阻止安装和激活。版本豁免可能导致崩溃和数据丢失：授权前必须警告用户，并获得用户对精确插件版本与运行时版本组合的明确许可。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "Management operation.",
      "enum": [
        "list_plugins",
        "list_bundles",
        "set_plugin",
        "set_bundle",
        "install_bundle",
        "remove_bundle",
        "list_version_exemptions",
        "set_version_exemption"
      ]
    },
    "target": {
      "type": "string",
      "description": "Plugin entry id, bundle package name, or installation spec, according to action."
    },
    "enabled": {
      "type": "boolean",
      "description": "Required for set operations; defaults to true for installation. For set_version_exemption, true grants and false revokes."
    },
    "runtimeVersion": {
      "type": "string",
      "description": "For set_version_exemption: exact DSH version from list_version_exemptions. Target must be the manifest package-name@version, not an alias or version range."
    },
    "acceptRisk": {
      "type": "boolean",
      "description": "For granting an exemption: true only after warning the user about possible crashes and data loss and receiving explicit permission for this exact plugin/runtime pair. General installation permission is not enough."
    },
    "approvedBuilds": {
      "type": "array",
      "description": "For install_bundle: pass names from pendingBuilds only after the user explicitly approves running their install scripts in the conversation. This grants persistent permission for this profile.",
      "items": {
        "type": "string"
      }
    },
    "registry": {
      "type": "string",
      "description": "For install_bundle: the npm registry URL asked first, when the user names one; otherwise the configured registry is asked, and its configured fallbacks while a registry is unreachable."
    },
    "offset": {
      "type": "number",
      "description": "Zero-based list offset; defaults to 0."
    },
    "limit": {
      "type": "number",
      "description": "List page size, from 1 to 100; defaults to 25."
    }
  },
  "required": [
    "action"
  ]
}
```

来源： [`packages/boot/plugin-manager/src/tools.ts`](../packages/boot/plugin-manager/src/tools.ts)

<a id="deepseek-aidsh-mcp-resources"></a>

## `@deepseek-ai/dsh-mcp-resources`

### `list_mcp_resource_templates`

列出 MCP 服务器提供的参数化资源 URI 模板。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "cursor": {
      "type": "string",
      "description": "Continuation cursor returned by this server."
    }
  },
  "required": [
    "server"
  ]
}
```

来源： [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)

### `list_mcp_resources`

列出 MCP 服务器提供的资源。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "cursor": {
      "type": "string",
      "description": "Continuation cursor returned by this server."
    }
  },
  "required": [
    "server"
  ]
}
```

来源： [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)

### `read_mcp_resource`

按 URI 从指定服务器读取 MCP 资源。使用已列出的 URI 或展开后的资源模板。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "uri": {
      "type": "string",
      "description": "Resource URI to read."
    }
  },
  "required": [
    "server",
    "uri"
  ]
}
```

来源： [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)

<a id="deepseek-aidsh-experimental-browser-use-stagehand-native"></a>

## `@deepseek-ai/dsh-experimental-browser-use-stagehand-native`

### `stagehand_act`

使用配置的 Stagehand 模型执行一次自然语言浏览器操作。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

### `stagehand_extract`

使用配置的 Stagehand 模型与可选的 JSON Schema 提取页面数据。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    },
    "schema": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "$ref": "#/$defs/__schema0"
      }
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false,
  "$defs": {
    "__schema0": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "number"
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/__schema0"
          }
        },
        {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "$ref": "#/$defs/__schema0"
          }
        }
      ]
    }
  }
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

### `stagehand_navigate`

将 Stagehand 浏览器标签页导航至指定 URL。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "url": {
      "type": "string",
      "format": "uri"
    }
  },
  "required": [
    "url"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

### `stagehand_observe`

使用配置的 Stagehand 模型查找符合指令的浏览器操作。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

### `stagehand_screenshot`

截取 Stagehand 标签页图像以供视觉检查。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "fullPage": {
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "fullPage"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

### `stagehand_tabs`

列出、创建、选择或关闭 Stagehand 浏览器标签页。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "list"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "new"
        },
        "url": {
          "type": "string",
          "format": "uri"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "select",
            "close"
          ]
        },
        "pageId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "action",
        "pageId"
      ],
      "additionalProperties": false
    }
  ],
  "type": "object"
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

<a id="deepseek-aidsh-tool-ask-user"></a>

## `@deepseek-ai/dsh-tool-ask-user`

### `ask_user_question`

继续操作前，如果需要确认、选择或缺失的信息，请向用户提出简明问题。

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "description": "Questions to ask the user before continuing.",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable id for this question; echoed in the answer."
          },
          "question": {
            "type": "string",
            "description": "The specific question to ask the user."
          },
          "header": {
            "type": "string",
            "description": "Optional short heading for the question, such as \"Confirm\" or \"Choose Mode\"."
          },
          "options": {
            "type": "array",
            "description": "Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label.",
            "items": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "label": {
                  "type": "string",
                  "description": "Short user-facing option label."
                },
                "description": {
                  "type": "string",
                  "description": "One sentence explaining the tradeoff or impact."
                }
              },
              "required": [
                "label"
              ]
            }
          },
          "multi_select": {
            "type": "boolean",
            "description": "Whether the user may select more than one option. Defaults to false."
          }
        },
        "required": [
          "id",
          "question"
        ]
      }
    }
  },
  "required": [
    "questions"
  ]
}
```

来源：[`packages/interaction/tool-ask-user/src/index.ts`](../packages/interaction/tool-ask-user/src/index.ts)

ask_user_question 会暂停工具调用，直到当前 UI 提供方返回人类答案。

<a id="deepseek-aidsh-tool-audio-transcribe"></a>

## `@deepseek-ai/dsh-tool-audio-transcribe`

### `audio_transcribe`

使用当前 Muse 账号转写本地音频或视频。start 提交异步任务并返回收据；用 status 查询同一任务，完成后取得带时间戳的转写文件。需要先登录 Muse。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "start=提取音轨并提交；status=按原收据查询及发布结果。",
      "enum": [
        "start",
        "status"
      ]
    },
    "project": {
      "type": "string",
      "description": "项目根目录，保存 transcript/jobs 收据及 transcript/raw 版本结果。"
    },
    "input": {
      "type": "string",
      "description": "start 必填：获授权的本地音频或视频文件路径。"
    },
    "receipt": {
      "type": "string",
      "description": "status 必填：start 返回的 transcript/jobs 收据路径。"
    },
    "language": {
      "type": "string",
      "description": "start 识别语种；默认 zh。",
      "enum": [
        "zh",
        "auto"
      ]
    }
  },
  "required": [
    "method",
    "project"
  ]
}
```

??? [`packages/drama/tool-audio-transcribe/src/index.ts`](../packages/drama/tool-audio-transcribe/src/index.ts)

start ???? Muse ?????????????????status ??????????????????? TXT ? JSON??? Muse ????????????????????

<a id="deepseek-aidsh-tools"></a>

## `@deepseek-ai/dsh-tools`

### `run_code`

针对可用工具执行 TypeScript 程序。接受两个必填参数：`code`，即异步函数的**函数体**（仅使用可擦除语法；支持顶层 `await` 和 `return`）；以及 `description`，简要说明该程序做什么。请根据系统提示词中的声明，以 `await tools.name(args)` 形式调用工具。只有打印或返回的内容属于程序输出，请谨慎筛选。含图片的子工具结果会在运行结束后附加。

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "The program: the body of an async TypeScript function."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Positive elapsed-time budget in milliseconds, capped by the deployment maximum."
    },
    "sandbox_permissions": {
      "type": "string",
      "description": "Wider sandbox mode for this complete program execution; requires justification and approval.",
      "enum": [
        "workspace-write",
        "danger-full-access"
      ]
    },
    "justification": {
      "type": "string",
      "description": "Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request."
    }
  },
  "required": [
    "code",
    "description"
  ]
}
```

来源：[`packages/core/tools/src/ptc.ts`](../packages/core/tools/src/ptc.ts)

在 `mode: ptc`／`mode: both` 下，它由工具注册表所有，作为可过滤能力层之外的保留传输机制（参见 PTC mode Agent Note）。在 `ptc` 下，它是注册表对协议格式的唯一贡献；其他可见能力在使用已加载运行时语言生成的 SDK 章节中声明。程序通过 binding 调用这些能力，调用按照原生并发约定调度：启动顺序和策略遵循提交顺序，并发安全的函数体最多重叠执行 `maxParallelSubCalls` 个。调用会重新进入完整且受守卫保护的工具流水线，并将每个嵌套执行关联到此外层结果。

<a id="deepseek-aidsh-plan-mode"></a>

## `@deepseek-ai/dsh-plan-mode`

### `exit_plan_mode`

仅在规划模式下使用。提交计划供用户评审，并在获批后退出规划模式。用户可以批准（从你的下一步骤起执行计划），也可以要求继续规划；其反馈会通过工具结果返回，请修改后再次提交。

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "The complete plan, as markdown, starting with a # heading that names it."
    }
  },
  "required": [
    "plan"
  ]
}
```

来源：[`packages/plan/plan-mode/src/index.ts`](../packages/plan/plan-mode/src/index.ts)

规划未激活时，exit_plan_mode 仍保留在面向模型的 schema 中，这样状态转换不会在规划策略变更之外额外造成工具目录变动。其执行路径会拒绝规划模式之外的调用；在规划模式下，它通过用户交互 seam 提交计划（批准／根据反馈继续规划），批准后会在步骤边界记录规划模式已停用。

<a id="deepseek-aidsh-tool-bash"></a>

## `@deepseek-ai/dsh-tool-bash`

### `bash`

执行 bash 命令（`bash -c`）并返回 stdout/stderr。每次调用都在新 shell 中运行；请传入 `workdir`，不要使用 `cd`。托管的 `$DSH_*` 变量公开当前 harness 环境信息。较长的输出会截断，只保留尾部；如可用，完整输出会保存到文件并报告其路径。命令可能在文件沙箱中运行；被阻止的文件操作报告为 `[sandbox: file access denied under <mode> mode]`，这是策略拒绝：请勿换一种方式重试。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to execute."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "command",
    "description"
  ]
}
```

来源：[`packages/shell/tool-bash/src/index.ts`](../packages/shell/tool-bash/src/index.ts)

bash 工具是 bash 执行器 seam 面向模型的消费方。组合中有 job 注册表时，每次调用一启动就注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具（来自 `@deepseek-ai/dsh-tool-jobs`）收集／停止；没有注册表或 `enableRunInBackground: false` 时，工具注册不带 `run_in_background` 参数的纯前台 schema。

<a id="deepseek-aidsh-tool-present"></a>

## `@deepseek-ai/dsh-tool-present`

### `present`

将已有文件声明为交付给用户的最终交付物。当用户需要独立文件时使用，尤其是 Office 文档、电子表格和演示文稿；如果最终回复已经足够，优先使用最终回复。用户打开的是当前文件；不复制其内容。

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "description": "Usually the 1-2 most important deliverables; at most 4 per call.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "description": "Path of an existing regular file. Relative paths use the Session working directory."
          },
          "description": {
            "type": "string",
            "description": "Brief description for the user."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  "required": [
    "files"
  ]
}
```

来源： [`packages/deliverables/tool-present/src/index.ts`](../packages/deliverables/tool-present/src/index.ts)

交付归调用方 Session 所有；Web ui-deliverables 提供源文件打开与卡片。

<a id="deepseek-aidsh-tool-pwsh"></a>

## `@deepseek-ai/dsh-tool-pwsh`

### `pwsh`

执行 PowerShell 命令（`pwsh -Command`）并返回 stdout/stderr。每次调用都在新的 pwsh 进程中运行；请传入 `workdir`，不要使用 `cd`。路径采用 Windows 原生形式（`C:\...`）；使用 `$env:NAME` 读取环境变量。托管的 `$env:DSH_*` 变量公开当前 harness 环境信息。较长的输出会截断，只保留尾部；如可用，完整输出会保存到文件并报告其路径。在 Windows 上，被强制终止的命令会以 `[exit code: 1]` 结算且不带信号标记，请将其视为中断，而不是命令失败。命令可能在文件沙箱中运行；被阻止的文件操作报告为 `[sandbox: file access denied under <mode> mode]`，这是策略拒绝：请勿换一种方式重试。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to execute."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"Get-Process\" → \"List running processes\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "command",
    "description"
  ]
}
```

来源：[`packages/shell/tool-pwsh/src/index.ts`](../packages/shell/tool-pwsh/src/index.ts)

pwsh 工具是 Windows 组合中 bash 执行器 seam 的 PowerShell 方言消费方（由 `@deepseek-ai/dsh-pwsh-local` 等 PowerShell 执行器为 `ctx.shell` 提供后端）；除沙箱接口外，它逐项对应 bash 工具调用。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具收集／停止；托管的 `DSH_*` 环境来自 `@deepseek-ai/dsh-shell-env`。每次调用都在新进程中运行，不使用持久 PTY 会话。路径采用原生 `C:\...` 形式，变量采用 `$env:NAME`。

<a id="deepseek-aidsh-tool-cordis"></a>

## `@deepseek-ai/dsh-tool-cordis`

### `cordis_inspect_list`

列出 Host 当前已知的所有 Cordis Inspect Provider，包括本地 Host Provider 和 Client 同步的最新清单。每项包含平台、用途、只读方法以及输入输出 schema。编写或配置插件前先调用本工具，再从结果选择 cordis_inspect_query 的 provider 和方法。不要猜测名称，也不要把 Inspect 方法当作插件代码可调用的业务 Service。

```json
{
  "type": "object",
  "properties": {}
}
```

来源： [`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_inspect_query`

执行 Inspect Provider 声明的只读查询。platform、provider 和 method 必须来自 cordis_inspect_list，input 必须符合该方法的 schema。编写插件代码前，用本工具读取准确的 Service 方法、Event 模式、插件 Config schema、Tool schema、主题 token，或实时 Slot 树与 props。Host 查询在本地运行。Client 查询等待页面首个有效响应，直到页面回应或工具取消。本工具不能调用业务 Service 方法或修改运行时。

```json
{
  "type": "object",
  "properties": {
    "platform": {
      "type": "string",
      "description": "Runtime platform that owns the Provider.",
      "enum": [
        "host",
        "client"
      ]
    },
    "provider": {
      "type": "string",
      "description": "Exact Provider ID returned by cordis_inspect_list."
    },
    "method": {
      "type": "string",
      "description": "Exact method name declared by the Provider manifest."
    },
    "input": {
      "description": "Optional query input; it must satisfy the method input schema."
    }
  },
  "required": [
    "platform",
    "provider",
    "method"
  ]
}
```

来源： [`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

创造模式提供两个只读运行时检查工具。Cordis host runner 提供检查注册表；Client 查询需要已连接页面。持久化变更编写为组合包，再通过 plugin_manager 安装。

<a id="deepseek-aidsh-tool-bash-persistent"></a>

## `@deepseek-ai/dsh-tool-bash-persistent`

### `bash`

在持久 bash shell 中运行命令。包括当前目录和已导出环境变量在内的状态会在此 agent 的多次调用之间保留。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

来源：[`packages/shell/tool-bash-persistent/src/index.ts`](../packages/shell/tool-bash-persistent/src/index.ts)

一个按所有者隔离的持久 bash 工具；部署组合提供 PTY 后端，并可覆盖面向模型的环境描述。

<a id="deepseek-aidsh-tool-pwsh-persistent"></a>

## `@deepseek-ai/dsh-tool-pwsh-persistent`

### `pwsh`

在持久 PowerShell shell 中运行命令。包括当前目录和已导出环境变量在内的状态会在此 agent 的多次调用之间保留。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

来源：[`packages/shell/tool-pwsh-persistent/src/index.ts`](../packages/shell/tool-pwsh-persistent/src/index.ts)

一个按所有者隔离的持久 pwsh 工具，持久 bash 工具的 Windows 对应物；部署组合提供 pwsh 方言的 PTY 后端，并可覆盖面向模型的环境描述。

<a id="deepseek-aidsh-tool-str-replace-editor"></a>

## `@deepseek-ai/dsh-tool-str-replace-editor`

### `str_replace_editor`

用于查看、创建和编辑文件的自定义编辑工具：

* 状态会在命令调用以及与用户的讨论之间持久保留
* 如果 `path` 是文件，`view` 会显示应用 `cat -n` 后的结果。如果 `path` 是目录，`view` 会列出最多向下 2 层的非隐藏文件和目录
* 如果指定的 `create` 命令目标 `path` 已作为文件存在，则不能使用该命令
* 如果 `command` 产生较长输出，输出会被截断并标记为 `<response clipped>`
* 当前命令不使用某个参数时，值为 `null` 的占位参数视为未提供。必填参数仍须提供值；删除匹配内容时应省略 `str_replace.new_str`，而不是将其设为 `null`

使用 `str_replace` 命令时请注意：

* `old_str` 参数应与原文件中一行或多行连续内容**完全**匹配。请留意空白字符！
* 如果 `old_str` 参数在文件中不唯一，则不会执行替换。请确保在 `old_str` 中包含足够的上下文，使其唯一
* `new_str` 参数应包含用于替换 `old_str` 的已编辑行

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
      "enum": [
        "view",
        "create",
        "str_replace",
        "insert"
      ]
    },
    "path": {
      "type": "string",
      "description": "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`."
    },
    "file_text": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required string parameter of `create` command, with the content of the file to be created. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "insert_line": {
      "oneOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required integer parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "new_str": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional string parameter of `str_replace` command containing the new string (if omitted, no string will be added). Required string parameter of `insert` command containing the string to insert. A null placeholder is accepted only by commands that do not use this parameter."
    },
    "old_str": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required string parameter of `str_replace` command containing the string in `path` to replace. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "view_range": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "integer"
          }
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional parameter of `view` command when `path` points to a file. If omitted or null, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file."
    }
  },
  "required": [
    "command",
    "path"
  ]
}
```

来源：[`packages/fs/tool-str-replace-editor/src/index.ts`](../packages/fs/tool-str-replace-editor/src/index.ts)

基于文件系统 seam 的独立查看／创建／唯一字面量替换／按行插入工具；可与任何 shell 或终端接口组合。

<a id="deepseek-aidsh-tool-fs"></a>

## `@deepseek-ai/dsh-tool-fs`

### `edit`

通过替换字面量文本来编辑现有 UTF-8 文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to edit, resolved by the filesystem backend."
    },
    "old_string": {
      "type": "string",
      "description": "Literal text to replace."
    },
    "new_string": {
      "type": "string",
      "description": "Literal replacement text. Use an empty string to delete the match."
    },
    "replace_all": {
      "type": "boolean",
      "description": "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

### `read`

读取 UTF-8 文本文件，并返回带行号的内容。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to read, resolved by the filesystem backend."
    },
    "offset": {
      "type": "number",
      "description": "1-based first line to return. Defaults to 1."
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to return. Defaults to 2000."
    }
  },
  "required": [
    "file_path"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

### `read_image`

读取 PNG/JPEG/WebP/GIF 文件并返回图像本身。大图会自动缩小；不要为了查看图片而安装图片库或创建缩略图。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to the image file, resolved by the filesystem backend."
    }
  },
  "required": [
    "file_path"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

### `write`

创建或完全替换 UTF-8 文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to write, resolved by the filesystem backend."
    },
    "content": {
      "type": "string",
      "description": "Full UTF-8 text content to write."
    }
  },
  "required": [
    "file_path",
    "content"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

先读后写／编辑策略由 `@deepseek-ai/dsh-fs-observation-policy` 添加；它是一个 `fs/*` 事件门禁插件，不会改变 schema。加载这些工具的部署按预期也应加载该插件。没有 `ctx.attachments` 时图片工具不会注册；其 schema 与路由无关，执行时除非确切路由的模型声明图片输入，否则拒绝。

<a id="deepseek-aidsh-tool-fs-search"></a>

## `@deepseek-ai/dsh-tool-fs-search`

### `glob`

查找路径匹配 glob 模式的文件（不含目录），包括隐藏文件和被忽略的文件。最多按修改时间顺序返回 100 条路径；更大的结果会从顶层条目中抽样，并报告完整列表的保存位置。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth."
    },
    "path": {
      "type": "string",
      "description": "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
    }
  },
  "required": [
    "pattern"
  ]
}
```

来源：[`packages/fs/tool-fs-search/src/index.ts`](../packages/fs/tool-fs-search/src/index.ts)

### `grep`

使用 ripgrep 正则表达式搜索文件内容。返回带行号的匹配行，并按文件分组。最多返回 250 条匹配；更大的结果会报告完整匹配列表的保存位置。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regular expression to search for (ripgrep syntax)."
    },
    "path": {
      "type": "string",
      "description": "File or directory to search. Defaults to the session workspace; a relative path resolves against it."
    },
    "include": {
      "type": "string",
      "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
    }
  },
  "required": [
    "pattern"
  ]
}
```

来源：[`packages/fs/tool-fs-search/src/index.ts`](../packages/fs/tool-fs-search/src/index.ts)

glob 和 grep 是无条件可用的发现工具，通过 ctx.subprocess spawn 随包提供的 ripgrep 二进制文件（`@vscode/ripgrep`），并作为普通前台调用运行，绝不作为后台任务；无需在宿主机安装 `rg`，也不经过 shell 层。本目录使用 `sampleOverCapGlobResults: true`；部署必须显式选择该行为。结果超过上限时，会通过可选的 ctx.spillStore 后端保存完整的格式化列表；在共置部署中，如果后端公开本地路径，返回的定位信息可供后续读取／搜索。

<a id="deepseek-aidsh-tool-terminal"></a>

## `@deepseek-ai/dsh-tool-terminal`

### `terminal_close`

关闭一个持久终端，并等待其捕获且所有的进程树完全退出。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    }
  },
  "required": [
    "sessionId"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_list`

列出当前 agent 所有的持久终端会话。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_open`

通过已注册的后端类型创建按所有者隔离的持久终端会话。需要在多次工具调用之间保留 shell 或 REPL 状态时，请使用此工具。

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "description": "Registered terminal backend type, usually \"shell\"."
    },
    "name": {
      "type": "string",
      "description": "Optional owner-local display name such as \"main\" or \"gdb\"."
    },
    "cwd": {
      "type": "string",
      "description": "Initial working directory. Defaults to the deployment workspace root."
    }
  },
  "required": [
    "type"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_read`

从持久终端读取一页有界的保留输出，不发送输入。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    },
    "offset": {
      "type": "number",
      "description": "Newest-relative line offset (default 0)."
    },
    "count": {
      "type": "number",
      "description": "Requested line count (default 500; backend caps apply)."
    }
  },
  "required": [
    "sessionId"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_send`

向持久终端发送文本。默认会提交 Enter，并等待提示符、stdin 等待、输出静默、超时或会话退出。后台模式会返回供 job_output／job_kill 使用的 job id。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id returned by terminal_open or terminal_list."
    },
    "text": {
      "type": "string",
      "description": "UTF-8 text to write to the terminal."
    },
    "submit": {
      "type": "boolean",
      "description": "Submit Enter after text (default true). Set false for control characters or incomplete REPL input."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Return a job id immediately; collect with job_output or stop with job_kill."
    }
  },
  "required": [
    "sessionId",
    "text"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_signal`

向持久终端当前的前台进程组发送允许的信号。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    },
    "signal": {
      "type": "string",
      "description": "Signal to deliver. Shell-targeted SIGKILL is rejected; use terminal_close.",
      "enum": [
        "SIGINT",
        "SIGTERM",
        "SIGKILL",
        "SIGTSTP",
        "SIGHUP"
      ]
    }
  },
  "required": [
    "sessionId",
    "signal"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

这 6 个终端工具需要选择启用，用于补充一次性 bash／文件系统工具。`terminal_send(run_in_background: true)` 会注册到 `ctx.jobs`；schema 不包含 TUI、具名按键序列、BEL、调整尺寸、自动启动和跨 agent 共享。

<a id="deepseek-aidsh-tool-goal"></a>

## `@deepseek-ai/dsh-tool-goal`

### `create_goal`

创建一个持久化目标，使当前会话跨自动延续 Round 持续工作。当直接人类请求是长期目标时使用，即使用户没有说「目标」；不要用于单轮工作。

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The concrete completion objective inferred from the direct human request."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Optional positive safe-integer limit on automatic continuation rounds."
    }
  },
  "required": [
    "objective"
  ]
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

### `get_goal`

读取当前会话目标，包括 update_goal 所需的 id 和 revision。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

### `update_goal`

更新当前目标。

```json
{
  "type": "object",
  "properties": {
    "goal_id": {
      "type": "string",
      "description": "Exact id returned by get_goal."
    },
    "revision": {
      "type": "number",
      "description": "Exact positive revision returned by get_goal."
    },
    "action": {
      "type": "string",
      "description": "edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.",
      "enum": [
        "edit",
        "pause",
        "resume",
        "complete",
        "blocked"
      ]
    },
    "objective": {
      "type": "string",
      "description": "Replacement objective; valid only with action edit."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Replacement cap; valid only with action edit."
    },
    "blocked_reason": {
      "type": "string",
      "description": "Required only with action blocked: the concrete condition that persisted across rounds and blocks progress."
    }
  },
  "required": [
    "goal_id",
    "revision",
    "action"
  ]
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

create、edit、pause 和 resume 要求直接来自人类的根权限；complete 和 blocked 也接受确切的当前 Goal Round。blocked 的默认下限是 3 个获准的 Round。

<a id="deepseek-aidsh-schedule"></a>

## `@deepseek-ai/dsh-schedule`

### `schedule_create`

在当前会话中创建一条提醒，到期时投递 prompt。请恰好提供一个时间参数：after_seconds、at、every_seconds、daily、weekly 或 cron。时区中不存在的本地时间会被跳过；重复出现的本地时间只在较早的时刻触发一次。停机后，重复提醒只投递最近错过的一次。崩溃后可能重复投递。

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Reminder content to present when the target becomes due."
    },
    "title": {
      "type": "string",
      "description": "Task name of at most 120 characters, shown on the task card and in task lists."
    },
    "after_seconds": {
      "type": "number",
      "description": "Delay in whole seconds."
    },
    "every_seconds": {
      "type": "number",
      "description": "Fixed-rate interval in whole seconds, at least 60, aligned to the creation time; changing it with schedule_update re-aligns it to the save time."
    },
    "daily": {
      "type": "object",
      "description": "Every day at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "time",
        "time_zone"
      ]
    },
    "weekly": {
      "type": "object",
      "description": "On the given weekdays at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        },
        "weekdays": {
          "type": "array",
          "description": "ISO weekdays, Monday 1 through Sunday 7, without repetitions.",
          "items": {
            "type": "integer"
          }
        }
      },
      "required": [
        "time",
        "time_zone",
        "weekdays"
      ]
    },
    "cron": {
      "type": "object",
      "description": "Five-field Vixie cron expression in a time zone.",
      "additionalProperties": false,
      "properties": {
        "expression": {
          "type": "string",
          "description": "minute hour day-of-month month day-of-week, for example \"*/15 9-17 * * 1-5\". When both day fields are restricted, a date matches if either one matches."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "expression",
        "time_zone"
      ]
    },
    "at": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "date": {
              "type": "string"
            },
            "time": {
              "type": "string"
            },
            "time_zone": {
              "type": "string"
            }
          },
          "required": [
            "date",
            "time",
            "time_zone"
          ]
        }
      ],
      "description": "Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone."
    }
  },
  "required": [
    "prompt",
    "title"
  ]
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

### `schedule_delete`

删除当前会话中的一条提醒，活动或已结束的均可。删除不会撤回已经入队的提醒消息。

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Schedule id returned by schedule_list."
    }
  },
  "required": [
    "id"
  ]
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

### `schedule_list`

列出当前会话中的活动提醒。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

选择启用的 Schedule 服务加载期间，在 live 根 Agent scope 内注册。接受 after_seconds、显式绝对 at、有界固定速率 every_seconds、带显式 IANA 时区的每日与每周本地时间，以及作为五字段表达式的 cron。管理使用宿主 storage domain；到期消息会恢复原 Session。

<a id="deepseek-aidsh-tool-lsp"></a>

### `schedule_update`

原地修改一条提醒并保留其 id。提供新的 title、prompt，或至多一个时间参数；未提供的字段保持原值。需要相对延迟时请新建一条提醒。

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Schedule id returned by schedule_list."
    },
    "title": {
      "type": "string",
      "description": "New task name of at most 120 characters."
    },
    "prompt": {
      "type": "string",
      "description": "New reminder content."
    },
    "every_seconds": {
      "type": "number",
      "description": "Fixed-rate interval in whole seconds, at least 60, aligned to the creation time; changing it with schedule_update re-aligns it to the save time."
    },
    "daily": {
      "type": "object",
      "description": "Every day at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "time",
        "time_zone"
      ]
    },
    "weekly": {
      "type": "object",
      "description": "On the given weekdays at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        },
        "weekdays": {
          "type": "array",
          "description": "ISO weekdays, Monday 1 through Sunday 7, without repetitions.",
          "items": {
            "type": "integer"
          }
        }
      },
      "required": [
        "time",
        "time_zone",
        "weekdays"
      ]
    },
    "cron": {
      "type": "object",
      "description": "Five-field Vixie cron expression in a time zone.",
      "additionalProperties": false,
      "properties": {
        "expression": {
          "type": "string",
          "description": "minute hour day-of-month month day-of-week, for example \"*/15 9-17 * * 1-5\". When both day fields are restricted, a date matches if either one matches."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "expression",
        "time_zone"
      ]
    },
    "at": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "date": {
              "type": "string"
            },
            "time": {
              "type": "string"
            },
            "time_zone": {
              "type": "string"
            }
          },
          "required": [
            "date",
            "time",
            "time_zone"
          ]
        }
      ],
      "description": "Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone."
    }
  },
  "required": [
    "id"
  ]
}
```

Source: [`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

Schedule 服务加载期间，在 live 根 Agent scope 内注册。接受 after_seconds、显式绝对 at、有界固定速率 every_seconds、带显式 IANA 时区的每日与每周本地时间，以及作为五字段表达式的 cron。管理使用宿主 storage domain；到期消息会恢复原 Session。

<a id="deepseek-aidsh-tool-lsp"></a>

## `@deepseek-ai/dsh-tool-lsp`

### `lsp`

查询语言服务器，以精确导航代码。operation 可取 goToDefinition、findReferences、goToImplementation 或 hover。line 和 character 是从 1 开始的 UTF-16 光标坐标。findReferences 包含声明。

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "description": "goToDefinition, findReferences, goToImplementation, or hover.",
      "enum": [
        "goToDefinition",
        "findReferences",
        "goToImplementation",
        "hover"
      ]
    },
    "file_path": {
      "type": "string",
      "description": "The source file to query, relative to the workspace or absolute."
    },
    "line": {
      "type": "number",
      "description": "One-based line of the cursor."
    },
    "character": {
      "type": "number",
      "description": "One-based UTF-16 column of the cursor."
    }
  },
  "required": [
    "operation",
    "file_path",
    "line",
    "character"
  ]
}
```

来源：[`packages/lsp/tool-lsp/src/index.ts`](../packages/lsp/tool-lsp/src/index.ts)

lsp 工具将提供方选择和语言服务器子进程置于 ctx.lsp 之后，因此其模型可见 schema 在更换提供方时保持稳定。运行时要求已注册提供方，例如 `@deepseek-ai/dsh-lsp-stdio`；如果没有提供方，查询会返回结构化 `LSP_UNAVAILABLE` 错误，而不会改变 schema。

<a id="deepseek-aidsh-tool-ralph"></a>

## `@deepseek-ai/dsh-tool-ralph`

### `ralph`

围绕一个不可变目标运行使用全新 agent 的前台 Ralph 循环。仅当直接人类明确要求 Ralph 或使用全新 agent 迭代时使用。每个 Round 都会启动一个全新子级，该子级看不到父级对话或先前子会话；共享工作区充当长期记忆，Round 之间只传递有界的结构化报告。当工作进程报告完成、报告具体阻塞项或达到 Round 上限时，调用返回。普通的长期同会话工作应使用 goal 工具。

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The immutable completion objective for every fresh Ralph round."
    },
    "maxRounds": {
      "type": "number",
      "description": "Optional positive safe-integer round cap, bounded by the deployment ceiling."
    }
  },
  "required": [
    "objective"
  ]
}
```

来源：[`packages/workflow/tool-ralph/src/index.ts`](../packages/workflow/tool-ralph/src/index.ts)

固定的前台工作流会在每个 Round 启动一个全新的结构化子级；模型只能选择不可变目标和可选的 Round 上限。

<a id="deepseek-aidsh-tool-skill"></a>

## `@deepseek-ai/dsh-tool-skill`

### `skill`

加载某项 skill（技能）的完整说明。在执行点名某项 skill 或与会话 skill 目录中某项 skill 明确匹配的任务前，请调用此工具。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The exact skill name from the available skills list."
    }
  },
  "required": [
    "name"
  ]
}
```

来源：[`packages/skill/tool-skill/src/index.ts`](../packages/skill/tool-skill/src/index.ts)

<a id="deepseek-aidsh-tool-session-query"></a>

## `@deepseek-ai/dsh-tool-session-query`

### `session_event_read`

从一个已获授权的会话中读取一个完整且未删节的事件，以及可选的相邻原始事件概述。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "seq": {
      "type": "integer",
      "description": "Target event sequence number."
    },
    "before": {
      "type": "integer",
      "description": "Number of preceding raw events to summarize. Omit for none."
    },
    "after": {
      "type": "integer",
      "description": "Number of following raw events to summarize. Omit for none."
    }
  },
  "required": [
    "seq"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_event_search`

在一个已获授权的会话中搜索先前事件；如果搜索当前会话，则排除执行此次调用的步骤。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "query": {
      "type": "string",
      "description": "Literal full-text query over the target session."
    },
    "seq_from": {
      "type": "integer",
      "description": "Inclusive event sequence lower bound."
    },
    "seq_to": {
      "type": "integer",
      "description": "Inclusive event sequence upper bound."
    },
    "time_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time lower bound."
    },
    "time_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time upper bound."
    },
    "event_types": {
      "type": "array",
      "description": "Event types to include.",
      "items": {
        "type": "string"
      }
    },
    "surfaces": {
      "type": "array",
      "description": "Event surfaces to include.",
      "items": {
        "type": "string",
        "enum": [
          "current",
          "shadowed",
          "log-only"
        ]
      }
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_event_trace`

读取已获授权会话中某个事件的所有直接替换关系，以及该事件与其引用的来源事件之间的关系。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "seq": {
      "type": "integer",
      "description": "Target event sequence number."
    }
  },
  "required": [
    "seq"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_search`

搜索调用方工作区中的先前会话，并从每个会话返回匹配度最高的事件。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Literal full-text query over prior session history."
    },
    "session_ids": {
      "type": "array",
      "description": "Optional session ids to include.",
      "items": {
        "type": "string"
      }
    },
    "created_at_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 creation-time lower bound."
    },
    "created_at_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 creation-time upper bound."
    },
    "parent_session_ids": {
      "type": "array",
      "description": "Optional direct parent session ids.",
      "items": {
        "type": "string"
      }
    },
    "include_root_sessions": {
      "type": "boolean",
      "description": "Include sessions with no parent in the parent filter."
    },
    "availability": {
      "type": "array",
      "description": "Require at least one selected source availability.",
      "items": {
        "type": "string",
        "enum": [
          "live",
          "persisted"
        ]
      }
    },
    "event_seq_from": {
      "type": "integer",
      "description": "Inclusive event sequence lower bound."
    },
    "event_seq_to": {
      "type": "integer",
      "description": "Inclusive event sequence upper bound."
    },
    "event_time_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time lower bound."
    },
    "event_time_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time upper bound."
    },
    "event_types": {
      "type": "array",
      "description": "Event types to include.",
      "items": {
        "type": "string"
      }
    },
    "event_surfaces": {
      "type": "array",
      "description": "Event surfaces to include.",
      "items": {
        "type": "string",
        "enum": [
          "current",
          "shadowed",
          "log-only"
        ]
      }
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_trace`

读取围绕一个会话的已授权会话谱系，包括完整可见的祖先和后代关系。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    }
  }
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

这 5 个只读工具会隐藏提供方游标，并根据不可变的调用 agent 会话为每个结果授权。该包需要选择启用；需要强制截止时间或限制行内输出的组合还会挂载通用超时或 spill 策略。

<a id="deepseek-aidsh-tool-subagent"></a>

## `@deepseek-ai/dsh-tool-subagent`

### `list_subagent_models`

发现 subagent 可用的 LLM 路由，不更改当前 Agent。无参数调用会列出已注册提供方；提供 `provider` 时会列出其公布的模型；同时提供 `provider` 和 `model` 时会检查该精确模型及其推理强度。目录条目只提供建议：adapter 可能接受未列出的模型 id。把返回的 id 用于委派工具的 `provider`、`model` 与 `reasoning_effort` 字段。

```json
{
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "description": "Registered LLM provider id. Omit to list providers."
    },
    "model": {
      "type": "string",
      "description": "Exact model id to inspect. Requires provider; omit to list that provider's advertised models."
    }
  }
}
```

来源：[`packages/subagent/tool-subagent/src/list-models.ts`](../packages/subagent/tool-subagent/src/list-models.ts)

### `subagent`

将一项自包含任务委派给 subagent（在自身上下文中工作的独立 agent），用它卸载聚焦且独立的工作，例如研究、限定范围的实现或分析，以免消耗当前对话的上下文。subagent 会返回结果，但不会返回中间步骤。此调用默认等待结果。

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "A short (3-5 word) description of the delegated task, for display."
    },
    "prompt": {
      "type": "string",
      "description": "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run as a background job and return its id (collect with job_output, stop with job_kill). Defaults to false."
    }
  },
  "required": [
    "description",
    "prompt"
  ]
}
```

来源：[`packages/subagent/tool-subagent/src/index.ts`](../packages/subagent/tool-subagent/src/index.ts)

注册的委派工具名称取决于加载时 `toolName` 配置（默认为 `subagent`）；上述默认 schema 关闭模型选择，而发现 schema 则展示为已启用 Session 中可用的固定配套工具。Web preset 会在每个新顶层 Session 创建时读取插件页偏好，并为其子 Session 保留该决定；`subagent_fork` 始终使用固定路由。每个实例通过 `modelSelectionSettings`、`backgroundMode` 与 `enableRunInBackground` 独立控制是否读取模型选择设置及其后台行为。

<a id="deepseek-aidsh-tool-subagent-control"></a>

## `@deepseek-ai/dsh-tool-subagent-control`

### `interrupt_agent`

请 subagent 停止当前工作。此调用不等待其停止即返回。之后可以用 send_message 继续与直接子级的对话。它启动的 subagent 会继续运行。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The id of an agent created under you: your direct child or a deeper descendant."
    }
  },
  "required": [
    "agent_id"
  ]
}
```

来源：[`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts)

### `list_agents`

列出你启动的 subagent 及其 id、标签和状态。running 表示正在工作；inactive 表示当前未在工作。subagent 完成时你会收到通知，无需反复查看状态。使用 send_message 继续对话。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "children (default) lists direct children, which accept send_message in any status. descendants lists the whole tree below you with each entry's parent session id and depth; entries deeper than 1 accept only interrupt_agent.",
      "enum": [
        "children",
        "descendants"
      ]
    }
  }
}
```

来源：[`packages/subagent/tool-subagent-control/src/list-agents.ts`](../packages/subagent/tool-subagent-control/src/list-agents.ts)

### `send_message`

向某个 agent 发送消息。工作中的 agent 会在下一个 step 收到消息；空闲的 agent 会以该消息开始新一轮。返回投递确认，而不是该 agent 的答案。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The agent id of your direct continuable child, or your direct parent when you are a resident continuable child."
    },
    "message": {
      "type": "string",
      "description": "The message to deliver to the agent."
    }
  },
  "required": [
    "agent_id",
    "message"
  ]
}
```

来源：[`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts)

这些是控制可继续后台 subagent 的全局命名工具：绑定提供方的 `tool-subagent` 实例注册不同的委派工具；本包注册一次 `send_message` 和 `interrupt_agent`，另由 `list_agents` 通过单独加载的 `/list-agents` 插件提供，其目录行使用 sessionProjections 和实时 Agent 注册表。

<a id="deepseek-aidsh-tool-jobs"></a>

## `@deepseek-ai/dsh-tool-jobs`

### `job_kill`

请求取消正在运行的后台任务。

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "reason": {
      "type": "string",
      "description": "Optional short reason, recorded in the log and forwarded to the job."
    }
  },
  "required": [
    "job_id"
  ]
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

### `job_list`

列出你的后台任务（包括正在运行和已完成的任务）及其 id、种类和状态。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

### `job_output`

读取后台任务：流式任务返回自上次读取以来的输出，已完成的最终输出任务返回其结果。

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "wait": {
      "type": "boolean",
      "description": "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false."
    },
    "timeout_ms": {
      "type": "number",
      "description": "Max wait in milliseconds with wait: true. Defaults to and is capped by configuration."
    }
  },
  "required": [
    "job_id"
  ]
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

与任务种类无关的后台任务控制器：后台 bash 命令、PTY 发送和 subagent 都通过相同的 3 个工具读取、列出和终止。加载该插件会挂接控制器，从而启用生产方的 `ctx.jobs.start()`。

<a id="deepseek-aidsh-experimental-tool-agent-team"></a>

## `@deepseek-ai/dsh-experimental-tool-agent-team`

### `interrupt_agent`

中断一名 teammate 的当前 turn，同时保留其待处理 inbox。仅 Team Lead 可用。

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Teammate target returned by spawn_teammate or list_agents."
    }
  },
  "required": [
    "target"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `list_agents`

列出 Lead 与所有持久 teammate，以及可用于寻址的 target 和当前可用状态。inactive 表示没有轮次在执行，不表示任务结果。provisioning 与 failed 描述成员创建状态。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `send_message`

向另一名 Team member 发送一条持久消息。running target 会在最近的步骤边界收到消息；inactive target 会启动或恢复一个 turn。

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Member target returned by spawn_teammate or list_agents, including lead."
    },
    "message": {
      "type": "string",
      "description": "Self-contained message for the target."
    }
  },
  "required": [
    "target",
    "message"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `spawn_teammate`

创建一名具名、持久的 teammate。只有 Team Lead 可以调用此工具。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Unique lower-kebab-case teammate name."
    },
    "description": {
      "type": "string",
      "description": "Short description of the delegated responsibility."
    },
    "prompt": {
      "type": "string",
      "description": "Complete initial task for the teammate."
    },
    "context": {
      "type": "string",
      "description": "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.",
      "enum": [
        "fresh",
        "fork"
      ]
    }
  },
  "required": [
    "name",
    "description",
    "prompt"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_create`

在共享 Team 任务板上创建一个无 owner 的 pending task。

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "Concise task title."
    },
    "description": {
      "type": "string",
      "description": "Complete task details and acceptance criteria."
    },
    "blocked_by": {
      "type": "array",
      "description": "Task ids that must complete first.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Advisory workspace-relative file or directory prefixes this task expects to modify.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "subject",
    "description"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_get`

在修改或执行共享任务前，读取其完整的最新值。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    }
  },
  "required": [
    "task_id"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_list`

列出共享任务，包括 readiness、owner、revision、blocker 与 write-scope warning。

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "description": "Optional exact status filter.",
      "enum": [
        "pending",
        "in_progress",
        "completed"
      ]
    },
    "owner": {
      "type": "string",
      "description": "Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner."
    },
    "ready": {
      "type": "boolean",
      "description": "Optional readiness filter."
    },
    "cursor": {
      "type": "integer",
      "description": "Zero-based result offset. Defaults to 0."
    },
    "limit": {
      "type": "integer",
      "description": "Number of rows, 1 through 100. Defaults to 50."
    }
  }
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_update`

使用 team_task_get 或 team_task_list 返回的最新 revision，对共享任务操作执行 compare-and-set。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    },
    "expected_revision": {
      "type": "integer",
      "description": "Current task revision used as the CAS precondition."
    },
    "action": {
      "type": "string",
      "description": "Task transition to apply.",
      "enum": [
        "claim",
        "release",
        "edit",
        "set_dependencies",
        "complete",
        "reopen",
        "reassign",
        "delete"
      ]
    },
    "subject": {
      "type": "string",
      "description": "Replacement title for edit."
    },
    "description": {
      "type": "string",
      "description": "Replacement details for edit."
    },
    "blocked_by": {
      "type": "array",
      "description": "Complete blocker list for set_dependencies.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Replacement advisory write scopes for edit.",
      "items": {
        "type": "string"
      }
    },
    "owner": {
      "type": "string",
      "description": "Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign."
    }
  },
  "required": [
    "task_id",
    "expected_revision",
    "action"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `wait_agent`

等待本次调用开始后下一次 teammate 状态、mailbox 或共享任务变更。它绝不会唤醒 inactive member；若没有其他 member 正在 running 或 provisioning，则立即返回 noProgress。唤醒或超时后应重新列出状态，而不是轮询。

```json
{
  "type": "object",
  "properties": {
    "timeout_ms": {
      "type": "integer",
      "description": "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."
    }
  }
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

这 10 个工具限定于隐式 Team Lead 与持久 teammate 作用域。随产品发布的 dsh-base bundle 默认禁用该包；文档中的 Agent Teams profile patch 会启用它，并禁用旧 continuable child 的同名控制工具。


<a id="deepseek-aidsh-tool-todo"></a>

## `@deepseek-ai/dsh-tool-todo`

### `todo_write`

记录并更新任务列表，用于规划多步骤工作并展示进度；简单的单步骤任务无需使用。开始前为每个具体步骤添加一项 todo。只要工作尚未完成，就将正在处理的 todo 标记为 `in_progress`，仅在工作并行运行时同时标记多项。某项 todo 完成后立即标记为 `completed`。

```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "description": "The COMPLETE task list, replacing any previous list.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "content": {
            "type": "string",
            "description": "What the task is — a short imperative line."
          },
          "status": {
            "type": "string",
            "description": "pending (not started) | in_progress (now) | completed (done).",
            "enum": [
              "pending",
              "in_progress",
              "completed"
            ]
          }
        },
        "required": [
          "content",
          "status"
        ]
      }
    }
  },
  "required": [
    "todos"
  ]
}
```

来源：[`packages/todo/tool-todo/src/index.ts`](../packages/todo/tool-todo/src/index.ts)

todo_write 是会话所有的状态；UI 将最新的 todo/write 事件渲染为检查清单。`allowParallelInProgress` 是没有默认值的必填项，因此本目录明确选择 `true`，对应描述允许同时存在多个 `in_progress` 项。选择 `false` 的部署会获得同一工具，但描述会要求只能有 1 个活动任务。

<a id="deepseek-aidsh-tool-workflow"></a>

## `@deepseek-ai/dsh-tool-workflow`

### `workflow`

运行用于大规模编排 subagent 的 JavaScript 工作流脚本。当工作会分散到许多相互独立的部分时，请使用此工具，例如审查大量文件、执行迁移、开展多角度研究或对发现进行对抗式验证；此时应将编排写成脚本，而不是逐轮委派。

脚本函数体提供以下钩子：

- `agent(prompt, opts?): Promise<any>`：运行一个 subagent 直至完成。不提供 `opts.schema` 时，解析为子级最终文本；提供 `opts.schema` 时，它必须是以对象为根、且**只能**使用 type/properties/required/additionalProperties/items/enum/const/oneOf 的 JSON Schema，不支持 pattern/format/数值边界，此时解析为通过校验的对象，而且子级必须调用它的 `structured_output` 工具上报：子级用纯文本作答的 `schema` 调用会解析为 `null`。提示词里如果自己写了返回格式，那段文字描述的是载荷，永远不是上报通道。子级失败时解析为 `null`，可使用 `.filter(Boolean)` 过滤。其他选项包括 `label`（显示名称）、`phase`（进度组），以及相互独立的 `provider`／`model` LLM（大语言模型）目标覆盖项，两者可单独提供。其他任何选项（`effort`／`isolation`／`agentType`）都会明确报错。
- `pipeline(items, ...stages): Promise<any[]>`：让每个条目分别经过各阶段，阶段之间**没有**屏障；多阶段工作优先使用它。每个阶段接收 `(prev, item, index)`。普通的阶段异常会将该**条目**变为 `null`，并跳过它的剩余阶段。
- `parallel(thunks): Promise<any[]>`：并发运行零参数函数并等待**全部**完成。它会形成屏障，仅当某个阶段确实需要汇总全部先前结果时使用。抛出异常的 thunk 解析为 `null`。
- `phase(title)`：开始一个进度阶段；`log(message)`：说明进度；`args`：工具调用的 `args` 输入，原样提供。

如果误用钩子（参数错误、未知选项、不受支持的 schema、触发上限），整个脚本会终止，而不会产生 `null`。脚本没有文件系统、网络、定时器或 Node.js API；具体工作由 agent 完成。

```json
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "description": "The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. End with `return <value>`; the JSON-serializable value is this tool's result."
    },
    "meta": {
      "type": "object",
      "description": "The workflow identity as plain JSON, not code.",
      "additionalProperties": true,
      "properties": {
        "name": {
          "type": "string",
          "description": "Short kebab-case workflow name."
        },
        "description": {
          "type": "string",
          "description": "One-line description of what the workflow does."
        },
        "whenToUse": {
          "type": "string",
          "description": "Optional guidance on when this workflow applies."
        },
        "phases": {
          "type": "array",
          "description": "Optional phase declarations matched by phase() calls.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "title": {
                "type": "string",
                "description": "The phase title phase() calls match by exact string."
              },
              "detail": {
                "type": "string",
                "description": "Optional one-line description of the phase."
              },
              "provider": {
                "type": "string",
                "description": "Optional provider override this phase is expected to use."
              },
              "model": {
                "type": "string",
                "description": "Optional model override this phase is expected to use."
              }
            },
            "required": [
              "title"
            ]
          }
        }
      },
      "required": [
        "name",
        "description"
      ]
    },
    "args": {
      "type": "object",
      "description": "Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {\"files\": [...]}).",
      "additionalProperties": true
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice."
    }
  },
  "required": [
    "script",
    "meta"
  ]
}
```

来源：[`packages/workflow/tool-workflow/src/index.ts`](../packages/workflow/tool-workflow/src/index.ts)

<a id="deepseek-aidsh-tool-workspace-dependencies"></a>

## `@deepseek-ai/dsh-tool-workspace-dependencies`

### `load_workspace_dependencies`

获取随包附带的 Python 和库目录的绝对路径，以及随包 Python 发行版的版本。payload 提供 Node.js 和 pnpm 时才返回对应路径。Python 含 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml 与 XlsxWriter。除非用户或工作区指令选择了别的环境，Office 文件请使用这些库。返回 Node.js 和 pnpm 路径时，用该 Node 可执行文件和 pnpm 脚本路径运行 pnpm。本工具不改 PATH，也不改包管理器设置。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/skill/tool-workspace-dependencies/src/index.ts`](../packages/skill/tool-workspace-dependencies/src/index.ts)

<a id="deepseek-aidsh-tool-web"></a>

## `@deepseek-ai/dsh-tool-web`

### `web_fetch`

获取指定 HTTP(S) URL 的内容，并将其解码为文本后返回。

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The HTTP(S) URL to fetch."
    }
  },
  "required": [
    "url"
  ]
}
```

来源：[`packages/web/tool-web/src/index.ts`](../packages/web/tool-web/src/index.ts)

### `web_search`

在 Web 上搜索最新信息。返回可选的摘要答案和来源 URL 列表。

```json
{
  "type": "object",
  "properties": {
    "queries": {
      "type": "array",
      "description": "1–4 search queries; their results are merged.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "queries"
  ]
}
```

来源：[`packages/web/tool-web/src/index.ts`](../packages/web/tool-web/src/index.ts)

web_search 和 web_fetch 将提供方选择置于 ctx.web 之后，使模型可见 schema 在更换后端时保持稳定。

<a id="deepseek-aidsh-tool-jubian"></a>

## `@deepseek-ai/dsh-tool-jubian`

### `jubian_asset`

剧变（Jubian）主体设定与资产的查询、确认出演与删除。get/list/materials/generated_image 只读。**confirm_casting 有副作用**：它用 GET 动词改变了远端状态，会使该材质被本次制作采用。它同样需要 idempotency_key，且不要重试。**remove 会不可恢复地删除一个父资产**（`DELETE /aigc/asset/removeAsset/{id}`，带 scriptId 与 isParent=1）：资产与其媒体版本会被移除，引用它的镜头匹配与已生成视频不会因此重建。**如果只是想取消"正式选用"，不要用 remove** —— 那是一个不同的动作。**create_folder / move / rename 会改变控制台里的组织方式**（都在 `/aigc/*` 上真实写入）：create_folder 建一个类别库里的文件夹，同名同级已存在时直接报告、不发请求；move 把材质行移进文件夹，目标文件夹不在该库里时同样只报告；rename 改资产的显示名称。三者都需要 idempotency_key，都不改图片、不改 id、不换类别。**批量改名或搬家前必须先取得用户明确同意**：这些是用户已经在控制台里看到的名字和位置。**upload_reference 免费**：把本地参考图（jpg/jpeg/png/webp）按剧变前端自身的上传配置送到它的对象存储，返回 HTTPS material_url —— gpt-image-2 的参考图只接受 URL。两条边必须是 16 的倍数：已合规的文件原样上传，不合规时调用本机 ffmpeg 重编码（可用 DSH_JUBIAN_FFMPEG/FFMPEG_PATH 指定二进制）；本机找不到 ffmpeg 时返回 alignment_required 并给出应有的尺寸，绝不上传不合规的图片。写方法必须提供 idempotency_key（批量方法在每个项目里提供）：同一请求的同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）；不同请求不能复用 key。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "get=单个资产（含 is_local/status）；list=项目资产分页；materials=主体设定材质；generated_image=该资产的生成图 URL；confirm_casting=确认出演（有副作用）；register=按指定类别新建一条资产，只引用已有图片、不生成新图（有副作用）；remove=删除一个父资产（不可恢复）；upload_reference=上传本地参考图并取回 material_url（免费）；create_folder=在某个类别库里建文件夹；move=把资产移动进文件夹；rename=给资产改名。",
      "enum": [
        "get",
        "list",
        "materials",
        "generated_image",
        "confirm_casting",
        "register",
        "remove",
        "upload_reference",
        "create_folder",
        "move",
        "rename"
      ]
    },
    "script_id": {
      "type": "number",
      "description": "剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，不必单独提供；其余方法按上面的必填说明传入。"
    },
    "asset_id": {
      "type": "number",
      "description": "get / generated_image 必填：主体资产 ID。"
    },
    "material_id": {
      "type": "number",
      "description": "confirm_casting 必填：生成材质 ID（不是父资产、不是任务 ID）。"
    },
    "page_num": {
      "type": "number",
      "description": "页码，默认 1。"
    },
    "page_size": {
      "type": "number",
      "description": "每页条数，默认 20，上限 1000。"
    },
    "idempotency_key": {
      "type": "string",
      "description": "写方法必填；读方法忽略。写方法必须提供 idempotency_key（批量方法在每个项目里提供）：同一请求的同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）；不同请求不能复用 key。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。"
    },
    "image_path": {
      "type": "string",
      "description": "upload_reference 必填：本地参考图路径（jpg/jpeg/png/webp）。"
    },
    "folder_name": {
      "type": "string",
      "description": "create_folder 必填：文件夹名，例如 `EP05`。"
    },
    "parent_id": {
      "type": "number",
      "description": "create_folder 可选：父文件夹 ID；省略则建在该类别库的根下（根自己的 ID 就是 root_category_type 的数字）。"
    },
    "asset_scope_type": {
      "type": "number",
      "description": "create_folder / move 必填：1=团队资产，2=个人资产。资产在哪个库就在哪个库建夹与移动。",
      "enum": [
        1,
        2
      ]
    },
    "root_category_type": {
      "type": "number",
      "description": "create_folder / move 必填：1=角色库，2=场景库，3=道具库。move 只用它在本地读文件夹树做前置校验，请求体仍与前端一致（不发这个字段）。",
      "enum": [
        1,
        2,
        3
      ]
    },
    "material_ids": {
      "type": "array",
      "description": "move 必填：要移动的材质行 ID（素材列表里每行的 id，不是父 asset_id）。",
      "items": {
        "type": "number"
      }
    },
    "target_folder_id": {
      "type": "number",
      "description": "move 必填：目标文件夹 ID；要放回库根目录就传该库的 root_category_type 数字。"
    },
    "asset_name": {
      "type": "string",
      "description": "image_generate 必填、rename 必填：资产名。给了 episode 时这里只写资产自己的名字（如 `红包`），插件按规范补齐前缀与类别段；不给 episode 时原样发送。rename 发送的就是最终的完整名称。"
    },
    "episode": {
      "type": "string",
      "description": "可选：集号（`5` 与 `05` 都规范成 `EP05`）或配置的跨集母版标记（默认「全剧」）。给了它，资产名会按规范组合成 `EP05｜角色｜陆沉舟`，处理任务名会加上 `EP05-P3-` 这样的可排序前缀；不给就完全按调用方原样使用 asset_name / task_name。"
    },
    "asset_category": {
      "type": "string",
      "description": "资产类别。与 episode 同时给出时决定资产名里的类别段，并决定 image_generate 的 assetType（角色=1、场景=2、道具=3）——场景与道具必须传对应类别，否则资产会落进控制台的角色库。",
      "enum": [
        "角色",
        "场景",
        "道具"
      ]
    },
    "asset_type": {
      "type": "number",
      "description": "image_generate 的资产类别号：1=角色，2=场景，3=道具。给了 asset_category 时可以不传（插件按类别推导）；两个都给时必须一致。场景与道具必须传 2/3——一律传 1 会把它们建进控制台的角色库。",
      "enum": [
        1,
        2,
        3
      ]
    },
    "asset_url": {
      "type": "string",
      "description": "register 必填：这条新资产要引用的图片 HTTPS 地址（通常是原资产的 materialUrl）。register 按它新建资产，不生成新图。"
    }
  },
  "required": [
    "method"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_catalog`

剧变（Jubian）目录与项目只读查询：账户模型目录与报价、剧本、分集。全部只读，不产生费用。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "models=账户模型目录；rate=单个计价标准；script=剧本身份；episodes=分集列表。",
      "enum": [
        "models",
        "rate",
        "script",
        "episodes"
      ]
    },
    "task_type": {
      "type": "number",
      "description": "models 必填：1=视频，2=图片，10=去字幕。"
    },
    "standard_id": {
      "type": "number",
      "description": "rate 必填：计价标准 ID。"
    },
    "script_id": {
      "type": "number",
      "description": "剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，不必单独提供；其余方法按上面的必填说明传入。"
    },
    "page_num": {
      "type": "number",
      "description": "页码，默认 1。"
    },
    "page_size": {
      "type": "number",
      "description": "每页条数，默认 20，上限 1000。"
    }
  },
  "required": [
    "method"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_claim`

剧变剧本池单本操作：inspect 只读；claim 会真实认领，必须有用户对该 ID 的明确授权与当前账号 canClaim=1。按 viewRole 选择认领端点；写前记账。未知结果只读对账，不换 key 重投。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "inspect=只读查看该 ID 对当前账号是否可领；claim=经用户明确授权后认领一次。",
      "enum": [
        "inspect",
        "claim"
      ]
    },
    "script_id": {
      "type": "integer",
      "description": "用户明确授权查看或认领的剧本池 ID。"
    },
    "idempotency_key": {
      "type": "string",
      "description": "claim 必填；复核同一笔时保持原 key。inspect 不需要。"
    },
    "authorization_basis": {
      "type": "string",
      "description": "claim 必填：简述用户原话中对这个 ID 的明确认领授权；不能由查询结果或代理自己推定。inspect 不需要。"
    }
  },
  "required": [
    "method",
    "script_id"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_find`

按名字查找剧变（Jubian）剧本。只读、免费，不需要 idempotency_key，也不改变任何远端状态。两个 scope：mine=你自己名下的画布项目（`GET /aigc/script/list`）；pool=可认领的剧本池（`GET /script/center/pool/list`）。name 先去掉首尾空白、把内部连续空白并成一个空格、忽略大小写，再同时匹配 scriptName 与 manuscriptName 的子串——没有拼音、别名或模糊匹配，差一个字就是没找到。page_size 只限制单次请求的条数，不是扫描上限：工具会一直翻页，直到读完 total、某一页为空，或达到 scan_page_limit（页数上限，返回值里有）。complete=false 表示这次没有覆盖 total（或用了页数上限），不要读成"就这些"；scanned_pages 是实际请求的页数。returned 是本次返回的匹配数，truncated=true 表示匹配列表被输出上限截断（扫描本身可能已完整）。每条匹配给出 script_id、script_name、manuscript_name、episode_count、status 与 script_style；scope=pool 时另有 can_claim、claim_leader_name、claim_member_name，但没有 script_style——这个字段只有 mine 的行被实测到。省略 name 就是列出该 scope 的第一页（page_size 条），不是错误。status 只对 pool 有效，会原样作为查询参数转发；给 mine 传 status 会被拒绝，不会静默忽略。production_type 与 share_target_type 只对 mine 有效，同样原样转发为 productionType 与 shareTargetType；控制台打开「漫剧视频」时发的就是 productionType=0 + shareTargetType=1，要列漫剧项目就传这两个值。两个取值都是提供方自己的编码，本工具不解释、不校验、也不设默认值，省略就不出现在查询串里；给 pool 传会被拒绝。它不写账本、不检查预算、不重试。响应读不懂时直接报 CONTRACT_CHANGED，绝不把读不懂的响应当成"没找到"——漏本和没本必须能区分。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "mine=自己名下的画布项目；pool=可认领的剧本池。必填，两者只能选一个。",
      "enum": [
        "mine",
        "pool"
      ]
    },
    "name": {
      "type": "string",
      "description": "可选：要查的名字片段，同时匹配 scriptName 与 manuscriptName 的子串。先去掉首尾空白、内部连续空白并成一个空格、忽略大小写；不支持拼音、别名与模糊匹配。省略就是列出该 scope 的第一页。空白字符串会被拒绝。"
    },
    "page_num": {
      "type": "number",
      "description": "可选：从第几页开始扫描，默认 1。它会同时决定 completeness 的起点：第 2 页起要读完的仍是 total 里剩下的部分。"
    },
    "page_size": {
      "type": "number",
      "description": "可选：单次请求的条数，默认 20，上限 1000。它只限制一次请求，不限制整次扫描——扫描会翻页读到 total 或达到 scan_page_limit。结果太大时用它调小每次请求。"
    },
    "status": {
      "type": "string",
      "description": "可选，仅 scope=pool：按池子状态过滤，原样转发（例如 returned、claimed、pending_leader_claim）。状态名由提供方定义，本工具不解释也不校验。"
    },
    "production_type": {
      "type": "number",
      "description": "可选，仅 scope=mine：按提供方自己的 productionType 编码过滤，原样转发为查询参数 productionType。控制台打开「漫剧视频」时发的是 productionType=0，所以要列漫剧项目就传 0；这个编码由提供方定义，本工具不解释也不校验取值，省略就不出现在查询串里。"
    },
    "share_target_type": {
      "type": "number",
      "description": "可选，仅 scope=mine：按提供方自己的 shareTargetType 编码过滤，原样转发为查询参数 shareTargetType。控制台打开「漫剧视频」时发的是 shareTargetType=1，所以要列漫剧项目就传 1；这个编码由提供方定义，本工具不解释也不校验取值，省略就不出现在查询串里。"
    }
  },
  "required": [
    "scope"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_media`

把剧变（Jubian）CDN 上的媒体下载到本地文件，返回本地路径、字节数与 sha256。不产生费用、不需要凭证（该 CDN 是公开的）。下载后请用你自己的看图工具（如 read_image）或抽帧工具读取该路径——本工具不会把图片或视频内容放进返回值。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "download=从 media_url 下载到 output_path。",
      "enum": [
        "download"
      ]
    },
    "media_url": {
      "type": "string",
      "description": "media 必填：剧变 CDN 上的媒体 URL（来自其他方法的返回值）。"
    },
    "media_kind": {
      "type": "string",
      "description": "media 必填：要下载的是图片还是视频。",
      "enum": [
        "image",
        "video"
      ]
    },
    "output_path": {
      "type": "string",
      "description": "media 必填：落盘的本地绝对路径。"
    }
  },
  "required": [
    "method",
    "media_url",
    "media_kind",
    "output_path"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_model`

免费配置现有分镜的视频模型与分辨率。preview 只读实时目录和分镜，按明确范围写本地冻结计划，返回每项 before/after 与 fingerprint；不 PUT、不生成。scope=storyboards 使用远端 storyboard_ids，episodes 使用远端 episode_ids（不是集号），project 仅包含当前项目已有分镜。仅查询分镜用 jubian_storyboard list/get；preview 用于修改设置预览，不用它探测空项目，也不更换项目绑定来排错。apply 必须先取得用户对范围和配置的同意，使用 preview_path 与 idempotency_key=fingerprint。写前校验全部目标、成员和目录，每项再即时回读；只改 modelConfig 模型字段，所有 PUT 强制 isGenerate=0，保留提示词、资产身份和顺序、非模型设置，回读核验。未提供的设置保留，不会默认切换模型；更换模型未指定 platformId 时要求目录唯一匹配，否则拒绝。项目未来默认值和已生成媒体不变。错误或超时立即停止剩余项并逐项报告；同一计划不会重发或续写，先回读对账，不要换 key 盲目重试。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "preview=只读预览并落冻结计划；apply=应用用户批准的计划（免费，不生成）。",
      "enum": [
        "preview",
        "apply"
      ]
    },
    "project_dir": {
      "type": "string",
      "description": "含 project_config.json 的项目目录。"
    },
    "script_id": {
      "type": "number",
      "description": "必须与 project_config.json 及所有目标一致的远端项目 ID。"
    },
    "scope": {
      "type": "string",
      "description": "preview 必填：已有分镜的明确范围。",
      "enum": [
        "storyboards",
        "episodes",
        "project"
      ]
    },
    "storyboard_ids": {
      "type": "array",
      "description": "storyboards 范围必填：精确远端分镜 ID，不能重复。",
      "items": {
        "type": "number"
      }
    },
    "episode_ids": {
      "type": "array",
      "description": "episodes 范围必填：精确远端 episodeId，不是显示集号。",
      "items": {
        "type": "number"
      }
    },
    "changes": {
      "type": "object",
      "description": "preview 必填：至少一项。未指定字段保留，目录中不支持或不唯一时拒绝。",
      "additionalProperties": false,
      "properties": {
        "modelId": {
          "type": "string",
          "description": "账户视频目录中的精确模型 ID，不接受别名或默认替换。"
        },
        "platformId": {
          "type": "string",
          "description": "明确指定的平台；换模型时省略则要求唯一匹配。"
        },
        "ratio": {
          "type": "string",
          "description": "目录支持的比例，例如 9:16。"
        },
        "resolution": {
          "type": "string",
          "description": "目录支持的分辨率，例如 720p、1080p。"
        },
        "genType": {
          "type": "number",
          "description": "目录支持的生成类型。"
        },
        "duration": {
          "type": "number",
          "description": "模型允许的整数秒数，包含末尾自然收束：SD2.0 为4–15秒，SD2.5 为4–30秒，具体修订须已核实。按每包内容确定，不必填满上限。未提供时保留各分镜已存时长；未保存时长的分镜必须按该包内容补齐，不能为探测随意填数。"
        },
        "genNum": {
          "type": "number",
          "description": "目录支持的生成数量。"
        }
      }
    },
    "preview_path": {
      "type": "string",
      "description": "apply 必填：preview 返回的冻结计划路径。"
    },
    "idempotency_key": {
      "type": "string",
      "description": "apply 必填：必须等于计划 fingerprint；同计划永不重发。"
    }
  },
  "required": [
    "method",
    "project_dir",
    "script_id"
  ]
}
```

Source: [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_organize`

只读、免费的资产组织视图：把剧变项目按「集数 → 类别」列出（每集用到哪些角色/场景/道具，各自的 asset_id、material_id 与状态），并做两份审计——不符合 `EP{两位集数}｜{类别}｜{名称}` 规范的远端名称，以及 assetType 与自身名字或清单声明不一致的资产（历史遗留的类别错放）。同时读出个人资产库里每个类别的文件夹树。**它只读：不重命名、不移动、不改动任何远端资产**，结果同时写一份本地索引文件。要改，用 jubian_asset 的 create_folder / move / rename，且批量操作前先取得用户同意。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "index=按集数与类别输出组织视图，并写本地索引文件。",
      "enum": [
        "index"
      ]
    },
    "script_id": {
      "type": "number",
      "description": "剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，不必单独提供；其余方法按上面的必填说明传入。"
    },
    "project_dir": {
      "type": "string",
      "description": "prepare_video 必填、submit_video 可选：项目目录，必须含 project_config.json，且其 jubian_script_id 必须等于实时 scriptId。"
    }
  },
  "required": [
    "method",
    "script_id",
    "project_dir"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_snatch`

剧变剧本池有界后台认领。只有用户明确授权目标范围和 UTC 时间窗口才启动；每本仅在当前账号 canClaim=1 时尝试一次。返回 job_id，用 job_output 查看；job_kill 只停后续尝试，已提交认领不会撤销，进程重启不恢复。未知结果先只读对账，不换 key 重投。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "ids=仅指定 ID；new_claimable=与作业启动时完整池子基线比较，只取新增且 canClaim=1 的剧本。两种范围均需用户明确授权。",
      "enum": [
        "ids",
        "new_claimable"
      ]
    },
    "script_ids": {
      "type": "array",
      "description": "scope=ids 必填：用户授权的正整数 ID 列表，不能重复；new_claimable 时必须省略。",
      "items": {
        "type": "integer"
      }
    },
    "start_at": {
      "type": "string",
      "description": "开始时间，UTC ISO 格式，例如 2026-09-28T12:00:00.000Z。"
    },
    "end_at": {
      "type": "string",
      "description": "结束时间，UTC ISO 格式；必须晚于开始且在部署窗口上限内。"
    },
    "idempotency_prefix": {
      "type": "string",
      "description": "本次授权窗口唯一非空前缀；每本的 ledger key 是 <前缀>/<script_id>。恢复核对时复用原前缀。"
    },
    "authorization_basis": {
      "type": "string",
      "description": "简述用户原话中对本次目标范围和时间窗口的明确授权；不能把查询结果当成授权。"
    }
  },
  "required": [
    "scope",
    "start_at",
    "end_at",
    "idempotency_prefix",
    "authorization_basis"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_storyboard`

剧变（Jubian）分镜查询与提交。list/get/create/save 免费（create/save 强制 isGenerate=0）。list 按当前 script_id 分页查询分镜 ID 与分集归属，空列表正常，不需要模型设置、本地项目文件或用户手工样本。**generate、erase_subtitle 与 submit_video 会真实计费且不可撤销**。generate 先读当前分镜快照再把 isGenerate 置 1 提交，因此必须同时给出 content_duration_ms，且它必须与该分镜已保存的时长一致，否则会在发请求前失败。**主体视频的唯一正常通道是 select_assets(isGenerate=0) → prepare_video → submit_video**：select_assets 的素材按提示词 key 首次出现的顺序选一次，提示词后文可重复引用同一 key。选定资产写进分镜，永远强制 isGenerate=0（免费），PUT 后回读身份/URL/名称/顺序；prepare_video 只读实时分镜、主体设定与模型目录，保留已存 modelId/比例/分辨率/时长，按精确模型 ID 解析当前目录；不支持、匹配不唯一或超过该模型时长上限时拒绝，不自动换模型，在 <project_dir>/video_tasks/ 原子写一份 *.storyboard-native.prepared.json，不 PUT、不创建任务、不收费；submit_video 的 idempotency_key 必须等于该 preview 自带的 fingerprint，PUT 前做远端任务全量双快照对账，确认无冲突后最多执行一次 PUT /aigc/storyboard（isGenerate=1），随后第二次快照回读每个子项的 assetId/materialName/imageUrl 与顺序；身份缺失是终态 subject_identity_lost，超时/5xx/连接中断/缺 task ID 只进入对账状态，绝不自动二次 PUT。模型和平台沿用 jubian_catalog script 返回的 project_settings；未核实时长能力时报告缺项，不能换模型绕过。Agent 按 models 当前价格与用量提供每包 estimated_cost_cny 和 estimate_basis，在项目默认预算内分配，不让用户手填单次估价。submit_video_batch 先核查本次提交清单中的全部 preview 与总预算，任一失败则零 PUT；全部通过后同轮有界并行提交不同分镜，按各项原 key 对账；未知结果不重投。**禁止 direct POST /admin/aigc/video/task/create**（任务 335470 因此丢失主体身份）；storyboard PUT 创建的 335343 保留了全部七项身份。**erase_subtitle 必填 task_id、model_id 与画面尺寸**（script_id 从任务行读取）：源身份从父任务与子结果读，擦除矩形按提供方的默认比例从画面尺寸推导，不需要也不应该由调用方画框。model_id 没有默认值，省略会在发任何请求之前报 INVALID_ARGUMENT，不会静默替你挑一个模型。它与转高清一样是异步的，提交后不要干等——先做别的，之后用 subtasks 回读判断。写方法必须提供 idempotency_key（批量方法在每个项目里提供）：同一请求的同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）；不同请求不能复用 key。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "list=按 script_id 分页读已有分镜；get=读分镜（含 model_config 与素材键）；create=按 body 字段说明新建；create_batch=整批预检后并行免费创建分镜；save=存为不生成；generate=提交生成（计费）；select_assets=写入选定资产（免费，强制 isGenerate=0）；prepare_video=只读准备并落 preview（免费）；submit_video=按 preview 提交一次（计费、异步）；submit_video_batch=整包预检后并行提交多个独立分镜（逐项计费、异步）；erase_subtitle=去字幕（计费、异步）。",
      "enum": [
        "list",
        "get",
        "create",
        "create_batch",
        "save",
        "generate",
        "select_assets",
        "prepare_video",
        "submit_video",
        "submit_video_batch",
        "erase_subtitle"
      ]
    },
    "storyboard_id": {
      "type": "number",
      "description": "分镜 ID。"
    },
    "content_duration_ms": {
      "type": "number",
      "description": "generate 必填：本包内容时长，4000–14000 的整千毫秒。"
    },
    "page_num": {
      "type": "number",
      "description": "页码，默认 1。"
    },
    "page_size": {
      "type": "number",
      "description": "每页条数，默认 20，上限 1000。"
    },
    "task_id": {
      "type": "number",
      "description": "task / subtasks 必填：视频任务 ID。"
    },
    "script_id": {
      "type": "number",
      "description": "剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，不必单独提供；其余方法按上面的必填说明传入。"
    },
    "model_id": {
      "type": "string",
      "description": "erase_subtitle 必填：quzimuToB（羽点，区域性）或 ark-erase-video-subtitle-pro（自动）。插件不设默认值——省略即在发请求前报错，不会替你挑一个模型。"
    },
    "task_name": {
      "type": "string",
      "description": "erase_subtitle 可选：任务名，省略时按「<源任务名>-去字幕」生成。"
    },
    "episode": {
      "type": "string",
      "description": "可选：集号（`5` 与 `05` 都规范成 `EP05`）或配置的跨集母版标记（默认「全剧」）。给了它，资产名会按规范组合成 `EP05｜角色｜陆沉舟`，处理任务名会加上 `EP05-P3-` 这样的可排序前缀；不给就完全按调用方原样使用 asset_name / task_name。"
    },
    "package_number": {
      "type": "string",
      "description": "erase_subtitle / upscale 可选：本集内的包号，配合 episode 生成 `EP05-P3` 前缀。"
    },
    "video_width": {
      "type": "number",
      "description": "erase_subtitle 必填：画面宽度。"
    },
    "video_height": {
      "type": "number",
      "description": "erase_subtitle 必填：画面高度。"
    },
    "subtitle_box": {
      "type": "object",
      "description": "erase_subtitle 可选：{zimuLeft,zimuTop,zimuWidth,zimuHeight}。省略时按画面尺寸推导提供方默认比例——通常不要传，工作台的预览坐标无法由调用方复现。",
      "additionalProperties": true
    },
    "storyboards": {
      "type": "array",
      "description": "create_batch 必填：先写好并检查全部包的提示词与 body，再一次传入整批。每项独立 key、body 或 body_path；默认最多 1000 项，并发 4 项提交，无需等待逐项完成。字段见 body。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "idempotency_key": {
            "type": "string",
            "description": "本项固定重放键；不得重复。"
          },
          "body": {
            "type": "object",
            "description": "create 与 body_path 二选一。创建字段：scriptId=当前项目远端 ID；episodeId=jubian_catalog episodes 返回的真实分集 ID（不是集号）；episodeCount=显示集号；scriptName=项目名；storyboardName=包名，如 EP01-P1；sortOrder=从 0 开始的包序号；isGenerate=0。视频模型、平台、比例、分辨率和风格沿用当前项目；每包 duration 按镜头内容计算，不能照抄项目默认时长。modelConfig 是 JSON 字符串：包含完整包 prompt、duration（整数秒，含收束）、modelId、platformId、ratio、resolution、genType、genNum=1、standardId、modelGenerationTypeId、videoStandardId；模型与选择器取当前 jubian_catalog models(task_type=1)，不要抄历史 ID。提示词必须写入 modelConfig.prompt，不能只放顶层 prompt；在提示词开头按素材顺序各写一次 @[素材名](material_key)，后续 selections 使用相同 key 和顺序。get 的 model_config.prompt 是保存的提示词，material_keys 来自已绑定素材；新分镜 material_keys 为空不代表提示词为空。主体素材后续用 select_assets 写入；新建不要复制旧记录的 id、任务列表或账号字段。创建后从响应取 ID 并 get 回读核对提示词，再继续下一批；无需用户先手工创建样本。",
            "additionalProperties": true
          },
          "body_path": {
            "type": "string",
            "description": "create 与 body 二选一：按 body 的字段说明生成并检查的本地 UTF-8 JSON 文件路径；一包一份请求体。"
          }
        },
        "required": [
          "idempotency_key"
        ]
      }
    },
    "body": {
      "type": "object",
      "description": "create 与 body_path 二选一。创建字段：scriptId=当前项目远端 ID；episodeId=jubian_catalog episodes 返回的真实分集 ID（不是集号）；episodeCount=显示集号；scriptName=项目名；storyboardName=包名，如 EP01-P1；sortOrder=从 0 开始的包序号；isGenerate=0。视频模型、平台、比例、分辨率和风格沿用当前项目；每包 duration 按镜头内容计算，不能照抄项目默认时长。modelConfig 是 JSON 字符串：包含完整包 prompt、duration（整数秒，含收束）、modelId、platformId、ratio、resolution、genType、genNum=1、standardId、modelGenerationTypeId、videoStandardId；模型与选择器取当前 jubian_catalog models(task_type=1)，不要抄历史 ID。提示词必须写入 modelConfig.prompt，不能只放顶层 prompt；在提示词开头按素材顺序各写一次 @[素材名](material_key)，后续 selections 使用相同 key 和顺序。get 的 model_config.prompt 是保存的提示词，material_keys 来自已绑定素材；新分镜 material_keys 为空不代表提示词为空。主体素材后续用 select_assets 写入；新建不要复制旧记录的 id、任务列表或账号字段。创建后从响应取 ID 并 get 回读核对提示词，再继续下一批；无需用户先手工创建样本。",
      "additionalProperties": true
    },
    "body_path": {
      "type": "string",
      "description": "create 与 body 二选一：按 body 的字段说明生成并检查的本地 UTF-8 JSON 文件路径；一包一份请求体。"
    },
    "idempotency_key": {
      "type": "string",
      "description": "写方法必填；读方法忽略。写方法必须提供 idempotency_key（批量方法在每个项目里提供）：同一请求的同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）；不同请求不能复用 key。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。"
    },
    "selections": {
      "type": "array",
      "description": "select_assets 必填：有序的 (material_key, 父 asset_id) 列表，顺序必须与提示词里的 key 顺序完全一致。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "material_key": {
            "type": "string",
            "description": "提示词里 @[名称](key) 的 key。"
          },
          "asset_id": {
            "type": "number",
            "description": "主体设定行的父资产 ID（materials 返回的 asset_id）。"
          }
        },
        "required": [
          "material_key",
          "asset_id"
        ]
      }
    },
    "project_dir": {
      "type": "string",
      "description": "prepare_video 必填、submit_video 可选：项目目录，必须含 project_config.json，且其 jubian_script_id 必须等于实时 scriptId。"
    },
    "preview_path": {
      "type": "string",
      "description": "submit_video 必填：prepare_video 返回的 preview_path，不要猜测或手写文件名。"
    },
    "video_previews": {
      "type": "array",
      "description": "submit_video_batch 必填：本次提交清单中同项目不同分镜的预览；先逐项预检与总预算预约，再有界并行提交。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "estimated_cost_cny": {
            "type": "string",
            "description": "本包预计费用（人民币十进制字符串）。由 Agent 按项目所选模型的实时目录价格、包时长/用量或同规格已结算费用估算；不是让用户填写，也不改变每项目默认4000元额度。"
          },
          "estimate_basis": {
            "type": "string",
            "description": "本包估价依据：模型/平台、价格单位、时长/用量假设或同规格实际费用。提供估价时必填；估算不是实际结算金额。"
          },
          "preview_path": {
            "type": "string",
            "description": "本项 prepare_video 返回的预览文件。"
          },
          "idempotency_key": {
            "type": "string",
            "description": "本项 preview 自带的 fingerprint；重放保持原 key。"
          }
        },
        "required": [
          "preview_path",
          "idempotency_key"
        ]
      }
    },
    "estimated_cost_cny": {
      "type": "string",
      "description": "本包预计费用（人民币十进制字符串）。由 Agent 按项目所选模型的实时目录价格、包时长/用量或同规格已结算费用估算；不是让用户填写，也不改变每项目默认4000元额度。"
    },
    "estimate_basis": {
      "type": "string",
      "description": "本包估价依据：模型/平台、价格单位、时长/用量假设或同规格实际费用。提供估价时必填；估算不是实际结算金额。"
    }
  },
  "required": [
    "method"
  ]
}
```

Source: [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_video`

剧变（Jubian）视频任务查询与图片生成。task/tasks/subtasks 只读（subtasks 用 POST 承载查询体，仍然只读；它返回成片 videoUrl 与字幕像素框）。**image_generate 会真实计费且不可撤销**：生成或重生成一张主体资产图；给了 parent_asset_id 就是重生成（PUT），否则新建（POST）。它只在同一个 idempotency_key 下发送一次，并在受理后回读该资产直到 hsAssetStatus 变为 Active，然后返回 material_id（confirm_casting 需要它）与 image_url。返回里的 asset_status 说明回读结论：active 才是拿到图（此时才可落盘/审核）；timeout 表示受理已计费但资产尚未 Active，不要换 key 重投，稍后用 jubian_asset get/generated_image 续读；failed 表示提供方判失败；unverified 表示没能确认资产，先回读 jubian_asset list。**image_generate_batch 会真实计费且不可撤销**：短剧门禁在整批开始前核对项目资产对账证据。工具先检查同一项目的全部图片提示词与资产身份，再一次读取实时目录核对全部所选通道。随后按配置的并发上限逐项提交计费请求，全部提交返回后再并发回读图像；慢轮询不会占用提交槽。每项独立 idempotency_key、预算占用与账本记录；返回顺序与 items 一致；每项 status=returned 只表示调用返回，是否拿到图仍看 asset_status=active。逐项给出 outcome、回读状态和错误。任何一项超时或结果未知都先按原 key 对账，不能换 key 重投。账户目录里 gpt-image-2 可能有多行（不同平台、不同单价）；插件不替你挑平台：没有锁定行而目录多于一行时，请求体构造阶段就会报错并列出全部候选行（platformId、standardId、单价）。锁定行由人在 Web 设置的「短剧 → 资产图生成通道」里选，或由部署在插件配置里给 imagePlatformId/imageStandardId；本次改道可显式给 image_platform_id。遇到未锁定的多候选时把候选念给用户，请他在设置里选一行，不要自己挑。**upscale 会真实计费（SeedVR2 视频高清，1 元/条）**：把成片转成 1080p。SD2.5 默认使用原片，不自动提交或等待高清；任何模型都不能仅因 needs_upscale=true 自动付费。仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）。普通导出尺寸与真实源分辨率须分别如实报告；本地缩放不等于恢复源画质。它是异步的，实测要十几分钟，提交后立刻返回、绝不等待——先做别的，之后用 subtasks 回读 hd_count / last_task_type / resolution 判断是否转好。**retry 是服务端状态变更**：只在父子任务全部终止失败、没有结果 URL、也没有真实费用时才会发出；重试响应异常时不要盲目重提，先回读父任务与生成子素材。写方法必须提供 idempotency_key（批量方法在每个项目里提供）：同一请求的同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）；不同请求不能复用 key。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "task=单个任务（含 cost 观测）；tasks=项目任务分页；subtasks=任务的子结果（成片 URL、字幕框、阶段、分辨率与 needs_upscale）；unresolved=只读本地账本，列出没有确定结果的写入（进程重启后先做这一步，按返回的 next 逐笔对账，不要换 key 重发）；image_generate=生成一张图片（计费）；image_generate_batch=校验后有界并发生成多张图片（逐项计费）；upscale=转高清（计费、异步）；retry=重试终止失败且未计费的任务。",
      "enum": [
        "task",
        "tasks",
        "subtasks",
        "unresolved",
        "image_generate",
        "image_generate_batch",
        "upscale",
        "retry"
      ]
    },
    "task_id": {
      "type": "number",
      "description": "task / subtasks 必填：视频任务 ID。"
    },
    "script_id": {
      "type": "number",
      "description": "剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，不必单独提供；其余方法按上面的必填说明传入。"
    },
    "page_num": {
      "type": "number",
      "description": "页码，默认 1。"
    },
    "delivery_resolution": {
      "type": "string",
      "description": "subtasks 可选但强烈建议：本次要交付的分辨率，如 1080p。给定后每行都会得到 needs_upscale：低于该分辨率的结果为 true，否则为 false，无法判断时为 null。true 仅提示实际分辨率低于交付尺寸，不是内容不可用判定，也不构成付费义务。"
    },
    "asset_name": {
      "type": "string",
      "description": "image_generate 必填、rename 必填：资产名。给了 episode 时这里只写资产自己的名字（如 `红包`），插件按规范补齐前缀与类别段；不给 episode 时原样发送。rename 发送的就是最终的完整名称。"
    },
    "asset_type": {
      "type": "number",
      "description": "image_generate 的资产类别号：1=角色，2=场景，3=道具。给了 asset_category 时可以不传（插件按类别推导）；两个都给时必须一致。场景与道具必须传 2/3——一律传 1 会把它们建进控制台的角色库。",
      "enum": [
        1,
        2,
        3
      ]
    },
    "prompt": {
      "type": "string",
      "description": "image_generate 必填：图片提示词。"
    },
    "items": {
      "type": "array",
      "description": "image_generate_batch 必填：同一 script_id 下各不相同的资产请求；每项独立 key，整批先校验后并发执行。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "idempotency_key": {
            "type": "string",
            "description": "本项独立的幂等键；批次顶层不使用 idempotency_key。未知结果必须用本项原 key 对账。"
          },
          "asset_name": {
            "type": "string",
            "description": "本项资产名；episode 与 asset_category 可组成规范名称。"
          },
          "asset_type": {
            "type": "number",
            "description": "1=角色，2=场景，3=道具；与 asset_category 二选一。",
            "enum": [
              1,
              2,
              3
            ]
          },
          "asset_category": {
            "type": "string",
            "description": "资产类别；给 episode 时必填。",
            "enum": [
              "角色",
              "场景",
              "道具"
            ]
          },
          "episode": {
            "type": "string",
            "description": "集号或全剧；按规范组合资产名。"
          },
          "prompt": {
            "type": "string",
            "description": "本项图片提示词。"
          },
          "image_platform_id": {
            "type": "string",
            "description": "本项可选的实时通道 platformId；切换前核对授权、价格与旧任务。"
          },
          "references": {
            "type": "array",
            "description": "本项有序参考图 HTTPS URL。",
            "items": {
              "type": "string"
            }
          },
          "parent_asset_id": {
            "type": "number",
            "description": "可选：重生成的父资产 ID；省略则新建。"
          }
        },
        "required": [
          "idempotency_key",
          "asset_name",
          "prompt"
        ]
      }
    },
    "image_platform_id": {
      "type": "string",
      "description": "image_generate 可选：仅本次使用实时目录中的指定 platformId；省略时使用设置或部署已选通道。切换前核对价格、授权和上一笔结果；超时或未知结果不能直接换通道重投。"
    },
    "references": {
      "type": "array",
      "description": "image_generate 可选：有序参考图 HTTPS URL，顺序即生成顺序。",
      "items": {
        "type": "string"
      }
    },
    "parent_asset_id": {
      "type": "number",
      "description": "image_generate 可选：给了就是重生成（PUT），不给是新建（POST）。"
    },
    "episode": {
      "type": "string",
      "description": "可选：集号（`5` 与 `05` 都规范成 `EP05`）或配置的跨集母版标记（默认「全剧」）。给了它，资产名会按规范组合成 `EP05｜角色｜陆沉舟`，处理任务名会加上 `EP05-P3-` 这样的可排序前缀；不给就完全按调用方原样使用 asset_name / task_name。"
    },
    "asset_category": {
      "type": "string",
      "description": "资产类别。与 episode 同时给出时决定资产名里的类别段，并决定 image_generate 的 assetType（角色=1、场景=2、道具=3）——场景与道具必须传对应类别，否则资产会落进控制台的角色库。",
      "enum": [
        "角色",
        "场景",
        "道具"
      ]
    },
    "package_number": {
      "type": "string",
      "description": "erase_subtitle / upscale 可选：本集内的包号，配合 episode 生成 `EP05-P3` 前缀。"
    },
    "task_name": {
      "type": "string",
      "description": "erase_subtitle 可选：任务名，省略时按「<源任务名>-去字幕」生成。"
    },
    "idempotency_key": {
      "type": "string",
      "description": "写方法必填；读方法忽略。写方法必须提供 idempotency_key（批量方法在每个项目里提供）：同一请求的同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）；不同请求不能复用 key。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。"
    }
  },
  "required": [
    "method"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

### `jubian_watch`

只读后台观察已受理的剧变操作，立即返回 job_id；task_id 必须是本次生成/转高清/去字幕操作的任务 ID，不是源视频任务 ID。只读同一任务及其完整子结果，严格核对身份、阶段和成功状态；旧 URL 或 hdCount 不代表本次完成。完成后由 jobs 通知，用 job_output 取结果；job_kill 只停观察，不取消提供方操作。进程重启不恢复，超时失败不重投收费请求。提供方完成不等于视觉审核通过：结果仍需抽帧、音频和交付分辨率检查。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "integer",
      "description": "已受理的本次操作任务 ID（正安全整数），不是源任务 ID。"
    },
    "stage": {
      "type": "string",
      "description": "本次操作的阶段，必须与任务类型及全部输出一致。",
      "enum": [
        "generate",
        "upscale",
        "erase_subtitle"
      ]
    }
  },
  "required": [
    "task_id",
    "stage"
  ]
}
```

来源： [`packages/jubian/tool-jubian/src/index.ts`](../packages/jubian/tool-jubian/src/index.ts)

Every paid write (image_generate, image_generate_batch, generate, submit_video, submit_video_batch, erase_subtitle, upscale) requires a caller-supplied idempotency_key (one per batch item) and records each intent in the ledger before its request leaves; image_generate_batch validates all local items before any request and runs the individually budgeted image writes at configured bounded concurrency; submit_video_batch verifies all previews and reserves the whole budget before bounded parallel storyboard submissions; erase_subtitle and upscale are asynchronous and return as soon as the provider accepts the task, so a caller re-reads `subtasks` instead of waiting on the call. `jubian_claim` inspects or claims one explicitly authorized pool ID; `jubian_snatch` watches an explicitly authorized bounded pool scope through a background job.

<a id="deepseek-aidsh-tool-shot-script"></a>

## `@deepseek-ai/dsh-tool-shot-script`

### `drama_shot`

短剧镜头脚本的判定与编译（剧变流水线）。validate=只读校验：逐镜给出推导时长（9 有效字/秒）、有效字、发声类型、画外音合法性、资产绑定，硬失败与警告分开列出；preview=只读预算：在 validate 之上算出每包内容时长与打包方案，不落盘，用于提交前看预算；compile=判定通过后写入 matched JSON（matches/<集号>.matched.json）与单集 package（prompts/<集号>.txt、episode_packages/<集号>/），并回报每包的 content_duration_ms、提交给剧变的整秒时长与素材键顺序。时长：N秒的正整数声明优先；省略时按 9 有效字/秒估算。超过 15 字写作阈值或内建 36 字建议、偏离估算仅警告，可保留长慢镜头；但项目在 project_config.json 的 delivery.max_effective_chars_per_shot 里声明了每镜上限时，超过该上限判失败（按原文语义拆镜，或改掉该项目的这条要求），不删字、不改顺序、不换说话人；无发声镜必须写 发声类型：action，时长由 动作复杂度（简单/一般/较复杂/复杂 = 1/2/3/4 秒）决定，没写就按默认 2 秒计；只在一个镜头块的字段里读到 台词：无、空台词行 或 出镜人物：无 时判失败：无声镜整行省略台词行与出镜人物，不要用占位值占位；本说明、技能正文与检查清单里出现这些字样不算脚本违规，校验只看脚本里写了什么。旁白/解说/心声/画外声/OS 作为 vo 画外发声保留原文与说话人，提醒核对项目配音；风格/负面词缺失和正文秒数仅警告；只绑定 official=true 且有剧变 asset/material ID 与 URL 的资产；角色状态在绑定前强制核对：每个入画角色都要在自己的 主体状态追踪 段落里写 身体状态：【阶段（孕周/年龄段）；服装；发型】；（孕八周记孕早期，没有体型变化写 非孕期），所挂资产的 state_or_costume（连同资产名）必须登记同一组维度，资产还必须登记 episodes（本集号数组，或 ["all"] 全剧母版）；任一侧没写、写了别的阶段、或本集不在登记集数里都判失败并点名资产 id，清单里根本没有该状态的资产时给出补料需求（角色/阶段/服装/用于哪几集）与补料路径，不静默绑定。preview/compile 必填 max_submit_seconds：单包提交时长上限（至少4秒，在项目模型确认能力内），不是自动取模型最大值。只合并同场连续完整镜头，内容加1秒收束不得超过该值，超长单镜拒绝，禁止截断。硬失败时不会写任何文件，也不给打包方案。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "validate=只读校验；preview=只读预算（不落盘）；compile=判定通过后写入 matched JSON 与单集 package。",
      "enum": [
        "validate",
        "preview",
        "compile"
      ]
    },
    "script": {
      "type": "string",
      "description": "镜头脚本路径（绝对，或相对当前工作目录）。"
    },
    "assets": {
      "type": "string",
      "description": "资产清单 assets_manifest.json 的路径；preview 与 compile 必填，validate 可选——给了才判定资产绑定。"
    },
    "project": {
      "type": "string",
      "description": "项目根目录（含 episodes/、prompts/、matches/、episode_packages/）；compile 必填。给了它就读该项目的 project_config.json（每镜有效字上限等交付要求）；validate/preview 省略时，从脚本所在目录向上找最近的 project_config.json。"
    },
    "max_submit_seconds": {
      "type": "integer",
      "description": "preview/compile 必填：本次打包的单包总时长上限，包含收束。项目模型 SD2.0 支持4–15秒，SD2.5 支持4–30秒；具体修订须已核实。按内容确定，不必取最大值；编译后将各包 submit_seconds 写入对应分镜。"
    },
    "episode": {
      "type": "integer",
      "description": "集号（正整数，如 3）；compile 必填，写入时补成两位，如 03。validate/preview 也接受：给了就同时判定所挂资产登记的 episodes 是否覆盖这一集。"
    }
  },
  "required": [
    "method",
    "script"
  ]
}
```

Source: [`packages/drama/tool-shot-script/src/index.ts`](../packages/drama/tool-shot-script/src/index.ts)

The three methods share one schema: `validate` and `preview` only read, and `compile` writes the matched JSON and the episode package, returning each package's `content_duration_ms`, its submitted whole-second length, and the prompt-ordered `material_keys` that `jubian_storyboard` `select_assets` must match. A script with any hard failure returns that failure list and writes nothing.

<a id="deepseek-aidsh-perception-bgm"></a>

## `@deepseek-ai/dsh-perception-bgm`

### `bgm_match`

在本地索引或部署配置的公开 BGM 库里按情绪选曲。match：给出目标「愉悦度」与「能量」（都用 1–9 的刻度，1=最消极/最平静，9=最积极/最激烈），返回最接近的候选及每首的实际测量值。index：扫描一个目录，逐首分析情绪并入库；约 15–30 秒一首，按内容哈希增量更新，可随时中断续跑。inspect：只分析一首并返回它的数值。公开库 match 仅返回 track_id/name/url 和测量值，不自动下载；选定后用 download + track_id 下载并校验，返回可供配乐合成使用的真实本地 path。match/download 不需要 Python。**返回的是候选排序，不是决定**——最终选哪首由你判断；每首附带的 valence/arousal 原值就是判断依据。**注意：底层音乐理解骨干 m-a-p/MERT-v1-95M 采用 CC-BY-NC-4.0 许可，仅限非商业用途。**

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "match=按坐标排序候选；index=扫描目录建库（可续跑）；inspect=分析单个音频文件；download=下载公开库中明确选定的 track_id。",
      "enum": [
        "match",
        "index",
        "inspect",
        "download"
      ]
    },
    "track_id": {
      "type": "string",
      "description": "download 必填：公开库 match 返回的 track_id；不接受任意 URL。"
    },
    "directory": {
      "type": "string",
      "description": "index 必填：要扫描的音乐目录。"
    },
    "audio_path": {
      "type": "string",
      "description": "inspect 必填：单个音频文件的路径。"
    },
    "valence": {
      "type": "number",
      "description": "match 必填：目标愉悦度，1–9。"
    },
    "arousal": {
      "type": "number",
      "description": "match 必填：目标能量，1–9。"
    },
    "limit": {
      "type": "number",
      "description": "match 可选：返回候选数，默认 5，上限 20。"
    }
  },
  "required": [
    "method"
  ]
}
```

来源：[`packages/perception/perception-bgm/src/index.ts`](../packages/perception/perception-bgm/src/index.ts)

`match` 排序候选，不代替选曲；公开库模式返回 ID 与 URL，不自动下载。`download` 接受选定的目录曲目 ID，返回经校验的本地文件。默认使用本地索引；公开库匹配需由部署配置。`index` 和 `inspect` 仅在执行时启动 Python，收集 schema 时不会启动。MERT 分析骨干仅限非商业用途（CC-BY-NC-4.0）；音频权利须另行确认。

<a id="deepseek-aidsh-tool-bgm-compose"></a>

## `@deepseek-ai/dsh-tool-bgm-compose`

### `drama_bgm`

短剧整集 BGM 合成工具；只执行 Agent 已确认的 episodes/segments 计划，不选曲、不替代试听。可先用 bgm_match 获取带实测愉悦度/能量的候选，再由 Agent 按剧情选择曲目、切点和理由并写入计划。preview=安全预检：验证时间线、来源和完整连续覆盖，检测 1–5 秒内的起音，测量源窗口平均响度并计算目标 -17.5 dB、最大 +9 dB 的增益，不写正式产物。compose=按计划截取源曲，以计划 crossfade_seconds（默认 1.5 秒）交叉淡化，首尾淡入淡出，输出 48kHz 双声道 pcm_s16le WAV；先在同目录暂存并 ffprobe 回读，整批成功后才无覆盖发布 WAV 与 generation.json，失败会清理暂存文件。verify=只回读已有 WAV 的编码、采样率、声道、时长、大小和 SHA-256，不读取源曲、不重写文件，segments 为空。compose 返回的 output 传给 drama_render.bgm，同一 plan 传给 drama_render.bgm_plan。本工具不依赖 bgm_match；bgm_match 的 m-a-p/MERT-v1-95M 骨干采用 CC-BY-NC-4.0，仅限非商业用途，只要使用其候选就必须遵守。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "preview=预检且不发布；compose=合成并无覆盖发布；verify=核验已有 WAV。",
      "enum": [
        "preview",
        "compose",
        "verify"
      ]
    },
    "project": {
      "type": "string",
      "description": "短剧项目根目录。"
    },
    "episode": {
      "type": "integer",
      "description": "正整数集号，内部补成两位。"
    },
    "timeline": {
      "type": "string",
      "description": "项目内时间线 JSON，必须含 body_end，通常为 editing/<集>-timeline.json。"
    },
    "plan": {
      "type": "string",
      "description": "项目内 episodes/segments BGM 计划 JSON；段落必须连续完整覆盖正文，跨集复用规则见 policy_findings（每集至少 2 首、集内不重复、单曲最多 2 集、至少 1 首全新、切点在镜头包边界）。"
    },
    "output": {
      "type": "string",
      "description": "项目内 WAV 路径；省略为 audio/bgm/<集>.wav。"
    }
  },
  "required": [
    "method",
    "project",
    "episode",
    "timeline",
    "plan"
  ]
}
```

来源：[`packages/drama/tool-bgm-compose/src/index.ts`](../packages/drama/tool-bgm-compose/src/index.ts)

`preview` 校验剧情完整覆盖并回报源哈希、偏移、实测平均音量与增益，不发布产物；`compose` 交叉淡化选定曲目，暂存 WAV 通过 ffprobe 后才发布；`verify` 测量已有 WAV，不重写它。工具不选曲，也不调用 `bgm_match`；剧情解读与最终选曲归 Agent。

<a id="deepseek-aidsh-tool-episode-render"></a>

## `@deepseek-ai/dsh-tool-episode-render`

### `drama_render`

短剧整集渲染编排（剧变流水线）。subtitles=按语音识别对齐写出 SRT：对齐文档（alignment）给出每一镜每一句的说话时间，字幕文字只取 lines 里的剧本原文，cue 时间 = 该镜在时间线上的起点 + 镜内偏移。**本工具不做识别、不测能量、不估算时间**：能量门限分不出具体哪句在哪里，估算出来的时间正是字幕压在错句上的原因。缺某一镜的对齐、段数与台词条数不符、识别文本与剧本对不上，都按 failure 报出（subtitle_line_coverage），并指出该对哪一镜重跑识别；有识别结果却没声明台词，同样报 failure。写出的每条字幕还会检查时长、重叠、越界与阅读速度（超过 20 字/秒按 failure，超过 12 字/秒按 warning）。对齐时间本身的准确度不由本工具判断，识别模型与语言选择由调用方负责。prepare=按成片清单构建渲染输入：把每镜成片复制到 video/<集>/shot_00N.mp4，按 ffprobe 实测时长铺时间线（editing/<集>-timeline.json），把每镜自己的声音按各自起点拼成整集原声 master（audio/<集>.wav，48kHz 无损、不加增益、不逐镜重采样），并安装 SRT 到 editing/<集>.srt；不编码画面。render=出片：逐镜编码到交付规格 1440x2560@60、24M 目标码率 / 30M 上限 / 48M 缓冲、H.264 high@5.1，片尾用最后一镜的真实尾帧定格 2 秒：ending_effect 按自身原速只播放一次，覆盖片尾开头它自己的时长，其余时间是纯定格帧（不变速、不拉伸、不补黑场），只有 ending_audio 的前 2 秒在正片结束处进入混音；这两份素材按 SHA-256 校验，只接受随包字节，换成别的文件或送上长于 2 秒的特效都会直接报错。拼接后烧录 ASS 字幕（默认 SimHei 68，字体服从部署配置；字间距 -2、黑描边按成片像素推导（目标 7px，标准管线写入 5）、底部居中，烧录链最后是 fps=60,setpts=N/(60*TB)，把帧率与时间基准固定在字幕之后，手写链把 fps 放在 subtitles 之前会让成片只剩少量帧，右下角唯一的「内容由AI生成」标记——这条标记由写出的 ASS 携带一次，另加 drawtext 或 overlay 就会重复），再把整集原声（增益 1.45）+ BGM（增益 0.24，到正片结束）+ 片尾音 amix 后 alimiter=0.95，AAC 192k/48kHz、+faststart 输出，并回读实测分辨率/帧率/码率/时长/大小/编码器。GPU 编码先探测 h264_nvenc（用 256x256 探针，太小会被 NVENC 拒绝），失败就按设计回退 libx264，回退原因写进 encoder_fallback_reason 与渲染日志。verify=渲染后检查：总时长、音视频流、总码率下限 4.6 Mbps、首/中/尾抽帧真实解码、黑帧、静音、字幕 cue 是否越界，逐项给实测值与中文修法。**不许只看元数据**：容器里的时长、帧率、码率在一份大量丢帧的成片上照样正常，decode_probe 会在首、中、尾各解一帧，任何一处解不出画面就按 failure 报出。抽尾帧固定用 -sseof -0.1：-sseof -0.05 在部分片子上不写文件却返回 0，所以每次都用 framemd5 与顺序解码的最后一帧比对，证明抽到的是真实尾帧，比对不上就改用顺序解码取帧。只有让渲染无法进行的问题（缺参数、缺文件、命令失败、尾帧无法证明）才会报错；成片本身的问题按 checks 返回，ok=false 并在 failures 里给出中文修法，成片与实测参数照常返回。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "prepare=构建渲染输入（不编码）；render=出片并回读实测参数；verify=渲染后检查；subtitles=按语音识别对齐文档给台词定时并写出 SRT（不编码、不做识别）。",
      "enum": [
        "prepare",
        "render",
        "verify",
        "subtitles"
      ]
    },
    "project": {
      "type": "string",
      "description": "项目根目录（含 video/、audio/、editing/、exports/）；四个方法都必填。"
    },
    "episode": {
      "type": "integer",
      "description": "集号（正整数，如 2）；写入时补成两位，如 02。"
    },
    "shots": {
      "type": "string",
      "description": "成片清单 JSON 路径，形如 {\"shots\":[{\"shot\":1,\"video\":\"media/02/p1-clean.mp4\",\"audio\":\"可选\"}]}；prepare 与 subtitles 必填。video 缺音轨时必须给 audio。"
    },
    "lines": {
      "type": "string",
      "description": "台词计划 JSON 路径，形如 {\"shots\":[{\"shot\":1,\"lines\":[\"第一句\",\"第二句\"]}]}；subtitles 必填。每镜的台词在这里就按字幕条切好（单条不超过 14 个字），工具只给时间，不改文字。"
    },
    "alignment": {
      "type": "string",
      "description": "语音识别对齐文档 JSON 路径，subtitles 必填，形如 {\"shots\":[{\"shot\":1,\"cues\":[{\"text\":\"识别文本\",\"start\":0.0,\"end\":0.8}]}]}（镜内、相对该镜起点，秒）。只取它的时间：字幕文字仍来自 lines，识别文本仅用于核对是不是同一段表演。缺某一镜、段数与台词条数不符、或文本对不上，都会按 failure 报出。"
    },
    "timeline": {
      "type": "string",
      "description": "时间线 JSON 路径；render 与 verify 必填，通常是 prepare 写出的 editing/<集>-timeline.json。"
    },
    "subtitle_srt": {
      "type": "string",
      "description": "本集 SRT 字幕路径；subtitles 写出它（省略时写 editing/<集>.srt），prepare 装到 editing/<集>.srt，render 烧录它，verify 检查它的 cue 是否越界。"
    },
    "last_shot": {
      "type": "integer",
      "description": "本次交付的最后一个镜头号（如 9）；render 必填，时间线里 shot <= last_shot 的镜头数必须正好等于它。"
    },
    "bgm": {
      "type": "string",
      "description": "本集实际使用的 BGM 文件路径；render 必填，会循环铺到正片结束。"
    },
    "bgm_plan": {
      "type": "string",
      "description": "render 可选：现有 episodes/segments 配乐计划 JSON；校验时间、记录曲目与复用提醒，不代替试听。"
    },
    "ending_audio": {
      "type": "string",
      "description": "片尾音文件路径；render 必填。只能用随包素材 tweet-drama-background-render/assets/ending_audio.mp3（SHA-256 d1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f，全长 3.474 秒）：只有前 2 秒延迟到正片结束处进入混音，其余不进成片；换成别的文件 render 直接报错。"
    },
    "ending_effect": {
      "type": "string",
      "description": "片尾特效视频路径；render 必填。只能用随包素材 tweet-drama-background-render/assets/ending_effect.mp4（SHA-256 49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010，实测 1.020 秒）：它按自身原速只播放一次，覆盖片尾开头 1.020 秒，其余 0.980 秒是定格帧；换成别的文件、或长于片尾 2 秒窗口的素材，render 直接报错，不做截断。"
    },
    "output": {
      "type": "string",
      "description": "成片输出路径；render 省略时写 exports/<集>.mp4，verify 必填（要检查哪个文件）。"
    },
    "force": {
      "type": "boolean",
      "description": "render 是否忽略 exports/.render_cache 里的逐镜缓存并全部重编；默认 false。"
    }
  },
  "required": [
    "method",
    "project",
    "episode"
  ]
}
```

Source: [`packages/drama/tool-episode-render/src/index.ts`](../packages/drama/tool-episode-render/src/index.ts)

### `drama_video`

按用户决定禁用或解除禁用具体视频版本。ban 必须提供本地 video 和至少一个 labels 标签（如人物对调、字幕错误），reason 可选，不要求审图证据。内部按 SHA256 标识，同字节副本共享禁用，新生成不同字节不受影响。unban 不等于审核通过；list/inspect 可读标签和原因。只在 drama_render prepare/render 拦截，verify 报告风险不删文件；不拦截通用 ffmpeg。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "enum": [
        "ban",
        "unban",
        "list",
        "inspect"
      ]
    },
    "project": {
      "type": "string",
      "description": "现有项目目录，禁用清单持久化在该目录。"
    },
    "video": {
      "type": "string",
      "description": "本地视频路径，相对项目或绝对路径；ban 必填，内部计算 SHA256。"
    },
    "sha256": {
      "type": "string",
      "description": "仅 unban/inspect 可用清单返回的 SHA256 代替已不存在的 video，二者互斥。"
    },
    "labels": {
      "type": "array",
      "description": "ban 必填：至少一个非空标签，如人物对调、字幕错误。",
      "items": {
        "type": "string"
      }
    },
    "reason": {
      "type": "string",
      "description": "ban 可选：用户禁用原因；不是审图证据。"
    }
  },
  "required": [
    "method",
    "project"
  ]
}
```

来源：[`packages/drama/tool-episode-render/src/index.ts`](../packages/drama/tool-episode-render/src/index.ts)

`drama_video` 记录带标签、可逆的 SHA256 禁用决定，不要求审核证据；解除禁用不等于批准。`drama_render` 在 `prepare`/`render` 中拒绝已禁用的选用字节，`verify` 则报告风险，不删除媒体。其三个方法：`prepare` 构建渲染输入但不编码画面，`render` 出片并回报实测的分辨率、帧率、码率、时长、大小与编码器，`verify` 检查成片。交付样式固定——1440x2560@60、24M 目标码率与 30M 上限、4.6 Mbps 下限、SimHei 68 字幕加右下角唯一的 AI 标记，以及用最后一镜经过证明的真实尾帧定格的 2 秒片尾。无法进行下去的渲染会抛错并给修法；不符合规格的成片返回 `ok: false` 与逐项修法。

## `@deepseek-ai/dsh-tool-drama-assets`

### `drama_assets`

短剧流水线的付费生成前资产对账（剧变）。reconcile=只读剧变、免费：把「剧变远端这个项目里已选用的资产」与「assets_manifest.json 里写了什么」逐条比一遍，产出机读证据 <project_dir>/_probe/asset-reconcile.json。判定口径：远端存活 = asset/list 里 delFlag == "0"；已选用 = material/list 里 isUsed == 1 且 hsAssetStatus == "Active"；unregistered = 已选用但清单里没有（不许直接生成，先登记复用或写明不需要）；dangling = 清单里有但远端没有；matched = 两端都有的数量。dispose=给某条 unregistered 写处置：status=registered（已登记进清单）或 ignored（确认不需要，必须带非空 note）；只更新证据里的 disposition 并重算 blocking / ignored_without_note / ready，不重新对账、不联网。ready = issues 为空且 blocking 与 ignored_without_note 都为空，宿主侧的付费前置钩子只认这一条，证据 24 小时内有效。清单读不全不报错、也不拒绝运行：缺 items 资产数组（或只写在 assets 键下）、缺 lead_readonly_records、某条记录不是对象，都写进 issues 并让 ready=false，好让 agent 一次看全所有要修的地方。为什么清单不够：清单只记录我们生成过什么，不等于剧变项目里已经有什么——2026-09-20 就因为只看清单，给一张项目里早就存在的正式资产重新生成了两次（花掉 1.17 元）。本工具绝不调用剧变的任何写方法、绝不计费：远端只读，本地只写 _probe/asset-reconcile.json 这一个文件。

```json
{
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "description": "reconcile=只读剧变做对账并写证据（免费）；dispose=只改证据里的处置记录（不联网）。",
      "enum": [
        "reconcile",
        "dispose"
      ]
    },
    "project_dir": {
      "type": "string",
      "description": "项目根目录绝对路径，必须含 assets_manifest.json；证据写在它的 _probe/asset-reconcile.json。"
    },
    "asset_id": {
      "type": "integer",
      "description": "dispose 必填：要处置的 unregistered 资产 ID（不是 material_id、不是任务 ID）。"
    },
    "status": {
      "type": "string",
      "description": "dispose 必填：registered=已登记进清单（下次 reconcile 会自动确认）；ignored=确认不需要，必须同时给 note 说明原因。",
      "enum": [
        "registered",
        "ignored"
      ]
    },
    "note": {
      "type": "string",
      "description": "dispose 可选但 status=ignored 时必填且非空：写清为什么这个资产不需要（例如是别的剧的备选、失败遗留、废弃版本）。"
    }
  },
  "required": [
    "method",
    "project_dir"
  ]
}
```

Source: [`packages/drama/tool-drama-assets/src/index.ts`](../packages/drama/tool-drama-assets/src/index.ts)

Two methods over one evidence file: `reconcile` reads the remote project’s asset and material lists and the manifest and writes the evidence the host’s reconcile gate reads, and `dispose` records one disposition in it without any remote read. The tool never calls a Jubian write method and never bills; the disposition verdicts (`blocking`, `ignored_without_note`, `ready`) are the gate’s inputs.

# Muse Bot

[English](README.md) | 中文

Muse Bot 为现有 Muse 桌面应用增加持久 Bot 会话、团队名单、群聊、协作任务和独立 Bot 记忆。它基于 [DS-Bot](https://github.com/Fei2411/DS-Bot) 适配，作为原生 `ds-bot` Cordis 插件分发。[源码清单](../sources.json)固定上游版本和修订；产品界面使用 Muse Bot 品牌，模块名和通信路由继续保留以便兼容。

## Desktop use

从 Muse 侧栏打开 Muse Bot，创建 Bot，选择模型与推理等级，然后向它发送任务。Bot 使用现有 Muse 的模型列表、账号、工作目录和工具。新选择遵循提供方和模型的可见性设置，已有 Bot 的选择保持不变。会话仍是普通 Harness Session，原来的 Muse 任务界面继续可用。群聊可让 Bot 通过消息协作，无须引入另一套必须执行的规划、审校或审批流程。

打开 Muse Bot 界面或查询名单时，可见的独立 Muse Session 会原地登记为普通 Bot，包括普通分叉会话。子 Agent、团队群聊内部会话、Bot 历史分段、独立 DSH Agent 管理的会话和已归档会话不参与登记。历史、当前目录、工作间、模型、推理等级和预设仍属于原 Session，原生提问、运行中的 Agent、目标和后台任务也继续保留。自动登记读取名单元数据，不恢复未加载的 Agent，不发送问候或模型请求。

Bot 在已注册的工作间中新开会话分段时，该分段也会出现在经典会话模式的对应工作间列表中。切换到经典会话模式时，若当前显示的 Bot 分段还没有归属工作间，且工作目录未变并匹配已注册的工作间，则将该分段挂到对应工作间。尚未注册为工作间的文件夹仍作为未分组的工作目录；其他会话分段不会被移动。

关闭自动登记后，仍可从“设置 → Bots → 使用已有会话”将所选 Session 原地登记，并打开原来的对话；Bot 默认使用 Session 标题命名。用户可在同页赋予主 Bot 身份。主 Bot 负责协调，也能直接执行简单任务，按需要委派。所有主 Bot 在侧边栏顶部依次排列，每行最多三个；普通置顶仍留在列表中。无论窗口宽度如何，打开 Bot 或会话都会保留侧边栏当前的展开或收起状态。 桌面端 Bot 模式收起后保留与 Web 相同的 56px 头像栏，离开 Bot 模式后恢复原生收起行为。

新团队的主 Bot 使用 `bot-coordinator` 预设中的 DS Bot Chief of Staff 协调职责，Muse 则作为独立的 `short-drama` 专业执行 Bot。已有 Bot 的身份、Session、预设和历史继续保留。共享团队工作区保留 Muse 预装的短剧工具，设置中不提供通用插件和能力新增入口；底部账号区继续由 Muse 管理。Bot 仍可发现和加载已有技能、使用已挂接的能力，Host 工具、权限和保存的能力定义保持不变。“关于”页展示 Muse Bot 产品信息，不展示仓库或许可区块。

从“设置 → 反馈”打开 Muse 原有的会话反馈表单，由用户选择内容并提交；打开表单不会发送反馈或诊断信息。同一页面仍可预览、复制和保存本地诊断。

Bot 状态和记忆默认存放在当前 Muse home 的 `muse-bot/` 下，会话历史仍由现有 Session 存储管理。该适配不会自动导入独立 Muse Bot 实验应用的数据，也不改变已有 Muse 任务历史。

Muse Bot 内置 DS Bot 的本地记忆，不需要另装服务。`remember`、`recall` 和 `forget` 跨会话保存偏好、决定、纠正、有用事实及工作方法。每个 Bot 使用独立的 Markdown 笔记；团队和群组记忆保留原有访问规则。核心笔记进入新会话的上下文，详细主题按需回读。默认在回合结束后，使用该 Bot 的普通 Muse 模型线路复盘值得保留的信息，不复制每条消息。复盘可能增加模型用量，但不需要 Hindsight 服务或凭据。已有笔记、变更日志及来源引用保持原位。记忆只属于当前 Muse home，不跨电脑同步；最新用户要求和项目文件优先。

Host 向原生 IM 适配器提供 `museTeam.registerSessionAsBot(sessionId, { name?, role?, main? })`、`resolveCurrentSession(botId)` 和 `switchCurrentSession(botId, sessionId)`。用户明确切换当前 Session 时，Bot ID 保持稳定，早先的 Session 仍可从历史打开；目标和后台任务留在原 Session。登记与切换会校验独立 Session 归属，保存失败则回滚名单变更。显式切换可吸收未定制的自动名单项，已定制或参与协作的 Bot 保留独立身份。接入后的普通用户回合和目标续跑仍由原生机制恢复；已接收的 Bot 协作消息继续按原交接收据恢复。

原生飞书按应用注册项和聊天 ID 对应一个 Bot，群内话题沿用原来的回复位置。已有群聊和私聊 Session 直接登记，不重新启动。适配器用既有聊天或消息元数据取得群名或聊天对象名字，以 `nameHint` 传入，不申请通讯录权限。界面展示原聊天名；重名或名称需处理时，另显示可准确引用的 Bot 名称。未取得元数据时沿用原会话标题，用户手动改名优先于后续自动名称。认证、工作区隔离、消息去重、卡片、文件和发送回执继续由原生 IM 运行时管理。已绑定且飞书长连接及宿主可用的 Bot 会在头像的活动状态灯或主 Bot 星标上方显示圆形飞书标识，连接断开时标识隐藏。显式 `/new` 和 `/use` 为同一个 Bot 选择当前 Session，不另建团队身份。

## Native configuration

内置组合只挂载一个 `muse-bot` 配置项：

```yaml
- insert:
    - id: muse-bot
      name: ds-bot
      config:
        agentPreset: short-drama
        mainAgentPreset: bot-coordinator
        ensureMuseSpecialist: true
        contextManagement: host
        goals: host
        memoryReview: true
        autoSessionBots: true
        sessionBotSyncIntervalMs: 30000
        github: false
        updateCheck: false
```

`agentPreset` 为新专业 Bot 会话选择已注册的 Muse 预设；`mainAgentPreset` 为新主 Bot 选择预设。`ensureMuseSpecialist` 会在没有专业成员时创建一个 Muse 执行 Bot，并保留已有专业成员的身份。所需预设必须可用，创建失败时不会改用其他预设。`contextManagement: host` 让当前 Host 管理上下文压缩。`goals: host` 保留 Host 的目标工具和续跑行为。`updateCheck: false` 关闭插件和 Harness 的独立更新提示；已审核插件随 Muse 应用更新提供。`github: false` 关闭可选的内置 GitHub MCP 连接器。该 bundle 不替换 profile 的网页搜索、模型路由、账号设置或权限策略。

`memoryReview: false` 关闭自动后台复盘，保留记忆工具、已有笔记和面板。复盘使用该 Bot 选择的模型，请求最低可用思考档位，先使用 2,048 Token 输出预算；输出被截断时最多以 8,192 Token 重试一次。供应商调用失败时可以回退到已配置的默认模型。这些都是通过现有 Muse 线路计费的普通模型请求。Host 关闭时取消并等待待处理复盘结束，再完成资源释放；已取消的复盘不会保存迟到的模型回复。已登记 Session 在模型目录刷新时保留原生选择；用户通过界面或 `update_bot` 明确修改模型或推理等级后，才由 Bot 配置管理该选择。

`autoSessionBots: false` 关闭自动会话登记，仍保留手动入口。`sessionBotSyncIntervalMs` 按毫秒设置名单元数据的刷新间隔；原生 Session 变更会使缓存失效。新建 Bot 会话继续使用 `short-drama`，登记已有 Session 则保留其原有预设。

`create_bot` 支持 `preset` 和 `resident_tools`，`update_bot` 可以替换这两项。预设变更用于未来新建的 Session，当前会话继续使用原预设。常驻工具按精确名称存入 Bot 记录。共享的 Harness `tool_search` 按能力查找工具，`tool_context` 负责加载、常驻、取消常驻和收起。各 Bot 的私聊、群聊和后续会话分段共用自己的常驻列表。能力目录共享，原有授权继续生效；加载名称不会增加权限。常驻配置保存失败时操作会报错，并恢复原 Bot 设置。收起工具后，历史工具结果仍保留在 Session 中。

桌面组合从首个模型请求开始提供已注册的 Bot 团队工具，包括 `ask_user`、`show_view` 和安全凭据卡片。普通 DSH Agent 会话排除 Bot 管理工具，工具可见性不会授予主 Bot 权限。用户额外选择工具的常驻与收起行为保持不变。卡片注册选择性采用 DS Bot 0.2.4 的更新：Bot 作用域的 `show_view` 优先于其他插件的全局渲染器，并在 Agent 或插件卸载时移除。插件保留 0.2.2 基础、Muse 渲染器、模型路由与 Muse 网页搜索。

可选的 `home` 配置可指定其他 Bot 状态目录。模型和推理等级仍可在界面中选择；创建 Bot 或向其发送消息可能通过已配置的提供方发起正常模型请求。认证与提供方可用性由 Muse 原有服务管理。

会话活动行区分等待回复和收到正文，并将计时标为本轮总时长。上下文状态优先使用已记录且配对的校准估算与工作目标，提示中单独列出模型总窗口；缺少配对元数据时沿用旧的上下文显示。普通工具调用保留可折叠记录，展示工具名及已返回、失败或结果未返回状态，不展示参数和原始结果。

用户尚未设置思考显示偏好时，默认展示模型返回的思考摘要；明确关闭过的设置保持关闭。该偏好仅控制显示，不请求隐藏推理，也不会在模型未返回摘要时编造摘要。

## Source, packaging and checks

[受控构建器](../build.mjs)从 `src/client` 重建浏览器模块，按已审核 Host 版本限定 peer，并把 `LICENSE`、`NOTICE` 和 `SOURCE.json` 放入产物。Muse 适配层不打包上游自动搜索模块及其已退役的 `dsh-web` peer。产物不包含上游开发应用，也不安装第二套 Agent 引擎。

在仓库根目录运行所属构建检查：

```sh
pnpm --dir third_party/plugins/toolchain run test:bot
```

仓库开发依赖将 `esbuild` 固定为此插件声明的版本。在仓库根目录运行保留的无密钥测试，使用本检出的已构建 Harness 依赖：

```sh
DSH_HARNESS="$PWD" node --import ./third_party/plugins/ds-bot/test/harness-resolve.mjs --test "third_party/plugins/ds-bot/test/*.test.js"
```

保留的上游团队夹具显式选择原有主理人、预设、Bot 管理的上下文和记忆审阅。提问和视图夹具使用已有团队，不自动创建专业 Bot。`muse-host.test.js` 单独检查默认主理人与 Muse 专业 Bot 的初始化。测试解析器使用实际 Web 与 base 配置包的依赖，回归检查将解析模块与这些配置包的消费者进行比对。

打包检查验证原生组合、浏览器入口、来源记录和署名。录制会话用隔离状态执行实际的名单工具。这些检查不代表付费提供方可用、创作质量通过或账号实测通过；Host 激活与 Muse Bot 界面另行进行桌面验证。

源码 lint 覆盖 `src`、入口模块、脚本和测试。生成的 `client.js` 不参与 lint；`node scripts/build-client.mjs --check` 使用声明的 esbuild 版本核对它与 `src/client` 是否一致。

## License and attribution

保留源码采用 Apache-2.0，版权和第三方署名见 [LICENSE](LICENSE) 及未修改的上游 [NOTICE](NOTICE)。Muse 品牌、原生预设接入、Host 管理的上下文与目标，以及受控桌面打包属于本地修改。Muse 不声称拥有上游作者身份或获得上游背书。

# Muse Bot

[English](README.md) | 中文

Muse Bot 为现有 Muse 桌面应用增加持久 Bot 会话、团队名单、群聊、协作任务和独立 Bot 记忆。它基于 [DS-Bot](https://github.com/Fei2411/DS-Bot) 适配，作为原生 `ds-bot` Cordis 插件分发。[源码清单](../sources.json)固定上游版本和修订；产品界面使用 Muse Bot 品牌，模块名和通信路由继续保留以便兼容。

## Desktop use

从 Muse 侧栏打开 Muse Bot，创建 Bot，选择模型与推理等级，然后向它发送任务。Bot 使用现有 Muse 的模型列表、账号、工作目录和工具。会话仍是普通 Harness Session，原来的 Muse 任务界面继续可用。群聊可让 Bot 通过消息协作，无须引入另一套必须执行的规划、审校或审批流程。

“设置 → Bots → 使用已有会话”将已列出的根 Session 原地登记为 Bot。历史、当前目录、工作间、模型与推理等级、原生提问、运行中的 Agent、目标和后台任务仍属于原 Session；登记不会发送问候或模型请求。新登记者是普通成员，用户可在同页赋予主 Bot 身份。主 Bot 负责协调，也能直接执行简单任务，按需要委派。

团队工作区使用 Muse 预装的短剧工具，设置中不提供通用插件和能力新增入口；底部账号区继续由 Muse 管理。Bot 仍可发现和加载已有技能、使用已挂接的能力，Host 工具、权限和保存的能力定义保持不变。“关于”页展示 Muse Bot，原项目署名放在默认收起的开源许可详情中。

从“设置 → 反馈”打开 Muse 原有的会话反馈表单，由用户选择内容并提交；打开表单不会发送反馈或诊断信息。同一页面仍可预览、复制和保存本地诊断。

Bot 状态和记忆默认存放在当前 Muse home 的 `muse-bot/` 下，会话历史仍由现有 Session 存储管理。该适配不会自动导入独立 Muse Bot 实验应用的数据，也不改变已有 Muse 任务历史。

Muse 原有的 `hindsight_memory` 按需保存有来源且已确认的用户偏好、审美反馈和项目决定；Bot 记忆用于身份分工、协作约定和可复用工作方法。默认不在每轮结束后自动复盘 Bot 记忆，已有记录仍可阅读和编辑，不自动迁移或删除。两套存储不会同步，显式编辑仍可能产生重复记录；最新用户要求和当前项目文件优先。

Host 向原生 IM 适配器提供 `museTeam.registerSessionAsBot(sessionId, { name?, role?, main? })`、`resolveCurrentSession(botId)` 和 `switchCurrentSession(botId, sessionId)`。用户明确切换当前 Session 时，Bot ID 保持稳定，早先的 Session 仍可从历史打开；目标和后台任务留在原 Session。登记与切换会校验根 Session 归属，保存失败则回滚名单变更。

原生飞书按应用注册项和聊天 ID 对应一个 Bot，群内话题沿用原来的回复位置。已有群聊和私聊 Session 直接登记，不重新启动。适配器用既有聊天或消息元数据取得群名或聊天对象名字，以 `nameHint` 传入，不申请通讯录权限。界面展示原聊天名；重名或名称需处理时，另显示可准确引用的 Bot 名称。未取得元数据时沿用原会话标题，用户手动改名优先于后续自动名称。认证、工作区隔离、消息去重、卡片、文件和发送回执继续由原生 IM 运行时管理。显式 `/new` 和 `/use` 为同一个 Bot 选择当前 Session，不另建团队身份。

## Native configuration

内置组合只挂载一个 `muse-bot` 配置项：

```yaml
- insert:
    - id: muse-bot
      name: ds-bot
      config:
        agentPreset: short-drama
        contextManagement: host
        goals: host
        memoryReview: false
        github: false
        updateCheck: false
```

`agentPreset` 为新 Bot 会话选择已注册的 Muse 预设。`contextManagement: host` 让当前 Host 管理上下文压缩。`goals: host` 保留 Host 的目标工具和续跑行为。`updateCheck: false` 关闭插件和 Harness 的独立更新提示；已审核插件随 Muse 应用更新提供。`github: false` 关闭可选的内置 GitHub MCP 连接器。该 bundle 不替换 profile 的网页搜索、模型路由、账号设置或权限策略。

显式配置 `memoryReview: true` 可开启 Bot 协作笔记的后台复盘，默认不发起这类额外模型请求。已登记 Session 在模型目录刷新时保留原生选择；用户通过界面或 `update_bot` 明确修改模型或推理等级后，才由 Bot 配置管理该选择。

可选的 `home` 配置可指定其他 Bot 状态目录。模型和推理等级仍可在界面中选择；创建 Bot 或向其发送消息可能通过已配置的提供方发起正常模型请求。认证与提供方可用性由 Muse 原有服务管理。

## Source, packaging and checks

[受控构建器](../build.mjs)从 `src/client` 重建浏览器模块，按已审核 Host 版本限定 peer，并把 `LICENSE`、`NOTICE` 和 `SOURCE.json` 放入产物。Muse 适配层不打包上游自动搜索模块及其已退役的 `dsh-web` peer。产物不包含上游开发应用，也不安装第二套 Agent 引擎。

在仓库根目录运行所属构建检查：

```sh
pnpm --dir third_party/plugins/toolchain run test:bot
```

打包检查验证原生组合、浏览器入口、来源记录和署名。录制会话用隔离状态执行实际的名单工具。这些检查不代表付费提供方可用、创作质量通过或账号实测通过；Host 激活与 Muse Bot 界面另行进行桌面验证。

## License and attribution

保留源码采用 Apache-2.0，版权和第三方署名见 [LICENSE](LICENSE) 及未修改的上游 [NOTICE](NOTICE)。Muse 品牌、原生预设接入、Host 管理的上下文与目标，以及受控桌面打包属于本地修改。Muse 不声称拥有上游作者身份或获得上游背书。

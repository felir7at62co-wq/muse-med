---
description: "登录 MUSE，让智能体私有保存经复核的剧本，再检索和阅读账号获授权的来源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

[English](README.md) | 中文

## 概述

用户可以在桌面版设置中登录 MUSE，无需在模型会话中输入密码。智能体可私有保存复核后的剧本和不可变原件，再在账号或项目范围内综合成带引用的 Wiki 页面。它可浏览目录、全文检索、沿链接阅读、查阅历史修订，并阅读管理员授权的参考资料。这些操作需要已配置的 Muse 网关。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Muse Desktop 在空白首启时先提供 MUSE 登录，再检查模型配置；选择**稍后登录**仍可从侧栏和**设置 → MUSE 账号**进入。打开页面时会刷新模型目录；点击**验证状态**可向网关确认账号身份。输入用户名和密码即可登录。注册选项初始未选中；如果希望登录失败后尝试创建该用户名，可主动勾选。请求成功后，页面会清空密码输入框。同一登录会话会加载网页版模型目录，并用于模型调用、知识库和语音转写。新配置自动选择首个 Muse 模型；未配置自身凭据的旧直连默认路由会选择对应的 Muse 路由。模型设置仍可添加自定义提供方和凭据，已配置凭据的自定义默认模型会保留。退出登录只撤下 Muse 模型。官方 DeepSeek 路由和 GLM-5.3 模型通过 Muse 代理时显式配置思考协议和必需的 `reasoning_content` 字段，不依赖从代理 URL 猜测上游提供方。

已有会话中的未配置直连路由可使用 Muse 目录中相同的精确模型。只有本次请求组装的提供方、模型和推理级别仍与当前选择一致，Host 才通过正常模型选择事件和请求头记录切换；用户较新的选择会保留。如果 Muse 不供应该模型，会话会提示用户在模型选择器选择可用的 Muse 模型。

回答评分与任务反馈弹窗提交到侧栏意见反馈页面所用的同一个 Muse 意见箱。提交使用桌面保存的账号，并保留分类、本地会话及消息标识。相关摘录的可选勾选框默认关闭；勾选后只附有限长度的可见请求和回答文字，并移除已知凭据。不发送工具参数、工具结果、思考内容、附件或完整会话日志。意见箱保存凭据经确认后表单才关闭；登录、网络和账号切换失败保留草稿。提交结果不确定时，应先查看意见箱再决定是否重试。管理员在 `/feedback` 查看全部意见，普通用户只能查看自己的意见。

### Minimal configuration

桌面 Host 从 [`desktop.cordis.patch.yml`](../../../apps/desktop-host/config/desktop.cordis.patch.yml) 装载此配置行：

```yaml
- name: '@deepseek-ai/dsh-muse-account'
  config:
    baseUrl: https://muse.aigc-pipeline.cn
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | HTTPS 网关源地址；本机回环网关可使用 HTTP。 |
| `excludedModelPrefixes` | `[]` | 账号供应模型需要排除的模型名称前缀，忽略大小写；比较前会移除可选的提供方路径。不影响自定义提供方。 |
| `modelRefreshMs` | 60,000 | 模型目录刷新间隔毫秒数，可设为 10,000 至 3,600,000。 |
| `accountHome` | 当前 DSH 主目录 | 存放本产品账号会话文件的绝对目录。 |
| `requestTimeoutMs` | 15,000 | 账号和知识库授权请求的超时毫秒数，可设为 1,000 至 120,000。 |
| `feedbackExcerptChars` | 1,000 | 每条可选相关请求或回答摘录的可见字数，可设为 100 至 1,200。 |
| `asrRequestTimeoutMs` | 300,000 | 一次压缩音频上传与网关响应的超时毫秒数，可设为 10,000 至 1,800,000。 |
| `remoteAccess` | `false` | 启用账号绑定的桌面连接；Muse 桌面默认启用。需要桥接、Connection 和 Web server 提供者。 |
| `remoteChunkBytes` | 32,768 | 需确认的数据段大小，可设为 1,024 至 32,768 字节。 |
| `remoteAckTimeoutMs` | 15,000 | 握手和数据确认超时，可设为 1,000 至 120,000 毫秒。 |
| `remoteReconnectMaxIntervalMs` | 60,000 | 网络断开后的最大重连间隔，可设为 1,000 至 300,000 毫秒。 |

[配置目录](../../../docs/config-catalog.zh.md)由插件 schema 生成。装载本插件前需挂载 `tools`、`llm`、`sessionProjections` 和 `agentDefaultModel`；桌面 Host 组合已提供这些必需服务。本包已包含在桌面 Host 配置中，不是独立应用启动入口。

### Desktop access from the website

启用远程访问时，登录或恢复已保存的账号会主动连接网关。在网页版登录同一账号，即可使用桌面端的会话、文件和进度。离线时，网页版显示 **您的电脑上的 Muse 未启动** 并检查恢复连接，不会启动替代的云端 Agent。每台安装发送持久 UUID、电脑名称和操作系统。同一账号可同时连接多台电脑；网页版选择其中一台，并让每个标签页绑定该电脑。切换入口在新标签页打开电脑列表。会话与文件保留在各自安装中。

连接器用现有 Host 启动授权换取私有回环 cookie，它与 Muse 会话都只放在 HTTP 请求头。切换账号会等待旧连接关闭。退出先断开连接再联系网关；失败时，该已保存会话修订保持暂停，直到重新登录。关闭浏览器数据流只移除观察者，不取消 Agent 工作，也不重试已提交请求。账号撤权与会话过期会关闭访问。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

通过身份验证的 `museAccount` Remote 命名空间把[设置界面](../../client/ui-muse-account/README.zh.md)调用送至 Host 账号控制器。控制器向已配置的网关提交凭据、确认返回的身份，并把绑定网关源地址的 cookie 原子写入产品主目录。Remote 响应只包含固定错误类别和账号身份，不包含密码或 cookie。

已认证的 `museAccount.feedback` Remote 接收经 Typert 验证的标识和评分，核对实际反馈目标，捕获绑定源地址的账号 revision，并在准备文字后重新核对。它携带捕获的 cookie 和 Origin 请求头，向同源 `/api/muse.feedback` 发送一次 JSON POST，不跟随重定向，不重试结果未知的写入。保存凭据必须匹配账号名及实际提交的标题、正文和分类。提交期间切换账号会报告账号变化结果，应查看原账号意见箱。Muse 桌面关闭上游会话日志发送插件。输入 Host 命令 `/feedback <text>` 仍只记录本地意见。

Host 通过普通 Node 运行包内构建后的 `lib/types/mcp-server.js`，并等待 MCP 工具发现。挂载本插件的源码 profile 需要先执行 `pnpm run build`。每次知识库调用时，子进程通过 `/api/kb/access` 将当前保存的 cookie 换成新的短时 bearer，再调用同源 MCP 接口；它不持久化或返回 bearer。`muse_kb_ingest_script` 一次提交最多 12 集或章经复核的 Markdown 剧本，请求总量不超过 2 MiB，并逐项报告已写入、已存在或失败。九个 `muse_kb_wiki_*` 工具提供不可变来源采集、目录浏览、全文检索、原文或页面阅读、带引用的页面写入、历史、链接、状态和迁移预览。范围默认为 `private`；`project` 需要账号内的 `project_id`，`shared` 使用明确授权且仅管理员可写。页面写入携带原始来源字符引用和 `expected_revision`；冲突后必须读取并合并当前页再重试。来源采集建立待综合的来源页，迁移预览既不修改原件也不改变授权。旧阅读工具保留每页 6,000 字符与开头最多 24,000 字符的限制。

MCP SDK 验证远程响应字段，本地桥接仅接受文本块。本地失败只返回固定错误码，不传递上游响应文本。经过限长与识别的 Wiki 错误区分修订冲突、写入占用、无效引用、未解析链接和访问拒绝。模型会收到 Wiki 编辑重试所需的固定指引；未知错误和包含 bearer 的结果仍会被拒绝。每次调用都会重读账号会话，因此登录刷新与退出无需重启 MCP 子进程即可生效。

仅 Host 使用的 `MuseAsrClient` 为 `audio_transcribe` 工具读取同一账号会话。提交携带收据可选的 `X-Muse-Asr-Purpose`（`subtitles` 或 `screenplay`）；查询使用按账号隔离的既有任务 ID。省略用途保留旧路由。客户端接受可选的安全用途与服务版本元数据，校验并保留分句与字词的秒级时间戳，拒绝无效时间范围。桌面不暴露提供方密钥、资源选择器或 TOS 凭据。未登录、网关不可用或服务器未配置 ASR 都明确报错。服务器部署与任务限额见 [`services/muse-accounts`](../../../services/muse-accounts/README.zh.md)。

转写拒绝区分队列容量、上传繁忙、账号请求频率、提供方服务限制、账号日额度和幂等冲突。客户端保留校验后的 `Retry-After` 秒数，丢弃上游诊断文本。一次 HTTP 调用内不重试提交；由持有收据的工具控制明确恢复。

本包不发布运行时不变量伴随插件，因为账号状态和已注册 MCP 工具都能通过各自所属的服务或工具注册表观察，没有可能独立产生分歧的第二份状态。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 带服务端名称的工具命名与生命周期。
- [桌面应用组合](../../../apps/desktop/README.zh.md) — 已交付的应用配置。
- [账号与知识库决策](../../../.agents/notes/implemented/feature/2026-09-28-muse-account-kb-access.zh.md) — 凭据与来源访问的取舍。

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

内置 MCP 服务连接后，模型会收到十六个 schema：账号状态、四个旧来源操作、九个范围内 Wiki 操作、参与汇报和获授权的项目组合。Wiki 结果包含来源或页面 ID、摘要哈希、修订号、引用、链接、限长摘录和续读起点。写入工具区分不可变原件、综合知识页与经复核的剧本段落。`muse_kb_wiki_record_project` 区分已保存详情与未同步概览；`muse_kb_wiki_project_portfolio` 标明本人或获授权的跨账号访问。密码、cookie 和 bearer 不出现在工具参数或结果中。模型可见的参数与结果仍属于 Session 数据。

#### Token effect

服务装载期间，十六个工具 schema 构成稳定的请求开销。调用将返回文本追加到对话；旧结果最多 128 KiB，Wiki 结果为链接图和引用提供最多 4 MiB。阅读按每页 6,000 字符返回。超过相应上限的结果会被拒绝，包括异常庞大的歧义链接候选列表。本包不增加系统提示词文本。

#### KV Cache effect

稳定的工具 schema 保留已有可复用的请求前缀。新的工具结果会延长对话；账号状态和知识库内容可在不同调用之间变化，但不会替换先前记录的 token。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于内置桌面账号流程。

- **同一系统用户的文件访问** — 保存的 cookie 不在模型会话中，但以同一系统用户身份运行的智能体进程，仍可能通过文件工具读取会话文件。设置页和 Remote 路由不提供完整隔离；更强的隔离需要系统凭据库、独立账号或更严格的沙箱读取权限。
- **依赖网关** — 账号私有写入与知识库阅读需要已部署的网关、私有用户目录和明确的共享文档授权。只发布源码不会启用这些能力。
- **参与汇报** — 工具保存并核验 Agent 汇报，不独立检查产物或证明完成。预设提示主动更新阶段记录，不观察每次 shell 操作。极简模式没有 Wiki 工具，只保留本地待同步记录。
- **智能体指令** — 编辑模式提示智能体在起草前阅读有用的剧本和案例材料；Host 不强制执行写作前检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

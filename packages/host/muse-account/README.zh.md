---
description: "登录 MUSE，使用账号授权的模型、网页搜索、云语音和桌面服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

[English](README.md) | 中文

## 概述

用户可以在桌面版设置中登录 MUSE，无需在模型会话中输入密码。通过已配置的 Muse 网关，使用账号模型目录、可选网页搜索、云转写、意见反馈和桌面远程访问。账号凭据保留在 Host 存储中。

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

Muse Desktop 在空白首启时先提供 MUSE 登录，再检查模型配置；选择**稍后登录**仍可从侧栏和**设置 → MUSE 账号**进入。打开页面时会刷新模型目录；点击**验证状态**可向网关确认账号身份。账号页面直接发起飞书浏览器登录，不提供用户名、密码或注册表单。同一登录会话会加载网页版模型目录，并用于模型调用和语音转写。新配置自动选择首个 Muse 模型；未配置自身凭据的旧直连默认路由会选择对应的 Muse 路由。模型设置仍可添加自定义提供方和凭据，已配置凭据的自定义默认模型会保留。退出登录只撤下 Muse 模型。官方 DeepSeek 路由和 GLM-5.3 模型在两种传输方式下都显式配置思考协议和必需的 `reasoning_content` 字段，不依赖从代理 URL 猜测上游提供方。智谱官方 GLM-5.3 请求在启用思考时，通过 `clear_thinking: false` 保留历史思考，有工具时发送 `tool_stream: true`，让工具参数可以增量返回。

每次目录刷新成功后以及 Agent 创建期间，Muse 可以把未配置自身凭据的直连选择替换为同一模型的 Muse 路由。提交时，完整的提供方、模型和显式推理选择仍须与此前观察一致；账号变化、个人凭据已配置、模型或显式推理档位不可用，或较新的选择都会阻止替换。修复仅记录供后续步骤使用的模型选择。已经组装的请求保留捕获的路由及其正常凭据错误；重试前请刷新目录或显式选择 Muse 模型。

浏览器登录只打开已配置 Muse 源地址下精确的桌面授权或飞书入口网址，拒绝额外查询参数和片段。Host 请求 `provider=feishu`；启用飞书的网关直接跳转飞书官方授权 UI，随后用户在 MUSE 页面核对桌面端设备码并确认设备。不支持飞书的网关保留原授权网址，新网关也为未提交 provider 字段的旧客户端保留该网址。短期授权兑换成独立的桌面会话。兑换密钥仅保留在 Host 内存，不进入界面、浏览器 URL、Agent 或会话日志。Host 验证身份并写入既有的、绑定源地址的会话文件，再报告成功。发起、检查与取消按顺序执行；密码登录和退出先收取取消结果。已保存的登录复用密码登录的模型、语音与桌面远程访问服务。网关重启或兑换结果丢失时需要重新发起。使用浏览器按钮前须部署对应账号网关接口；旧认证接口继续供现有消费者使用。

账号认证并保存 session 后，即使紧接着的桌面连接或模型目录刷新失败，桌面端仍报告登录成功。读取账号状态时同样以账号控制器返回的本地状态或显式验证结果为准；刷新失败会分别记录，后台定时刷新可继续重试。模型目录或直连访问端点返回 401 时，只撤下 Muse 路由并删除该登录 revision 对应的模型访问凭据，不删除账号 session。只有显式账号验证负责确认并清除无效 session。

网关明确启用桌面直连后，Muse 在登录后下载供应商密钥，在 `session.json` 旁将其保存为 `model-access.json`，POSIX 文件仅所有者可读写，并直接向各供应商发送流式请求。密钥不进入 UI 显示的模型目录、配置设置或会话日志，但本机操作系统用户可以提取它；Windows 保护依赖账号目录 ACL。刷新会重新领取当前密钥；启动要求在线授权，不信任已保存的文件。退出或确认会话失效会撤回模型、取消请求并删除该登录的凭据文件，同时保留并发产生的新登录。Host 销毁时立即撤回模型，并等待刷新与私人文件操作完成；已取消的保存会在销毁完成前撤回，迟到的完成回调不能重新注册模型。网关不能撤销 Muse 之外已复制的密钥；被禁用账号在 Muse 内也可能继续使用到下一次成功授权刷新。阻止已复制密钥的使用需要供应商撤销或轮换。

网关可让部分提供方经过中转，其他提供方继续直连。桌面端协商 `mixed-v1` 和智谱 `leased-v1`；收到 `transport: leased` 时，每条供应商流单独领取临时凭据，不保存到 `model-access.json`。准入请求只携带模型 ID，消息、图片和回复直接在桌面与供应商之间传输。Host 定期检查账号授权，授权被拒绝或达到请求时限时取消，并在流清理后报告完成。准入中断或响应无法读取时返回 `MODEL_ACCESS_UNCERTAIN`，默认重试策略不会重复该请求；网关将可能已签发的占用保留到时限。访问 JSON 无效时返回 `INVALID_CONFIG`，调用方取消时返回 `ABORTED`；HTTP 拒绝保留状态和有效重试延迟，并分别归类为认证、限流、服务端或无效请求错误。这不会新增对结果不明的准入或供应商调用的重试。旧网关仍可返回中转。持久化占用恢复、时限，以及 JWT 撤销与供应商并发的限制见[网关准入配置](../../../services/muse-accounts/README.zh.md)。

准入成功后，账号存活检查失败返回不可重试的 `MODEL_ACCESS_CHECK_FAILED`，保留已知 HTTP 状态和有效重试延迟；达到访问时限返回不可重试的 `MODEL_REQUEST_DEADLINE`。用户主动取消仍为 `ABORTED`。这些失败会取消供应商工作，等待检查器结束，并尝试释放原预留，不会重新领取凭据；释放失败时，服务端预留保持到原截止时间。

模型拒绝与取消流只提供固定诊断，以及可用的错误类别、HTTP 状态和重试延迟。Host 诊断日志只记录 provider、model、错误类别、HTTP 状态和有长度限制的供应商请求 ID；供应商错误原文、凭据、Authorization 标头、诊断请求标识和异常原因链不会进入会话日志。成功的模型内容与重放元数据保持原样。内容安全拒绝保留 `CONTENT_FILTER`，不会变成暂时性重试类别。

Muse 账号模型在当前供应商的有界重试结束后，遇到已归类的额度、限流、服务、超时、连接或空响应故障，会在同一轮次依次尝试其他已授权且可选择的供应商，每个供应商最多选择一个模型；同一模型优先，其次同系列模型。候选须支持当前完整会话中的图片、原模型的上下文容量、显式输出上限及显式思考档位。每次切换都记录正常模型选择并在新步骤重新组装提示词和工具，失败流不会执行其中的工具调用。候选耗尽后会停止并报告错误。账号注销、用户取消、账号或供应商认证失败、内容安全拒绝、无效请求、结果不确定的准入和请求截止不会触发切换；个人配置的供应商不会被自动选用。

每次 Muse 模型调用生成随机 `client_request_id`。Host 诊断将其会话、提供方、模型与用途关联到可用的、长度受限的响应标识、结束原因及用量。诊断中的 Token 计数只接受非负安全整数；无效字段省略，不改动模型流中的原始数据块。适配器经过公开的请求标头准备 waterfall；仅向已配置 Muse 中转 origin 的请求携带 `x-muse-client-request-id`，供应商直连不携带该标头。诊断不记录消息正文、凭据、完整标头或异常原文；这些请求标识不增加 Session 事件，也不改写重放元数据。客户端标识对应一次准备好的调用，网关的每次 HTTP 尝试另有独立标识。

模型使用账号目录为各模型声明的默认思考档位，直到用户显式选择其他受支持的档位。准备调用时，模型默认档位会进入实际请求日志；没有思考能力的模型不会收到默认思考档位。云映的精确 `gpt-6.1-sol` 模型使用 `max_completion_tokens` 设置输出上限。

`volcengine-ark` 账号路由的 DeepSeek V4.1 Flash `260910` 与 `261017` 模型 ID 支持 `v4-1` 和 `v4.1` 两种版本分隔写法，均使用 `thinking.type`。`alibaba-bailian` 路由的精确 `deepseek-v4.1-flash-1017` 模型 ID 使用 `enable_thinking`。两者均在工具续接中保留助手的 `reasoning_content`，并遵循目录默认思考档位或显式 `off` 选择；各模型支持的档位由账号目录声明。

模型菜单只显示账号目录公布的思考档位。云映 GPT-6.1 Sol 支持 `low`、`medium`、`high`、`xhigh` 和 `max`；Gemini 3.1 Pro 支持 `low`、`medium` 和 `high`。会话菜单保留将选择保存为个人默认值的既有行为，不改写服务器目录默认值。Gemini 在传递所选 `reasoning_effort` 时保留 `include_thoughts: true`。指定思考档位不保证供应商每一步都返回可见摘要。

目录刷新期间保存的模型选择优先于初始账号默认选择。刷新后的目录仍可使用；无关的设置写入错误仍会使刷新失败。

已有会话中的未配置直连路由可使用 Muse 目录中相同的精确模型。只有本次请求组装的提供方、模型和推理级别仍与当前选择一致，Host 才通过正常模型选择事件和请求头记录切换；用户较新的选择会保留。如果 Muse 不供应该模型，会话会提示用户在模型选择器选择可用的 Muse 模型。

回答评分与任务反馈弹窗通过[账号 UI](../../client/ui-muse-account/README.zh.md)提交到 Muse 意见箱。提交使用桌面保存的账号，并保留分类、本地会话及消息标识。相关摘录的可选勾选框默认关闭；勾选后只附有限长度的可见请求和回答文字，并移除已知凭据。不发送工具参数、工具结果、思考内容、附件或完整会话日志。意见箱保存凭据经确认后表单才关闭；登录、网络和账号切换失败保留草稿。提交结果不确定时，应先查看意见箱再决定是否重试。管理员在 `/feedback` 查看全部意见，普通用户只能查看自己的意见。

启用 `feedbackTools: true` 后，`muse_feedback_submit` 从实际调用 Agent 的会话提交用户明确提出的问题或建议，`muse_feedback_status` 查询当前登录账号拥有的反馈收据。工具不提供管理员操作。提交需提供稳定的 `requestId`、标题、类型和正文；相关可见摘录仍默认不附带。结果不确定时保留原编号及完全相同的内容。旧服务器返回的匹配收据仍可确认保存，但会报告不支持重复保护，此时不得再次提交。原编号下若反馈文字或捕获的摘录发生变化，服务器会拒绝并报告冲突。状态结果不含会话正文、附件或处理历史，并移除已知凭据。已保存反馈不代表问题已修复或新版已发布。

### 账号授权的网页搜索

配置 `webSearch: true` 时，Muse Desktop 选择 `muse` 搜索提供方，`web_fetch` 继续使用现有 `http` 提供方。原有 `web_search` 工具使用已保存的 Muse 会话，把每条查询及可选结果数发送到同源 `/api/web/search` 接口。官方搜索 API Key 保留在服务器，不要求本地 `DEEPSEEK_API_KEY`、模型凭据或 DeepSeek Account 登录。非 Muse profile 保留各自配置的搜索提供方。

搜索拒绝重定向，使用独立的 `searchRequestTimeoutMs` 时限，将网关 JSON 限制为 1 MiB，只返回校验过的来源 URL、标题、摘要片段或 summary 后备文本及日期。工具的来源数量上限仍有效。请求期间退出或切换账号会拒绝该结果。错误使用固定诊断，不包含原始网关响应、凭据值或传输异常，不自动重试。插件卸载会取消并等待在途搜索结束。客户端选择该提供方前，账号网关须先部署对应接口。

### 公司媒体

启用 `mediaTools: true` 后，`muse_media_data`、`muse_media_download`、`muse_media_task`、`muse_media_import` 四个延迟加载工具使用当前私密 Muse 登录。桌面默认启用，员工无需填写上游 API Key。匹配的[公司媒体网关](../../../services/muse-media/gateway/README.zh.md)检查公司成员身份、任务归属与按账号限流。权限拒绝不会删除 Muse 登录。每次调用捕获当前登录修订，账号变化后拒绝交付；卸载会取消并等待网络请求和本地辅助进程结束。

云端提交必须携带稳定 `requestId`；结果不确定时查询原任务，不得换编号重新提交。`cloud_saved` 仅表示云端完整保存。`partial` 只公开逐项接受的文件，导入其中一个文件后整个任务仍为部分完成。导入原样使用云端清单中的文件名，包括允许的空格和括号，不做重命名。清单与导入共用同一文件名规则：以 ASCII 字母或数字开头，长度最多 128 个字符，仅含字母、数字、点、下划线、连字符、空格和括号，不含 `..` 或路径分隔符。导入要求发起会话有本机工作区，拒绝只读策略和覆盖已有文件，工作区写入辅助进程通过已配置的操作系统沙箱执行。完整字节数、SHA-256、FFprobe 元数据和 FFmpeg 完整解码通过后才发布文件。`local_ready` 仅代表一个校验过的图片或视频，同时保留源任务状态和文件覆盖信息；图片不代表视频成功。使用现有 `present` 工具展示返回路径，生成文件卡并进入视频清单。私有辅助进程以内联代码打包，没有公开可执行入口，也不接收账号凭据。

### 共享声线登记

`MuseAccountService.requestVoiceSlot` 仅供 Host 使用，沿当前私密 Muse 会话调用[共享登记协调器](../../../services/muse-accounts/README.zh.md#shared-voice-registration)。剧变 token 仅通过私密请求头发送，响应后核对账号修订，拒绝重定向，将严格 UTF-8 协调响应限制为 16 KiB，且不自动重试。该方法不是 Remote 接口，也不是模型可见的凭据读取器。未配置服务时拒绝新的协调登记，已有音频复用和其他制作工作仍可继续。

<a id="host-credential-reads"></a>
### Host 凭据读取

包主入口导出的 `readMuseSession(file, baseUrl)` 读取显式指定的私有会话文件，并核对配置中的规范化网关 origin。文件不存在或会话属于其他 origin 时返回 null；存储数据格式错误时明确拒绝。Host 集成可复用该读取器，无需挂载账号的模型 provider。返回的 cookie 属于 Host 私有数据，不得进入 Remote 结果、模型消息或发往其他 origin 的请求。[`muse-market/cloud`](../muse-market/README.zh.md#account-bound-cloud) 通过独立的 `sessionFile` 配置使用该读取器。

本地登录、登出和浏览器登录完成后会发送普通 `muse-account/session-changed`；观察到账号状态变化时也会发送。该通知不携带凭据或身份 payload。消费者撤销缓存的私有能力，并重新查询真实当前身份；外部会话文件替换由账号绑定的传输在每次请求时校验。

### 云转写

云转写响应只保留校验过的供应商额度类别和可选的 `recovery.retry_after` 等待秒数。lifetime 额度耗尽时，先恢复原应用额度，再查询既有任务；这些字段或 HTTP 429 都不授权新建付费任务。

原生导入器完成校验和发布后，账号传输使用准确的文件占用和摘要，发送一次有时限、按账号归属验证的导入确认。普通读取、解码失败及不完整传输不发送确认。确认失败或丢失时不重试，云端继续使用较长保留期，不使已验证的本地文件失效。没有占用字段的旧服务器仍可使用。本地提交前切换账号和取消操作仍会拒绝交付；确认阶段不能回滚已经提交的本地文件。

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
| `excludedModels` | `[]` | 从账号目录排除的精确 `{ providerId, modelId }` 组合；不影响其他提供方的同 ID 模型或个人适配器。 |
| `excludedProviderIds` | `[]` | 从目录排除的精确账号提供方 ID，须符合网关的小写标识语法；不影响个人适配器。 |
| `hiddenProviderIds` | `[]` | 为已保存 Session 保持注册、但从新模型选择和账号默认模型中隐藏的精确账号提供方 ID，`visibleModels` 指定的模型除外。ID 须符合网关的小写标识语法；不影响个人适配器。 |
| `visibleModels` | `[]` | 隐藏的账号提供方中仍可选择的精确 `{ providerId, modelId }` 组合。已排除的提供方和模型仍被排除；不影响其他提供方和个人适配器。 |
| `modelRefreshMs` | 60,000 | 模型目录刷新间隔毫秒数，可设为 10,000 至 3,600,000。 |
| `accountHome` | 当前 DSH 主目录 | 存放本产品账号会话文件的绝对目录。 |
| `requestTimeoutMs` | 15,000 | 账号网关请求的超时毫秒数，可设为 1,000 至 120,000。 |
| `webSearch` | `false` | web 服务存在时注册 `muse` 搜索提供方；Muse Desktop 启用此项。 |
| `searchRequestTimeoutMs` | 60,000 | 独立的账号授权搜索超时毫秒数，可设为 1,000 至 120,000。 |
| `modelRequestImageMaxBytes` | 适配器默认值（`20 MiB`） | 每次模型请求累计 base64 图片字节上限，可设为正安全整数。挂载 `compaction-image-offload` 后记录最早图片的卸载并重试，来源附件仍可读取；不限制正文输出。 |
| `feedbackTools` | `false` | 注册明确的用户反馈提交及本人收据查询工具；Muse 桌面启用。 |
| `mediaTools` | `false` | 注册四个延迟加载的公司媒体工具；桌面默认启用。 |
| `mediaRequestTimeoutMs` | 60,000 | 元数据与收据请求时限，范围 1,000–120,000 毫秒。 |
| `mediaFileTimeoutMs` | 1,800,000 | 文件传输及消费全过程时限，范围 10,000–3,600,000 毫秒。 |
| `mediaVerifyTimeoutMs` | 1,800,000 | 本地辅助进程与完整解码时限，范围 10,000–3,600,000 毫秒。 |
| `mediaMaxReplyBytes` | 1,048,576 | 完整 JSON 响应字节上限，范围 1 KiB–16 MiB。 |
| `mediaMaxFileBytes` | 536,870,912 | 单个导入文件字节上限，正安全整数。 |
| `mediaDirectory` | `source/media/company` | 相对目标目录，路径段仅含字母、数字、下划线或连字符。 |
| `mediaNodePath` | `node` | 私有辅助进程的 Node 可执行文件；桌面使用当前宿主可执行文件。 |
| `mediaFfmpegPath` | `ffmpeg` | 完整解码可执行文件；桌面使用 `DSH_FFMPEG_PATH`。 |
| `mediaFfprobePath` | `ffprobe` | 元数据检查可执行文件；桌面使用 `DSH_FFPROBE_PATH`。 |
| `mediaCommandGraceMs` | 1,000 | 进程终止宽限，范围 100–30,000 毫秒。 |
| `mediaCommandMaxOutputBytes` | 65,536 | 完整辅助进程报告与诊断上限，范围 1 KiB–1 MiB。 |
| `mediaMaxPixels` | 67,108,864 | 导入媒体宽乘高上限，正安全整数。 |
| `mediaMaxDurationSeconds` | 7,200 | 视频时长上限，范围 1–86,400 秒。 |
| `feedbackExcerptChars` | 1,000 | 每条可选相关请求或回答摘录的可见字数，可设为 100 至 1,200。 |
| `activityReportIntervalMs` | 30,000 | 同一登录两次使用情况上报的最短间隔，范围 1,000–3,600,000 毫秒。 |
| `activityRequestTimeoutMs` | 5,000 | 尽力上报使用情况的请求时限，范围 100–30,000 毫秒。 |
| `asrRequestTimeoutMs` | 300,000 | 一次压缩音频上传与网关响应的超时毫秒数，可设为 10,000 至 1,800,000。 |
| `remoteAccess` | `false` | 启用账号绑定的桌面连接；Muse 桌面默认启用。需要桥接、Connection 和 Web server 提供者。 |
| `remoteChunkBytes` | 32,768 | 需确认的数据段大小，可设为 1,024 至 32,768 字节。 |
| `remoteAckTimeoutMs` | 15,000 | 握手和数据确认超时，可设为 1,000 至 120,000 毫秒。 |
| `remoteReconnectMaxIntervalMs` | 60,000 | 网络断开后的最大重连间隔，可设为 1,000 至 300,000 毫秒。 |

[配置目录](../../../docs/config-catalog.zh.md)由插件 schema 生成。装载本插件前需挂载 `tools`、`llm`、`sessionProjections`、`agentDefaultModel` 和 `sessions`；桌面 Host 组合已提供这些必需服务。本包已包含在桌面 Host 配置中，不是独立应用启动入口。

### Desktop access from the website

启用远程访问时，登录或恢复已保存的账号会主动连接网关。在网页版登录同一账号，即可使用桌面端的会话、文件和进度。离线时，网页版显示 **您的电脑上的 Muse 未启动** 并检查恢复连接，不会启动替代的云端 Agent。每台安装发送持久 UUID、电脑名称和操作系统。同一账号可同时连接多台电脑；网页版选择其中一台，并让每个标签页绑定该电脑。切换入口在新标签页打开电脑列表。会话与文件保留在各自安装中。

连接器用现有 Host 启动授权换取私有回环 cookie，它与 Muse 会话都只放在 HTTP 请求头。切换账号会等待旧连接关闭。退出先断开连接再联系网关；失败时，该已保存会话修订保持暂停，直到重新登录。关闭浏览器数据流只移除观察者，不取消 Agent 工作，也不重试已提交请求。账号撤权与会话过期会关闭访问。

根会话的一轮中，已提交的用户输入会尽力向 `/api/muse.activity` 发送 `task-start` 标记，供管理员统计使用情况。目标自动续轮、子代理、历史记录和模型目录刷新不会上报。请求不含任务标识、标题、路径、消息或客户端时间戳，由网关记录服务器时间。Host 捕获并复核已保存的登录版本，使用 `activityReportIntervalMs` 限制同一登录的上报频率，以 `activityRequestTimeoutMs` 限定请求时长。重叠的根会话轮次合并处理，同时最多有一次未完成的账户读取和一次未完成的网络请求。上报不延迟任务、不重试失败写入，也不持久化发送队列，因此离线使用可能未被记录。插件卸载会取消并等待尚未结束的上报。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

通过身份验证的 `museAccount` Remote 命名空间把[设置界面](../../client/ui-muse-account/README.zh.md)调用送至 Host 账号控制器。控制器向已配置的网关提交凭据、确认返回的身份，并把绑定网关源地址的 cookie 原子写入产品主目录。Remote 响应只包含固定错误类别和账号身份，不包含密码或 cookie。

未注入传输实现时，账号网关的每次请求都读取当前的全局 fetch；显式注入的传输实现在客户端存续期间保持不变。

只有当前网关返回严格的 `admin: true` 与精确的 `/admin` 路径时，已验证账号状态才提供管理员入口。Host 将该路径转换为已配置源地址下的网址，丢弃其他管理员目标。本地缓存状态从不提供管理员入口，登录持久化只在既有会话字段旁保留用户名、环境与工作区标签。

已认证的 `museAccount.feedback` Remote 接收经 Typert 验证的标识和评分，核对实际反馈目标，捕获绑定源地址的账号 revision，并在准备文字后重新核对。它携带捕获的 cookie 和 Origin 请求头，向同源 `/api/muse.feedback` 发送一次 JSON POST，不跟随重定向，不重试结果未知的写入。保存凭据必须匹配账号名及实际提交的标题、正文和分类。提交期间切换账号会报告账号变化结果，应查看原账号意见箱。Muse 桌面关闭上游会话日志发送插件。输入 Host 命令 `/feedback <text>` 仍只记录本地意见。

仅 Host 使用的 `MuseAsrClient` 为 `audio_transcribe` 工具读取同一账号会话。提交携带收据可选的 `X-Muse-Asr-Purpose`（`subtitles` 或 `screenplay`）；查询使用按账号隔离的既有任务 ID。省略用途保留旧路由。客户端校验可选用途、实际服务版本、已受理排队状态、固定错误类别、受限提供方诊断和恢复指示。未知元数据保持缺失，不能由用途推断旧任务的版本。分句与字词时间戳保留秒数，拒绝无效时间范围。桌面不暴露提供方密钥、资源选择器或 TOS 凭据。未登录、网关不可用或服务器未配置 ASR 都明确报错。服务器部署与任务限额见 [`services/muse-accounts`](../../../services/muse-accounts/README.zh.md)。

Host 转写调用同时接受调用方取消信号与请求超时。取消会终止上传和响应读取，保留调用方的取消原因，并等待传输或未读取响应体清理完成后结束。取消不会撤销网关已受理的任务。

转写拒绝区分队列容量、上传繁忙、账号请求频率、提供方服务限制、账号日额度和幂等冲突。客户端保留校验后的 `Retry-After` 秒数，以及安全的诊断类别、操作、HTTP 状态和数字提供方码；丢弃响应正文、签名 URL、账号及资源身份和凭据。一次 HTTP 调用内不重试提交；由持有收据的工具控制明确恢复。

本包不发布运行时不变量伴随插件，因为账号控制器与模型注册表拥有可观察的账号和路由状态。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 带服务端名称的工具命名与生命周期。
- [桌面应用组合](../../../apps/desktop/README.zh.md) — 已交付的应用配置。
- [移除内置知识库](../../../docs/upgrade-guide/v0.2.1-alpha.1/muse-account-kb-removal/guide.zh.md) — 已移除工具与自定义 MCP 配置。

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

模型请求使用选定的账号提供方与模型。可选账号搜索通过原有 `web_search` 工具返回校验过的来源。本包不提供账号状态或知识库工具 schema。密码和 cookie 不进入工具参数及结果。模型图片预算超出时，已组合的图片卸载执行器会记录最早图片的占位文字；模型仍可重新读取原附件。

#### Token effect

启用 `feedbackTools` 时，模型请求增加两个反馈工具 schema，收据结果进入正常工具历史。反馈和媒体工具均关闭时，本包不增加工具 schema 或系统提示词文本。启用 `mediaTools` 注册四个延迟加载 schema，由发现机制控制请求准入，接受的结果进入正常工具历史。可选账号搜索沿用原有网页工具 schema，并将返回的来源追加到会话。

#### KV Cache effect

账号设置与状态保留为 Host 和 Client 数据。模型选择与原有工具历史规则决定请求前缀的复用。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于内置桌面账号流程。

- **同一系统用户的文件访问** — 保存的 cookie 不在模型会话中，但以同一系统用户身份运行的智能体进程，仍可能通过文件工具读取会话文件。设置页和 Remote 路由不提供完整隔离；更强的隔离需要系统凭据库、独立账号或更严格的沙箱读取权限。
- **依赖网关** — 账号授权的模型、网页搜索和语音需要已部署的匹配网关服务。只发布源码不会启用这些能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

---
description: "部署并验证 Muse 账号网关、云端知识库和按账号隔离的语音转写。"
kind: "package-reference"
---

# Muse accounts gateway

[English](README.md) | 中文

## Summary

本目录包含单独部署的 Muse 账号网关。网关提供按账号隔离的语音转写、按管理员授权阅读参考资料，以及私有剧本保存。桌面端和工作区包不启动它，也不保存火山或 TOS 凭据。

## Release inputs

网关开始监听后，启动日志报告实际回环端口。隔离部署检查可设置 `MUSE_PORT=0`，由操作系统分配可用端口。

网关需要 Node 22 或更新版本，以及账号、模型、知识库路由使用的发布根目录 DSH 依赖。云端工作区模式和管理员运行时上下文还需要对应版本的 `muse-runtime` 与 `global` 发布目录；桌面工作区模式不启动云端 Agent。复制进每个新的不可变发布目录后，在本目录运行 `npm ci --omit=dev`；`package-lock.json` 锁定 TOS SDK 和 WebSocket 传输依赖。启用 ASR 时，服务器必须具备 `ffprobe`。账号数据库、知识库文件、凭据和 ASR 任务账本不得复制进发布树。

服务从 `MUSE_ASR_CONFIG` 指向的私有 JSON 文件读取配置。省略此变量即关闭 ASR，已登录的 ASR 请求返回 503。Linux 上该文件须为权限 0600 的普通文件，包含以下字段：

| 字段 | 用途 |
|---|---|
| `appId`、`accessToken` | 旧单应用的服务器专用凭据。使用资源池时，以 `defaultPoolId` 保留原应用；若同时提供顶层 `appId`，它必须与该资源一致。 |
| `providerKind` | 旧单资源默认值：`standard`（1.0）或 `flash`；显式资源分别声明版本。 |
| `resources`、`quotaGroups`、`defaultPoolId` | 资源声明 `poolId`、`appId`、私密 `accessToken`、`quotaGroup`、`maxConcurrentJobs` 及对应 `serviceVersion`／`resourceId`。组声明 `id`、共享 `maxConcurrentJobs` 及可选日额度；默认资源处理未提供用途的请求并保留旧归属。 |
| `routes` | 用途映射：`{ "subtitles": "flash", "screenplay": "standard-v2" }`；兼容时显式选择 `standard-v1`。混合池须使用这些服务类型并提供对应资源。 |
| 组 `submitQps`、`queryQps` | 标准版提交与查询的独立频率，各默认 10；合计不超过 20 QPS，不表示在途任务数。 |
| 组 `rollingAudioWindowSeconds`、`maxRollingAudioSeconds` | 可选且成对配置的组时长上限，覆盖所有账号与版本。标准版部署使用 1,800 秒／1,800,000 音频秒，对应官方半小时提交 500 小时限制。 |
| `legacyAppId` | 用于迁移无资源字段收据的原应用 ID，默认取保留的顶层 `appId`。显式资源池存在旧收据时必须提供此归属，并与默认应用一致。 |
| `maxConcurrentJobs`、`maxQueuedJobs` | 全局工作线程上限与真实等待容量（默认 20）。旧线程默认 5 且不能超过 5；资源池按组与应用／服务组合计算容量，显式全局上限不得更大。标准版名额保留到完成，包括未知结果；等待队列满时返回 429。 |
| `maxPendingUploadsPerAccount` | 每账号未完成上传上限（默认 4）；请求等待前次账号上传与额度预约后才暂存，超过上限返回 429。 |
| `storageKind`、`gatewayStorage` | 标准版存储：`tos`（旧默认）或显式 `gateway`。网关需要独立的绝对私有 `root`、路径严格为 `/api/asr/audio/` 的 HTTPS `baseURL` 及至少 32 UTF-8 字节的服务器私密 `secret`；极速版均不需要。 |
| `accessKeyId`、`secretAccessKey` | 服务器私密 TOS 凭据，仅标准版 `storageKind: tos` 需要。 |
| `bucket`、`region`、`endpoint`、`prefix` | 使用 TOS 时的私有桶、匹配区域的官方端点及以 `/` 结尾的临时前缀。 |
| `root` | 发布树外的私有绝对路径，保存按账号隔离的任务收据和短期暂存音频。 |
| `ffprobePath` | 服务器 `ffprobe`，核验真实编码和时长以执行限额。 |
| `timeoutMs`、`signedUrlTtlSeconds`、`pollIntervalMs` | 提供方／验证超时；覆盖媒体时长加一小时且不超过七天的签名期限；标准版查询间隔默认 5,000 毫秒，允许 1,000–60,000 毫秒。 |
| `maxAudioBytes`、`maxDurationSeconds` | 上传大小与时长上限；极速版逐请求另限 100,000,000 字节／7,200 秒，标准版时长不超过 18,000 秒。混合池可使用较长的标准版时长，同时保留极速版限制。 |
| `maxDailySeconds`、`maxDailyJobs`、`maxActiveJobs` | 每账号计费上限；兼容字段 `maxActiveJobs` 保持 1，预约串行执行。已受理任务可按共享工作线程限制排队。 |
| `retentionSeconds`、`sweepIntervalSeconds` | 音频留存覆盖媒体时长加一小时；标准版留存不得超过下载签名有效期。清理间隔至少 60 秒且不超过留存时间。 |

标准版音频使用私有 TOS 或网关存储。TOS 上传前核验桶 ACL 与策略，只接受所有者授权及没有 Allow 语句的策略。对象使用私有 ACL，匿名 GET 必须返回 403，签名分段 GET 必须成功后才计费。预检失败留下失败收据，不提交提供方任务。网关存储在启动时检查私有目录，监听就绪后才恢复排队任务。

网关存储在账号鉴权前处理 `/api/asr/audio/` 的签名 GET／HEAD，禁止无签名读取。HMAC 绑定对象 UUID、期限与内容摘要，有效签名支持单段 HTTP Range，替换内容使旧签名失效。完成、静音或留存到期删除暂存文件并保留收据；反向代理转发该路由时不得记录查询参数（`access_log off` 或只记录 URI）。签名 URL 是临时下载凭据，无须 TOS 账号或客户端上传凭据。

账号鉴权 API 接受 `audio/mpeg` 与 `audio/wav`，计费前核验 MP3 或 16 kHz 单声道 PCM16 WAV。两个服务类型均持久排队，独立于提供方完成时间返回 202；排队显示为 `processing`。结果含以秒计的 `start`、`end`、`text` 及可选 `words`，省略空白词与零时长标点。极速版直接发送 base64 `audio.data`，不使用 URL 存储。启动恢复未提交的极速版工作；持久写入 `submitting` 后中断则转为 `uncertain`，不查询也不自动重提。无效响应仍保留未知，只有提交前失败允许重试上传。

标准版工作线程只提交一次，随后查询原任务直到完成或静音。处理中与未知结果持续占用应用／服务／组名额，重启后亦然；状态读取不额外查询提供方。留存到期删除音频，但未知计费不可重试，也不释放名额；修改容量前核查未解决的提供方任务。缺 `providerKind` 的旧收据保持标准 1.0 语义，须保留原存储与服务定义。每份账本只运行一个网关，多个部署须分配共享额度；`close()` 停止受理与轮询并等待自身操作完成，不取消提供方任务。

极速版对客户端允许的 `zh` 和 `auto` 都使用提供方默认语言检测，不发送显式语言选项。标准版适配器保留其语言参数。

### ASR 应用资源池

资源／组 ID 为稳定的小写 ASCII 标识；应用 ID 接受 ASCII 字母、数字、下划线与连字符，不允许前后空白。服务为 `flash`（`volc.bigasr.auc_turbo`）、`standard-v1`（`volc.bigasr.auc`）及 `standard-v2`（`volc.seedasr.auc`）。容量按 `(appId, resourceId)` 识别，同一组合的两个 key 须声明同组及同并发，key 不扩大组容量。三个独立 5 路极速版额度提供 15 个工作线程；两个标准版本在三个应用间共享保守配置的 5 路组，总本地容量 20。这是调度策略，不表示提供方授权 20 个在途任务；九条服务资源不表示九份独立额度。

可选 `X-Muse-Asr-Purpose: subtitles|screenplay` 选择服务器路由：字幕用极速版，混合池剧本转写默认标准 2.0，可显式配置标准 1.0。未提供用途时保留旧客户端默认路由；每个幂等键永久保留原用途，包括未提供用途，改变则返回 409。路由变更只影响新键；等待容量与日额度独立，部署保留等待 30、每账号每天 1,000 任务／180,000 秒。组日额度按 UTC 日统一预约所有账号；滚动时长额度跨午夜计入未知计费及排队预约，在接受新计费收据前返回 `provider_rate`。

预约优先使用有空位的应用／服务；调度轮流处理账号，保留各账号顺序并执行资源／组／全局限制。计费前收据持久记录 `poolId`、`appId`、`quotaGroup`、`serviceVersion`、`resourceId` 及新预约时间戳；未知结果不转投其他应用或版本。启动先核验全部归属，再给已完成或未解决的旧收据补缺失绑定，原字段、`providerKind` 与未提供用途不变。缺应用字段时要求 `legacyAppId` 与保留默认资源一致；资源缺失或应用／组／服务／存储变更会拒绝启动。存在收据时保留定义，旧单应用代码不能恢复新绑定；私有账本字段不改变已发布 Session 数据。

响应保留旧状态值与可选 `queued: true`，带用途请求增加 `purpose` 与 `service_version`。失败可报告 `provider_rejected`、`provider_unavailable` 或提交前的 `storage_unavailable`，诊断不表示计费确定性。私有诊断仅含操作、固定错误码、校验过的 HTTP 状态与纯数字提供方状态；凭据、签名 URL、响应正文、原始异常与应用身份不进入响应。旧桌面版本接受额外字段，但不显示队列／错误元数据。

HTTP 拒绝保留 `error` 并增加 `error_code`：`queue_full`、`upload_busy`、`daily_quota`、`provider_rate`、`request_rate`、`invalid_request` 或 `idempotency_conflict`。队列／上传上限带 `Retry-After: 2`，滚动额度给出最早重试间隔；提交与查询共享每账号／IP 每分钟 60 次限制，超出带 `Retry-After: 60`，日额度不提示立即重试。未受理上传在容量恢复后沿用原 ID；已受理或未知收据须对账，不以新 ID 重提；旧桌面客户端将这些错误统一为 `request-rejected`。

凭据值不得进入 Git、systemd `Environment=`、桌面设置、日志或模型工具结果。开发环境和正式环境都通过 `MUSE_KB_VAULT` 与私有 `MUSE_KB_SECRET` 文件启用知识库机器端点。`MUSE_KB_DOCUMENT_GRANTS` 指向由管理员维护、位于可写共享 vault 和编辑器可写目录外的普通 JSON 文件；在 POSIX 上，用户组和其他用户不能写入该文件。未设置文件路径时，不授权任何共享文档。网关在检索或阅读前核对每份共享文档的完整 SHA-256。不能仅凭开发 vault 的文件数量或标题把它复制到正式环境。未配置知识库时机器端点不存在；启用后，未鉴权的 `/api/kb/mcp` 请求返回 401。

启用知识库的网关启动前，须把 `MUSE_KB_USER_ROOT` 指向共享 vault 外已存在、仅所有者可访问的绝对目录。目录缺失、权限过宽或与共享 vault 重叠会阻止启动。已登录账号每次可用 `ingest_script` 提交 1–12 段复核后的 Markdown 剧本；请求上限为 2 MiB，单段上限为 400,000 字符。每段的标题、项目相对来源标识与不可变正文按稳定账号 ID 分开保存；结果逐项报告已写入、已存在或失败。账号可通过 `search`、`read` 和 `read_opening` 阅读自己的 `private/SRC-...` ID；其他账号和机器令牌不能读取这些私有 ID。Muse 召回使用目录、全文关键词和页面链接；MCP 端点不调用语义向量。此工具不上传视频二进制。桌面端使用前，服务器须完成部署和配置；只发布源码不会启用此功能。

桌面模型调用复用网页版的账号会话和全局模型目录。`GET /api/desktop-models/providers` 返回公开元数据；`POST /api/desktop-models/:provider/chat/completions` 接受会话令牌作为 Bearer 凭据，并要求已配置的公开 Origin。上游密钥保留在服务器。Desktop 与云端工作间模型中转对已认证请求不设置 Muse 自有的每账号或共享并发上限，Desktop 路由也没有 Muse 模型请求频率限制。上游供应商限流与模型输出上限仍然有效。退出登录、账号撤销、会话过期与客户端取消会中止所属请求。启动网关前删除已移除的环境设置 `MUSE_DESKTOP_MODEL_MAX_ACTIVE` 和 `MUSE_DESKTOP_MODEL_MAX_TOTAL`；存在这些设置会拒绝启动并给出迁移提示。

全局目录中的各模型可将 `defaultReasoningEffort` 声明为其 `reasoningEfforts` 映射中已启用的键。两条转发路径只在请求未提供 `reasoning_effort` 时将默认档位映射成上游值；请求显式选择的受支持档位优先。未配置默认档位时保留提供方默认行为。GLM-5.3 请求通过 `clear_thinking: false` 在工具续接时保留思考，关闭该模型思考的请求会被拒绝。配置中的 `maxTokens` 为省略输出上限的请求提供默认值并限制更大的请求，显式更小的上限保持原值。直接编辑私有目录文件后须重启网关；管理员设置更新实时生效。

上游拒绝通过固定的 `error.code` 与 `error.message` 区分认证、额度、限流、上下文、输出上限和无效参数。分类最多读取 64 KiB，提供方控制的诊断和凭据不会返回。仅提及额度而未说明耗尽，不会归为额度耗尽。上游 429 拒绝会保留经验证的整数 `Retry-After`。未知服务器失败返回通用错误；结束原因 `finish_reason: length` 仍报告输出截断。

部署的内置目录供应云映模型，包括 Gemini 与 Cloud models 两个分组。网关启动仅公开已配置的供应商目录，不再附加独立的原生 DeepSeek 供应。上游密钥保留为服务器私密凭据。桌面端的自定义供应商与独立 Codex 订阅各自保留其凭据与目录。

## Desktop website access

网关入口默认使用 `MUSE_WORKSPACE_MODE=desktop`。桌面安装通过 `/api/desktop/connect` 连接。浏览器登录后，`/` 在仅一台电脑在线时自动进入；多台或没有电脑在线时显示电脑选择页。`/computers` 始终打开选择页，显示账号所属电脑的名称、操作系统、在线状态和最近连接时间。普通浏览器访问不会启动云端 agent。显式设置 `MUSE_WORKSPACE_MODE=cloud` 可保留云端工作间；`createAccountServer` 库工厂为兼容现有调用者，仍保留该默认值。

显式管理员账号上下文在独立口令提升权限后，使用 `MUSE_RUNTIME_SOCKET` 指定的既有运行时 broker（默认 `/run/muse-runtime/broker.sock`）。普通桌面接口既不启动云端工作间，也不延长其活动时间。每个管理员上下文仍绑定其登录、目标与到期时间；其他账号或后续登录不能复用该授权。这些上下文不会改变用户的桌面绑定。

桌面用 Muse cookie 和安装 UUID 认证，并发送电脑名称和操作系统。不同安装可以同时连接。同一 UUID 重连时，仅替换该安装的旧连接。账号存储保留离线电脑，并兼容旧 `desktopDeviceId` 记录；旧客户端使用基于 UUID 的名称。重设密码、停用、退出与过期会撤销对应连接。浏览器退出仅关闭自己的观察，不会让单独登录的桌面退出。

HTTP 上传、事件流、Range 响应和原生 `/api/remote.mux` 数据帧按段确认。浏览器取消仅移除本地代理，桥接不会重放请求或取消 Agent 轮次。桌面注入自己的私有 Host cookie 和回环 Origin，保留 Host 信任校验。账号、模型、ASR、Wiki 和反馈接口仍由网关处理；设置与自定义模型提供者属于桌面。每个浏览器标签页通过 `/desktop/<installation-UUID>/` 请求资源、HTTP 接口和原生 WebSocket。网关检查账号归属，并在转发前去掉前缀。多台电脑在线时，未选择目标的请求以 `desktop-selection-required` 失败。工作区、文件和会话仍属于各自电脑。`desktopRelayOptions` 工厂参数配置传输限额与 `maxDevices`（默认每账号保留 20 台安装）。

桥接每隔 `heartbeatIntervalMs`（15 秒）向在线桌面发送 Ping；`heartbeatTimeoutMs`（30 秒）内没有 Pong 时，将桌面标为离线并关闭浏览器的观察连接。选择页与入口页面可见时每五秒查询状态。聊天页显示当前电脑；**切换电脑** 在新标签页打开选择页，保留当前标签页。另一台电脑在线时，断线标签页仍等待原来的 UUID。断线与登录过期提示会保留当前工作区和未发送内容；重连移除提示，不刷新页面。只有完整、未压缩的入口 GET 页面会加入观察脚本；HEAD、部分响应、压缩内容和事件流保留原始字节。本地 Host 响应或 WebSocket 升级失败只结束对应浏览器请求，桌面控制连接保持可用。

桌面模式需要 TLS 反向代理把 WebSocket 转发到此进程。仅安装客户端不会切换已部署的网关。本地集成与 Chromium 测试验证了电脑选择、独立标签页、隔离、Range 播放、取消与撤权；生产手机登录和反向代理仍需要部署验证。

浏览器表单页使用 `Referrer-Policy: same-origin`，使同源导航 POST 保留 Origin 供 CSRF 校验。跨源与 null 源写入仍被拒绝。仓库安装为该夹具提供 `ws`；独立网关部署仍安装此目录自身的依赖。从仓库根目录运行 `node --test services/muse-accounts/desktop-{devices,remote,tunnel}.test.mjs` 验证传输和存储；构建 Host、Client 与 Web 后，运行 `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/muse-multi-computer.e2e.ts` 检查登录、标签页、草稿和响应式页面。

## Muse LLM Wiki

Muse LLM Wiki 通过既有 `/api/kb/access` 接口复用当前 Muse 登录，不需要用户 API Key 或新的存储根目录。Muse 主模型通过 MCP 阅读原始资料并综合为相互链接的 Markdown；网关不运行第二个模型。检索使用目录、全文关键词和 Wiki 链接。网关启动忽略 `MUSE_KB_EMBEDDING_*`、`MUSE_KB_VECTORS` 和语义评分变量；既有向量文件仅作为归档保留，不会打开。兼容的 `search` 和 `ingest` 也不调用嵌入。

| 范围 | 所有权与 ID |
|---|---|
| `private` | 默认范围，仅当前账号可用。原件使用 `private/SRC-...`，页面使用 `private/wiki/concepts/...`。 |
| `project` | 当前账号与安全的 `project_id` 共同限定范围；ID 以 `project/<project_id>/` 开头。项目 ID 不能选择其他账号或磁盘目录。 |
| `shared` | 沿用管理员按完整字节摘要维护的授权。原件 ID 仍为 `SRC-...`，页面 ID 仍为 `wiki/...`。 |

使用 `wiki_capture_source` 保存 Markdown 原件并建立来源页提纲；重复入库返回既有不可变来源 ID。`ingest_script` 保留已复核剧本校验，并尝试建立相同的来源页，结果提示模型继续综合。提纲的状态是 `skeleton`，仅包含预览，不表示资料已完成分析。共享入库要求管理员账号；原件须获授权后才能阅读或总结。

使用 `wiki_directory` 浏览 ID 和修订号，使用 `wiki_search` 进行全文匹配，使用 `wiki_read` 每次阅读 6,000 字符，并跟随 `next_start` 续读。共享范围的 `wiki_search` 和兼容的 `search` 对最大 4 MiB 的受支持文件匹配完整获授权正文。共享资料的开头阅读授权仍限制为 24,000 字符。私有与项目来源读取既有不可变来源包；`read` 和 `read_opening` 继续接受旧私有来源 ID，`read` 也接受私有 Wiki 页面 ID。`wiki_status` 返回账号、配置状态、私有或项目数量，以及通过校验的共享数量。

阅读有关原件后使用 `wiki_write_page`，传入范围内的 `page_id`、标题、综合后的 Markdown、`expected_revision` 和 `citations: [{id, start, end}]`。引用偏移按 Unicode 字符计算；每个范围最多 6,000 字符，并且须指向可读取的原始资料。保存的引用包含原件完整 SHA-256；展示的摘录从当前仍获授权的原件重新生成。派生正文最多 100,000 字符。新页面的期望修订号为 0；既有页面使用读取或目录结果返回的修订号。既有的 `[[concepts/name]]`、`[[entities/name]]` 和 `[[sources/SRC-...]]` 支持带目录的链接导航；目标缺失或歧义会拒绝写入。先建立目标页面，再添加指向它的链接。

`wiki_history` 列出不可变的编号修订；`wiki_read` 接受历史 `revision`。更新旧页面时，完整旧正文保存为修订 0。进程锁和修订号检查拒绝重叠或过期写入；重读当前页面并合并后再重试。若 Markdown 投影写入失败，已提交的修订仍为权威数据，写入结果返回 `projection_pending`。崩溃进程留下的锁须由管理员检查。`wiki_links` 返回向外链接、反向链接和引用，并标明截断数量。

普通账号不能写入共享资料；兼容的 `ingest` 即使使用机器令牌，也要求管理员账号。管理员可依据获授权原件建立共享页，或更新当前完整字节已获全文阅读授权的既有页面。每次共享页面写入都返回 `grant_update_required` 和新摘要；管理员更新外部授权文件并重启网关后，账号才能读取新字节。共享历史修订仅在完整字节与当前授权摘要相符时可读。写入不会扩大账号权限。

`wiki_migration_preview` 报告旧页面、已有原件和缺少提纲的来源，不重写原件、不移动数据、不建立授权，也不宣称已完成综合。既有来源 ID 和管理员授权继续有效。链接索引、解析、Unicode 标题归一化和来源页提纲改编自 `@zosmaai/pi-llm-wiki` 0.6.3；[锁定记录](wiki-upstream.json) 保存来源文件的精确摘要，[MIT 许可](wiki-upstream.LICENSE) 保留其版权声明。系统不加载 Pi 宿主钩子、QMD 或上游模型执行流程。

保存原始资料前拒绝链接指向的存储目录；判断重复资料时核验原文字节。

`wiki_record_project` 在当前账号私有 Wiki 登记计划或实际参与内容。稳定 `project_key`（最多 75 个 ASCII 字符）与 `contribution_id` 用于更新和重试；不同账号可以使用相同标识，记录仍相互隔离。工具保存不可变依据，写入带引用的参与详情并读回，再更新可浏览的项目概览。`synced` 确认两页都已同步；`partial` 表示详情已保存，须用同一记录重试概览。状态来自 Agent 汇报（`completion_basis: "agent-report"`），不独立核验产物。被外部修改的参与页保留，须先解决冲突。

`wiki_project_portfolio` 分页返回参与项目和阶段状态统计，或某项目的工作摘要、状态与产物引用。普通账号会话仅查看本人记录。将 `MUSE_KB_PORTFOLIO_READERS` 指向管理员维护的外部 JSON 文件，内容为 `{ "version": 1, "accountIds": ["<16 字符账号 ID>"] }`，可授权指定、已启用的账号读取其他启用账号的参与记录。文件须为常规文件，位于两个 Wiki 根目录之外；POSIX 上不得允许组或其他用户写入。未设置时不授予跨账号权限；无效配置会停止启动。一般管理员和机器令牌不会自动获得组合权限。结果不返回原始资料、会话或其他私人 Wiki 页面；此授权不会把私有项目变成共享知识。

## Verification and release

在本目录运行 `node --test *.test.mjs`；测试中的提供方和 TOS 操作均由替身实现。真实提供方请求须另行获得付费集成检查授权。切流前保存现行服务单元和发布指针，保留上一不可变版本，并备份任务账本及账号状态，且不输出其内容。先发布开发版，再发布正式版。检查 `/login` 返回 200；配置好知识库后，未鉴权 `/api/kb/mcp` 返回 401；配置好 ASR 后，已登录账号 GET 一个随机 `/api/asr/jobs/:id` 返回 404，503 表示未启用。使用两个测试账号保存一段经复核的短剧本：所有者须能检索并阅读其 `private/SRC-...` ID，另一账号不能。再核验获授权的共享资料检索，并对一段另行批准的短音频执行真实 ASR，方可判定服务可用。检查失败时把服务单元切回上一版本；保留持久任务账本，以便继续查询已提交的任务 ID。回滚时不删除旧发布目录或临时 TOS 对象。

`node verify-models-live.mjs <私有目录文件>` 只列出已配置的路由，不调用提供方。授权计费检查后，添加 `--run`，通过 Muse 安装的 pi-ai 序列化器验证工具调用及其续接，同时处理两个模型，每个请求限时 45 秒。探测请求 `max_tokens: 32768`；参数被接受和短续接成功不能说明模型可以输出这么多 token。工具选择默认使用 Muse 的自动选择；`--tool-choice=forced` 改为检查显式指定的函数。`--model=<id>` 选择 ID，`--exclude-model=<id>` 排除 ID。结果只包含固定的失败代码和 token 数；用量缺失时为 `null`，pi-ai 的全零默认用量也按缺失处理。探测不修改目录，不输出提供方诊断、思考文本、凭据、余额或费用。

服务单元名分别是 `muse-dev-accounts.service` 与 `muse-accounts.service`。发布工具仅在源码和配置检查通过后，将各单元的工作目录设为新的不可变发布目录。持久账号、ASR 和 Wiki 数据保留在发布目录之外。本目录本身不会部署。

## Provider basis

[模型列表](https://docs.volcengine.com/docs/DoubaoVoice/model-list?lang=en) 标明标准 2.0 和极速版资源；[旧控制台鉴权](https://docs.volcengine.com/docs/DoubaoVoice/old-version-console-authentication-reference-example?lang=zh) 支持其应用／Access Token 鉴权。[说话人分离](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh) 文档确认标准 1.0／2.0 共用 v3 `/auc/bigmodel/submit` 与 `/query` 链路。[标准版限制](https://docs.volcengine.com/docs/DoubaoVoice/ProductOverview-6?lang=zh) 区分 20 QPS 与半小时提交 500 小时音频上限。[TOS 签名](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en) 最长七天，[桶策略](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketPoliciesNodejsSDK?lang=en) 与 [ACL](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketACLsNodejsSDK?lang=zh) 均影响隐私；旧 `/api/v1/auc` 小模型接口不适用。测试模拟提供方调用，真实版本验收为另行授权的发布操作。

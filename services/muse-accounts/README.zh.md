---
description: "部署并验证 Muse 账号网关、云端知识库和按账号隔离的语音转写。"
kind: "package-reference"
---

# Muse accounts gateway

[English](README.md) | 中文

## Summary

本目录包含单独部署的 Muse 账号网关。网关提供按账号隔离的语音转写、按管理员授权阅读参考资料，以及私有剧本保存。桌面端和工作区包不启动它，也不保存火山或 TOS 凭据。

## 管理员账号概览

`admin: true` 的账号可从 `/account` → 管理账户，或直接进入 `/admin`，查看注册、正常、停用与管理员数量。同页统计已鉴权且连接中的桌面实例，并将多台电脑对应的在线账号去重。这些是页面刷新时的快照，不是历史活跃记录：桌面连接不代表有人正在操作，注册数也包含测试账号；当前不提供日活与月活。普通账号不能进入该页；查看数量不要求运行时管理使用的独立提权，也不读取私人会话与稿件。

<a id="shared-voice-registration"></a>
## 共享声线登记

用 MUSE_VOICE_SLOTS_DIR 启用 POST /api/jubian/voice-slots，路径必须是不可变发布目录之外的绝对私密持久目录。MUSE_VOICE_SLOTS_LEASE_MS、MUSE_VOICE_SLOTS_LOCK_WAIT_MS、MUSE_VOICE_SLOTS_LOCK_POLL_MS 和 MUSE_VOICE_SLOTS_TIMEOUT_MS 分别配置认领到期、锁等待／轮询及供应商核验超时。接口要求有效的 Muse Cookie 或 Bearer 会话、同源写请求和私密 X-Jubian-Token。每项操作通过固定源地址核验精确剧变项目访问权；ready／complete 还要求 delFlag=0 且无冲突删除标记，并核对真实音频资产、规范人物／时期标签及 HTTPS 地址。供应商凭据不持久化、不返回。

操作为 acquire、start、complete、abandon 与 read，键包含项目／人物／人生时期及原登记操作。排他文件系统锁在多个网关进程间串行化写入。只有尚未开始的认领会到期，持久化 submitted 操作不会放行第二次创建。完成后保留精确资产 ID，不悄悄更换。未知结果沿原操作对账。遗留锁目录须确认写进程已停止后由运维核查，不能删除 submitted 回执，不能把登录过期当成重新创建许可。未配置返回 503。服务协调参与的新 Muse 客户端，不阻止剧变网页或旧客户端写入，也不自动删除资产。

## Release inputs

网关开始监听后，启动日志报告实际回环端口。隔离部署检查可设置 `MUSE_PORT=0`，由操作系统分配可用端口。

网关需要 Node 22 或更新版本，以及账号、模型、知识库路由使用的发布根目录 DSH 依赖。云端工作区模式和管理员运行时上下文还需要对应版本的 `muse-runtime` 与 `global` 发布目录；桌面工作区模式不启动云端 Agent。复制进每个新的不可变发布目录后，在本目录运行 `npm ci --omit=dev`；`package-lock.json` 锁定 TOS SDK 和 WebSocket 传输依赖。启用 ASR 时，服务器必须具备 `ffprobe`。账号数据库、知识库文件、凭据和 ASR 任务账本不得复制进发布树。

### 桌面端浏览器登录

`POST /api/desktop-login/start` 签发私密兑换密钥、公开授权网址与核对码。`/desktop-login` 网页复用已有登录，或在登录与注册过程中保留本次请求，再要求明确的同源授权确认。`POST /api/desktop-login/check` 必须携带原始密钥；授权仅可兑换一次，通过 `Set-Cookie` 签发独立的桌面会话。`POST /api/desktop-login/cancel` 取消尚未兑换的请求。密钥不进入 URL，首次签发后也不再出现在响应正文；授权和状态响应禁止缓存。兑换前退出网页登录、重置密码或撤销账号会使授权失效；兑换完成后，网页与桌面端分别退出。

请求仅存在内存中，十分钟后到期，每进程最多1,000个；告知桌面端的轮询间隔为两秒。工厂参数 `desktopLoginOptions` 可配置 `ttlMs`、`maxAttempts` 与 `pollIntervalMs`。网关重启会清除待完成授权，单次兑换的结果丢失时需要重新登录。兑换后沿用既有的持久化会话策略。网关与桌面改动须配套部署；不需要注册操作系统 URL 协议或启动本地回调监听器。

### 账号会话

网关会把 `MUSE_ACCOUNTS_FILE` 解析为绝对路径，并默认将登录会话写入同目录的 `sessions.json`；也可用 `MUSE_SESSIONS_FILE` 指定另一个绝对路径。两个文件都应位于不可变发布目录之外、不会暴露给用户的同一私有持久化目录。会话写入复用账号存储的仅所有者可访问目录和 0600 原子文件机制。文件只包含 token 的 SHA-256 摘要、账号 ID、账号 revision 与到期时间，不包含 bearer token 或 cookie 明文。一个会话文件只能由一个网关进程使用。

`MUSE_SESSION_TTL_MS` 配置新签发会话的有效期，范围为 60,000 毫秒至 7,776,000,000 毫秒（90 天）。默认值为 2,592,000,000 毫秒（30 天），用于覆盖桌面端隔日恢复，同时保持有限期而非永久登录。已签发会话保留签发时记录的到期时间。启动时不恢复已过期记录，并从文件中清理。退出登录、修改或重置密码，以及每次启用或禁用账号导致的 revision 变化，都会撤销受影响记录。

会话文件不存在是有效状态，网关以空会话启动，因此未增加新配置的部署仍可沿用原账号配置。旧网关进程中仅存于内存的会话无法重建，所以首次上线可能要求现有用户登录一次。启用持久化后签发的会话可跨后续网关重启和发布指针切换恢复。升级和回滚都应保留会话文件，且不得在开发与生产环境之间复制会话数据。

服务从 `MUSE_ASR_CONFIG` 指向的私有 JSON 文件读取配置。省略此变量即关闭 ASR，已登录的 ASR 请求返回 503。Linux 上该文件须为权限 0600 的普通文件，包含以下字段：

| 字段 | 用途 |
|---|---|
| `appId`、`accessToken` | 旧单应用的服务器专用凭据。使用资源池时，以 `defaultPoolId` 保留原应用；若同时提供顶层 `appId`，它必须与该资源一致。 |
| `providerKind` | 旧单资源默认值：`standard`（1.0）或 `flash`；显式资源分别声明版本。 |
| `resources`、`quotaGroups`、`defaultPoolId` | 资源声明 `poolId`、`appId`、私密 `accessToken`、`quotaGroup`、`maxConcurrentJobs` 及对应 `serviceVersion`／`resourceId`。组声明 `id`、共享 `maxConcurrentJobs` 及可选日额度；默认资源处理未提供用途的请求并保留旧归属。 |
| `routes` | 用途映射：`{ "subtitles": "flash", "screenplay": "standard-v2" }`；兼容时显式选择 `standard-v1`。混合池须使用这些服务类型并提供对应资源。 |
| `speakerDiarization`, `speakerDiarizationVersion`, `speakerLongAudioSeconds` | 剧本标准转写默认启用说话人分离，使用版本 `200`，以 180 秒区分短、长音频模式。可显式关闭或选择 `300`，后者不发送仅适用于 `200` 的模式。保留 `speaker_id`、`additions.speaker_id` 和实际 AUC `additions.speaker` 字段，别名冲突会使结果失败；编号区分同一任务内的声音，不能直接确定角色姓名。 |
| 组 `submitQps`、`queryQps` | 标准版提交与查询的独立频率，各默认 10；合计不超过 20 QPS，不表示在途任务数。 |
| 组 `rollingAudioWindowSeconds`、`maxRollingAudioSeconds` | 可选且成对配置的组时长上限，覆盖所有账号与版本。标准版部署使用 1,800 秒／1,800,000 音频秒，对应官方半小时提交 500 小时限制。 |
| `legacyAppId` | 用于迁移无资源字段收据的原应用 ID，默认取保留的顶层 `appId`。显式资源池存在旧收据时必须提供此归属，并与默认应用一致。 |
| `maxConcurrentJobs`、`maxQueuedJobs` | 全局工作线程上限与真实等待容量（默认 20）。旧线程默认 5 且不能超过 5；资源池按组与应用／服务组合计算容量，显式全局上限不得更大。标准版名额保留到完成，包括未知结果；连续确认终止失败时释放名额，不重提原任务；等待队列满时返回 429。 |
| `requestRatePerMinute` | 每账号／IP 每分钟共享的 ASR 提交／状态请求上限，默认 60；须覆盖并发客户端轮询需求，不改变提供方提交／查询 QPS。 |
| `maxPendingUploadsPerAccount` | 每账号未完成上传上限（默认 4）；请求等待前次账号上传与额度预约后才暂存，超过上限返回 429。 |
| `storageKind`、`gatewayStorage` | 标准版存储：`tos`（旧默认）或显式 `gateway`。网关需要独立的绝对私有 `root`、路径严格为 `/api/asr/audio/` 的 HTTPS `baseURL` 及至少 32 UTF-8 字节的服务器私密 `secret`；极速版均不需要。 |
| `accessKeyId`、`secretAccessKey` | 服务器私密 TOS 凭据，仅标准版 `storageKind: tos` 需要。 |
| `bucket`、`region`、`endpoint`、`prefix` | 使用 TOS 时的私有桶、匹配区域的官方端点及以 `/` 结尾的临时前缀。 |
| `root` | 发布树外的私有绝对路径，保存按账号隔离的任务收据和短期暂存音频。 |
| `ffprobePath` | 服务器 `ffprobe`，核验真实编码和时长以执行限额。 |
| `timeoutMs`、`signedUrlTtlSeconds`、`pollIntervalMs` | 提供方／验证超时；覆盖媒体时长加一小时且不超过七天的签名期限；标准版查询间隔默认 5,000 毫秒，允许 1,000–60,000 毫秒。 |
| `maxAudioBytes`、`maxDurationSeconds` | 上传大小与时长上限；极速版逐请求另限 100,000,000 字节／7,200 秒，标准版时长不超过 18,000 秒。混合池可使用较长的标准版时长，同时保留极速版限制。 |
| `terminalQueryConfirmations` | 标准任务连续返回相同明确终止状态的确认次数，默认3次；随后失败并释放 worker。处理中或查询不可用会重置计数。 |
| `maxDailySeconds`、`maxDailyJobs`、`maxActiveJobs` | 每账号计费上限；兼容字段 `maxActiveJobs` 保持 1，预约串行执行。已受理任务可按共享工作线程限制排队。 |
| `retentionSeconds`、`sweepIntervalSeconds` | 音频留存覆盖媒体时长加一小时；标准版留存不得超过下载签名有效期。清理间隔至少 60 秒且不超过留存时间。 |

标准版音频使用私有 TOS 或网关存储。TOS 上传前核验桶 ACL 与策略，只接受所有者授权及没有 Allow 语句的策略。对象使用私有 ACL，匿名 GET 必须返回 403，签名分段 GET 必须成功后才计费。预检失败留下失败收据，不提交提供方任务。网关存储在启动时检查私有目录，监听就绪后才恢复排队任务。

网关存储在账号鉴权前处理 `/api/asr/audio/` 的签名 GET／HEAD，禁止无签名读取。HMAC 绑定对象 UUID、期限与内容摘要，有效签名支持单段 HTTP Range，替换内容使旧签名失效。完成、静音或留存到期删除暂存文件并保留收据；反向代理转发该路由时不得记录查询参数（`access_log off` 或只记录 URI）。签名 URL 是临时下载凭据，无须 TOS 账号或客户端上传凭据。

账号鉴权 API 接受 `audio/mpeg` 与 `audio/wav`，计费前核验 MP3 或 16 kHz 单声道 PCM16 WAV。两个服务类型均持久排队，独立于提供方完成时间返回 202；排队显示为 `processing`。结果含以秒计的 `start`、`end`、`text` 及可选 `words`，省略空白词与零时长标点。极速版直接发送 base64 `audio.data`，不使用 URL 存储。启动恢复未提交的极速版工作；持久写入 `submitting` 后中断则转为 `uncertain`，不查询也不自动重提。无效响应仍保留未知，只有提交前失败允许重试上传。

标准 1.0 与 2.0 工作线程只提交一次，随后查询原任务直到完成或静音。标准任务处于处理中或未知状态时，活动的恢复工作线程占用应用／服务／组并发名额，重启后会恢复原任务的工作线程；状态读取不额外查询提供方。留存到期删除音频，但留存到期本身不授权另起计费请求，也不释放仍未解决的标准任务工作线程名额。已经结束但结果未知的极速请求保留原收据和计费身份，没有活动或重启恢复的本地工作线程；没有本地工作线程不证明提供方完成、取消或退款。日额度与滚动音频额度仍按收据账本计算。修改容量前核查未解决的提供方任务。缺 `providerKind` 的旧收据保持标准 1.0 语义，须保留原存储与服务定义。每份账本只运行一个网关，多个部署须分配共享额度；`close()` 停止受理与轮询并等待自身操作完成，不取消提供方任务。 网关收到 `SIGTERM` 或 `SIGINT` 时先停止新 ASR 上传，自身响应结束前保留签名音频及状态读取，随后关闭 HTTP 与模型监听器；重复信号共享一次关闭。账本 Worker 故障及所持有的留存清理故障在资源释放后报告；客户端上传被拒绝本身不会导致关闭失败。服务管理器的停止超时须大于最长提供方超时加上传与清理时间，强制终止不能保留尚未返回的极速响应。

极速版对客户端允许的 `zh` 和 `auto` 都使用提供方默认语言检测，不发送显式语言选项。标准版中文转剧本请求使用提供方默认中英模型以保留说话人分离能力；旧标准版请求保留原有语言参数。

标准查询返回 45000092（任务不存在）或 55001010（任务超时）时，只有连续 terminalQueryConfirmations 次相同响应才记为 failed。保留原回执和任务 ID，已提交的失败 key 不再提交，已预留的计费额度仍保留；这不证明退款或实际收费结果。其他未知响应继续查询原任务。调度在每个账号内选择当前可用资源，避免被堵住的标准任务阻止该账号的快速转写。

### ASR 应用资源池

资源／组 ID 为稳定的小写 ASCII 标识；应用 ID 接受 ASCII 字母、数字、下划线与连字符，不允许前后空白。服务为 `flash`（`volc.bigasr.auc_turbo`）、`standard-v1`（`volc.bigasr.auc`）及 `standard-v2`（`volc.seedasr.auc`）。容量按 `(appId, resourceId)` 识别，同一组合的两个 key 须声明同组及同并发，key 不扩大组容量。只有供应商独立授予的资源组才扩大可用线程容量。标准版可在多个应用间共享一个保守资源组，该组上限与全局上限由部署显式配置；服务行数及 key 数量不证明独立的供应商额度。

可选 `X-Muse-Asr-Purpose: subtitles|screenplay` 选择服务器路由：字幕用极速版，混合池剧本转写默认标准 2.0，可显式配置标准 1.0。未提供用途时保留旧客户端默认路由；每个幂等键永久保留原用途，包括未提供用途，改变则返回 409。路由变更只影响新键；等待容量与日额度独立，部署保留等待 30、每账号每天 1,000 任务／180,000 秒。组日额度按 UTC 日统一预约所有账号；滚动时长额度跨午夜计入未知计费及排队预约，在接受新计费收据前返回 `provider_rate`。

预约优先使用有空位的应用／服务；调度轮流处理账号，在可用资源内保留等待顺序并执行资源／组／全局限制。只有尚无提交时间戳的排队请求可以在核验共享日额度和滚动预约后，转到原服务版本的空闲应用；重新绑定先持久化再向提供方发请求。用途、任务 ID、音频摘要和预约时间戳不变；提交中、处理中及未知任务始终保留原应用和服务。启动先核验全部归属，再给旧收据补缺失绑定，原字段、提供方类型与未提供用途不变；缺应用字段时要求 `legacyAppId` 与保留默认资源一致，旧单应用代码不能恢复新绑定。资源缺失或应用／组／服务／存储变更会拒绝启动。存在收据时保留定义；私有账本字段不改变已发布 Session 数据。

响应保留旧状态值、可选 `queued: true` 和实际 `service_version`；带用途请求再增加 `purpose`。失败可报告 `provider_rejected`、`provider_unavailable` 或提交前的 `storage_unavailable`。可选 `provider_diagnostic` 只含校验过的操作、HTTP／提供方状态和固定原因 `timeout`、`transport`、`http`、`response`、`json`、`result` 或 `audio`；旧收据缺原因时仍省略。`recovery` 说明支持的操作：查询原标准任务、等待当前极速响应、核查已结束的未知极速收据、使用结果，或用同 ID 恢复未提交上传；不授权再次付费提交。未知极速任务没有提供方查询能力，反复读取不变的服务器收据无法恢复丢失的同步响应。诊断不证明收费或退款；凭据、签名 URL、响应正文、原始异常与应用身份不进入响应。

HTTP 拒绝保留 `error` 并增加 `error_code`：`queue_full`、`upload_busy`、`daily_quota`、`provider_rate`、`request_rate`、`server_draining`、`invalid_request` 或 `idempotency_conflict`。队列／上传上限与排空状态带 `Retry-After: 2`，滚动额度给出最早重试间隔；提交与查询共享每账号／IP 每分钟 `requestRatePerMinute` 次限制（默认 60），超出带 `Retry-After: 60`，日额度不提示立即重试。未受理上传在容量恢复后沿用原 ID；已受理或未知收据须对账，不以新 ID 重提。

`GET /api/admin/asr/diagnostics` 只允许已登录且短时提升权限仍有效的管理员访问，并把访问写入管理员审计日志。审计持久化后重新核验授权；已取消的请求不读取诊断。响应禁止缓存，只包含内存聚合数量和配置上限：active、worker 与 waiting 占用，按服务版本和额度组汇总的使用量，标准版未解决任务的年龄桶，以及本次网关进程启动以来的 `queue_full` 类别。该接口不读取或修改收据，也不返回账号、任务、应用、音频、路径、提供方响应或凭据数据；网关重启后计数清零。

凭据值不得进入 Git、systemd `Environment=`、桌面设置、日志或模型工具结果。开发环境和正式环境都通过 `MUSE_KB_VAULT` 与私有 `MUSE_KB_SECRET` 文件启用知识库机器端点。`MUSE_KB_DOCUMENT_GRANTS` 指向由管理员维护、位于可写共享 vault 和编辑器可写目录外的普通 JSON 文件；在 POSIX 上，用户组和其他用户不能写入该文件。未设置文件路径时，不授权任何共享文档。网关在检索或阅读前核对每份共享文档的完整 SHA-256。不能仅凭开发 vault 的文件数量或标题把它复制到正式环境。未配置知识库时机器端点不存在；启用后，未鉴权的 `/api/kb/mcp` 请求返回 401。

启用知识库的网关启动前，须把 `MUSE_KB_USER_ROOT` 指向共享 vault 外已存在、仅所有者可访问的绝对目录。目录缺失、权限过宽或与共享 vault 重叠会阻止启动。已登录账号每次可用 `ingest_script` 提交 1–12 段复核后的 Markdown 剧本；请求上限为 2 MiB，单段上限为 400,000 字符。每段的标题、项目相对来源标识与不可变正文按稳定账号 ID 分开保存；结果逐项报告已写入、已存在或失败。账号可通过 `search`、`read` 和 `read_opening` 阅读自己的 `private/SRC-...` ID；其他账号和机器令牌不能读取这些私有 ID。Muse 召回使用目录、全文关键词和页面链接；MCP 端点不调用语义向量。此工具不上传视频二进制。桌面端使用前，服务器须完成部署和配置；只发布源码不会启用此功能。

桌面模型调用复用网页版的账号会话和全局模型目录。`GET /api/desktop-models/providers` 返回公开元数据；`POST /api/desktop-models/:provider/chat/completions` 接受会话令牌作为 Bearer 凭据，并要求已配置的公开 Origin。默认 `MUSE_DESKTOP_MODEL_TRANSPORT=relay` 模式下，上游密钥保留在服务器。私有目录中的 `zhipu-official` 凭据数组在桌面和云端工作间路由上都使用[共享模型 Key 资源池](#model-key-pools)。单个凭据及其他供应商对已认证请求不设置 Muse 自有的每账号或共享并发上限；Desktop 路由没有 Muse 模型请求频率限制。上游供应商限流与模型输出上限仍然有效。退出登录、账号撤销、会话过期与客户端取消会中止所属请求。启动网关前删除已移除的环境设置 `MUSE_DESKTOP_MODEL_MAX_ACTIVE` 和 `MUSE_DESKTOP_MODEL_MAX_TOTAL`；存在这些设置会拒绝启动并给出迁移提示。

全局目录中的各模型可将 `defaultReasoningEffort` 声明为其 `reasoningEfforts` 映射中已启用的键。两条转发路径只在请求未提供 `reasoning_effort` 时将默认档位映射成上游值；请求显式选择的受支持档位优先。未配置默认档位时保留提供方默认行为。GLM-5.3 请求通过 `clear_thinking: false` 在工具续接时保留思考，关闭该模型思考的请求会被拒绝。配置中的 `maxTokens` 为省略输出上限的请求提供默认值并限制更大的请求，显式更小的上限保持原值。直接编辑私有目录文件后须重启网关；管理员设置更新实时生效。

上游拒绝通过固定的 `error.code` 与 `error.message` 区分认证、额度、限流、上下文、输出上限和无效参数。分类最多读取 64 KiB，提供方控制的诊断和凭据不会返回。仅提及额度而未说明耗尽，不会归为额度耗尽。上游 429 拒绝会保留经验证的整数 `Retry-After`。未知服务器失败返回通用错误；结束原因 `finish_reason: length` 仍报告输出截断。

`MUSE_DESKTOP_MODEL_TRANSPORT=direct` 明确启用向已登录 Desktop Host 分发供应商凭据。新版 Host 在元数据请求中通过 `X-Muse-Model-Access: direct-v1` 协商，再从 `GET /api/desktop-models/access` 取得含供应商私密地址和密钥的当前目录；两个响应均禁止缓存。旧版客户端继续使用中转。直连要求完整的原生全局模型目录：供应商中的每个模型必须解析为其公布的 ID、相同的 HTTPS API 根地址和相同的已配置密钥。智谱 Key 池通过协商后的网关路由使用，其他供应商单独验证直连凭据。配置缺失会报错，不回退到云端中转。Host 将凭据存入账号目录并直接调用供应商；模型请求正文和 SSE 回复不经过此网关。账号禁用、过期和退出会阻止再次领取凭据，但无法使已复制的供应商密钥失效，也无法终止 Muse 之外的直连请求；需要时应在供应商处撤销或轮换密钥。该选项不提供供应商执行的用户配额、临时密钥或请求审计。仅对已获授权分发的凭据启用。

选定的 Muse 账号目录供应官方 DeepSeek Flash、V4 Pro，七个云映模型（包括 GLM-5.3-Flash），以及 [`selected-models.mjs`](selected-models.mjs) 定义的智谱官方 GLM-5.3-Flash 与 FlashX。DeepSeek 和智谱分别使用官方 Chat Completions 路由；云映路由沿用运营者现有 API 根地址。各路由使用独立的服务器凭据引用；用户登录 Muse 后无需填写供应商密钥。桌面端的自定义供应商与独立 Codex 订阅各自保留其凭据与目录。准备这份目录不会部署或启用它。

运行 `node services/muse-accounts/prepare-selected-models.mjs`，通过 `--source` 和 `--output` 提供绝对路径；输出必须位于仓库与分发目录之外。源文件是现有版本二私密模型目录（`MUSE_MODEL_CONFIG` 加 `.native`）；新输出的父目录必须已存在，且仅所有者可访问。DeepSeek 密钥从仅所有者可读的 `--deepseek-key-file` 或运营者进程的 `DEEPSEEK_API_KEY` 读取。单个独立智谱密钥可由运营者 `MUSE_ZHIPU_API_KEY` 提供，多个密钥可通过 JSON 数组环境变量 `MUSE_ZHIPU_API_KEYS` 提供；仅所有者可读的 `--zhipu-key-file` 支持每行一个密钥，单行仍保持单值行为。现有私有目录中的 `MUSE_ZHIPU_API_KEY` 同样可以是单值或数组。云映通常沿用唯一明确的现有端点和凭据，也可通过 `--yunying-base-url`、`--yunying-key-file` 或运营者 `MUSE_YUNYING_API_KEY` 覆盖。继承和覆盖始终保留已验证的云映来源站点；其他供应商的相同模型 ID 不授权复用凭据。命令以排他创建方式生成 0600 候选文件和原文件的精确 `.source-backup`，不修改源文件。已有输出会被拒绝；仅打印模型 ID、修订号及文件摘要，候选文件和备份不得提交或打包。

部署前必须将当前源文件与收据的 `sourceSha256` 比对，保留私密备份，再原子替换服务器 `.native` 文件并重启网关。报告可用前，应核查登录后的目录并实测工具连续调用。回滚时还原精确私密备份并重启网关。此次替换会撤回其他全部共享模型；已有会话若选中了撤回模型，必须重新选择可用模型。选定容量和输出预算见[模型预算表](#selected-model-budgets)，上游限制仍然有效。准备的目录不添加并发上限。

<a id="model-key-pools"></a>
### 模型 Key 资源池

智谱数组凭据让桌面和云端工作间请求共用一个网关并发池。桌面客户端协商 `X-Muse-Provider-Routing: mixed-v1`；额外发送 `X-Muse-Zhipu-Direct: leased-v1` 且网关已开启直连时，智谱返回 `transport: leased`。这类客户端每次调用前只向 `/api/desktop-models/zhipu-official/leases` POST `{model}`，随后使用短期 JWT 直接向返回的供应商地址发送会话并接收流。GET `/leases/<id>` 核验同一个登录，DELETE 报告供应商流已清理。旧客户端仍收到 `transport: relay`，不领取资源池 Key。两种传输共用 `MUSE_ZHIPU_KEY_CONCURRENCY`（默认 20）、`MUSE_ZHIPU_QUEUE_LIMIT`（1000）和 `MUSE_ZHIPU_QUEUE_TIMEOUT_MS`（120000）。队列满或等待超时会在调用供应商前失败；领取结果不明时不会自动重试。

直连名额在签发凭据前保存到账号文件旁的私密 `model-direct-leases.json`。启动时恢复各凭据指纹的占用后才接收请求，当前目录暂时移除的凭据指纹也会恢复计数；文件不含供应商密钥或 JWT。`MUSE_ZHIPU_DIRECT_TOKEN_MS`（60000）、`MUSE_ZHIPU_DIRECT_REQUEST_MS`（1800000）、`MUSE_ZHIPU_DIRECT_CHECK_MS`（30000）和 `MUSE_ZHIPU_DIRECT_GRACE_MS`（15000）分别配置凭证有效期、请求最长时限、登录检查间隔和释放缓冲期。正常清理后等待缓冲期释放；未收到完成报告时保守占用到原请求时限加缓冲期。持久化失败会停止新的直连准入。部署时保留此文件，同一个共享 Key 池只使用一个拥有者网关进程。

JWT 在过期前仍是可复用的持有者凭证，供应商不会替 Muse 强制执行单次使用或限定模型。登录检查和客户端时限用于协调正常 Muse 客户端，不能保证供应商已取消请求或撤销已签发的 JWT。实际账户并发权益以供应商为准，其他客户端使用这些凭据产生的调用不在网关计数内；承诺用户容量前应验证真实授权与吞吐。

流式中转原样转发字节，直到完整的 SSE `data: [DONE]` 事件，随后关闭上游响应和请求，并在下游发送完成后释放名额。仅收到 `finish_reason` 不会结束转发：后续工具调用片段、其他候选回复和用量仍然保留。支持分片 UTF-8 以及 LF、CRLF 和 CR 事件分隔符；最后一个 CR 立即结束事件，已收到的可选 LF 一并保留。不含 `[DONE]` 的流仍在普通 EOF 时结束；非流式 JSON 保持不变。已转发响应的 `Server-Timing` 字段仅包含耗时：`gateway-queue` 表示使用 Key 资源池时的名额等待时间，`upstream-headers` 表示从发送请求到收到上游 HTTP 响应头的时间，包含建连。这两项都不是模型首 token 延迟，也不包含请求内容、账号标识或凭据。

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

<a id="selected-model-budgets"></a>
## Selected model budgets

`prepare-selected-models.mjs` 生成含十一款模型的私有目录，不执行部署。[GPT Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) 与 [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) 使用 1,050,000 上下文与 128,000 输出 tokens；[Claude Opus 5.5/Fable 5.1 与 Sonnet 5.5](https://platform.claude.com/docs/en/models/overview) 使用 1,000,000 上下文与 128,000 输出 tokens。[Gemini 3.1 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) 使用 1,048,576 上下文与 65,536 输出 tokens。[GLM-5.3-Flash 与 FlashX](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) 标注 1M 上下文、128K 输出及文本和图像输入；目录分别声明 1,048,576 上下文与 128,000 输出上限。云映 Flash 沿用供应商默认思考档位；智谱官方 Flash 与 FlashX 默认使用 `max` 并开启思考。官方 [DeepSeek Flash/Pro](https://api-docs.deepseek.com/api/create-chat-completion/) 使用 1,048,576 上下文与 393,216 输出 tokens。GPT 与 DeepSeek 默认使用低思考档位。这些是模型规格，不保证云映开放了上游全部能力。部署前须验证所配置的接口；短回复不能证明完整上下文或最大输出容量。有限输出预算仍可能以 `max-tokens` 结束；部分输出保留在会话中，可继续生成。

云端管理员模型发现复用本地设置的 pi-ai 列表解析器。已保存的目录无需调用供应商；显式接口探测固定公网 DNS 结果、拒绝跳转，使用草稿密钥或指定路由存储的凭据。发现只返回候选模型，不修改配置。管理员选择并保存后，账号目录才会包含它们。探测失败返回安全的字段诊断，并保留手动添加能力。

## Verification and release

在本目录运行 `node --test *.test.mjs`；测试中的提供方和 TOS 操作均由替身实现。真实提供方请求须另行获得付费集成检查授权。切流前保存现行服务单元和发布指针，保留上一不可变版本，并备份任务账本及账号状态，且不输出其内容。先发布开发版，再发布正式版。检查 `/login` 返回 200；配置好知识库后，未鉴权 `/api/kb/mcp` 返回 401；配置好 ASR 后，已登录账号 GET 一个随机 `/api/asr/jobs/:id` 返回 404，503 表示未启用。使用两个测试账号保存一段经复核的短剧本：所有者须能检索并阅读其 `private/SRC-...` ID，另一账号不能。再核验获授权的共享资料检索，并对一段另行批准的短音频执行真实 ASR，方可判定服务可用。检查失败时把服务单元切回上一版本；保留持久任务账本，以便继续查询已提交的任务 ID。回滚时不删除旧发布目录或临时 TOS 对象。

`node verify-models-live.mjs <私有目录文件>` 只列出已配置的路由，不调用提供方。授权计费检查后，添加 `--run`，通过 Muse 安装的 pi-ai 序列化器验证工具调用及其续接，同时处理两个模型，每个请求限时 45 秒。探测请求 `max_tokens: 32768`；参数被接受和短续接成功不能说明模型可以输出这么多 token。工具选择默认使用 Muse 的自动选择；`--tool-choice=forced` 改为检查显式指定的函数。`--model=<id>` 选择 ID，`--exclude-model=<id>` 排除 ID。结果只包含固定的失败代码和 token 数；用量缺失时为 `null`，pi-ai 的全零默认用量也按缺失处理。探测不修改目录，不输出提供方诊断、思考文本、凭据、余额或费用。

服务单元名分别是 `muse-dev-accounts.service` 与 `muse-accounts.service`。发布工具仅在源码和配置检查通过后，将各单元的工作目录设为新的不可变发布目录。持久账号、ASR 和 Wiki 数据保留在发布目录之外。本目录本身不会部署。

## Provider basis

[模型列表](https://docs.volcengine.com/docs/DoubaoVoice/model-list?lang=en) 标明标准 2.0 和极速版资源；[旧控制台鉴权](https://docs.volcengine.com/docs/DoubaoVoice/old-version-console-authentication-reference-example?lang=zh) 支持其应用／Access Token 鉴权。[说话人分离](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh) 文档确认标准 1.0／2.0 共用 v3 `/auc/bigmodel/submit` 与 `/query` 链路。[标准版限制](https://docs.volcengine.com/docs/DoubaoVoice/ProductOverview-6?lang=zh) 区分 20 QPS 与半小时提交 500 小时音频上限。[TOS 签名](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en) 最长七天，[桶策略](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketPoliciesNodejsSDK?lang=en) 与 [ACL](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketACLsNodejsSDK?lang=zh) 均影响隐私；旧 `/api/v1/auc` 小模型接口不适用。测试模拟提供方调用，真实版本验收为另行授权的发布操作。

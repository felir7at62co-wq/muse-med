---
description: "部署并验证 Muse 账号网关、云端知识库和按账号隔离的语音转写。"
kind: "package-reference"
---

# Muse accounts gateway

[English](README.md) | 中文

## Summary

本目录包含单独部署的 Muse 账号网关。网关提供按账号隔离的语音转写、按管理员授权阅读参考资料，以及私有剧本保存。桌面端和工作区包不启动它，也不保存火山或 TOS 凭据。

## Release inputs

网关需要 Node 22 或更新版本，以及账号、模型、知识库路由使用的发布根目录 DSH 依赖。云端工作区模式和管理员运行时上下文还需要对应版本的 `muse-runtime` 与 `global` 发布目录；桌面工作区模式不启动云端 Agent。复制进每个新的不可变发布目录后，在本目录运行 `npm ci --omit=dev`；`package-lock.json` 锁定 TOS SDK 和 WebSocket 传输依赖。启用 ASR 时，服务器必须具备 `ffprobe`。账号数据库、知识库文件、凭据和 ASR 任务账本不得复制进发布树。

服务从 `MUSE_ASR_CONFIG` 指向的私有 JSON 文件读取配置。省略此变量即关闭 ASR，已登录的 ASR 请求返回 503。Linux 上该文件须为权限 0600 的普通文件，包含以下字段：

| 字段 | 用途 |
|---|---|
| `appId`、`accessToken` | 仅服务器使用的火山凭据，须已开通所选 ASR 资源。 |
| `providerKind` | `standard`（默认）或 `flash`；每份任务收据保留原提供方。 |
| `maxConcurrentJobs`、`maxQueuedJobs` | 所有账号共享的极速版并发上限（默认 5，最高 5）和等待容量（默认 20，正整数）。容量预留包含上传中的任务；队列满时返回 429。 |
| `accessKeyId`、`secretAccessKey` | 仅服务器使用的 TOS 凭据，标准版必需；极速版直接上传时省略。 |
| `bucket`、`region`、`endpoint`、`prefix` | 仅标准版使用：私有 TOS 桶、匹配区域的官方端点，以及以 `/` 结尾的专用临时前缀。 |
| `root` | 发布树外的私有绝对路径，保存按账号隔离的任务收据和短期暂存音频。 |
| `ffprobePath` | 服务器 `ffprobe`，核验真实编码和时长以执行限额。 |
| `timeoutMs`、`signedUrlTtlSeconds` | 提供方/访问验证超时；标准版还要求仅 GET 签名 URL 有效期至少比 `maxDurationSeconds` 多一小时，且不超过七天。 |
| `maxAudioBytes`、`maxDurationSeconds` | 上传音频最大字节数与识别时长。极速版拒绝超过 100,000,000 字节或 7,200 秒的配置；标准版时长须保持在 18,000 秒以内。 |
| `maxDailySeconds`、`maxDailyJobs`、`maxActiveJobs` | 每账号计费上限；`maxActiveJobs` 必须是 1，使单进程网关的限额预留串行化。同一账号已受理的极速版任务可以排队，并受共享并发上限约束。 |
| `retentionSeconds`、`sweepIntervalSeconds` | 临时音频留存时间和后台清理间隔。留存至少覆盖媒体时长加一小时；使用 TOS 时不得超过签名 URL 有效期。清理间隔至少 60 秒，且不超过留存时间。 |

标准版需要 TOS。上传前，网关读取桶 ACL 和策略；只接受桶所有者授权及没有 Allow 语句的策略。读取权限不足或返回结果无法核实时停止上传。对象上传显式设置 private ACL，之后匿名 GET 必须返回 403，签名分段 GET 必须成功，才提交提供方任务。检查失败会保留私有任务账本记录，但不会产生提供方计费提交。后台清理到期对象，包括状态仍不明的任务，同时保留收据；标准版任务 ID 仍可查询。账号查询状态时也会清理，网关报告留存到期后，桌面端删除对应的本地 MP3。

极速版沿用账号鉴权的启动与状态 API：排队任务对外显示 `processing`；完成后的每段包含以秒计的 `start`、`end`、`text`，以及可选的同字段 `words`。空白词和零时长标点被省略。网关将私有音频文件持久排队，通过 base64 `audio.data` 直接发送给火山，处理过程独立于上传连接，无须 TOS。上传接受 `audio/mpeg` 和 `audio/wav`；网关在计费前核验 MP3 或 16 kHz 单声道 PCM16 WAV。完成、静音或留存到期后删除网关文件。启动时恢复排队任务；已持久写入 `submitting` 后中断的极速版请求转为 `uncertain`，不查询也不自动重提。提供方错误或无效响应同样保留为不确定状态。只有提交提供方之前的失败允许重试上传。没有提供方字段的收据沿用标准版提交与查询语义；仍有标准版对象待清理时须保留 TOS 配置。每份账本只运行一个网关；共享提供方并发额度的部署须在各自工作线程配置间分配额度。模拟生命周期测试覆盖这些规则；真实极速版 API 检查由发布操作人员执行。

极速版对客户端允许的 `zh` 和 `auto` 都使用提供方默认语言检测，不发送显式语言选项。标准版适配器保留其语言参数。

凭据值不得进入 Git、systemd `Environment=`、桌面设置、日志或模型工具结果。开发环境和正式环境都通过 `MUSE_KB_VAULT` 与私有 `MUSE_KB_SECRET` 文件启用知识库机器端点。`MUSE_KB_DOCUMENT_GRANTS` 指向由管理员维护、位于可写共享 vault 和编辑器可写目录外的普通 JSON 文件；在 POSIX 上，用户组和其他用户不能写入该文件。未设置文件路径时，不授权任何共享文档。网关在检索或阅读前核对每份共享文档的完整 SHA-256。不能仅凭开发 vault 的文件数量或标题把它复制到正式环境。未配置知识库时机器端点不存在；启用后，未鉴权的 `/api/kb/mcp` 请求返回 401。

启用知识库的网关启动前，须把 `MUSE_KB_USER_ROOT` 指向共享 vault 外已存在、仅所有者可访问的绝对目录。目录缺失、权限过宽或与共享 vault 重叠会阻止启动。已登录账号每次可用 `ingest_script` 提交 1–12 段复核后的 Markdown 剧本；请求上限为 2 MiB，单段上限为 400,000 字符。每段的标题、项目相对来源标识与不可变正文按稳定账号 ID 分开保存；结果逐项报告已写入、已存在或失败。账号可通过 `search`、`read` 和 `read_opening` 阅读自己的 `private/SRC-...` ID；其他账号和机器令牌不能读取这些私有 ID。Muse 召回使用目录、全文关键词和页面链接；MCP 端点不调用语义向量。此工具不上传视频二进制。桌面端使用前，服务器须完成部署和配置；只发布源码不会启用此功能。

桌面模型调用复用网页版的账号会话和全局模型目录。`GET /api/desktop-models/providers` 返回公开元数据；`POST /api/desktop-models/:provider/chat/completions` 接受会话令牌作为 Bearer 凭据，并要求已配置的公开 Origin。上游密钥保留在服务器。每个账号最多同时运行四个流式请求，输出受模型配置上限限制。退出登录、撤销账号和会话到期都会中止桌面端正在进行的请求。

## Desktop website access

网关入口默认使用 `MUSE_WORKSPACE_MODE=desktop`。登录后的浏览器通过 `/api/desktop/connect` 进入账号已连接的桌面；离线时显示 **您的电脑上的 Muse 未启动**。此模式没有电脑选择器，也不会启动云端运行时。显式设置 `MUSE_WORKSPACE_MODE=cloud` 可保留云端工作间；`createAccountServer` 库工厂为兼容现有调用者，仍保留该默认值。

桌面用 Muse cookie 和安装 UUID 认证。网关从会话确定归属，每个账号仅允许一台安装在线，并在账号存储中保留绑定。原安装离线后，新登录的安装可替换绑定；另一台安装同时连接会收到 `device-conflict`。重设密码、停用、退出与过期会撤销对应连接。浏览器退出仅关闭自己的观察，不会让单独登录的桌面退出。

HTTP 上传、事件流、Range 响应和原生 `/api/remote.mux` 数据帧按段确认。浏览器取消仅移除本地代理，桥接不会重放请求或取消 Agent 轮次。桌面注入自己的私有 Host cookie 和回环 Origin，保留 Host 信任校验。账号、模型、ASR、Wiki 和反馈接口仍由网关处理；设置与自定义模型提供者属于桌面。`desktopRelayOptions` 工厂参数配置段大小、超时、准入和字节限额。

桥接每隔 `heartbeatIntervalMs`（15 秒）向在线桌面发送 Ping；`heartbeatTimeoutMs`（30 秒）内没有 Pong 时，将桌面标为离线并关闭浏览器的观察连接。入口页面可见时每五秒查询状态。断线与登录过期提示会保留当前工作区和未发送内容；重连移除提示，不刷新页面。只有完整、未压缩的入口 GET 页面会加入观察脚本；HEAD、部分响应、压缩内容和事件流保留原始字节。本地 Host 响应或 WebSocket 升级失败只结束对应浏览器请求，桌面控制连接保持可用。

桌面模式需要 TLS 反向代理把 WebSocket 转发到此进程。仅安装客户端不会切换已部署的网关。本地集成测试验证了隔离、Range 播放、取消与撤权；生产手机登录和反向代理仍需要部署验证。

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

## Verification and release

在本目录运行 `node --test *.test.mjs`；测试中的提供方和 TOS 操作均由替身实现。真实提供方请求须另行获得付费集成检查授权。切流前保存现行服务单元和发布指针，保留上一不可变版本，并备份任务账本及账号状态，且不输出其内容。先发布开发版，再发布正式版。检查 `/login` 返回 200；配置好知识库后，未鉴权 `/api/kb/mcp` 返回 401；配置好 ASR 后，已登录账号 GET 一个随机 `/api/asr/jobs/:id` 返回 404，503 表示未启用。使用两个测试账号保存一段经复核的短剧本：所有者须能检索并阅读其 `private/SRC-...` ID，另一账号不能。再核验获授权的共享资料检索，并对一段另行批准的短音频执行真实 ASR，方可判定服务可用。检查失败时把服务单元切回上一版本；保留持久任务账本，以便继续查询已提交的任务 ID。回滚时不删除旧发布目录或临时 TOS 对象。

服务单元名分别是 `muse-dev-accounts.service` 与 `muse-accounts.service`。发布工具仅在源码和配置检查通过后，将各单元的工作目录设为新的不可变发布目录。持久账号、ASR 和 Wiki 数据保留在发布目录之外。本目录本身不会部署。

## Provider basis

ASR 适配器支持用户 Pi 会话验证过的火山 v3 大模型录音文件**标准版 1.0**接口与 `volc.bigasr.auc` 资源，也支持使用 `volc.bigasr.auc_turbo` 的[极速版接口](https://www.volcengine.com/docs/6561/1631584) `/api/v3/auc/bigmodel/recognize/flash`。[标准版产品说明](https://www.volcengine.com/docs/6561/1354871?lang=zh)的时长限制为五小时；[TOS 签名 URL](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en)最长七天。[TOS 桶策略](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketPoliciesNodejsSDK?lang=en)和[桶 ACL](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketACLsNodejsSDK?lang=zh)都会影响访问权限，因此上传前同时读取两者。旧小模型 `/api/v1/auc` 文档不描述此 v3 适配器。真实提供方验证仍属于发布操作。

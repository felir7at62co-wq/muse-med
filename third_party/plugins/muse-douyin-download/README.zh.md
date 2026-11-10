---
description: "为配置层提供授权抖音页面数据与经过验证、可续跑的所选视频下载。"
kind: "package-bundle"
---

# Muse 抖音数据与下载工具

[English](README.md) | 中文

## 摘要

启用本配置层的配置获得所选作品页面数据、验证下载和持久下载任务控制。默认下载等待结果；后台下载返回可查询、取消或显式续跑的已接收任务。自有配置层使用配套 Desktop Host 完成授权内置浏览器播放，并把任务状态保存在 Host 私有设置目录，不接受 Cookie 文件、签名媒体地址或任意输出路径。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[自有配置层](../owned-downloads.json)包含[配置补丁](cordis.patch.yml)。向配置添加归档包会插入此提供器；配置须提供 `agents`、`tools`、`subprocess`、`jobs`、所属作用域的 Jobs 控制器和 `sandboxPolicy`。浏览器播放还需要配套 Desktop 传输，单独安装插件不会提供该传输。

`douyin_download` 接受已选择的官方 HTTPS 视频/分享 `url`，或已核对的 `urls` 列表，验证后保存到发起会话的 `source/media/douyin/`。公开请求始终忽略保存的浏览器设置；`publicOnly:true` 禁用内置浏览器回退。公开分享数据不受支持时，可与公开媒体不可用一样使用授权浏览器回退。工具不接受浏览器配置、Cookie 文件、记住账号或任意输出目录。

### 持久下载任务

`mode:wait` 为默认值，保留已有单条或批量状态/收据字段，并增加 `downloadTask:{id,state,jobId}`。`mode:background` 在任务接收后返回 `status:queued` 和持久任务收据，不代表媒体已完成。持久 ID 由真实所属 Session 和已记录的工具调用计算，同一调用重试不启动第二个执行器。原生 `result.taskId` 保持浏览器 UUID，不被持久 `downloadTask.id` 替换。每次显式续跑产生新的进程内 `jobId`。

`douyin_download_task` 接受 `action:list`，或带持久 `taskId` 的 `status`、`resume`、`cancel`。控制须匹配精确存活的所属 agent 与原规范化工作目录；其他 Session 不能查看或控制该任务。查询不联网，在只读策略下仍可使用。新下载与续跑会在网络工作前解析当前文件策略。取消、owner 释放、Jobs 取消和插件卸载都会等待已准入的子进程/原生操作及最终状态写入。后台工作拥有独立控制器，接收工具调用完成或取消后不会停止已接收的任务。

任务经过 `queued`、`running` 和 `completed`，或停在 `waiting_user`、`waiting_source`、`interrupted`、`cancelled`、`failed`。只有已验证项目才计为完成。后台任务在关联来源或开始原生传输前，会等待当前页面的登录/验证检查。可见的抖音手机号或二维码登录弹窗会暂停任务。登录/验证需要用户正常操作后显式续跑，与来源不可用分开。任务按准入顺序执行，视频按选择顺序处理，取消排队任务不会让后继越过前项。进度描述单个视频，Jobs 仅交付完成或需要行动的结果，不周期性向模型发消息。前台调用会自行收集 Jobs 终态。

续跑会逐项检查已完成文件、SHA-256、大小、来源收据和视频身份后才跳过。已完成收据发生变化时停止续跑，不猜测成功。已知视频 ID 可复用同一规范化工作目录中重新独立验证的文件，不返回外部 Session 的任务元数据。重复选择保留输入顺序，并通过 `reused`、`reusedSelections`、`uniqueVideos` 说明，避免将已满足选择冒称独立视频。未解析短链的视频身份未知，不能预先去重；解析后每项目标 ID 不得改变。

注册表位于 `settingsHome/plugin-data/muse-douyin-download/tasks/v1/registry.json`，格式版本为 1，保存 owner/调用接收身份、规范化目标目录、官方选择、逐项状态和验证收据。私有文件使用独占租约、有界读取、版本检查、私有临时文件和原子发布。初始化会把已死亡执行器的任务标为中断，不重放下载，也不抢占存活或无法确认归属的 Host 租约。旧注册表实例的 Jobs ID 会清空。缺少 `settingsHome` 时明确失败，不使用临时存储；缺少媒体可执行文件时保留原有运行环境阻塞结果，不建立任务。

媒体验证成功但注册表写入失败时，等待结果返回 `partial`/`interrupted`、`verifiedButUnrecordedReceipts`、登记错误和最终状态是否写入。后台 Jobs 返回相同的具体文件证据。这些收据不会变为持久完成项。进程在媒体发布与项目登记之间崩溃时可能留下未登记文件，须人工核对，绝不根据文件名认证成功。

### 运行环境与配置

随包集成的页面数据与内置浏览器获取功能依赖 Desktop Host 协议 8 和 `douyinBrowser.version === 4`。版本 2 和 3 在页面数据或下载 IPC 前被拒绝。版本 4 的下载方法要求显式传入第五个 `nativeTimeoutMs` 参数；应用与插件必须配套更新。单独安装插件不会增加浏览器下载接口。Desktop 自动选择经过验证的随包 Python，保留显式媒体程序设置，并从随包媒体目录或普通 PATH 查找已有 ffmpeg/ffprobe；不安装依赖或修改 PATH。Mac 安装包包含对应架构的媒体程序，运行时查找不会安装依赖。打包后的 Python 脚本及提取器归档位于 ASAR 外，使内置解释器可以读取。 后台播放还要求 `supportsBackgroundDownload:true`，内部第六参数为 `{background:true}`；旧桥不会把后台任务静默降级为前台播放。

公开执行器需要 `agents`、`tools`、`subprocess`、`jobs` 和 `sandboxPolicy`；浏览器回退还需要宿主下载接口。部署配置保留 `pythonExecutable`、`ffprobeExecutable`、`ffmpegExecutable`、`settingsHome`、`requestTimeoutMs`、`timeoutMs`、`nativeTimeoutMs`、`maxDownloadBytes`、`graceMs`、`maxVideos`、`dataTimeoutMs`、`maxComments`。执行器默认 120 秒、512 MiB、20 条链接；页面数据默认每条链接 30 秒、每页 20 条评论。`requestTimeoutMs` 还用于在外层传输截止前等待页面结果送达。`maxDownloadBytes`（1 字节到 8 GiB）同时用于公开下载、内置浏览器传输和本地文件验证。内置浏览器最多一个任务。准备阶段单独限时 120 秒；`nativeTimeoutMs` 默认 30 分钟（整数 1 秒到 2 小时），用于选定媒体后的原生传输，之后完整本地验证重新获得等长的独立预算。媒体关联另有 120 秒截止。宿主下载 IPC 预算包含这段关联时间、原生预算及额外 10 秒结果送达时间。此配置独立于公开 Python 的 `timeoutMs`；工具截止涵盖两条下载路径、验证及传输清理。组合批次截止超过 Node 计时器范围时配置会被拒绝，请降低 `maxVideos` 或预算。缺少验证程序时返回 blocked。

任务限制可配置：`taskMaxTasks` 默认 1,000，`taskRegistryMaxBytes` 为 16 MiB，`taskLockTimeoutMs` 为 5,000，`taskLockPollMs` 为 25，`taskReceiptMaxBytes` 为 256 KiB，`taskOutputMaxBytes` 为 64 KiB。容量耗尽或数据超限时拒绝操作，不截断持久证据。注册表和收据流在读取中执行字节限制；视频哈希在超过预期验证大小时停止。

### 页面数据与可选下载

`douyin_data` 接受 `url` 或 `urls`，数量不超过 `maxVideos`，按顺序读取所选作品。`source` 可选 `public`、`creator` 或 `auto`；成功结果标明 `public-page` 或 `creator-page` 以及观察时间。创作者数据要求正常登录，并有证据将确切作品关联到该账号。浏览器登录不授予 OAuth API 权限。`auto` 使用公开页。`creator` 打开正常的创作者内容管理页，要求字符串作品 ID、同一位置的修改权限和统计中的作品 ID 一致。仅返回所选作品；未核验归属时返回 `CREATOR_OWNERSHIP_UNVERIFIED`。必要时完成页面加载或在正常页面中定位较早作品。公开数据不替代不可用的创作者数据。

五项计数分别是播放、点赞、评论、分享和收藏，每项返回精确数值、取整显示值，或带原因的 `null`。公开计数来自确切作品的正常详情响应、页面初始数据或唯一可见的作品操作栏，保留源提供的正数播放量；缺失值和占位零仍为不可用。`includeComments:true` 请求一个已观察的评论页，数量受 `commentLimit` 和 `maxComments` 限制；`commentCursor` 只适用于单条作品链接。总评论数与返回的评论条目分开。Desktop 的评论内容和分页返回 `COMMENTS_UNAVAILABLE`，保留已观察计数，并将结果标为 partial。数据格式支持有界的评论文本、评论 ID 和数值计数，不包含账号标识或凭据。

`download:true` 通过现有下载器获取每条所选作品；页面数据已解析分享链接时，使用已核验的作品正式地址，并包含独立的下载结果。下载失败仍保留可用数据；数据不可用也可伴随经过验证的下载。批量结果为 complete、partial 或 blocked，各项保持输入顺序。取消会等待已接入的浏览器读取或子进程结束，在已记录的取消结果中保留已观察数据，并阻止下一条链接开始。只读页面数据不需要 Python 或媒体程序。数据保存在模型可见且持久记录的工具结果中；此工具不另建统计文件。

`douyin_data.download:true` 保持已有的调用内获取行为；需要持久任务控制时使用 `douyin_download mode:background`。

### 内置播放与结果

等待模式在公开访问失败后于已有隔离 Browser 面板打开官方页面，由用户正常完成登录、验证与播放。Host 在初始主文档导航结束后启动确切视频下载，播放检查也等待文档加载。后台模式在相同工作目录登录分区使用专属任务 guest，不依赖当前选中 Session 或 Renderer 侧栏租约。需要登录时停为 `waiting_user`；在普通 Browser 正常登录后显式续跑。页面数据观察仍使用目标绑定重载，并拒绝文档替换。导航、播放检查、DNS、暂存和原生启动失败保持不同阻塞码。官方标签跨重启保留工作目录登录；其他标签仍为进程内存储。不访问外部浏览器数据库、不导出凭据、不制造签名，也不绕过访问控制、验证码或 DRM。

成功必须有上限内的非零真实字节、ffprobe 视频流/时长/尺寸检查、ffmpeg 完整解码和 SHA-256。按详情或播放器元数据选择的文件还须匹配来源时长（误差不超过 0.25 秒）和宽高比（误差不超过 1%）。来源记录包括公开作品页、任务/作品 ID、大小、时长、尺寸、识别方式、媒体主机名及临时 URL 哈希，不包含 Cookie、Authorization 或签名媒体地址。已有输出不覆盖；`STAGED` 仅表示传输完成，不是工具下载成功。批量结果按验证后的各项返回 complete、partial 或 blocked。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[入口](src/index.js)注册数据、下载与任务控制工具。[任务](src/tasks.js)负责共享先进先出执行器、存活 owner 检查、Jobs 生命周期和收据复核；[私有存储](src/task-store.js)负责版本化注册表与执行租约。[收据证据](src/receipt.js)保留 Host 公开识别字段，并与 source.json 稳定比较，拒绝未知凭据/媒体地址字段。[执行器](src/runner.js)等待进程退出、限制输出并清理敏感环境项。

传输通过 `player-exact`、`provider-detail-verified` 或 `player-metadata-verified` 识别媒体。`player-exact` 要求匹配作品的公开 `_ROUTER_DATA` 或播放器父节点中有界的 `awemeInfo` 属性，以及唯一可见播放器来源的成功 MP4 响应。播放器添加的 `__vid` 必须等于字符串作品 ID；其余 URL 组成部分和按原顺序解码的查询参数必须与提供地址一致。原生传输仍使用未改写的可见播放地址。当前文档最多保留媒体或 XHR 请求中 16 个成功的 MP4 响应地址，替换文档时清空。

`provider-detail-verified` 使用页面自身收到的官方目标详情 JSON、确切作品 ID、有界普通 MP4 地址，以及匹配的可见播放器时长。`player-metadata-verified` 只使用最近一层播放器父节点的公开 `awemeInfo`，要求确切字符串作品 ID，以及唯一的时长、尺寸和来源信息。重复的相同记录会去重；最近一层记录冲突时，不通过外层推荐列表消除冲突。元数据时长必须与可见播放器相差不超过 0.25 秒，宽高比相差不超过 1%。元数据获取无需预先观察 MP4 或详情响应。两种验证分支均允许已加载的同源 blob 播放，记录 `currentSrcMatched:false`，并保留各自来源中未改写的普通 HTTPS MP4 地址。来源记录分别标识官方详情响应或 `player-parent-awemeInfo`，两者不能替代。获取不会改写签名地址、主动请求 API、启动播放或改变暂停状态。

CDN 请求和重定向必须通过租约所属浏览器的网络环境解析为公网地址。按验证来源进行的原生传输必须具有 MP4 MIME 和最终成功的 200/206 响应。缺失来源关联时，在现有期限内等待可用的详情观察；观察不可用、受保护媒体、分片或来源关联不明确仍会阻止下载。公开播放器地址支持字符串或 `{src}` 条目；获取要求唯一可见播放器已加载媒体数据，且没有媒体密钥或激活的保护标记。观察到 200/206 不代表完整下载。单次授权绑定 Host、窗口 owner、会话、任务、租约和目标作品，只放行确切原生请求；普通浏览器下载继续拒绝。侧栏会话切换或面板关闭会撤销前台播放。后台播放使用独立任务租约，切换会话不撤销；替换文档、无效导航、过期、取消或 Host 断开仍会撤销尝试并停止验证。

先构建已声明的工作区依赖，再执行聚焦产物测试：

```sh
pnpm --dir third_party/plugins/muse-douyin-download run test
pnpm --dir third_party/plugins/muse-douyin-download run check
pnpm --dir third_party/plugins/muse-douyin-download run package -- --out /tmp/muse-douyin-stage5-package
```

[打包](scripts/pack.mjs)将标准锁定 Python 提取器复制到私有暂存目录，保持解包脚本/运行环境布局，并在 `SOURCE.json` 记录 Host/协议/桥版本及每个插件源码哈希。浏览器获取仍依赖配套 Host。[批量阻塞 Session 回放](../../../snapshots/session/muse-douyin-blocked-batch/snapshot.yml)通过真实作用域工具和 agent 循环覆盖明确失败。

</details>

-----

<a id="model-experience"></a>
## 模型体验

启用的提供器暴露三个工具并记录 JSON 结果。后台接收报告 queued，而不是 downloaded；任务查询区分完成、来源/用户等待与中断。Jobs 进度可观察但不周期性注入提示，最终报告保留部分收据和来源失败。页面数据输出保留独立的字段精度与缺失原因。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

正常登录、授权播放与可用的未受保护来源媒体仍是前提。本包不绕过验证或 DRM，不恢复任意未登记文件，不下载直播/分片/受保护媒体，也不推断缺失页面计数。原生能力、本地离线测试与合成媒体不能证明真实抖音可用性；真实验收需要正常播放及该链接实际完整验证的文件收据。

<a id="dev-note"></a>
## 开发说明

<details>
<summary>维护上下文</summary>

任务回归使用真实构建的 Jobs/agent 依赖、隔离 Host 设置/工作目录、明确进程退出屏障和本地 MP4 样例，验证生命周期、所有权与收据处理；生产 Python/原生验证负责完整解码。测试不访问用户真实项目、Cookie 或浏览器配置。

</details>

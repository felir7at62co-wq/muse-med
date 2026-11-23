# 数据与剧本接口

这些 HTTP 接口供网页及未来 Muse/MCP 适配器共用，支持本机预览和独立反向代理入口；尚未实现 MCP 服务或视频转写。每日爆款转写的选片、任务表、储备看板及转写工人使用的服务令牌接口（`/api/service/*`）见 [hit-transcription.md](hit-transcription.md)。

## 身份与权限

`createApp({ identity })` 接收可信身份提供器，返回用户 `id`、`name`、`role`（`admin` 或 `member`），无法验证时返回空。本地预览使用固定管理员身份，启动配置拒绝公网监听；server 模式要求明确的受信代理身份及 HTTPS Origin，保护静态资源、SPA 与 API，不会回退为预览管理员。当前独立账号不等于现有公司登录，详情见 [server-identity.md](server-identity.md)。

除精确的 GET/HEAD 健康检查和只认服务令牌的 `/api/service/*` 外，接口要求已验证身份。写请求的 `Origin` 须与本地请求地址一致，或在 server 模式下与明确配置的公开 HTTPS Origin 一致；JSON 请求使用 `application/json`。只有指定的剧本上传路由接受 multipart。确认身份的 API 响应附 `X-Muse-Data-Authenticated: 1`，因此普通权限 403 可以重新核对角色，不必当作账号失效。服务不会读取 Muse 客户端的登录或会话文件。代理剥去 `/data/` 前缀，外部调用应为 `/data/api/...`。

## 作品与分类

| 方法与路径 | 内容 |
| --- | --- |
| `GET /api/session` | 当前用户、角色及 `local-preview` / `server` 模式 |
| `GET /api/boards?platform=...` | 平台内榜单目录 `boards` 及默认榜单 `defaultBoard`；不受关键词或题材过滤影响 |
| `GET /api/boards/days?platform=...&board=...` | 该平台该榜单有采集的北京时间日期 `days`（新到旧），每项含 `date` 与当天最后一次采集时间 `observedAt`，最多 400 天；还有更早日期时 `truncated` 为 `true` |
| `GET /api/boards/period?platform=...&board=...&period=day\|week\|month&date=YYYY-MM-DD` | 该榜单的日榜、周榜或月榜完整名单，一次返回全部成员 |
| `GET /api/boards/batches?platform=...&board=...` | 该平台该榜单的采集批次时间 `batches`（新到旧），最多 2000 个；还有更早批次时 `truncated` 为 `true` |
| `GET /api/boards/compare?platform=...&board=...&from=...&to=...` | 同一平台、榜单、来源中较早批次 `from` 与较晚批次 `to` 的成员和名次对比 |
| `GET /api/works` | 分页作品；支持 `platform`、`board`、`at`、`tag`、`q`、`sort`、`page`、`limit`，默认真实来源 |
| `GET /api/facets` | 当前平台、榜单、批次、关键词范围中的题材分组和作品数 |
| `GET /api/works/:workId?board=...` | 作品、指定榜单的真实观测历史和已绑定剧本 |
| `GET /api/covers/:workId` | 对应作品封面；不接受任意 URL |
| `GET /api/export` | 同样筛选范围的 CSV，最多 10000 条 |

`platform` 为 `hongguo`、`douyin`、`qimao` 或 `fanqie`。作品 ID 是平台与原始字符串 ID 组成的稳定标识，例如 `hongguo:7702763145030290457`；路径参数必须 URL 编码。指标使用原始名称与数值，缺失为 `null`。细分类包含 `source` 和原始 `evidence`，不把关键词线索当作确认结论。

`sort` 的 `rank`、`rising`、`recent` 用于名次、相邻批次变化和最近采集。抖音另支持 `plays`（本库 `video_plays` 降序，未知排后）与 `published`（原始发布时间降序）；这两个值必须同时指定 `platform=douyin`，不能跨平台或改写 `rank`。播放口径只指精选页单条视频，没有 DTK 主站指标或整剧累计的隐式合并。

若官方榜单包含作品而对应官方详情明确不可用，作品可以返回 `title: null`，必须同时带 `metadataStatus: "unavailable"` 与非空 `metadataNote`。其来源 ID、官方名次和观察指标保留；`verified` 或缺少状态的空标题均拒绝入库。展示层的“作品资料暂不可用”不是书名，不存回 `title`，也不用于题材推导。CSV 的空书名不替换为占位文案，另提供资料状态、说明列。

榜单查询默认只返回该榜最新成功批次的成员；带 `at`（须同时带 `board`）时返回该次采集的成员、名次和指标。响应的 `batch` 给出实际读取的批次时间 `observedAt` 及其上一批 `previousObservedAt`，首批的上一批为 `null`，该榜没有批次时 `batch` 为 `null`；`at` 不是该平台该榜单该来源的批次时，作品列表与导出返回 404。题材和导出接受同样的 `at`。涨跌仅比较所读批次与其上一批均在榜的作品；掉榜后重返时变化为 `null`。每条新观察保存该榜自己的 `sourceUpdatedAt`，旧观察没有来源日期时保持未知，不借用其他榜单的日期。

网页的关键词搜索不带 `board`，覆盖当前平台全部已采作品及仍保留的掉榜记录；筛选和导出使用同一范围，清空关键词后恢复原具体榜。搜索结果打开详情时也不带 `board`，读取作品最后已知观测和相应历史；显式指定榜单的详情可读取作品在该榜的最后一次真实观察，即使已经掉榜。历史记录不占据当前榜单名次，不能据此计算连续涨跌。

### 日榜、周榜与月榜

日期均为北京时间（Asia/Shanghai，固定 UTC+8）的日历日。`period` 默认 `day`；省略 `date` 时取该榜最近有采集的一天，响应的 `date` 给出实际日期。该平台该榜单该来源从未采集时返回 404；日期格式不对或不存在时返回 400。

- **日榜**：取该日最后一次采集的完整名单、官方名次和指标。排名变化只对比前一个日历日的最后一次采集；前一天没有采集时 `previous` 为 `null`，所有变化为 `null`，不跨过空缺日去对比更早的日期。
- **周榜、月榜**：本站按日榜计算，不是平台官方榜单。周期是包含 `date` 的周一至周日或自然月，只使用其中有采集的日期（`days`），`daysInPeriod` 是周期总天数，页面据此显示“覆盖 N/7 天”。排序依次为上榜天数（多者在前）、已知名次的平均值（小者在前）、最高名次（小者在前）；三项都相同的作品共用同一个 `position`，下一名按人数顺延。`work` 的名次、指标和采集时间取作品在本期最后上榜日（`lastDate`）的数据，`rankChange` 恒为 `null`。

当天或整个周期没有采集时返回 200，`days` 与 `items` 为空，不补造数据。每项 `items` 含 `position`（日榜为官方名次，来源未给时为 `null`；周、月榜为本站排名）、`daysOnBoard`、`averageRank`、`bestRank`（无已知名次时为 `null`）、`lastDate` 与 `work`（含剧本信息）。只统计同一平台、榜单、来源的观察，示例数据和其他平台的同名榜单不计入。查询沿榜单、来源、时间索引逐日定位，开销随所查天数增长，不随全部历史增长。

网页一次读取所选周期的完整名单，在浏览器内完成分页、本榜搜索与题材筛选；同一账号的标签页按平台、榜单、周期、日期保留已读结果，切回时不再请求，首个榜单显示后在后台预读该平台其他榜单的同一日期。

### 榜单批次与对比

批次列表和对比都要求 `platform` 与非空 `board`，`origin` 默认 `live`。批次只在同一平台、榜单、来源内列出、读取和比较，示例数据与真实采集互不混入，其他平台的同名榜单也不计入。批次时间是毫秒精度的 UTC ISO 文本，例如 `2026-11-14T10:03:00.000Z`；`at`、`from`、`to` 也接受带时区的同一时刻。

对比要求 `from` 早于 `to`，否则返回 400；任一时间不是该平台该榜单该来源的批次时返回 404。响应包含规范化的 `from`、`to` 与 `entries`。每条记录的 `work` 含 `id`、`sourceId`、`title`、`author` 及资料状态；`status` 为 `stayed`（两批都在榜）、`entered`（只在 `to`）或 `dropped`（只在 `from`）；`fromRank`、`toRank` 为对应批次的官方名次，不在该批或来源未给名次时为 `null`；`rankChange` 为 `fromRank - toRank`，正数表示上升，只有两批都在榜且名次已知时才有值。记录先按 `to` 名次排列，掉榜记录按 `from` 名次排在最后。对比只读取两端批次，中间批次曾掉榜又重返的作品仍为 `stayed`。

## 管理员采集接口

| 方法与路径 | 内容 |
| --- | --- |
| `GET /api/collectors` | 各平台上次尝试、最近成功、下次执行、覆盖范围、失败状态 |
| `POST /api/collectors/:platform/run` | 启动一次后台采集；成功受理 202，正在采集 409 |
| `GET /api/admin/settings` | 当前 `intervalHours` |
| `PUT /api/admin/settings` | JSON `{ "intervalHours": 6 }`，允许整数 1–168 |

以上接口要求管理员；普通成员返回 403。间隔修改保存后生效，正在运行的任务不会覆盖新设置。手动与定时入口共用任务锁和同一份采集代码。

### 抖音历史模块（当前数据站停用）

当前运行配置仅启用红果、番茄、七猫。以下保留模块的来源管理接口及抖音采集启动接口返回 410，不注册定时任务；存量记录仍保留。下列参数说明仅用于历史数据和解析模块维护。

| 方法与路径 | 内容 |
| --- | --- |
| `GET /api/admin/douyin/sources` | 返回 `sources` 与 `maxSources`（32） |
| `POST /api/admin/douyin/sources/validate` | 核对草稿，返回作者、作者 ID、一条样本及覆盖范围；不入作品库、不保存草稿 |
| `POST /api/admin/douyin/sources` | 保存新来源；验证成功绑定作者 ID，返回 201 |
| `PUT /api/admin/douyin/sources/:id` | 完整编辑；必须携带 `If-Match: <上次读到的 updatedAt>`，版本变化返回 409 |
| `PATCH /api/admin/douyin/sources/:id` | JSON `{ "enabled": false }`，只改变最新记录的启停状态，不回传旧表单 |
| `DELETE /api/admin/douyin/sources/:id` | 移除来源，不删除已采作品或剧本 |

以上路由仅管理员可见和调用；未登录 401、成员 403。输入为 `DouyinSourceInput`：`label`、`videoId`、`mode`（`creator` 作者公开近期窗口或 `video` 指定视频）、`expectedAuthor`（可留空由官方页面确认）、`includeKeywords`、`excludeKeywords`、`enabled`、`maxVideos`（1–20）。`videoId` 接受字符串 ID 或 HTTPS 的抖音官方完整视频链接，随后只保存 ID；不接受短链接、任意域名、端口或带凭据 URL。服务不会访问管理员任意提供的 URL，只构造固定精选域名的视频路径。

保存结果另含 `id`、`expectedAuthorId`、`updatedAt`、`validatedAt`。绑定的作者 ID 优先于昵称，名称变化不等于换人；没有可验证 ID 的来源继续严格核对名称。首次初始化安装八个筛选过的来源预设，之后始终使用持久配置，删除、停用和空列表不会复活。当前任务使用开始时的启用来源快照，编辑对下次任务生效；未启用任何来源时拒绝发出请求并保留旧数据。

验证失败返回 422，错输入 400，重复来源、旧版本编辑或超过数量上限返回 409。改变定位视频、模式、关键词或核对姓名时重新验证；仅改变标签、开关或采集条数不发起额外网络核对。所有来源仍是人工选择的公开窗口，不是抖音短剧全站发现、官方剧集榜或全集；当前没有运行 DTK 服务，也没有提供依赖它的假就绪入口。

## 持续发现

`GET /api/admin/discovery` 返回已启用的三个平台的独立扩库状态；`POST /api/admin/discovery/:platform/run` 继续该平台队列，接受空 JSON 对象。仅管理员可用，未登录返回 401、成员返回 403、已停用平台返回 410、未配置入口返回 503、平台任务锁忙返回 409。状态中的 `count` 为累计成功页，`newWorks` 为累计新增作品，`lastRunNewWorks` 为本轮新增，`pending` 为待处理页，`failed` 为待重试失败页。`lastPublishedAt` 只说明已有页面入库，不表示平台全库采完。

`GET /api/admin/metric-refresh` 返回各平台作品指标自动刷新状态（`MetricRefreshStatus`）：`due` 为上一轮时仍待刷新的目录作品数，`refreshed` 为累计更新数，`lastRunRefreshed` 和 `lastRunFailed` 为本轮更新与失败数。`POST /api/admin/metric-refresh/:platform/run` 立即运行一轮，接受空 JSON 对象。权限与状态码同扩库接口；没有详情来源的平台返回 503。作品的 `metricsObservedAt` 存在时表示指标的测量时间早于该作品的 `observedAt`。

## 抖音搜索

已登录成员可用；未配置 `MUSE_DATA_DTK_ORIGIN` 与 `MUSE_DATA_DTK_KEY_FILE` 时搜索与合集接口返回 503。返回字段见 `src/shared/douyin-search.ts`，缺失的计数为 `null`，不是 0。

| 方法与路径 | 内容 |
|---|---|
| `GET /api/douyin/status` | `{ enabled }`：本部署能否搜索抖音。 |
| `GET /api/douyin/search?type=posts\|accounts&q=&cursor=` | 一页作品（`DouyinPost`，含合集 `mix` 与红果匹配 `hongguo`）或账号（`DouyinAccount`）。`q` 为 1–100 字；`cursor` 原样传回上一页的值，`hasMore` 为假时没有下一页。 |
| `GET /api/douyin/mix?id=&cursor=` | 一个合集的作品，按作者排的顺序，每页 20 条。 |

搜索词无效返回 400；每个成员每分钟超过 20 次或同时进行的搜索超过 4 个返回 429；DTK 的小号不可用、抖音要求验证或服务连不上返回 503；排队超过一分钟返回 504；其他上游失败返回 502。错误正文为固定中文提示，不转发上游内容。

## 抖音下载到 TOS

已登录成员可用；同时配置了 DTK 与可读的 `MUSE_DATA_TOS_ENV_FILE` 才启用，否则 `status` 返回 `enabled: false` 和 `reason`（如「TOS 未配置」），其余接口返回 503。字段见 `src/shared/douyin-downloads.ts`。写请求须来自页面同源并使用 JSON。

| 方法与路径 | 内容 |
|---|---|
| `GET /api/douyin/downloads/status` | `{ enabled, access, linkSeconds, dailyLimit, usedToday, unlimited, maxMixEpisodes }` |
| `POST /api/douyin/downloads` | `{ "awemeId": "7570…" }`，排队一个作品；202 `{ queued, existing, skipped }` |
| `POST /api/douyin/downloads/mix` | `{ "mixId": "7529…" }`，经 DTK 翻页列出整个合集（最多 300 集，超过返回 400），按集数排队；超出当天额度的集数计入 `skipped` |
| `GET /api/douyin/downloads?mine=0\|1&mixId=&awemeIds=&limit=100` | 全组下载记录（新到旧）；`mine=1` 只看自己的；`awemeIds`（逗号分隔，最多 100 个）只取这些作品的记录，页面用它把每个作品的按钮变成「准备中」或下载链接；公开模式下已完成的记录带公开地址 `url` |
| `GET /api/douyin/downloads/:id/file` | 302 到文件：公开模式（默认）为公开地址，私有模式为 `linkSeconds` 秒内有效的签名链接；未完成返回 409 |

Muse 工具使用只认服务令牌的同一套接口 `/api/service/douyin/downloads*`，见 [hit-transcription.md](hit-transcription.md#抖音视频下载muse-抖音工具)。

每个作品只下载一次：已排队、进行中或已存入的作品返回在 `existing` 里；失败的作品再次请求时重新排队。新排队的作品计入请求人当天（北京时间）额度，默认 50 条，管理员不限；额度用完时单个作品返回 429。

流程：下载前经 DTK `GET /api/v1/douyin/video?aweme_id=` 现取无水印地址 → 服务器带 `Referer: https://www.douyin.com/` 下载到数据目录内的临时文件（≤1 GiB，边下边算 SHA-256）→ `@volcengine/tos-sdk@2.9.1` 上传到桶 `muse` 的 `download-video-date/douyin/<YYYYMMDD>/<合集ID或作品ID>/video/<三位集数>-<作品ID>.mp4`，禁止覆盖、对象元数据记录 SHA-256 → HeadObject 核对大小和 SHA-256 → 删除临时文件。同名对象已存在且大小和 SHA-256 相同则直接记为完成，不同则失败、不覆盖。默认 3 个下载通道，每个通道完成一次后停顿 3 秒。临时失败按 [自动重试设置](../README.md#抖音下载到-tos) 继续；服务重启时仅将进行中的下载重新排队，冷却任务保持原定时间。

记录增加 `errorCode`（安全错误码或 null）、`nextRetryAt`（下次自动重试最早 UTC 时间或 null）、`cooldownRounds`（已进入冷却的轮数）；`attempts` 累计尝试次数。等待重试仍是 `state: "queued"`，客户端保持轮询，不再提交新的下载请求。重试沿用原 ID、对象路径和每日额度；`done` 不会再次排队。`failed` 表示需要人工处理，保留原因；人工重新请求同一作品会清空重试计数。旧版本未携带新增字段的响应不由服务端伪造重试时间。

## 剧本绑定与个人书架

| 方法与路径 | 内容 |
| --- | --- |
| `POST /api/works/:workId/script` | 管理员上传 multipart 字段 `file`，绑定到现存作品 |
| `GET /api/scripts/:scriptId/download` | 取得真实文件；校验失败拒绝，不返回替代内容 |
| `POST /api/bookshelf` | 客户端确认取得文件后，提交 JSON `{ "scriptId": "UUID" }` 加入本人书架 |
| `GET /api/bookshelf` | 本人下载记录、对应文件及作品最新数据 |
| `DELETE /api/bookshelf/:scriptId` | 仅移出本人书架 |

上传响应为 `ScriptArtifact`：`id`、`workId`、`fileName`、`contentType`、`byteLength`、`sha256`、`createdAt`。同作品同内容上传幂等，不同内容创建独立版本。列表和详情的 `work.script` 为最新版本，没有文件时为 `null`；接口不会泄露物理文件路径。

允许 UTF-8 文本、Markdown、DOCX、PDF，最多 20 MiB，扩展名、MIME 和内容特征需要一致。下载响应使用附件文件名和原始字节。网页核对长度和摘要后触发保存，并单独确认入架；取消或失败的文件请求不会自动创建书架记录。书架与作品 ID 关联，采集更新指标时不改动已下载的文件版本。

未来云端转写流程应先查找准确作品 ID，再上传真实交付文件，并记录上传结果；重试复用同一内容摘要。云端执行、公司账号接入与 MCP 工具包装均不在当前实现范围。

## 原小说文件与准备任务

| 方法与路径 | 内容 |
| --- | --- |
| `GET /api/works/:workId/original` | 当前原文文件、最近准备任务及来源是否启用 |
| `POST /api/works/:workId/original/jobs` | 登录用户提交空 JSON 对象，按需准备原文；同书活动任务复用 |
| `GET /api/original-jobs/:jobId` | 读取该共享原文准备任务的状态与已核验章节进度 |
| `GET /api/originals/:artifactId/download` | 取得通过清单、文件长度及 SHA-256 校验的真实 TXT |
| `POST /api/bookshelf/originals` | 网页核对并保存文件后，提交 JSON `{ "artifactId": "UUID" }` 加入本人原小说书架 |
| `GET /api/bookshelf/originals` | 本人原小说书架、下载的版本及作品最新数据 |
| `DELETE /api/bookshelf/originals/:artifactId` | 仅移出本人原小说书架记录 |

状态响应为 `NovelState`，包含 `available`、`job` 和 `artifact`。任务状态为 `queued`、`running`、`ready` 或 `failed`；只有整个当前目录通过核验，才保存公开文件版本。来源授权、结构或完整性失败不会发布部分正文，旧文件版本不删除。队列满返回 429，不支持的作品来源返回 422。所有路由要求登录；成员可准备和下载，接口不返回本地路径、匿名设备标识、密钥或正文缓存位置。

启用 `MUSE_DATA_NOVEL_FULL_MODE=1` 时接口路径、状态与校验规则不变；成功文件仍只在整本目录通过核验后发布，区别是番茄/七猫改为通过官方移动端阅读接口取得完整已发布目录正文。该模式默认关闭，属于平台条款与版权风险范围，由数据站负责人决定。

`NovelArtifact` 保留 `workId`、`platform`、`fileName`、`contentType`、`byteLength`、`sha256`、`createdAt`、`sourceUrl`、`directoryObservedAt`、`chapterCount` 和 `scope`。`complete-book` 仅用于来源明确已完结且目录完整的版本；其他成功文件的 `current-published-directory` 只代表当时已发布章节，不表示未完结作品已有全集。更新另建不可变版本，准备与下载均不写剧本书架。

原小说有独立的个人书架：`POST /api/bookshelf/originals` 在网页核对文件长度和 SHA-256 并保存后提交 JSON `{ "artifactId": "UUID" }`，重复下载只更新下载时间；`GET /api/bookshelf/originals` 返回本人的 `NovelShelfItem`（作品最新数据、下载的版本、下载时间及该作品最新版本 ID `latestArtifactId`）；`DELETE /api/bookshelf/originals/:artifactId` 仅移出本人记录，不删除共享文件或他人记录。版本不存在返回 404，所有路由要求登录。

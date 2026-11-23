# 每日爆款转写：选片、任务表与服务接口契约

数据站负责「选哪部剧、谁在转、转到哪、剧本和原片在哪」。Muse 云端主会话按本接口领取候选、给每部剧派一个转写工人；工人把进度、原片归档和剧本写回数据站；甲组成员在「储备看板」下载。转写质量、Muse 侧工具不在本仓库。设计稿见 Muse 仓库 `.artifacts/daily-hit-transcription-loop-design-20261115.md` 第 1、3、4 节。

## 1. 自动选片

选片程序默认每 20 分钟跑一次（`MUSE_DATA_HIT_INTERVAL_MINUTES`，1–1440；`MUSE_DATA_HIT_ENABLED=0` 关闭；`MUSE_DATA_AUTO_COLLECT=0` 时也不跑）。只看红果真实采集作品，五个条件全部满足才入选：

| 条件 | 判定 | 数据来源 |
| --- | --- | --- |
| 爆量 | 收藏 **严格大于** `minCollection`（默认 100000，即「10万」显示值不算） | 榜单的 `collection` 指标（`parseCount`）与作品详情页 `series_favorite_count`，取测量时间较新者 |
| 下沉 | 用户 2026-10-19 规则：命中硬伤且无强下沉标签即淘汰；须命中强下沉标签或选材方向；`sink_score ≥ minScore`（默认 0） | `src/server/hits/sink.ts`，从 `数据与选材/.work/collect_picks.py` 原样移植（词表、加减分、「不/非/无」否定前缀）；另加选材方向「典故/关注度」（典故、传说、神话、民间故事、名著、成语、历史故事、家喻户晓），2026-11-15 用户加入，不在原 10-19 规则里，宽召回、由工人选材复核把关 |
| 已完结 | 详情页 `series_episode_info.series_status` 属于 `completedStatuses`（默认 `[1]`）；属于 `serialStatuses`（默认 `[0]`）为连载；没有状态时只认明确文字（「更新至」→连载，「已完结」→完结）；未知不入选 | 作品详情页 |
| 无番茄 IP | 与数据站自己的番茄库比对，「确认」才排除；「疑似」照常入选并在看板标注 | 见下文 |
| 抖音爆量 | 抖音上与剧名**完全同名**的话题播放量严格大于 `douyin.minPlays`（默认 50000000，即 5000万）；用户 2026-11-15 加入 | DTK：`search/posts` 找话题，`hashtag` 读 `view_count` |

榜单采集的连载状态为空、分类发现的作品没有收藏，所以对**已通过下沉规则**且缺少完结状态或收藏的作品，选片程序在红果平台锁下逐部读取官方详情页（默认每轮 40 部、间隔 1.5 秒）：连载与未知状态 24 小时后复查，收藏未知或未过线的目录作品 72 小时后复查，失败 6 小时后重试。只在分类中发现的作品，读到的热度、收藏、点赞也写回作品记录（与「作品指标自动刷新」相同的方式）。榜单作品的收藏由榜单采集更新。

**抖音话题播放量**（`src/server/hits/douyin-topic.ts`）：抖音搜索结果的播放数全是 0，所以用话题播放量。只对前四个条件都满足的剧查：用红果剧名调 DTK `search/posts?keyword=<剧名>&count=20&include_raw=true`，在 `raw.text_extra[]` 里找名字与剧名规范化后（NFKC、小写、去空格标点符号）**完全相同**的话题，不算「…后续」「…完整版」「…第N季」等变体（各季是红果上的不同作品，有各自的话题）；再调 `hashtag?hashtag_id=` 读 `view_count`（`content_count` 为作品数）。结果按剧保存（`douyin_topics`）：`pass` 超过阈值、`below` 未超过、`not_found` 没有同名话题、`error` DTK 失败（小号登录过期、限流、风控等）。只有 `pass` 入选；`error` 不当作通过或未通过，2 小时后重试；`below` 与 `not_found` 只要前四个条件仍满足，24 小时后复查（已知话题只重读播放量）；`pass` 不再复查。每轮最多查 20 部、间隔 5 秒，因为所有搜索共用一个抖音账号。没有配置 DTK 时无法查话题，看板显示「抖音话题未检查」，没有剧会入选（`douyin.required=false` 可关闭这个条件）。看板在 `not_found`、`error`、`below` 时显示原因、「去抖音找」链接和「指定话题」：成员填入话题编号后立即读取播放量，记为人工指定，此后复查只重读该话题。

**番茄 IP 判定**（`src/server/hits/ip-match.ts`）：标题去掉标点、空格和「第N季」后比较；主标题取第一个分隔符前、去掉续集序号；人名取详情页演员表的角色（「饰 柳如意」）以及简介中重复出现两次以上的「常见姓氏 + 1–2 字」，在超过 `maxNameDocuments`（默认 20）部番茄作品里都出现的词不算证据。

- 确认：简介用《》引用了库内书名；或共有 ≥2 个人名；或同名且共有 1 个人名或简介相似度 ≥0.35。
- 疑似：同名；或主标题相同；或共有 1 个人名且简介相似度 ≥0.2。

入选作品自动排队（`autoEnqueue`）。首次观测后 72 小时内入选的进「新上榜」通道，其余进「储备」通道。已排队但尚未被领取的自动任务，作品不再入选（例如新采到确认 IP）时撤回。

### 配置

所有阈值都有默认值，可用私有 JSON 文件覆盖：`MUSE_DATA_HIT_RULES_FILE=/绝对路径/hit-rules.json`（普通文件、不经符号链接、≤256 KiB），启动时读取，修改后重启生效。对象逐键合并；`sink.modes`、`sink.sink`、`sink.hard`、`sink.directions` 与各词表整体替换。完整字段与默认值见 `src/server/hits/rules.ts` 的 `DEFAULT_HIT_RULES`，例如：

```json
{ "minCollection": 200000, "queue": { "maxAttempts": 3 }, "sink": { "minScore": 2 } }
```

## 2. 任务表与状态

每部剧一行任务（`transcription_jobs`，主键为作品 ID），每次变化写入 `transcription_job_events`。

```text
queued ──claim──▶ downloading ⇄ transcribing ⇄ checking ──script──▶ published
   ▲                       │ (fail, retryable, 还有次数)            
   └───────────────────────┤ (租约过期, 还有次数)
                           ├─ fail（次数用完或 retryable:false）──▶ failed
                           └─ fail needsAttention / 租约过期且次数用完 ──▶ needs-attention（待处理）
downloading / transcribing / checking ──reject（选材复核淘汰）──▶ rejected（复核淘汰，选片不再自动排队）
failed / needs-attention / rejected / queued ──立即转写──▶ queued（排到队首；failed 与待处理的次数清零）
```

- 三个进行中状态由工人自由上报（检查不过回到转写重写是正常的）；进入 `published`、`failed`、`needs-attention` 只能通过对应接口或站内租约检查。
- **选材复核**：程序规则只看是否命中下沉标签或选材方向，不看整部剧的受众。所以工人领到剧后，先按 `review.standard`（规则文件，可改）判断整部剧的主要受众：看全部标签和简介，拿不准时看前一两集。不合格就调 `reject`，任务进入终态 `rejected`（看板显示「复核淘汰」和理由），选片程序不会再自动排队或重建它；成员对它点「立即转写」时进 `manual` 通道重新排队。`review.required` 在 `manual` 通道（成员自己的决定）或任务已有进度（之前的工人已接受过）时为 false；`review.enabled=false` 时恒为 false。
- **领取幂等**：同一个 `workerId` 重复领取，返回同一租约和同一任务，不增加次数；别的工人持有有效租约时返回 409。每次新领取 `attempts + 1`，默认最多 2 次（首次 + 自动重派一次）。
- **心跳与续传**：领取和每次上报都把租约延长 `leaseMinutes`（默认 30 分钟）。超时没有上报，任务退回 `queued`，保留上次进度（`progress`）与原片记录，下一个工人领取后可从第 x 集继续；次数用完则进入待处理。
- **优先级**：立即转写（按点击先后）→ 新上榜（按入选先后）→ 储备（按收藏从高到低）。

## 3. 服务接口（给 Muse 工具）

### 身份

- 服务身份是一个令牌，放在私有文件里，路径由 `MUSE_DATA_SERVICE_TOKEN_FILE` 指定：绝对路径、普通文件、权限 0600 或 0640、不经符号链接，内容为 32–512 个 `A-Za-z0-9._~+/=-` 字符（首尾空白忽略）。例如 `openssl rand -base64 36 | tr -d '\n' > service-token && chmod 600 service-token`。启动时读取；换令牌需重启。未配置时 `/api/service/*` 一律 404。
- 请求带 `Authorization: Bearer <令牌>`，或 `X-Muse-Data-Service-Token: <令牌>`。**经公网 Nginx `/data/` 入口时 `Authorization` 会被清空，必须用后者**；在服务器本机可直接请求 `http://127.0.0.1:19617/api/service/...`。
- 服务接口只认令牌：浏览器 Cookie 不能调用；带 `Origin` 头的请求一律 403；令牌也不能调用成员接口。JSON 请求须 `Content-Type: application/json`，请求体 ≤2 MiB；剧本上传为 multipart，≤20 MiB。
- 路径中的作品 ID 写 `hongguo:<series_id>`（URL 编码）或直接写 `<series_id>`。

### 错误

非 2xx 响应体为 `{ "error": "中文说明" }`（400 另有 `issues`）。401 令牌无效；404 无此任务；409 租约失效、已被他人领取、状态不允许（应重新领取或放弃）；415 内容类型不对；422 原片路径或剧本检查不符合要求。

### 接口

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/service/hits/candidates?limit=50` | — | `{ queued: Job[]（按领取顺序）, active: Job[], counts: {状态: 数量}, selection }` |
| `POST /api/service/hits/claim` | `{ "workerId": "muse-worker-<会话ID>", "workId"?: "7701328280862854168" }` | `{ job, lease, work, review }`；`work` = `{ title, category, tags（来源的全部标签）, description（完整简介）, episodes, collection, douyinTopic: { name, views } \| null, ipMatch（none/suspected/confirmed）, evaluation: { score, strongHits, blockHits, directions } \| null }`；`review` = `{ required, standard }`；不指定作品时领取队首；队列为空返回 `{ job: null, lease: null, work: null, review: null }` |
| `GET /api/service/hits/jobs/:workId` | — | `Job` |
| `POST /api/service/hits/jobs/:workId/progress` | `{ lease, state?: "downloading"\|"transcribing"\|"checking", episode?: 12, totalEpisodes?: 65, message?: "第12集写稿" }` | `Job`；只带 `lease` 即为心跳 |
| `PUT /api/service/hits/jobs/:workId/videos` | `{ lease, upload: <drama_tos_upload 结果> }` | `Job`（含 `videos`） |
| `POST /api/service/hits/jobs/:workId/script` | multipart：`lease`、`file`（DOCX/MD/TXT/PDF）、`checks`（可选，JSON 字符串 `{"passed":true,"summary":"65/65 集通过"}`） | 201 `{ job, script }`，任务变为 `published` |
| `POST /api/service/hits/jobs/:workId/reject` | `{ lease, reason }`（reason 1–500 字） | `Job`，`state` 为 `rejected`，`review` = `{ rejectedAt, reason, workerId }`；任何进行中状态凭有效租约都可调用（可以先看一两集再决定），租约无效 409，理由为空或超长 400 |
| `POST /api/service/hits/jobs/:workId/fail` | `{ lease, reason, stage?, retryable?: true, needsAttention?: false }` | `Job`（`queued`、`failed` 或 `needs-attention`） |

说明：

- `progress`：`episode ≤ totalEpisodes`；切换阶段且未给 `episode` 时清空集数。
- `videos`：`upload` 直接传 `drama_tos_upload`（Muse 87c906fd7a，输入为 `platform` + `work_id`）的结果，使用其中 `bucket`、`date`（YYYYMMDD）、`directory`、`objects[].kind/key/bytes/sha256/status`、`manifest.key`，其他字段（`directory_url`、`objects[].url`、`removed_local`、`kept_local` 等）忽略，manifest 文件内容不读取。桶必须是 `muse`，`directory` 必须正好是 `download-video-date/hongguo/<date>/<series_id>/`，所有 key 必须在该目录内。数据站**不使用调用方给的 URL**，而是按 key 生成公开地址 `https://muse.tos-cn-beijing.volces.com/<key>`（桶、顶层目录、域名可在规则文件 `videos` 中配置）。进行中可多次覆盖；发布后用发布时的同一租约仍可补记。
- `script`：先上传通过程序检查的剧本；`checks.passed` 为 `false` 时返回 422，应改调 `fail` 并带 `needsAttention: true`。同一租约重传相同文件是幂等的（仍返回 201、同一剧本）；发布后上传不同文件返回 409。剧本进入现有剧本库，成员在看板与作品列表即可下载。
- `fail`：`retryable`（默认 true）且还有次数时退回队列；`needsAttention: true` 直接进入待处理（例如检查自动重写一次后仍不过）。

`Job` 字段：`workId`、`sourceId`、`state`、`lane`（`manual`/`new`/`backlog`）、`priority`、`qualifiedAt`、`queuedAt`、`rushAt`、`requestedBy`、`workerId`、`claimedAt`、`heartbeatAt`、`leaseExpiresAt`、`attempts`、`progress {episode,totalEpisodes,message,updatedAt}`、`videos {bucket,date,directory,directoryUrl,manifest{key,url},objects[{kind,key,url,bytes,sha256,status}],recordedAt}`、`scriptId`、`checks {passed,summary}`、`lastError {at,reason,stage}`、`review {rejectedAt,reason,workerId}`（复核淘汰时）、`publishedAt`、`createdAt`、`updatedAt`。时间均为 UTC ISO 文本。租约只在领取响应中出现。

### 工人流程示例

```sh
H="X-Muse-Data-Service-Token: $(cat /srv/muse-data-web/access/service-token)"
B=https://muse.aigc-pipeline.cn/data/api/service/hits
curl -s -H "$H" -H 'content-type: application/json' -d '{"workerId":"muse-worker-a1"}' $B/claim      # → {job, lease}
curl -s -H "$H" -H 'content-type: application/json' -d '{"lease":"…","state":"transcribing","episode":1,"totalEpisodes":65}' $B/jobs/7701328280862854168/progress
curl -s -X PUT -H "$H" -H 'content-type: application/json' -d '{"lease":"…","upload":{…drama_tos_upload 结果…}}' $B/jobs/7701328280862854168/videos
curl -s -H "$H" -F lease=… -F 'checks={"passed":true}' -F 'file=@剧本.docx' $B/jobs/7701328280862854168/script
```

### 抖音视频下载（Muse 抖音工具）

数据站是抖音视频的唯一下载后端：网页上的「下载」和 Muse 工具调用的是同一套下载，文件存进 TOS 公开目录 `download-video-date/douyin/<YYYYMMDD>/<合集或作品ID>/video/<三位集数>-<作品ID>.mp4`，全组共用，已下过的作品不会重复下载。Muse 不需要自带下载器。身份、错误格式同上（服务令牌，不带 `Origin`，JSON）。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/service/douyin/downloads/status?requestedBy=<Muse 用户名>` | — | `{ enabled, reason?, access, dailyLimit, usedToday, maxMixEpisodes, … }`；`enabled:false` 时 `reason` 说明原因（如「TOS 未配置」） |
| `POST /api/service/douyin/downloads` | `{ "awemeId": "7570…", "requestedBy": "用户乙" }` | 202 `{ queued, existing, skipped }`；已下过或在准备中的作品在 `existing` 里 |
| `POST /api/service/douyin/downloads/mix` | `{ "mixId": "7529…", "requestedBy": "用户乙" }` | 202 同上；整个合集按集数排队（最多 300 集），超出当天额度的集数计入 `skipped` |
| `GET /api/service/douyin/downloads?awemeIds=a,b&mixId=&limit=100` | 至少给 `awemeIds`（逗号分隔，最多 100 个）或 `mixId` | 记录数组；`state` 为 `queued`/`downloading`/`uploading`（都表示准备中）/`done`/`failed`；`done` 的记录带 `url`（TOS 公开地址） |
| `GET /api/service/douyin/downloads/:id` | — | `{ download, file }`；`file` 在完成后为 `{ url, expiresAt }`（公开模式 `expiresAt` 为 null），否则为 null |

- `requestedBy` 是 Muse 里的用户名（1–64 字，省略时为「Muse」），记录里显示为「<名字>（Muse）」，出现在全组的下载记录中。每个名字与网页成员一样每天最多新增 50 条；超出时单个作品返回 429。
- 工具的典型流程：POST 发起 → 每 5–10 秒用 `awemeIds` 查询 → `done` 后把 `url` 交给用户。可恢复的失败由数据站沿原任务自动重试；冷却中的记录仍为 `queued`，`nextRetryAt` 表示下次尝试时间，`cooldownRounds` 表示已进入冷却的轮数，`errorCode` 和 `error` 说明上次失败。等待期间不要反复 POST，已成功的文件不会重新下载；`failed` 表示需要先处理登录、验证码、校验冲突等不可自动恢复的问题，处理后才能重新提交。并发和重试参数见 [README 的下载配置](../README.md)。
- 只认服务令牌；成员接口 `/api/douyin/downloads*` 仍只认网页登录，令牌不能代替成员身份。

### 抖音视频下载（桌面 Muse，用成员自己的 Muse 账号）

桌面 Muse 装在每个成员的电脑上，不能带服务令牌（它还能领取、发布、标记转写任务）。桌面 Muse 改用成员自己飞书登录的 Muse 账号：请求头 `X-Muse-Account-Token: <账号会话令牌>`（经公网 Nginx `/data/` 时 `Authorization` 被清空，所以用自定义头；Nginx 原样转发其他请求头）。数据站用 `Authorization: Bearer <令牌>` 调本机 Muse 网关的 `GET /api/muse/identity` 核对账号，只放行 `identities.json` 名单里的用户名，角色与网页一致；核对结果按令牌摘要缓存 60 秒（`MUSE_DATA_MUSE_SESSION_CACHE_SECONDS`），令牌本身不保存、不写日志。仅在 `MUSE_DATA_AUTHENTICATION=muse-session` 时启用，否则这些路径返回 404。带 `Origin` 头的请求一律 403；服务令牌和网页 Cookie 都不能用于这些路径。

公网入口 `https://muse.aigc-pipeline.cn/data/api/muse-client/…`：

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/muse-client/douyin/downloads/status` | — | 与服务接口相同：`{ enabled, reason?, access, dailyLimit, usedToday, maxMixEpisodes, … }`，按核对出的成员计 |
| `POST /api/muse-client/douyin/downloads` | `{ "awemeId": "7570…" }` | 202 `{ queued, existing, skipped }` |
| `POST /api/muse-client/douyin/downloads/mix` | `{ "mixId": "7529…" }` | 202 同上 |
| `GET /api/muse-client/douyin/downloads?awemeIds=a,b&mixId=&limit=100` | 至少给 `awemeIds` 或 `mixId` | 记录数组，字段与服务接口相同（`id`、`awemeId`、`mixId`、`episode`、`state`、`url`、`error` …） |
| `GET /api/muse-client/douyin/downloads/:id` | — | `{ download, file }` |

- 请求人就是核对出的成员（记录显示名单里的名字），不接受客户端传的 `requestedBy`（传了返回 400）。成员在网页和桌面 Muse 共用同一份每天 50 条的额度。
- 错误：401 没带令牌或令牌无效；403 账号不在名单（或请求带 `Origin`）；429 当天额度用完；503 TOS 未配置、DTK 不可用或暂时无法连上 Muse 网关；400 参数错误。正文都是 `{ "error": "…" }`。
- 云端 Muse 继续用上面的服务令牌接口 `/api/service/douyin/downloads*`。

### 数据页（桌面 Muse，用成员自己的 Muse 账号）

桌面 Muse 的「数据」页签看榜单、储备看板和立即转写，同样带 `X-Muse-Account-Token`。`/api/muse-client/data/<路径>` 交给网页同一个成员接口 `/api/<路径>` 处理，身份就是令牌核对出的成员，结果和网页完全一致；只放行下表，其他路径（管理员、服务、上传）一律 404。写操作不要求 `Origin`（桌面请求本来就不能带），仍要求 `Content-Type: application/json`。

| 方法与路径 | 对应网页接口 |
| --- | --- |
| `GET /api/muse-client/data/boards?platform=` | 平台的榜单目录 |
| `GET /api/muse-client/data/boards/period?platform=&board=&period=&date=` | 一个榜单的日/周/月榜 |
| `GET /api/muse-client/data/works?…`、`/works/:id`、`/facets?…` | 作品搜索、详情、题材 |
| `GET /api/muse-client/data/hits/board?filter=&q=&page=&limit=` | 储备看板 |
| `POST /api/muse-client/data/hits/:workId/rush` | 立即转写，请求人记为该成员 |
| `GET /api/muse-client/data/hits/jobs/:workId/events` | 一部剧的转写记录 |
| `GET /api/muse-client/data/scripts/:id/download` | 下载剧本 |
| `GET /api/muse-client/data/lvpaopao/status` | 绿泡泡采集端状态 |

### 储备推送（唤醒云端 Muse 主 Bot）

任务表的每一次状态变化本来就记在 `transcription_job_events`（自增 id）里，这张表就是推送的发件箱。另有一行游标 `station_event_cursor`（`name='main-bot'`）记着主 Bot 已确认收到的最后一个事件 id。

- **何时推：** 每 `MUSE_DATA_STATION_EVENTS_POLL_SECONDS` 秒（默认 15，5–300）检查一次。成员「立即转写」、任务失败或转为待处理的事件，下一次检查就推；其他变化等最早一条满 `MUSE_DATA_STATION_EVENTS_BATCH_SECONDS` 秒（默认 300，10–3600）后一起推。一次最多 200 条。
- **推什么：** `POST MUSE_DATA_STATION_EVENTS_URL`，正文为 `{"deliveryId":"<首id>-<末id>","events":[{"id","workId","title","at","from","to","actor","note"}]}`。请求头 `x-muse-station-timestamp`（毫秒）和 `x-muse-station-signature: sha256=<HMAC-SHA256(密钥, "<timestamp>.<正文>") 的十六进制>`。
- **确认与重发：** 只有收到 2xx 才把游标推进到这批的末 id；失败或连不上时游标不动，下一次检查原样重发（`deliveryId` 不变，接收方据此去重）。游标第一次建立时从当前最新事件开始，所以接通之前的历史不会补推。
- **密钥：** `MUSE_DATA_STATION_EVENTS_SECRET_FILE` 指向私有文件：绝对路径、普通文件、0600 或 0640、不经符号链接，32–4096 字节。URL 和密钥文件要么都配、要么都不配；读不到密钥时只关闭推送，数据站照常启动。
- **接收方：** 云端 Muse 的 DS Bot 路由 `/api/muse/station-events`，用同一份密钥验签，把每批变化作为一条消息送进主 Bot 的会话。

## 4. 成员与管理员接口（Muse 登录）

| 方法与路径 | 权限 | 内容 |
| --- | --- | --- |
| `GET /api/hits/board?filter=all\|script\|active\|queued\|failed\|rejected&q=&page=&limit=` | 成员 | 看板：`summary`（剧本储备、今日新增、平均出稿小时数与统计天数、失败/待处理、复核淘汰、排队、转写中、入选候选数）、`rules`、`items[{work, evaluation, job, script}]`、`selection` |
| `POST /api/hits/:workId/rush` | 成员，JSON `{}`，页面同源 | 立即转写：没有任务的红果作品建立手动任务；排队中排到队首；失败/待处理重新排队；进行中或已发布返回 409 |
| `GET /api/hits/jobs/:workId/events` | 成员 | 任务事件记录 |
| `POST /api/hits/:workId/douyin-topic` | 成员，JSON `{ "hashtagId": "…" }`，页面同源 | 人工指定抖音话题并立即读取播放量，返回检查结果；未配置 DTK 返回 503 |
| `POST /api/admin/hits/run` | 管理员，JSON `{}` | 立即跑一轮选片，202；正在跑 409 |

看板列出所有任务、所有入选候选以及已有剧本的红果剧。「有剧本」筛选只看已能下载的；原片链接为 manifest 与每集视频的公开地址（TOS 目录本身不允许匿名列出）。

## 5. 数据与部署

- 新表：`douyin_topics`（每部剧最近一次抖音话题检查）、`hongguo_details`（详情页读数，失败保留上次成功值）、`hit_candidates`（每部下沉候选的最新评估与首次入选时间）、`transcription_jobs`、`transcription_job_events`。都在现有 PGlite 中，服务启动时自动建立，不改已有表。
- 部署时需要：把令牌文件放到服务器（例如 `/srv/muse-data-web/access/service-token`，属主为数据站服务用户，0600），在 `server.env` 加 `MUSE_DATA_SERVICE_TOKEN_FILE`；可选 `MUSE_DATA_HIT_RULES_FILE`。Nginx 不需要改动。

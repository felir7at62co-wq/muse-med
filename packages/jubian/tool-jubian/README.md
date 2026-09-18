# @deepseek-ai/dsh-tool-jubian

剧变（Jubian，`web.jubianai.net`）工具插件：把剧变的 HTTP 能力做成任意 DSH 模式都能挂载的一组工具。

本包与 `@deepseek-ai/dsh-jubian`（传输层）和 `@deepseek-ai/dsh-jubian-api`（端点读取器）一起工作。
它不依赖、也不修改 `@deepseek-ai/dsh-muse-product`。

## 挂载

在 preset 的 `agent.cordis.yml` 或 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: tool-jubian
      name: '@deepseek-ai/dsh-tool-jubian'
      # 全部可选：
      # ledgerRoot: D:\somewhere\jubian-ledger   # 写账本目录，默认 <DSH_HOME>/jubian/ledger
      # baseUrl: https://web.jubianai.net/prod-api
      # timeoutMs: 30000
```

## 凭证

| 项 | 位置 |
|---|---|
| 键名 | `JUBIANAI_ADMIN_TOKEN`，由本包定义（`JUBIAN_TOKEN_REF`） |
| 值的存储 | `$DSH_HOME/.credentials.yaml`，经 DSH `credentials` 服务读取 |
| 环境变量覆盖 | `JUBIANAI_ADMIN_TOKEN` |

**凭证层级**（从高到低），来自 `packages/credentials/credentials-local/src/index.ts:5-10`：

```text
继承的进程环境（只读，最高）
> $DSH_HOME/.credentials.yaml（provider 管理，可写）
> <启动目录>/.env
> $DSH_HOME/.env
```

进程环境优先，所以 `JUBIANAI_ADMIN_TOKEN=… dsh` 会**盖过** `.credentials.yaml` 里的值并使其显示为只读。
排查"我改了怎么没生效"时先看这一条。

**粘贴痕迹会被自动修复。** 从 shell 或表单复制的值常带着首尾空白、一个 `;`、一对引号；
`trimBearerToken` 只修边界，token 本身从不被改写。**实测过：** 带着痕迹的原始值直接拿去发请求会得到
`认证失败`，经修复后同一 token 11 个端点全部 200。值内部若还有空白，则本地失败并发不出请求。

**不要把 `.credentials.yaml` 复制进这个包。** 该文件含明文 token，且不在版本控制里。

## 工具一览

五个工具，方法合计 22 个。计费与副作用写在工具描述里——模型读的是描述，不是源码。

| 工具 | 方法 | 端点 | 计费 |
|---|---|---|---|
| `jubian_catalog` | `models` `rate` `script` `episodes` | 4 个 | 只读 |
| `jubian_asset` | `get` `list` `materials` `generated_image` | 4 个 | 只读 |
| | `confirm_casting` | `/aigc/material/confirm/{id}` | **写·GET 有副作用** |
| `jubian_storyboard` | `get` `create` `save` | 3 个 | 写但免费 |
| | `generate` `erase_subtitle` | 2 个 | **收费·不可撤销** |
| `jubian_video` | `task` `tasks` `subtasks` | 3 个 | 只读 |
| | `image_generate` | `/aigc/asset` | **收费·不可撤销** |
| `jubian_media` | `download` | 剧变 CDN | 免费·不需要凭证 |

两个动词会骗人的地方，插件在描述里都写明了：

- `jubian_video.subtasks` 用 **POST** 承载查询体，但**只读**。
- `jubian_asset.confirm_casting` 是 **GET**，但**会改变远端状态**。

## 写方法与幂等

每个写方法都要 `idempotency_key`，**缺失即失败，插件从不代生成**——代生成会让"超时后重试"绕过第一次的记录，
而那正是这个机制唯一要防的事。

同一个 key 再调一次**不发任何请求**，直接返回既有记录并标 `replayed: true`。这条在实现上是硬的：
请求体是**惰性编译**的，所以连编译请求体所需的目录读取都不会发生。

账本在 `<ledgerRoot>/YYYY-MM-DD.ndjson`，两阶段追加：

- **出网前**落一条 intent（key、method、请求体哈希、报价快照）；
- **出网后**回填 settle（http_status、application_code、response_sha256、outcome）。

只有 intent 没有 settle 的那条，就是超时留下的"未知态"——它是回答"这笔到底扣没扣"的唯一依据。

`outcome` 为 `accepted` 仅当 HTTP 2xx 且信封 `code` 为 `0` 或 `200`；其余一律 `unknown`。

## 错误

五个稳定码，**永不携带远端响应体或 token**：

| 码 | 触发 |
|---|---|
| `AUTHENTICATION_REQUIRED` | 无 token / token 含内部空白 / HTTP 401 或 403 / 信封 `code` 401 或 403 |
| `PERMISSION_DENIED` | 信封 `code` 403 且 HTTP 为 2xx |
| `RATE_LIMITED` | HTTP 429 / 信封 `code` 429 |
| `CONTRACT_CHANGED` | 非 JSON 对象、非严格 UTF-8、超字节上限、信封形状不符、读取器字段不符 |
| `NETWORK_ERROR` | 连接失败、超时、重定向被拒、其他非 2xx |

## 两种信封形状（实测）

这个提供方同时使用两种：

```jsonc
// 单对象端点，如 /aigc/script/{id}
{ "code": 200, "msg": "操作成功", "data": { "id": 2708, … } }

// 列表端点，如 /admin/aigc/video/task/list
{ "code": 200, "total": 34, "rows": [ … ] }     // 没有 data
```

传输层把两者都归一成一个对象交给读取器，所以读取器不需要知道自己拿到的是哪一种。
**HTTP 状态在这里不足以判断成败**：认证失败也返回 HTTP 200，真正的判据是信封里的 `code`。

## 媒体

剧变的媒体在公开 CDN 上（`https://jubian-aigc.tos-cn-beijing.volces.com`），**下载不需要凭证**。

`jubian_media.download` 把文件写到 `output_path` 并返回路径、字节数与 sha256，**不把内容放进返回值**——
几十 MB 的 base64 会污染之后每一次请求的上下文。下载后请用你自己的看图或抽帧工具读取该路径。

边界：origin 白名单（不取自被下载的 URL）、图片 64 MiB / 视频 512 MiB、不跟随重定向、
按**解码出的文件头**判定真实类型而不是靠扩展名。

拿到成片 URL 的正确字段是 `subtasks` 返回的 `video_url`，它取自 `resultList[0].tosVideoUrl`。
同一载荷里的 `resultVideoUrl` 在**另一个 origin** 上，不在允许列表内。

## 转高清（付费，异步）

`jubian_video` 的 `upscale` 方法提交一次转高清。请求体形状**来自工作台的真实抓包**，不是推测：

```jsonc
{ "scriptId": 2708, "episodeId": 46734, "episodeCount": 1,
  "firstResultId": 979766, "parentResultId": 979766, "duration": 13,
  "taskName": "…-高清转换", "taskType": 20,
  "modelId": "2074071626416742401", "platformId": "RUNNING_HUB",
  "standardId": 55, "videoStandardId": 303,
  "videoUrl": "https://…/aigc_video_979766f610w8q0ly.mp4" }
```

- **`taskType` 是 20**，不是 2。一次真实样本里 `taskType=2` 是**失败的 `gpt-image-2` 图像任务**，与视频无关。
- `modelId` / `platformId` / `standardId` / `videoStandardId` 已钉死为工作台默认的 **SeedVR2视频高清**（1 元/条）。
- 调用方只需给 `task_id` 与 `idempotency_key`；`episodeId` 从父任务读，`firstResultId` / `duration` / `videoUrl` 从子结果读。
- `videoUrl` 用载荷里的原值，**不做域名改写**：工作台提交的是 `101.aigc.jubianai.net` 镜像，而载荷给的是对象存储域名，凭空改写有风险。

**它是异步的，且实测要十几分钟。** 所以这个方法是**提交即返回**，附一句 `next` 提示——不要在这里等待，
之后用 `subtasks` 回读 `hd_count` / `last_task_type` / `resolution` 判断是否转好。

## 每个视频的加工状态（实测字段）

`jubian_video.subtasks` 返回的每一行都带提供方**自己记录**的阶段信息，不是猜的：

| 字段 | 含义 |
|---|---|
| `resolution` | 该结果的分辨率（`480p` / `720p` / `1080p`） |
| `model_id` | 生成它的模型（`doubao-seedance-*` 生成，`2074071626416742401` = SeedVR2 高清） |
| `hd_count` | **转高清次数**，`0` 表示没转过 |
| `last_task_type` / `last_stage` | 最后经过的加工：`1`=generate、`10`=erase_subtitle、`20`=**upscale** |
| `upscaled` | 是否已转高清（`hd_count > 0` 或 `last_task_type=20` 或当前文件已是新文件） |
| `subtitle_erased` | 是否已去字幕 |
| `base_video_url` | 原始生成文件（转高清后仍在） |
| `video_url` | **当前该用的文件**；转高清后它指向高清版（`lastTosVideoUrl`） |
| `expiration_time` | 该结果还能被继续加工到什么时候 |
| `versions` | 提供方持有的各阶段记录 |

一次真实的转高清前后对比（同一项目实测）：

```text
转高清前：sub 972949  modelId=doubao-seedance-2-0-260128  resolution=720p  hdCount=0  lastTaskType=1
转高清后：sub 972949  resolution=720p  hdCount=1  lastTaskType=20
          base_video_url = .../2026/09/17/aigc_video_979766...mp4   ← 原片
          video_url      = .../2026/09/18/aigc_video_989004...mp4   ← 高清版
          sub 982120  modelId=2074071626416742401  resolution=1080p ← 提供方新建的高清子任务
```

注意 `2` **不是**转高清（那次是失败的 `gpt-image-2` 图像任务）；视频转高清是 **`taskType=20`**。

## 分辨率不够时必须先转高清

`jubian_video.subtasks` 接受 `delivery_resolution`（如 `1080p`）。给定后每一行都会得到：

- `needs_upscale`：该结果**低于**交付分辨率时为 `true`；未识别标签时为 `null`（不猜）；
- `delivery_resolution`：本次比较用的目标。

**`needs_upscale=true` 的结果不能直接用于交付**：低于交付分辨率的文件不能靠改扩展名或本地转码顶替，
必须先走提供方的转高清（SeedVR2 视频高清，`taskType=20`）。

这一条在 2.5 上是必然的：**`doubao-seedance-2-5-260628` 只提供 480p 与 720p，没有 1080p**
（`standardId` 337–340）。所以"用户要 2.5 + 480p"意味着**每一个镜头都要转高清**。

## 异步任务：不要干等

去字幕（`taskType=10`）与转高清（`taskType=20`）都是**异步任务**。实测转高清的响应可能十几分钟才回来，
所以 agent 的用法是：

```
提交 → 立刻拿到受理结果 → 去做别的任务 → 之后再查 subtasks 的 last_task_type / hd_count / resolution
```

**不要在提交后阻塞等待**。判断是否完成靠回读 `subtasks`，不靠等响应。

## 已实测的行为

| 验证 | 结果 |
|---|---|
| 登录态与信封 | `/model/charge/getSelectList?taskType=2` → 200，`gpt-image-2` 行存在 |
| 端点可达性 | 11 个只读端点全部 OK（修复 token 边界后） |
| 项目读取 | 真实项目 34 个视频任务、子任务含成片 URL 与 5 张参考图 |
| 媒体下载 | 真实成片 3,664,580 字节，`video/mp4`，sha256 校验通过 |
| 抽帧看图 | `ffmpeg` 抽 5 帧，画面内容与 `subtasks` 的 prompt 资产引用一致 |

## 本插件不做什么

- 不做付费授权、不做预算封顶：写方法开箱可用，超时后是否重试由调用方自己读账本决定。
- 不做 `storyboard.create` 的请求体编译（原样转发调用方给的 `body`）。
- 不做多账号。
- 不执行剧变旧 CLI（`jubianai_api.py`）；那条链路与本插件无关。

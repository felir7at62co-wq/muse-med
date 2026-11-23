# 绿泡泡短剧采集

绿泡泡短剧（微信小程序，AppID `wx404dde55fb12df78`）的数据只能从已登录的微信里取，所以采集分两半：Mac 上的采集端在一份隔离的微信副本里读取榜单和互动数，经 HTTPS 推给数据站；数据站负责入库、展示、看门狗和网页扫码登录。

## 现状

- 数据站：「绿泡泡短剧」放在红果短剧右边，有数据后显示榜单、历史和互动数；没有数据时显示采集端状态。采集管理页显示心跳、最近一次采集、登录二维码，以及「发起登录」「立即采集」按钮。
- Mac 采集端：代码在 [mac-collectors/lvpaopao/](../mac-collectors/lvpaopao/README.md)，测试用假 helper、假时钟和假数据站跑通，尚未安装到 Mac。启用前需要一个专用微信号；用户在准备（2026-11-15）。
- 尚未验证：Mac 上自动「重新进入小程序」和微信重启后自动打开绿泡泡，须用登录后的微信实测（见采集端 README 的启用步骤）。

## 服务器配置

| 变量 | 含义 |
| --- | --- |
| `MUSE_DATA_LVPAOPAO_TOKEN_FILE` | 采集端令牌文件，规则同 `MUSE_DATA_SERVICE_TOKEN_FILE`（绝对路径、普通文件、0600/0640、32–512 个 URL 安全字符）。不设置时 `/api/service/lvpaopao/*` 返回 404，页面显示「采集端未配置」。 |
| `MUSE_DATA_LVPAOPAO_ALERT_WEBHOOK_FILE` | 可选。飞书群自定义机器人 Webhook 地址所在文件（同样的文件权限要求）。不设置时只在页面上显示告警。 |
| `MUSE_DATA_LVPAOPAO_OFFLINE_MINUTES` | 可选，默认 `20`。超过这么久收不到心跳即判定采集端失联。 |

令牌与绿泡泡以外的服务令牌互不通用；更换令牌只需替换文件并重启服务。

## 采集端接口

公网地址 `https://muse.aigc-pipeline.cn/data/api/service/lvpaopao/…`（nginx 去掉 `/data` 前缀）。每个请求：

- 头 `X-Muse-Data-Service-Token: <令牌>`（公网 nginx 会清掉 `Authorization`）；
- 不带 `Origin`；
- 写请求 `Content-Type: application/json`，正文不超过 2 MiB；
- 时间一律为带时区的 ISO 8601。

失败时返回 `{error}`，状态码 400（参数无效）、401（令牌无效）、404（未配置）、409（同一 `runId` 内容不同）、413（过大）、415、5xx。400、409、413、415 说明这份数据本身有问题，不再重试；401、403、404 是服务器配置问题，数据保留在本地、按退避重试；5xx 和网络错误同样按退避重试。

### `POST /api/service/lvpaopao/runs`

上报一次已结束的采集。按 `runId` 幂等：相同内容重复上报返回 `duplicate:true`，内容不同返回 409。

```json
{
  "schema": 1,
  "runId": "20261115T0900+0800-rankings-3f9a1c2e",
  "kind": "rankings",
  "slot": "2026-11-15T09:00:00+08:00",
  "startedAt": "2026-11-15T09:00:04+08:00",
  "finishedAt": "2026-11-15T09:03:51+08:00",
  "status": "complete",
  "reason": null,
  "collector": { "version": "1.0.0", "host": "collector-mac" },
  "rankings": [
    {
      "boardType": 6, "boardName": "口碑榜", "observedAt": "2026-11-15T09:01:10+08:00",
      "total": 100, "pagesRead": 5, "partial": false,
      "entries": [ { "rank": 1, "title": "剧名", "srcAppId": "wx0123456789abcdef", "dramaId": "12345" } ]
    }
  ],
  "engagement": []
}
```

- `runId`：`[A-Za-z0-9._:+-]{8,120}`。
- `kind`：`rankings` 或 `engagement`。
- `status`：`complete`、`partial` 或 `failed`。
- `reason`：失败或部分完成时的原因码，见下文；完成时为 `null`。
- `rankings`：仅 `kind=rankings`，最多 50 个榜单。每榜 `entries` 最多 500 条，`rank` 为平台原始名次（正整数），无效条目留空缺名次不前移。`boardName` 1–80 字，作为数据站榜单名（加「绿泡泡 · 」前缀）。`srcAppId` 为 `wx` 加 16 位十六进制，`dramaId` 为 `[A-Za-z0-9._:-]{1,128}`。
- `engagement`：仅 `kind=engagement`，最多 200 部剧：

```json
{
  "srcAppId": "wx0123456789abcdef", "dramaId": "12345", "title": "剧名",
  "observedAt": "2026-11-15T10:12:00+08:00", "episodeCount": 80, "partial": false,
  "missingEpisodes": [],
  "episodes": [ { "episodeNo": 1, "likes": 1200, "comments": 35, "recommendations": 88, "shares": 14 } ]
}
```

各计数为非负整数或 `null`（未读到）。整剧数值是已读各集之和，不是去重人数。

`failed` 的运行只更新采集状态，不写入作品数据。

### `POST /api/service/lvpaopao/heartbeat`

采集端每 5 分钟发一次，`waiting-login` 期间每 20 秒一次（以便尽快收到 `start-login`），返回待执行的指令。

```json
{
  "schema": 1,
  "sentAt": "2026-11-15T09:05:00+08:00",
  "state": "ok",
  "message": "已就绪，下一次 12:00",
  "wechat": { "running": true, "loggedIn": true },
  "lastRun": { "runId": "…", "kind": "rankings", "status": "complete", "finishedAt": "…" },
  "nextSlot": "2026-11-15T12:00:00+08:00",
  "pendingUploads": 0,
  "collector": { "version": "1.0.0", "host": "collector-mac" }
}
```

`state` 取值：

| state | 含义 | 需要人 |
| --- | --- | --- |
| `ok` | 空闲，下一时段照常采集 | 否 |
| `collecting` | 正在采集 | 否 |
| `recovering` | 重试或重启微信中 | 否 |
| `waiting-login` | 隔离微信停在登录界面 | 是：网页扫码 |
| `reentry-failed` | 无法自动重新进入小程序 | 是：在 Mac 上打开绿泡泡 |
| `build-changed` | 微信版本或文件哈希变了 | 是：重新适配 |
| `offline-network` | Mac 没有网络 | 否（恢复后补发） |
| `error` | 其他错误，见 `message` | 视情况 |

`message` 不超过 300 字。`wechat.loggedIn` 无法判断时为 `null`。

返回：

```json
{ "commands": [ { "id": "c-…", "action": "start-login", "issuedAt": "…" } ], "serverTime": "…" }
```

`action` 为 `start-login`（点击登录窗口的「进入微信」或刷新二维码）或 `collect-now`（立即补跑一次榜单采集）。同一指令在确认前每次心跳都会返回，最长保留 30 分钟。

### `POST /api/service/lvpaopao/commands/:id/ack`

```json
{ "result": "done", "message": "已点击进入微信" }
```

`result` 为 `done` 或 `failed`，确认后不再下发。

### `PUT /api/service/lvpaopao/login-screen`

微信停在登录界面时，采集端每 20 秒上传一次登录窗口截图（只截该窗口）：

```json
{ "capturedAt": "…", "kind": "qr", "png": "<base64>" }
```

`kind` 为 `qr`（二维码）、`confirm`（「进入微信」按钮）或 `unknown`。PNG 解码后不超过 1 MiB（base64 后仍在 2 MiB 请求上限内）。登录成功后 `DELETE` 同一路径；数据站也会在 3 分钟没有新截图或心跳报告已登录时隐藏截图。

### 原因码

`mac-asleep`、`network`、`server-unreachable`、`wechat-not-running`、`wechat-logged-out`、`reentry-failed`、`target-timeout`、`build-changed`、`helper-error`、`business-error`、`budget-exhausted`、`cancelled`。数据站展示时附中文说明；未知原因码按原样显示。

## 数据站内的存储

- 榜单：每个 `rankings` 条目写成一条 `lvpaopao:<srcAppId>:<dramaId>` 作品的榜单观测，榜单名「绿泡泡 · <boardName>」，与红果等平台共用 `observations` 历史、名次变化和日/周/月视图。
- 互动数：每部剧每次读取存一行 `lvpaopao_engagement`（剧 × 读取时间为主键，含逐集计数），并把最近一次的整剧合计（点赞、评论、推荐、分享）附到该剧之后的榜单观测里。
- 运行与心跳：`lvpaopao_runs` 保存每次上报（含失败原因，用于画缺口），心跳和待办指令存在 `data_meta`。

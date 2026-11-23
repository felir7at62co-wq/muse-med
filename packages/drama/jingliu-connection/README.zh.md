---
kind: package-reference
description: 镜流账号授权与制作服务请求。
---

# 镜流账号连接

[English](README.md) | 中文

## 概述

Host 以当前 Muse 账号访问同站镜流接口和媒体文件。每段本地会话分别记录该账号确认的云项目，右侧栏与制片工具读取同一条关联。独立部署的镜流仍可使用原版登录交换。

共享目录返回素材描述、媒体路径和参考用途标记。

桌面 Host 访问所选镜流站点的 `/fwp/v2` 接口。`studioOrigin` 可配置 HTTPS 站点或明确的 IPv4、IPv6 回环地址。原版工作台入口位于 `/sfp/`。接口请求拒绝重定向；读取媒体时只跟随指向已配置存储主机的重定向，见[媒体文件](#media)。未配置站点时，服务保持未连接状态。

## 目录

- [登录](#sign-in)
- [Host 接口](#host-api)
- [媒体文件](#media)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="sign-in"></a>
## 登录

在 Muse 账号设置中登录后，聊天工具会自动用镜流专用的短期 Muse 授权码连接所选镜流站点。Muse 的账号 cookie 只发给签发它的账号网关。`/jingliu-login` 检查当前连接，`/jingliu-logout` 结束本次工具连接。再次调用工具时，Host 会使用当前 Muse 账号重新连接。

独立本地预览将 `localPreviewToken` 设为 `true`，在 Host 环境中通过 `MUSE_JINGLIU_SESSION_TOKEN` 提供测试账号会话。这一模式仅接受回环站点，直接读取测试凭据。工具选择项目前会先向 `/auth/me` 核实用户身份。

<a id="host-api"></a>
## Host 接口

Host 插件通过 `ctx.jingliuConnection.connection()` 取得已核验的 `JingliuSession`。其中的 `identity` 标识提交回执所属的镜流用户和服务器。Host 在发出请求前和返回结果前都会核对当前 Muse 登录身份。`request(path, options)` 访问相对于 V2 接口的受支持路由并返回解析后的 JSON。工作流工具选择向模型展示哪些结果。登录、账号变化检查和有界 JSON 请求来自共用的[工作台连接](../workbench-connection/README.zh.md)核心。

`billingDetails(signal)` 通过镜流 V2 接口读取当前用户的余额和最近 50 笔流水，并以镜流返回的本人资料确定查询账号。结果包含流水类型、时间和带正负号的余额变动金额，单位为分。结算流水表示预扣之后的余额调整。结果会区分无可查流水与已查到的空账本。Muse 账号所有者可以在界面或通过聊天工具查看这些数据。

客户端 Remote 还以当前登录用户的身份只读地读取工作台数据：`projectConfig`、`episodeList`、`episodeShots`、`shotMedia` 和 `projectAssets` 调用镜流的只读工作流（`get_project`；`list_episodes`；`list_shots` 与 `read_shots`；`get_shot` 与 `list_versions`；`list_assets` 与 `list_audio_clips`）。`thumbnail` 和 `localVideo` 按[媒体文件](#media)一节读取媒体；`video` 供没有本机媒体的 Host 以流的方式传回一段镜流视频，最多 64 MiB：先传内容类型，再传 base64 分段。结果只保留镜流媒体目录下的路径，客户端拿不到镜流凭据，也拿不到别的地址。另有四个调用供工作台的表单使用：`catalog` 读取镜流提供的模式及其画风、画面比例、分辨率和模型；`createProject` 按该目录逐项核对后创建项目；`renameProject` 重命名项目并核对保存后的名称；`deleteShot` 删除一个镜头，镜流不保留副本。

<a id="media"></a>
## 媒体文件

存储地址 `/fw/media/<目录>/<文件名>` 是镜流文件的永久 ID；`<目录>` 只能是 `generated`、`uploads`、`outputs`、`character-references`、`exports`、`bgm-library`、`sfx-library` 和 `voice-library` 之一，下面最多再有一层子目录，任何一段都不能以点开头，也不能以 `.part` 或 `.part.json` 结尾。Host 每次最多以 200 个地址请求 `POST /v2/media/resolve`，再从返回的对象存储预签名链接读取文件，不附带 Muse Cookie、镜流令牌或其他凭据。镜流仍保存在本机的文件（`local: true`）、对象存储不管的目录里的文件（`not_in_tos`），以及 resolve 路由返回 404 的镜流上的所有文件，照旧通过 Host 会话读取。对象存储没有报告 Content-Type 或只报告 `application/octet-stream` 时，使用镜流 resolve 给出的类型，没有则按文件扩展名判断。`/fwp/media/...` 的重定向只在目标属于 `mediaHosts` 时跟随，同样不附带凭据；其他目标以 `JINGLIU_MEDIA_REDIRECT_REFUSED` 失败。resolve 返回 `mediaHosts` 以外的链接时，只有那个文件改经 Host 会话读取，Host 为这一批记一行警告日志。媒体失败使用独立的错误码 `JINGLIU_MEDIA_NOT_FOUND`、`JINGLIU_MEDIA_UNAVAILABLE` 和 `JINGLIU_MEDIA_INTEGRITY`，不再报告为 Muse 登录失败。客户端拿不到存储链接，也拿不到存储密钥。

只有桌面 Host 设置 `localMedia: true`。开启后文件下载到本机文件夹：缩略图放在 Host 主目录的 `jingliu/media/<账号>`，视频和工具下载放在 `<工作区>/jingliu/<项目>/<目录>/<文件名>`。每个文件夹用索引 `.muse-media.json` 记录地址、大小和 ETag，索引里大小一致的文件直接复用，不再下载。下载会核对大小，ETag 是单段 MD5 时还核对 MD5；中断的 `.part` 文件按字节范围续传；同时最多 `mediaDownloads` 个，超过 `mediaTimeoutMs` 即停止。工具或剪映草稿用到的文件会保留；其余文件超过 `mediaCacheBytes` 时，按最久未用的顺序删除。缩略图经 Host 的 `/api/file` 路由、视频经 `/api/video` 路由交给客户端，都不放在内存里。不开启 `localMedia` 时（例如 Web Host），不向磁盘写任何文件：缩略图以内联方式返回，最多 8 MiB；视频以流的方式返回，最多 64 MiB。

`JingliuSession.upload(file, projectId, signal)` 上传一个本机图片、音频或视频文件：`POST /v2/media/upload-url` 签发 `mediaHosts` 主机上的 PUT 链接，Host 不带凭据把文件传上去，再由 `POST /v2/media/upload-complete` 确认地址和大小。结果是永久地址 `/fw/media/uploads/...`。镜流没有这些路由时以 `JINGLIU_UPLOAD_UNSUPPORTED` 失败。`download` 和 `place` 仅在开启 `localMedia` 时提供，让工具使用同样带索引的文件夹，并把已下载的文件链接到另一位置。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `localMedia` | `false` | 把媒体保存为本机文件；只由桌面 Host 设置。 |
| `mediaHosts` | `[]` | 预签名链接的精确 `host[:port]`；HTTPS，或回环地址上的 HTTP。 |
| `mediaDownloads` | 4 | 同时下载的数量。 |
| `mediaCacheBytes` | 2 GiB | 每个文件夹在清理前保留的已查看文件大小。 |
| `mediaMaxBytes` | 2 GiB | 镜流未说明大小时允许下载的最大文件。 |
| `mediaTimeoutMs` | 30 分钟 | 一次下载或上传的最长时间。 |

<a id="model-experience"></a>
## 模型体验

### 工作流调用期间切换账号

#### 模型看到什么

准备请求后切换账号，工作流工具会返回 `JINGLIU_ACCOUNT_CHANGED`。授权令牌保留在 Host。

#### Token 影响

登录不增加工具定义或系统指令。

#### KV 缓存影响

切换账号不会改变系统前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- Host 只读取 `mediaHosts` 中的预签名链接；部署配置需列出镜流签名所用的存储主机。没有 resolve 和上传路由的镜流仍通过 Host 读取媒体，也无法接收 Muse 的上传。
- 使用明文 HTTP 的远程部署需要通过可信的本地回环隧道连接，或在服务端提供 HTTPS。镜流站点需要实现 `/fwp/v2/auth/muse/challenge` 和 `/fwp/v2/auth/muse/exchange`，并在 Muse 账号网关注册镜流应用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>

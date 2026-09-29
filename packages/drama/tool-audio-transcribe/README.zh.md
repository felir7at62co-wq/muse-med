---
description: "通过当前 Muse 账号转写已授权的本地媒体，并保留带时间戳的项目版本产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-audio-transcribe

[English](README.md) | 中文

## 概述

Host 工具 `audio_transcribe` 通过已登录的 Muse 账号，把本地音频或视频转成带时间戳的文字。`start` 先保存幂等任务收据，再请网关提交计费云端任务；`status` 查询同一任务，并把非空 TXT 和 JSON 无覆盖地写入 `transcript/raw/`。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

桌面 Host 在 `@deepseek-ai/dsh-muse-account` 之后装载此行，产品各模式均可调用。开始前须登录 Muse 账号；云端网关还须单独启用转写。模型不能提供火山或 TOS 凭据。

```json
{"method":"start","project":"<project root>","input":"<authorized local audio or video>","language":"zh"}
{"method":"status","project":"<same project root>","receipt":"<start receipt path>"}
```

`start` 探测素材，用 FFmpeg 提取 16 kHz 单声道 MP3，在 `transcript/jobs/` 记录任务 ID 和音频摘要。Unix 上工具创建的转写目录权限为 0700，暂存 MP3、收据和转写产物权限为 0600。提交结果不明时保留收据；再次请求前先查询该收据。服务器确认任务不存在时，才能用原密钥和暂存 MP3 重试。完成后写 `transcript/raw/<素材名>-vN.txt` 与 `.json`；无语音时只保留收据。离线 Python 技能仅在用户明确要求离线时使用。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `ffmpegPath`、`ffprobePath` | `ffmpeg`、`ffprobe` | 桌面安装包通过 `DSH_FFMPEG_PATH` 和 `DSH_FFPROBE_PATH` 提供随包路径。 |
| `commandTimeoutMs` | 600,000 | 本地探测或提取的超时毫秒数。 |
| `maxDurationSeconds` | 18,000 | 本地接受的素材最长秒数。 |
| `maxAudioBytes` | 209,715,200 | 提取后 MP3 的最大字节数；服务器另有独立上限。 |

<a id="understand-the-implementation"></a>
## 实现说明

Host 账号服务读取绑定网关源地址的已保存会话，把压缩音频发送到 `POST /api/asr/jobs`，再以同一账号查询 `GET /api/asr/jobs/:id`。cookie、TOS 签名 URL 和提供方密钥均不返回给模型。网关负责私有临时 TOS 对象、账号隔离、限额、提供方提交与查询，以及清理。提交状态不明时只查询原提供方任务 ID，不换 ID 重新提交。服务器配置和发布步骤见 [`services/muse-accounts`](../../../services/muse-accounts/README.zh.md)。

实现依据是用户 Pi 会话验证过的火山大模型录音文件识别**标准版 1.0**，v3 `/api/v3/auc/bigmodel/submit` 和 `/query`，资源 `volc.bigasr.auc`。火山[大模型录音文件产品说明](https://www.volcengine.com/docs/6561/1354871?lang=zh)给出五小时时长限制；[TOS 签名 GET URL](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en)是凭 URL 持有的访问凭据，最长七天。旧小模型 `/api/v1/auc` 文档属于另一接口，不作为此实现的依据。状态码和 512 MiB 观察来自用户 Pi 实测；正式计费前仍须在获授权的真实集成检查中确认。

不发布运行时 invariant 伴随模块，因为任务收据和已注册工具各由一处存储或注册表持有，没有可能独立产生分歧的第二份状态。

<a id="model-experience"></a>
## 模型体验

### `audio_transcribe` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-audio-transcribe)记录 start/status schema。结果包含状态、收据路径、任务 ID 和完成产物路径。通用持久化工具卡展示调用与结果。媒体字节、账号 cookie、对象 URL 和提供方凭据不进入参数或结果；工具调用及返回路径仍属于 Session 数据。

#### Token 影响

schema 产生固定请求开销；每次结果只增加简短状态和本地路径。

#### KV Cache 影响

工具结果追加，不改写已有消息；描述或 schema 改动会改变可复用的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 云端识别要求已登录 Muse 账号，且服务器已部署并配置 ASR。工具不抓取网页链接；原始媒体必须在本地可读。
- 无语音时不生成原始转写。提供方时间戳与识别内容仍须人工核对，离线模型不会自动回退启用。
- 远端任务超过留存时间仍未解决时，网关删除临时 TOS 对象；下一次 `status` 删除本地暂存 MP3，但保留收据和原任务 ID 供只读对账。

<a id="dev-note"></a>
### 开发备注

修改收据恢复或响应校验前，应运行聚焦 runner 与账号客户端测试。`services/muse-accounts` 的网关测试用替身覆盖账号隔离、限额和状态不明的提供方提交，不产生真实计费调用。

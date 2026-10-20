---
description: "通过当前 Muse 账号转写已授权的本地媒体，并保留带时间戳的项目版本产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-audio-transcribe

[English](README.md) | 中文

## 概述

Host 工具 `audio_transcribe` 通过已登录的 Muse 账号，把本地音频或视频转成带时间戳的文字。`start` 先保存幂等任务收据，再请网关提交计费云端任务；`inspect` 只查询原任务，不再次上传音轨，完成后把 TXT、JSON 和 SRT 无覆盖地写入 `transcript/raw/`。原有 `status` 可能用同 ID 补传尚未受理的音轨并产生费用。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

桌面在标准、PTC、创造、编辑与短剧模式中装载此工具，极简模式除外。开始前须登录 Muse 账号，云端网关还须单独启用转写。模型不能提供服务商凭据。

```json
{"method":"start","project":"<project root>","input":"<authorized local audio or video>","language":"zh","purpose":"screenplay"}
{"method":"inspect","project":"<same project root>","receipt":"<start receipt path>"}
```

字幕校时使用 `purpose: "subtitles"`，走极速识别；音视频转剧本使用 `"screenplay"`，走标准识别。新任务默认 `subtitles`。收据和每个音轨分段保存解析后的用途，查询与恢复使用该值。未完成任务不能改用途；同一原片确需另一用途且已获额外计费授权时，必须显式指定用途，新任务使用独立版本收据和任务 ID，旧任务保持不变。省略用途不会跨用途新建付费任务。无用途字段的旧收据在恢复时仍保留旧路由。网关选择标准版本与私有资源。视频转小说和剧本的语音来源优先用已授权 ASR；只有确认队列满时，才将尚未提交且有可靠可见文字的工作按实测速率分给 OCR，不设固定比例。已受理排队任务保留付费身份，排队本身不证明全池容量耗尽。无语音不是识别失败，OCR 与 ASR 保留独立来源，均不能证明未观察的画面动作；标准版本不自动视为质量等价或降级。

限流拒绝返回安全的 `error_code`、原收据，以及可选的 `retry_after_seconds` 和 `resume_status`。按建议等待后恢复原收据。`status` 先查询；网关确认任务尚未受理后，可能用原 ID 补传一次暂存音轨，产生识别费用。账号额度、登录过期和幂等冲突不提供立即恢复调用：先处理具体障碍，再明确恢复。`inspect` 和 `status` 可传 0–30 秒的 `wait_seconds`（默认 0），在等待预算内按 `pollIntervalMs` 查询原任务、发布已完成结果或返回最新状态；单次网络请求仍受账号请求超时约束。`status` 仅第一次查询允许恢复上传，后续轮询均只读。取消会停止等待和后续查询。待完成结果提供 `resume_status` 与 `polling_note`；本地收据只是快照，不调用工具便不会更新。遇到 `inspect_receipt` 或需恢复上传时立即结束等待。分段结果返回已完成数与总分段数。可用的 `service_version`、`queued`、`error_code`、`provider_diagnostic` 与 `recovery` 会返回并保留到收据及音轨分段，旧收据可缺失这些字段。带 `resume_upload` 的失败收据仍可恢复：重复 `start` 返回原收据，一次明确的 `status` 最多对每段补传一次原 ID。`poll_original` 查询原任务，`wait` 保留原身份，`resume_upload` 只允许补传已确认尚未向供方提交的原 ID。`inspect_receipt` 停止盲等：已结束且 `no_query` 的极速请求无法靠等待补回丢失响应，绝不自动新建付费任务。客户端网络错误仍先回读网关，不能预判提供方状态；已受理任务的网关记录消失也不自动补传。分段结果显示阻塞分段的诊断，各原始分段的元数据仍在收据中。所有平台返回的绝对路径均使用 `/`。

`start` 探测素材，用 FFmpeg 提取 16 kHz 单声道 PCM WAV，在 `transcript/jobs/` 记录任务 ID 和音频摘要。Unix 上工具创建的转写目录权限为 0700，暂存音频、收据和转写产物权限为 0600。提交结果不明时保留收据；再次请求前先查询该收据。服务器确认任务不存在时，才能用原密钥和暂存音频 重试。完成后写 `transcript/raw/<素材名>-vN.txt` 、`.json` 与 `.srt`；无语音时只保留收据。离线 Python 技能仅在用户明确要求离线时使用。

取消调用会终止正在执行的媒体提取和 HTTP 请求，停止后续分段提交或查询，并等待已启动的工作结束。保存收据前取消会删除暂存音频；已有收据保留音频与原任务 ID，供之后明确调用 `status` 恢复。云端已受理的任务仍可能继续执行并计费。已经开始的本地写入会先结束，再返回取消结果；之后不再发布产物、替换收据或删除暂存音频。已经发布的文件会保留，供通过原收据恢复时核对。

本地媒体命令超时或诊断输出超限时，即使终止后的进程以成功状态退出，也会拒绝本次命令。每条命令的标准输出最多收集 65,536 个字符，标准错误累计最多 65,536 字节；保存收据前提取失败会删除暂存音频，并且不发起付费提交。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `ffmpegPath`、`ffprobePath` | `ffmpeg`、`ffprobe` | 桌面安装包通过 `DSH_FFMPEG_PATH` 和 `DSH_FFPROBE_PATH` 提供随包路径。 |
| `commandTimeoutMs` | 600,000 | 本地探测或提取的超时毫秒数。 |
| `maxDurationSeconds` | 18,000 | 本地接受的素材最长秒数。 |
| `pollIntervalMs` | 2,000 | 有界等待期间查询原任务的间隔。 |
| `chunkSeconds` | 600 | 每个云端任务的最长秒数；原素材仍受 `maxDurationSeconds` 限制。 |
| `maxAudioBytes` | 100,000,000 | 单段提取音频的最大字节数；服务器另有独立上限。 |

<a id="understand-the-implementation"></a>
## 实现说明

Host 账号服务读取绑定网关源地址的已保存会话，把音频发送到 `POST /api/asr/jobs`，再以同一账号查询 `GET /api/asr/jobs/:id`。cookie、TOS 签名 URL 和提供方密钥均不返回给模型。网关负责账号隔离、限额、提供方执行与临时音频清理。标准版使用私有 TOS 对象；极速版直接发送私有暂存音频。提交状态不明时保留原 ID 供回读核对。服务器配置和发布步骤见 [`services/muse-accounts`](../../../services/muse-accounts/README.zh.md)。

网关选择标准版或极速版识别。极速版使用[录音文件极速识别接口](https://www.volcengine.com/docs/6561/1631584?lang=zh)，每次最多两小时、100 MB。工具自动切分长媒体，将源文件 SHA-256 和分段任务 ID 保存在收据中，再把句子与字词时间戳合并到原媒体时间轴。默认十分钟 PCM 分段约 19.2 MB。提取时按重采样后的采样点数截取并重置输出时间戳，避免压缩音频包时间戳让分段变长。旧收据低估已提交音轨时长时，回读会核对原音轨摘要与实际时长，再接受超出计划范围的语音；真正超出音轨的时间戳仍会报错。`timing_warnings` 标识这些旧分段，保留原词和原时间戳，边界可能重叠；已完成任务不需补传。产物原子发布，不覆盖不同内容；重复查询会核对已存在的相同产物。极速请求结果未知时保持未解决状态，不自动再次计费。

不发布运行时 invariant 伴随模块，因为任务收据和已注册工具各由一处存储或注册表持有，没有可能独立产生分歧的第二份状态。

保留可用的说话人编号到带时间码 JSON。合并分段时为每个编号添加原始任务标识，避免不同任务里的同号声音悄悄合并。这些编号标识声音，不代表人物姓名；角色归属须另行核对声画证据。

<a id="model-experience"></a>
## 模型体验

### `audio_transcribe` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-audio-transcribe)记录 start/status schema。结果包含状态、收据路径、任务 ID 和完成产物路径。通用持久化工具卡展示调用与结果。`queue_full` 结果在原样 JSON 前增加“Muse 转写队列已满，请稍后重试”，明确指向 Muse 自身队列，而非提供方容量；其他错误码保留原有输出。媒体字节、账号 cookie、对象 URL 和提供方凭据不进入参数或结果；工具调用及返回路径仍属于 Session 数据。

#### Token 影响

可选用途枚举增加有限的请求开销；每次结果增加简短状态、收据已有的用途和本地路径；队列拒绝另增加一句解释。

#### KV Cache 影响

工具结果追加，不改写已有消息；描述或 schema 改动会改变可复用的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 云端识别要求已登录 Muse 账号，且服务器已部署并配置 ASR。工具不抓取网页链接；原始媒体必须在本地可读。
- 无语音时不生成原始转写。提供方时间戳与识别内容仍须人工核对，离线模型不会自动回退启用。
- 远端任务超过留存时间仍未解决时，网关删除临时音频；下一次 `status` 删除本地暂存音频，但保留收据和原任务 ID 供只读对账。

<a id="dev-note"></a>
### 开发备注

修改收据恢复或响应校验前，应运行聚焦 runner 与账号客户端测试。`services/muse-accounts` 的网关测试用替身覆盖账号隔离、限额和状态不明的提供方提交，不产生真实计费调用。

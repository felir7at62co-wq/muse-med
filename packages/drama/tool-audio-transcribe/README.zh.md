---
description: "通过当前 Muse 账号转写已授权的本地媒体，并保留带时间戳的项目版本产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-audio-transcribe

[English](README.md) | 中文

## 概述

Host 工具 `audio_transcribe` 通过已登录的 Muse 账号，把本地音频或视频转成带时间戳的文字。`start` 先保存幂等任务收据，再请网关提交计费云端任务；它也接受 `inputs` 列表，一次调用提交多个文件，每个文件一张收据。`inspect` 只查询原任务，不再次上传音轨，完成后把 TXT、JSON 和 SRT 无覆盖地写入 `transcript/raw/`。原有 `status` 可能用同 ID 补传尚未受理的音轨并产生费用。

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
{"method":"start","project":"<project root>","inputs":["<episode 1 media>","<episode 2 media>"],"language":"zh","purpose":"screenplay"}
{"method":"inspect","project":"<same project root>","receipt":"<start receipt path>"}
```

字幕校时使用 `purpose: "subtitles"`，走极速识别；音视频转剧本使用 `"screenplay"`，走标准识别。新任务默认 `subtitles`。收据和每个音轨分段保存解析后的用途，查询与恢复使用该值。未完成任务不能改用途；同一原片确需另一用途且已获额外计费授权时，必须显式指定用途，新任务使用独立版本收据和任务 ID，旧任务保持不变。省略用途不会跨用途新建付费任务。无用途字段的旧收据在恢复时仍保留旧路由。网关选择标准版本与私有资源。视频转小说和剧本的语音来源优先用已授权 ASR；只有确认队列满时，才将尚未提交且有可靠可见文字的工作按实测速率分给 OCR，不设固定比例。已受理排队任务保留付费身份，排队本身不证明全池容量耗尽。无语音不是识别失败，OCR 与 ASR 保留独立来源，均不能证明未观察的画面动作；标准版本不自动视为质量等价或降级。

`start` 接受 `input` 或 `inputs` 二者之一，`inputs` 列出 1 至 `maxBatchInputs` 个文件；两者同时给出、空列表或超出上限均为参数错误。批次在任何探测、提取或上传之前，拒绝按相对路径解析后重复列出的文件，以及不是普通文件的条目。随后按列表顺序逐个处理，一次只上传一个；`items` 按输入顺序为每个已处理文件返回一条结果，并以 `input` 原样回显给定字符串。仅在批次中，已有同用途未完成、完成、无语音或失败收据的文件直接返回该收据，不新建计费任务；单个 `input` 在任务结束后会创建新版本。网关从未确认提交、仍为 `prepared` 的收据按 `status` 的流程完成：先查询，只用原 ID 上传。某个文件在本次调用中自身的提交或恢复上传被拒，或在本地出错（以 `{input, error}` 报告）后，批次停止，其余文件列入 `not_started`。原样再次发送同一列表即可继续，并沿用已创建的全部收据。待完成条目共用一个顶层 `polling_note`，不逐条附带；试用额度耗尽的提示保留在对应条目上。

`start` 和 `status` 自行处理 `upload_busy` 与 `request_rate` 拒绝：拒绝带整秒 `retry_after` 时，在等待预算 `uploadRetryBudgetMs` 内等待该时长，再以同一 ID 重新提交同一暂存音轨。一个批次共用该预算，只有等待时间计入，长时间提取不会耗尽它。网关在记录 ID 之前拒绝这两类请求，且每个账号和 ID 最多发起一次计费提交，所以重试不会新建第二个任务。等待时长超过剩余预算的拒绝和其他拒绝立即返回；取消会停止等待。

限流拒绝返回安全的 `error_code`、原收据，以及可选的 `retry_after_seconds` 和 `resume_status`。按建议等待后恢复原收据。`status` 先查询；网关确认任务尚未受理后，可能用原 ID 补传一次暂存音轨，产生识别费用。账号额度、登录过期和幂等冲突不提供立即恢复调用：先处理具体障碍，再明确恢复。`inspect` 和 `status` 可传 0–30 秒的 `wait_seconds`（默认 0），在等待预算内按 `pollIntervalMs` 查询原任务、发布已完成结果或返回最新状态；单次网络请求仍受账号请求超时约束。`status` 仅第一次查询允许恢复上传，被拒的恢复上传可在等待预算内以同一 ID 再次提交；后续轮询均只读。取消会停止等待和后续查询。待完成结果提供 `resume_status` 与 `polling_note`；本地收据只是快照，不调用工具便不会更新。遇到 `inspect_receipt` 或需恢复上传时立即结束等待。分段结果返回已完成数与总分段数。可用的 `service_version`、`queued`、`error_code`、`provider_diagnostic` 与 `recovery` 会返回并保留到收据及音轨分段，旧收据可缺失这些字段。带 `resume_upload` 的失败收据仍可恢复：重复 `start` 返回原收据，一次明确的 `status` 最多对每段补传一次原 ID。`poll_original` 查询原任务，`wait` 保留原身份，`resume_upload` 只允许补传已确认尚未向供方提交的原 ID。`inspect_receipt` 停止盲等：已结束且 `no_query` 的极速请求无法靠等待补回丢失响应，绝不自动新建付费任务。客户端网络错误仍先回读网关，不能预判提供方状态；已受理任务的网关记录消失也不自动补传。分段结果显示阻塞分段的诊断，各原始分段的元数据仍在收据中。所有平台返回的绝对路径均使用 `/`。

`inspect` 查询网关从未受理的任务（例如首次上传被拒后）时，返回 `preparing`、`error_code: "job-not-found"`、指向同一收据 `status` 的 `resume_status`，以及不要删除收据的提示；不写入任何文件，也不上传。适用于未记录服务版本或恢复状态、暂存音轨仍在的 `prepared` 或 `uncertain` 收据，也适用于满足同样条件的分段，由 `diagnostic_job_id` 指明该段。无法恢复的缺失任务，即暂存音轨已过期、分段留存已过期，或收据已记录受理服务或恢复状态时，以 `job-not-found` 报错。

相对的 `input` 和 `receipt` 以 `project` 为基准解析，不以 Host 进程目录为基准。`start` 探测素材，用 FFmpeg 提取 16 kHz 单声道 PCM WAV，在 `transcript/jobs/` 记录任务 ID 和音频摘要。Unix 上工具创建的转写目录权限为 0700，暂存音频、收据和转写产物权限为 0600。提交结果不明时保留收据；再次请求前先查询该收据。服务器确认任务不存在时，才能用原密钥和暂存音频 重试。完成后写 `transcript/raw/<素材名>-vN.txt` 、`.json` 与 `.srt`；无语音时只保留收据。离线 Python 技能仅在用户明确要求离线时使用。

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
| `uploadRetryBudgetMs` | 120,000 | 单次调用等待 `upload_busy` 或 `request_rate` 后再次提交同一暂存音轨的总等待毫秒数；0 表示立即返回拒绝。 |
| `maxBatchInputs` | 10 | 单次批量 start 接受的 `inputs` 最大数量。 |

供应商额度诊断区分普通轮询与试用额度耗尽。确认 lifetime 额度耗尽时，返回 `inspect_receipt` 并提示管理员恢复原应用对应资源，保留原任务和收据。`recovery.retry_after` 同步到 `retry_after_seconds`，有界等待不会提前轮询；后续查询成功会清除过时错误字段，直接发布原任务结果，不再次提交。

<a id="understand-the-implementation"></a>
## 实现说明

Host 账号服务读取绑定网关源地址的已保存会话，把音频发送到 `POST /api/asr/jobs`，再以同一账号查询 `GET /api/asr/jobs/:id`。cookie、TOS 签名 URL 和提供方密钥均不返回给模型。网关负责账号隔离、限额、提供方执行与临时音频清理。标准版使用私有 TOS 对象；极速版直接发送私有暂存音频。提交状态不明时保留原 ID 供回读核对。服务器配置和发布步骤见 [`services/muse-accounts`](../../../services/muse-accounts/README.zh.md)。

网关选择标准版或极速版识别。极速版使用[录音文件极速识别接口](https://www.volcengine.com/docs/6561/1631584?lang=zh)，每次最多两小时、100 MB。工具自动切分长媒体，将源文件 SHA-256 和分段任务 ID 保存在收据中，再把句子与字词时间戳合并到原媒体时间轴。默认十分钟 PCM 分段约 19.2 MB。提取时按重采样后的采样点数截取并重置输出时间戳，避免压缩音频包时间戳让分段变长。旧收据低估已提交音轨时长时，回读会核对原音轨摘要与实际时长，再接受超出计划范围的语音；真正超出音轨的时间戳仍会报错。分段在原身份和摘要下保留已验证时长，暂存音轨清理后，后续查询仍保留警告，并能根据云端原任务重建缺失产物。`timing_warnings` 标识这些旧分段，保留原词和原时间戳，边界可能重叠。未保留时长的旧收据仍可读取完整的已发布产物；恢复时核验仍在的原暂存音轨，若时长证据和产物都已缺失，则明确提示恢复原音轨，不用识别时间戳推测时长，也不为补回证据新建付费任务。已完成任务不需补传。产物原子发布，不覆盖不同内容；重复查询会核对已存在的相同产物。极速请求结果未知时保持未解决状态，不自动再次计费。

工具未声明并发安全，同一消息中的 `start`、`inspect` 和 `status` 调用逐个执行，也不保留本地上传队列。网关已按账号串行处理上传，本地并行上传只会触及其待上传数量上限；上传和查询共用网关每账号每分钟 60 次请求的限制，并行轮询会耗尽该额度。`inspect` 也会保存收据并发布产物，同一素材的两个并发 start 可能都错过收据扫描，从而创建两个计费版本。

不发布运行时 invariant 伴随模块，因为任务收据和已注册工具各由一处存储或注册表持有，没有可能独立产生分歧的第二份状态。

保留可用的说话人编号到带时间码 JSON；TXT 和 SRT 保持原有的纯台词格式。合并分段时为每个编号添加原始任务标识，避免不同任务里的同号声音悄悄合并。完成发布与缓存回读都从实际 JSON 计算 `speaker_summary`，包含总片段数、有标签与缺失标签片段数、观察到的声学分组数及 `available`、`partial` 或 `not_provided` 覆盖状态。缺少标签仍可使用原转写，不触发重新提交。分组数不是人数，一个分组不能证明只有一位说话人。角色归属须另行核对声画证据；这些标签不能证明已试听音色或核实跨集身份。

<a id="model-experience"></a>
## 模型体验

### `audio_transcribe` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-audio-transcribe)记录 start/status schema。结果包含状态、收据路径、任务 ID 和完成产物路径。完成回读另附说话人标签覆盖摘要，简短提示读取 `output_json` 并按时间码结合画面核对角色归属。通用持久化工具卡展示调用与结果。`queue_full` 结果在原样 JSON 前增加“Muse 转写队列已满，请稍后重试”，明确指向 Muse 自身队列，而非提供方容量；其他错误码保留原有输出。批量 start 返回按输入顺序排列的 `items`，每条是带 `input` 的单文件结果，或使批次停止的 `{input, error}`，另附 `not_started` 和一个共用的 `polling_note`；任一条目为 `queue_full` 时，队列提示只出现一次。`inspect` 查询从未受理的任务时返回 `job-not-found`、`status` 调用参数和不要删除收据的提示。媒体字节、账号 cookie、对象 URL 和提供方凭据不进入参数或结果；工具调用及返回路径仍属于 Session 数据。

#### Token 影响

可选用途枚举、`inputs` 参数和描述中关于批次的一句话增加有限的请求开销；每次结果增加简短状态、收据已有的用途和本地路径；完成回读另附固定大小的说话人计数与提示，队列拒绝另增加一句解释。批次结果为每个已处理文件返回一条结果，`not_started` 只列出未处理路径，并只附一条提示而非逐条附带，总量受 `maxBatchInputs` 限制。展示批次分支的结果类型（如 PTC 提示）会在 `items` 内再列出一次结果字段。

#### KV Cache 影响

工具结果追加，不改写已有消息；描述和 schema（包括 `inputs` 与批次结果分支）属于可复用的请求前缀，改动它们会改变该前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 云端识别要求已登录 Muse 账号，且服务器已部署并配置 ASR。工具不抓取网页链接；原始媒体必须在本地可读。
- 无语音时不生成原始转写。提供方时间戳与识别内容仍须人工核对，离线模型不会自动回退启用。
- 远端任务超过留存时间仍未解决时，网关删除临时音频；下一次 `status` 删除本地暂存音频，但保留收据和原任务 ID 供只读对账。
- 一次批量调用的时长约等于其中所有上传之和，返回前不报告进度。
- 同一账号的并发调用者会争用网关的待上传数量上限，每次重试都是一次新的上传请求，计入每分钟请求上限。
- 暂存音轨已过期或收据已记录受理服务时，`inspect` 以错误报告 `job-not-found`，不提供恢复调用。

<a id="dev-note"></a>
### 开发备注

修改收据恢复或响应校验前，应运行聚焦 runner 与账号客户端测试。`services/muse-accounts` 的网关测试用替身覆盖账号隔离、限额和状态不明的提供方提交，不产生真实计费调用。

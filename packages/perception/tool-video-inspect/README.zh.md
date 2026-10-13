---
description: "通过 Session 文件系统与持久图片附件检查本地视频元数据和带时间码的画面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-video-inspect

[English](README.md) | 中文

## 概述

`video_inspect` 探测本地视频，或向支持图片的模型返回数量受限的解码画面。`video_ocr` 在 Windows 本地对有界批次画面识别可见文字，不调用模型或云端语音服务。两者都保留源显示时间码和版本证据。

## 目录

- [使用此包](#use-this-package)
- [执行与存储](#execution-and-storage)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

挂载函数插件，并提供 `tools`、`fs`、`subprocess`、`attachments` 和 `sandboxPolicy`。将 `ffmpegPath`、`ffprobePath` 配置为与文件系统同执行环境的程序。抽帧要求当前准确模型明确声明图片输入；`metadata` 不需要图片输入。两种操作都不会自行调用模型或语音供应商。

```json
{"file_path":"source/episode-01.mp4","method":"sample","start_seconds":0,"end_seconds":60,"frame_count":6,"manifest_path":"qa/video-01.json"}
```

均匀采样选择等长区间的中间点。`timestamps_seconds` 可指定源文件中的具体时刻。每次默认最多 12 帧、覆盖 120 秒区间；默认区间最多 60 秒。源文件还有剩余区间时，`next_start_seconds` 指明下一个区间。画面可见或内嵌文字使用 `video_ocr`；语音对白另用现有 `audio_transcribe` 工具，并遵守其账号与计费要求。

`video_ocr` 对请求的视频区间抽样，每批把数量和大小受限的 JPEG 交给一个 Windows OCR bridge 进程，并在工作区创建原始 JSON 证据和带时间码的合并 TXT。原始证据保留每行文字、词框、源时间码、扫描范围和保守分类。长时间、位置稳定且完全相同的文字可以标记为 `persistent_text_candidate`，这只表示视觉重复，不表示该文字不是剧情。两类文字都保留为内容候选并计入 `segment_count`，绝不静默删除；同一时间的多行文字保留 OCR 阅读顺序。

```json
{"file_path":"source/episode-01.mp4","start_seconds":0,"end_seconds":120,"frame_interval_seconds":0.5,"language":"zh-Hans-CN","raw_json_path":"transcript/raw/episode-01-ocr.json","merged_text_path":"transcript/raw/episode-01-ocr.txt"}
```

`scan_status` 区分 `complete`、`partial` 和 `failed`。只有该次调用的全部计划采样都处理成功时才可能返回 `text_status=no_text_detected`，但抽样 OCR 仍不能证明视频绝对没有字幕。`next_start_seconds`、未扫描范围和失败时间点会明确暴露覆盖缺口。指定的 Windows 语言缺失、解码失败或超时保持 `indeterminate`；本工具没有 ASR 回退能力，也不能授权或计费云端请求。部署可配置语言、采样间隔边界、范围/帧数/批次限制、图片与 JSON 字节限制、超时和文字重复判定阈值。识别进程失败会停止后续批次，不重复启动不可用的引擎。运行时不会安装 OCR 语言包。在 macOS 等不支持的平台上，说明实际能力并复用已提供的字幕或转写。只有另有明确覆盖本素材、用途和扣费的授权时，调用方才可沿现有 ASR 计费与收据流程继续；OCR 失败不会授权新的付费调用，也不能把 ASR 来源写成 OCR。

`strategy=scene_dialogue` 在实际 FFmpeg 镜头切换的前后选帧；`transcript_path` 指向同一完整视频的 `audio_transcribe` JSON 时，也取发声片段中点。说话人编号用于区分识别任务中的声音，不能直接当作人物姓名。调用方必须使用相同完整视频的转写，时间范围校验本身不能确认这种关联。`sampling_plan.selected` 解释本次返回的观察点，`sampling_plan.deferred` 列出未查看的时间点；后续通过 `timestamps_seconds` 分批复看，并在行动或人物归属不明处缩小区间。切镜检测可能漏掉渐变转场。

部署可配置 `sceneThreshold`（默认 0.25）、`scenePaddingSeconds`（0.12）、`maxPlanPoints`（1000）和 `maxTranscriptBytes`（2097152）。候选点超过预算时拒绝调用并提示缩短区间，不隐藏事件。没有转写也能按镜头切换抽帧；读取或抽帧期间转写发生变更时停止发布。

创作部署可启用 `trustedEvidence`（默认 false）。真实 `metadata` 调用随后返回 `window_plan`，将实际探测的完整时长划分为连续窗口，每窗不超过 `min(60, maxRangeSeconds)`。可信抽帧要求先成功探测同一当前视频的元数据。计划窗口仍未查看，只有后续成功抽帧调用返回真实画面后才有采样依据；可用窄区间复看冲突、起因、结果、集尾和疑点。切镜与 ASR 时间码只提供候选时刻，不识别故事含义。

<a id="execution-and-storage"></a>

`video_contact_sheet` 返回带时间标签的视频概览图，默认3列3行九宫格，`columns: 3, rows: 2` 为六宫格。按从左到右、从上到下的源时间顺序排列；`frame_count` 可跨多页，`timestamps_seconds` 指定具体时刻，或用 `frame_interval_seconds` 按间隔取帧且不同时指定帧数。`strategy: scene` 优先查看检测到的切点两侧。清单保留原始抽帧引用；疑点先对当前来源成功调用 `video_inspect method=metadata`，再于包含该时刻的有界区间抽帧查看大图。本次仅返回概览页图像，宫格不会签发受信任的视频检查凭据。

概览配置为 `contactColumns`、`contactRows`（默认均为3）、`contactTileWidth`（320像素）、`maxContactFrames`（32帧）、`maxContactRangeSeconds`（300秒）、`maxContactPixels`（每页16,000,000像素）和 `maxContactBytes`（全部页合计8MiB）。单格保持源比例，标签使用实际解码时间。还须满足图片存储的尺寸限制。超大布局、冲突的采样参数、源文件变化和已有清单均报错，不静默丢帧；长视频按 `next_start_seconds` 继续查看。人物或动作的细节验收不能只用缩略图。
## 执行与存储

读取经由 `ctx.fs`；探测和解码经由 `ctx.subprocess`，遵守当前 Session 文件策略。受限执行要求有可用沙箱提供方。FFmpeg 只接受本地文件与管道协议。源文件大小、编码画面面积（`maxSourcePixels`，默认 33,177,600）、时长、画面尺寸、完整图像字节数、进程超时和同时检查数量均可按部署配置。每条命令都等待进程范围退出，包括取消和失败。卸载插件会取消并等待其活动检查。

在 Windows 上，随包 `scripts/ocr_bridge.ps1` 通过 stdin 接收有界的 base64 JPEG JSON。每批只创建一个 Windows OCR 引擎，并通过 stdout 返回有界 JSON；不使用可预测的临时图片、shell 字符串拼接、网络访问或运行时安装。固定的随包脚本使用仅限当前进程的 `ExecutionPolicy Bypass`，应用不会改变机器或用户策略。明确指定的识别语言不可用时失败关闭。源文件变化会中止发布；输出路径必须互不相同且位于工作区内，已有文件不覆盖。

画面先进入规范化附件存储，再作为图片块返回。清单在当前工作区创建，不覆盖已有文件，之后回读核对。源文件版本发生变化时中止发布。原视频保持不变；结果不包含远程媒体链接或账号凭证。清单与附件各有唯一的存储所有者，因此不发布 invariant 配套模块。


自适应抽帧在输出切镜元数据前按所选来源时间区间裁定解码帧，并按返回帧数预算划分区间，在每个时段内优先选择切镜、再选择发声片段。开头密集切镜不会占满整次概览；其余观察点仍保留为待复看，概览不代表连续观看。

仅供 Host 使用的 `resolveTrustedVideoEvidence` 导出函数将导入清单与当前注册的真实执行记录匹配。它要求规范工具输出未变、各层外部执行成功、工具结果已提交，以及后续完成且支持图片的 AgentLoop 请求在供应商投影后保留全部返回图片。凭据绑定视频路径与文件系统版本、探测时长、元数据计划、实际采样区间、请求时刻、解码时间戳、附件、清单原字节摘要、投影后模型输入摘要与 Session 事件引用。`verified_readback` 仅说明清单回读一致；模型自填 JSON 不能签发凭据。单份凭据不表示全部计划窗口已抽帧。

未保存 Host 签发凭据的观察需要当前注册的真实证据；卸载或重启后须重新检查。Host 可在整集验收前或后向同一函数提供已保存的观察凭据，无需当前 Session。恢复通过 `sessionQuery` 读取原 Session，核对真实视频工具结果与成功的执行链，重建后续模型实际包含图片的输入，再检查当前源版本、清单与附件。它不重跑媒体命令或模型。原日志缺失或文件变化会阻断恢复。凭据依赖可信的 Host Session 存储，不是抵抗管理员修改该存储的签名。导出的 `TRUSTED_VIDEO_INSPECTION_RECEIPT` 解析器只校验文件字段；解析成功本身不建立可信性。

<a id="model-experience"></a>
## 模型体验

### `video_inspect` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-video-inspect) 记录参数。结果追加精简元数据、清单路径、采样区间、适用时的下一区间，以及前置源时间码的真实图片块。结果明确写出“These are sampled frames, not continuous viewing. Audio has not been transcribed.” 通用持久工具卡展示调用及元数据。

#### Token 影响

工具参数定义增加固定请求开销。结果增加受限文字及最多配置数量的图片输入；图片计费与请求缩放归选定供应商所有。完整视频字节不会进入模型上下文。 显式启用的元数据计划为每个窗口增加一条区间。Host 证据核验与已验收记录恢复不新增模型请求或模型可见上下文。

#### KV Cache 影响

工具结果追加，不改写之前的消息。参数定义或描述改变会改变可复用的请求前缀；画面附件在后续请求中增加视觉输入，直到常规图片卸载策略生效。

### `video_ocr` 工具

#### 模型看到什么

模型只收到精简且带来源标记的摘要：源版本、请求与实际扫描区间、扫描和文字状态、覆盖计数与范围、数量受限的片段预览，以及完整原始 JSON 和合并 TXT 路径。完整词框和所有片段保留在文件中，不膨胀每次工具结果。本工具不会把 OCR 与 ASR 来源混合。

#### Token 影响

参数定义增加固定请求开销。结果只增加受 `ocrPreviewSegments` 控制的有界文本；帧字节和原始 OCR JSON 不进入模型上下文。长视频继续扫描需要更多工具调用，但每次都提供明确续扫点，内部不增加模型轮次或 ASR 请求。

#### KV Cache 影响

结果追加，不改写之前的消息。固定参数定义会改变可复用请求前缀；只有调用方主动读取证据文件时，其内容才进入上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 采样可能漏掉短暂动作、转场和口型变化。需要检查有疑点的时间码和后续区间；采样不证明全片已覆盖。
- 抽样 OCR 可能漏掉短时、艺术字、移动或低对比度字幕。即使 `complete` 且 `no_text_detected`，也只描述计划采样，不能数学证明视频没有字幕；面向用户的流程必须显式决定是否回退。
- Windows OCR 的质量与语言支持取决于本机已安装的识别器。本包会报告语言或引擎缺失，不负责安装。
- 画面观察不能证明对白、说话人归属或声线一致。语音转写与人工听辨是独立步骤。
- 解码支持取决于安装的 FFmpeg。工具不获取网页链接、不使用供应商原生视频输入，也不自动识别人物。
- 后轮图片输入凭据要求全部目标帧仍可见，不计已卸载的图片。它仅证明采样图片送达，不证明注意力、故事理解、艺术质量或连续观看。故事覆盖、未解关键问题与语义判断仍由调用方负责。
- 证据恢复要求原模型路由及其支持图片的投影仍可用。助手带有其他供应商的私有回放状态，而此处不能重建适配器专属投影时，不签发凭据；此类供应商切换须使用新 Session。

<a id="dev-note"></a>
### 开发备注

聚焦测试使用原创合成 FFmpeg 素材、真实 PTC 执行、文件系统读取、规范化附件与无密钥脚本模型，检查实际请求中的图片块，并覆盖注册丢失与已验收记录的日志恢复。记录 Session 场景通过正式 profile 加载插件，只替换确定性的媒体进程输出。

`frameFormat` 可选 `png`（默认）或 `jpeg`；`frameJpegQuality` 指定 FFmpeg JPEG 量化值，范围 1–31（默认 2，PNG 忽略）。创作模式使用 JPEG，每次默认返回四帧，降低请求上传体积并保留源时间戳。画面尺寸应足以辨认字幕和人物；编码完成不代表模型已观察画面。

OCR 单元测试无需识别器即可覆盖多语言证据、MJPEG 边界、严格水印标记和部分覆盖。Windows 组合测试使用真实 FFmpeg 抽帧，只对 OCR bridge 输出使用确定性进程内替身。随包 PowerShell bridge 和已安装语言行为仍需在 Windows 打包验收中确认。

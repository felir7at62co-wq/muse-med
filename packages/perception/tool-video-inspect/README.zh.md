---
description: "通过 Session 文件系统与持久图片附件检查本地视频元数据和带时间码的画面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-video-inspect

[English](README.md) | 中文

## 概述

`video_inspect` 探测本地视频，或向支持图片的模型返回数量受限的解码画面。`video_ocr` 在本地对有界批次画面识别可见文字，不调用模型或云端语音服务。两者都保留源显示时间码和版本证据。

## 目录

- [使用此包](#use-this-package)
- [执行与存储](#execution-and-storage)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Muse 启用 `requireCompleteReview`。该部署中的 `video_inspect` 使用 `scan`、`next`、`revisit`、`observe`、`events`、`status`、`metadata`、`timeline` 和 `compare`，模型不能指定取样数量或扫描范围。`scan` 分块扫描整集：切镜评分检查全部解码缩略帧，另一条低帧率 RGB 通道检测累计画面变化并补充连续性观察点。每个检测切点按解码帧序号保留变化发生的那一帧，并保留前后画面，避免时间码取整后抽到相邻帧。分析滤镜在输出元数据或 RGB 字节前按分段时间限制筛选，保留边界帧以衔接切镜，排除解码预读的后续帧。全部候选进入该集清单；超过预算时报错，不截取部分候选冒充完整结果。检测灵敏度、扫描频率、资源预算和批大小由产品配置管理。图像预算拒绝需要卸载尚未查看的画面输入时，后续批次缩小到剩余待查看帧数，最少一张；仅卸载已查看或无关历史图片时，批大小保持不变。现有卸载机制继续恢复请求；被卸载而未呈现的图片不计为已查看。这些是画面变化候选，不是语义主体识别。

`next` 将首批未记录画面作为真实图片返回。每张图片抽取完成后，先保存附件引用再处理下一张；后续抽取失败时复用已保存的图片。每张图片的具名附件须进入成功的图像模型请求，并由 `observe` 记录具体可见内容、变化和疑点，才算完成。有实际疑点的记录会补入一轮邻近画面；`无。`、`无疑点`、`none`、`n/a` 等完整空标记不触发补帧，原记录文字保留。仍无法确认的内容保留为未知，不猜测。全部完成后在 `.muse/video-observations` 写出带版本的完整 JSON 报告，并返回 `observation_report`，供上下文压缩后的写稿阶段检索早期观察。状态响应最多列一批；`total`、`recorded`、`pending` 和 `frames_not_shown` 对应完整清单。增量 `video/review` 会话事件让进度在重载或上下文压缩后恢复；源文件变化后须重扫。在所属会话仍有未完成的整集扫描或逐图观察时，拒绝 `screenplay_export_docx` 和 `present`，中间稿仍可保存。其他会话和仅查元数据的调用不继承该限制。该要求不批准创作质量，也不证明模型认真理解了图片；普通 shell／文件访问不属于这些交付工具检查的范围。

`revisit` 接收当前批上限以内、不重复的已记录 `frame_ids`，将原缓存图片附件与原观察并列返回，标记 `revisited: true`；即使已有观察，渲染器也重新展示这些原图。工具校验缓存附件和当前视频版本，不运行 FFmpeg、不替换图片、不重置已呈现状态或观察、不新增待看事项，也不写观察报告。缓存缺失或不可读明确报错，不触发重新抽帧。显式或已保存 ASR 关联保持原有行为；完整结果通过字节上限检查后，新的显式关联仅可更新对应引用。重看不替代整集扫描。

`events` 可选地替换当前视频版本的完整 `event_groups` 表；空数组可清空。每个模型填写的事件引用实际已记录的 `frame_ids`，保留人物、动作、对象、前后状态及疑点。多帧可支持一个事件，不规定事件或动作行数量。Host 从引用帧导出采样时间与观察摘要，不确认动作含义或精确起点。可选事件表通过现有 `video/review` 事件持久化；旧记录无需该字段仍可读取。引用的观察发生变化后，比较结果将其 `evidence_current` 标为 false，直至重新整理。每个返回事件旁的 `evidence` 列出当前引用帧的原始观察，标为 `model_authored_observations`，即使这些帧不在常规批次中也就近展示，以便直接对照事件概括；不验证两者含义。完成后的观察报告包含事件表，并使用对应内容的文件名。ASR 路径以相对视频目录的位置参与摘要，使等价工作区副本保持稳定；报告正文仍保留实际规范路径，已有报告不变。

任何方法均可附带 `transcript_path`，读取 `audio_transcribe` 保存的完整 JSON：秒制片段数组、`{segments:[...]}`，或毫秒制原生 `{result:{utterances:[...]}}`。结果保留全部原始行、原话、时间、声学编号、文件版本和 SHA-256。相邻同号段列为 `continuous_speech_candidates`，保留每段及间隔；不自动合并或去重，未知声组不归并。每段及候选均标记 `speaker_identity_unverified`：同人可能换号、同号可能混人、一段可能包含多人。时间检查以当前视频为准，但时间范围相符不证明文件同源。ASR 输入受 `maxTranscriptBytes` 限制，完整合并结果受 `reviewCompareMaxBytes` 限制。显式成功读取后，在当前视频版本中保存仅含路径、版本和 SHA-256 的可选 `transcript_reference`；后续调用无需重复给路径，安全回读同一引用，不搜索替代文件。隐式回读遇到缺失、变化、不可读或超限时返回 `speech_unavailable`，画面事件与正文对照仍可继续；完整 ASR 导致合并结果超限时也降为不可用诊断，不静默截断。可显式提供路径刷新关联；显式路径校验失败仍报错。新视频版本不继承旧引用。成功读取也登记版本以供受版本保护的编辑使用。本操作不提交语音识别，不产生供应商费用。

普通 `scan`、`observe` 和状态结果自动带回精简的 `source_timeline_index`，列出时间窗、实际已记录／待记录数量和已关联 ASR 段引用，不重复观察正文，也不新增语义结论。完整结果无法容纳详细索引时，在预算允许的情况下返回精简的预算说明；索引不使原本有效的观察失败。

`timeline` 返回 `source_timeline`：按源版本划分的时间窗并列画面 ID 与模型观察、可选事件笔记、原始重叠 ASR 段及连续发言候选引用。`reviewTimelineWindowSeconds` 默认 10 秒，仅控制材料归组，不代表场景或动作分界。可选的 `timeline_start_seconds` 和 `timeline_end_seconds` 只选择核对材料，不减少扫描或观察要求。局部结果标明范围，保留疑点，并明确列出尚未记录的帧；连续发言跨越请求范围时仍保留完整原段上下文。材料 SHA-256 随来源、观察、事件、ASR 或所选范围变化。读取时间线不创造动作、不批准含义，完整输出受 `reviewCompareMaxBytes` 限制。

`compare` 接收本集已保存的 UTF-8 `draft_path`，返回经版本核对的文件摘要和完整带行号正文，以及全部已记录画面、可选事件表和提供的 ASR。每个事件列出时间重叠的 ASR 段 ID 和正文的字面命中候选行，注明命中字段；字面命中不等于语义覆盖，未命中也不证明事件遗漏。尚未归组的已记录帧 ID 明确保留。这些可选材料连接独立动作行、对白括注、无对白反应、道具状态和实际转场，不判断其含义。待查看画面仍然待查看；不写文件、不标记动作已采用、不要求交付前调用，也不增加审批。`reviewCompareMaxBytes` 默认 262144 个 UTF-8 字节，同时限制正文输入和完整序列化结果；超限明确报错，不返回部分材料。视频或正文在读取期间变化时，本次对照失败；成功后为普通受版本保护的编辑登记已读取的正文版本。

未启用 `requireCompleteReview` 时，下文的有界抽帧和概览接口保持原有行为。完整观察另需 `sessionProjections` 和 `llm` 服务。操作见 [Muse 迁移指南](../../../docs/upgrade-guide/v0.2.1-alpha.1/muse-video-observation/guide.zh.md)。

挂载函数插件，并提供 `tools`、`fs`、`subprocess`、`attachments` 和 `sandboxPolicy`。将 `ffmpegPath`、`ffprobePath` 配置为与文件系统同执行环境的程序。抽帧要求当前准确模型明确声明图片输入；`metadata` 不需要图片输入。两种操作都不会自行调用模型或语音供应商。

```json
{"file_path":"source/episode-01.mp4","method":"sample","start_seconds":0,"end_seconds":60,"frame_count":6,"manifest_path":"qa/video-01.json"}
```

均匀采样选择等长区间的中间点。`timestamps_seconds` 可指定源文件中的具体时刻。每次默认最多 12 帧、覆盖 120 秒区间；默认区间最多 60 秒。源文件还有剩余区间时，`next_start_seconds` 指明下一个区间。画面可见或内嵌文字使用 `video_ocr`；语音对白另用现有 `audio_transcribe` 工具，并遵守其账号与计费要求。

视频流和容器都明确从零开始且视频流时长有效、大于零时，OCR 按视频流时长规划抽帧；其他情况使用容器时长。这避免音轨稍长时在视频终点请求不存在的画面。普通视频检查元数据、宫格和 ASR 范围校验仍使用容器时长；请求区间内真正失败的采样仍表示覆盖不完整。

`video_ocr` 对请求的视频区间抽样，每批把数量和大小受限的 JPEG 交给一个已配置的本地 OCR bridge 进程，并在工作区创建原始 JSON 证据和带时间码的合并 TXT。每批抽帧先限制滤镜输出，再记录时间戳，诊断仅对应本批实际编码的画面。原始证据保留每行文字、可用的词框、源时间码、扫描范围和保守分类。长时间、位置稳定且完全相同的文字可以标记为 `persistent_text_candidate`，这只表示视觉重复，不表示该文字不是剧情。两类文字都保留为内容候选并计入 `segment_count`，绝不静默删除；同一时间的多行文字保留 OCR 阅读顺序。

```json
{"file_path":"source/episode-01.mp4","start_seconds":0,"end_seconds":120,"frame_interval_seconds":0.5,"language":"zh-Hans-CN","raw_json_path":"transcript/raw/episode-01-ocr.json","merged_text_path":"transcript/raw/episode-01-ocr.txt"}
```

`scan_status` 区分 `complete`、`partial` 和 `failed`。只有该次调用的全部计划采样都处理成功时才可能返回 `text_status=no_text_detected`，但抽样 OCR 仍不能证明视频绝对没有字幕。`next_start_seconds`、未扫描范围和失败时间点会明确暴露覆盖缺口。指定的 Windows 语言缺失、解码失败或超时保持 `indeterminate`；本工具没有 ASR 回退能力，也不能授权或计费云端请求。部署可配置语言、采样间隔边界、范围/帧数/批次限制、图片与 JSON 字节限制、超时和文字重复判定阈值。识别进程失败会停止后续批次，不重复启动不可用的引擎。运行时不会安装识别引擎、模型或语言包。包默认 `ocrEngine=windows-native` 使用 Windows 已安装的识别器；`ocrEngine=rapidocr` 使用 `ocrPythonPath` 和固定的 CPU 模型，可在 Windows、macOS、Linux 运行，线程由 `ocrCpuThreads` 配置（默认 2）。Muse 桌面端从内置解释器启用 RapidOCR；其中英文模型接受 `auto`、`zh-Hans-CN`、`en-US`，`zh-Hant-TW` 明确失败，不静默换引擎。运行环境或模型缺失也明确失败。只有另有明确覆盖本素材、用途和扣费的授权时，调用方才可沿现有 ASR 计费与收据流程继续；OCR 失败不会授权新的付费调用，也不能把 ASR 来源写成 OCR。

`strategy=scene_dialogue` 在实际 FFmpeg 镜头切换的前后选帧；`transcript_path` 指向同一完整视频的 `audio_transcribe` JSON 时，也取发声片段中点。说话人编号用于区分识别任务中的声音，不能直接当作人物姓名。调用方必须使用相同完整视频的转写，时间范围校验本身不能确认这种关联。`sampling_plan.selected` 解释本次返回的观察点，`sampling_plan.deferred` 列出未查看的时间点。选中的发声观察点保留原始 ASR 的 `start`、`end`、可选 `speaker_id`、受限 `text` 预览及 `text_truncated`；选中时间重合的片段分别保留；待查看点只返回时间与原因，完整语音文本仍在原始 ASR JSON，帮助按发声时段核对画面，不推断人物姓名或声线一致性；后续通过 `timestamps_seconds` 分批复看，并在行动或人物归属不明处缩小区间。切镜检测可能漏掉渐变转场。

部署可配置 `sceneThreshold`（默认 0.25）、`scenePaddingSeconds`（0.12）、`maxPlanPoints`（1000）、`maxTranscriptBytes`（2097152）和 `utterancePreviewCharacters`（80 个可见 Unicode 字符）。候选点超过预算时拒绝调用并提示缩短区间，不隐藏事件。没有转写也能按镜头切换抽帧；读取或抽帧期间转写发生变更时停止发布。

创作部署可启用 `trustedEvidence`（默认 false）。真实 `metadata` 调用随后返回 `window_plan`，将实际探测的完整时长划分为连续窗口，每窗不超过 `min(60, maxRangeSeconds)`。可信抽帧要求先成功探测同一当前视频的元数据。计划窗口仍未查看，只有后续成功抽帧调用返回真实画面后才有采样依据；可用窄区间复看冲突、起因、结果、集尾和疑点。切镜与 ASR 时间码只提供候选时刻，不识别故事含义。

<a id="execution-and-storage"></a>

`video_contact_sheet` 返回带时间标签的视频概览图，默认3列3行九宫格，`columns: 3, rows: 2` 为六宫格。按从左到右、从上到下的源时间顺序排列；`frame_count` 可跨多页，`timestamps_seconds` 指定具体时刻，或用 `frame_interval_seconds` 按间隔取帧且不同时指定帧数。`strategy: scene` 优先查看检测到的切点两侧，在结果和清单中保留 `sampling_plan.selected` 与全部尚未查看的 `sampling_plan.deferred` 候选。清单保留原始抽帧引用；疑点先对当前来源成功调用 `video_inspect method=metadata`，再于包含该时刻的有界区间抽帧查看大图。本次仅返回概览页图像，宫格不会签发受信任的视频检查凭据。

概览配置为 `contactColumns`、`contactRows`（默认均为3）、`contactTileWidth`（320像素）、`maxContactFrames`（32帧）、`maxContactRangeSeconds`（300秒）、`maxContactPixels`（每页16,000,000像素）和 `maxContactBytes`（全部页合计8MiB）。单格保持源比例，标签使用实际解码时间。还须满足图片存储的尺寸限制。超大布局、冲突的采样参数、源文件变化和已有清单均报错，不静默丢帧；长视频按 `next_start_seconds` 继续查看。人物或动作的细节验收不能只用缩略图。
## 执行与存储

读取经由 `ctx.fs`；探测和解码经由 `ctx.subprocess`，遵守当前 Session 文件策略。受限执行要求有可用沙箱提供方。FFmpeg 只接受本地文件与管道协议。源文件大小、编码画面面积（`maxSourcePixels`，默认 33,177,600）、时长、画面尺寸、完整图像字节数、进程超时和同时检查数量均可按部署配置。每条命令都等待进程范围退出，包括取消和失败。卸载插件会取消并等待其活动检查。

选择 `windows-native` 时，随包 `scripts/ocr_bridge.ps1` 通过 stdin 接收有界的 base64 JPEG JSON。每批只创建一个 Windows OCR 引擎，并通过 stdout 返回有界 JSON；不使用可预测的临时图片、shell 字符串拼接、网络访问或运行时安装。固定的随包脚本使用仅限当前进程的 `ExecutionPolicy Bypass`，应用不会改变机器或用户策略。明确指定的识别语言不可用时失败关闭。源文件变化会中止发布；输出路径必须互不相同且位于工作区内，已有文件不覆盖。

选择 `rapidocr` 时，随包 `scripts/ocr_bridge.py` 在 CPU 识别前核对 RapidOCR 3.10.0、ONNX Runtime 1.23.2 及三个模型的 SHA-256。解释器以隔离的 UTF-8 模式读写 JSON，不受 Windows 代码页影响。模型随固定 wheel 提供，通过明确路径加载，识别时不下载。该模型没有逐词位置，返回行框及空的词数组，不编造词框。输入输出限制、取消、源版本检查和文件发布与 Windows 引擎共用。

画面先进入规范化附件存储，再作为图片块返回。清单在当前工作区创建，不覆盖已有文件，之后回读核对。源文件版本发生变化时中止发布。原视频保持不变；结果不包含远程媒体链接或账号凭证。清单与附件各有唯一的存储所有者，因此不发布 invariant 配套模块。

Host 消费方可用 `videoReviewSummaries` 读取当前已记录的视频身份与显式 ASR 引用，再以明确的来源区间和字节／图片预算调用 `readVideoSourceTimeline`。请求的已记录 `frameIds` 从附件缓存读取，以真实图片块与时间线一同返回；省略 ID 时仅返回文字。该读取校验视频版本与缓存图片，不可用的可选 ASR 返回诊断，不另选来源、不抽帧、不修改观察进度。缓存缺失、源版本变化、无效帧选择和完整结果超限仅使本次证据读取失败，不新增交付条件。消费方须将返回块接入普通有日志的上下文或工具结果路径。`buildVideoSourceTimeline` 对已读取材料提供同一纯归组逻辑。


自适应抽帧在输出切镜元数据前按所选来源时间区间裁定解码帧，并按返回帧数预算划分区间，在每个时段内优先选择切镜、再选择发声片段。开头密集切镜不会占满整次概览；其余观察点仍保留为待复看，概览不代表连续观看。切镜只说明画面变化，须结合地点、时间和闪回标记判断是否换场；无对白段也可能转场，渐变可能不触发切镜检测。其余源时间区间沿 `next_start_seconds` 继续查看。

仅供 Host 使用的 `resolveTrustedVideoEvidence` 导出函数将导入清单与当前注册的真实执行记录匹配。它要求规范工具输出未变、各层外部执行成功、工具结果已提交，以及后续完成且支持图片的 AgentLoop 请求在供应商投影后保留全部返回图片。凭据绑定视频路径与文件系统版本、探测时长、元数据计划、实际采样区间、请求时刻、解码时间戳、附件、清单原字节摘要、投影后模型输入摘要与 Session 事件引用。`verified_readback` 仅说明清单回读一致；模型自填 JSON 不能签发凭据。单份凭据不表示全部计划窗口已抽帧。

未保存 Host 签发凭据的观察需要当前注册的真实证据；卸载或重启后须重新检查。Host 可在整集验收前或后向同一函数提供已保存的观察凭据，无需当前 Session。恢复通过 `sessionQuery` 读取原 Session，核对真实视频工具结果与成功的执行链，重建后续模型实际包含图片的输入，再检查当前源版本、清单与附件。它不重跑媒体命令或模型。原日志缺失或文件变化会阻断恢复。凭据依赖可信的 Host Session 存储，不是抵抗管理员修改该存储的签名。导出的 `TRUSTED_VIDEO_INSPECTION_RECEIPT` 解析器只校验文件字段；解析成功本身不建立可信性。

<a id="model-experience"></a>
## 模型体验

### `video_inspect` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-video-inspect) 记录参数。结果追加精简元数据、清单路径、采样区间、适用时的下一区间，以及前置源时间码的真实图片块。结果明确写出“These are sampled frames, not continuous viewing. Audio has not been transcribed.” 通用持久工具卡展示调用及元数据。

#### Token 影响

工具参数定义增加固定请求开销。结果增加受限文字及最多配置数量的图片输入；图片计费与请求缩放归选定供应商所有。可选 ASR 读取保留完整原始段，对照保留完整正文，受完整结果的配置字节上限约束；后续调用会回读已关联转写，仍受完整结果上限约束；原始段增加每次结果的文字量，不可用诊断不包含替代台词。事件归组、时间线读取和对照均不调用模型或语音服务。Host 返回的缓存图片最多按消费方确定的图片预算进入下一次有日志的请求。完整视频字节不会进入模型上下文。显式启用的元数据计划为每个窗口增加一条区间。Host 证据核验与已验收记录恢复不新增模型请求或模型可见上下文。

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
- 事件含义、连续发言归组和事件在正文中的覆盖，需要结合实际来源判断；工具只报告引用、时间重叠和字面候选，不执行语义审校。
- 解码支持取决于安装的 FFmpeg。工具不获取网页链接、不使用供应商原生视频输入，也不自动识别人物。
- 后轮图片输入凭据要求全部目标帧仍可见，不计已卸载的图片。它仅证明采样图片送达，不证明注意力、故事理解、艺术质量或连续观看。故事覆盖、未解关键问题与语义判断仍由调用方负责。
- 证据恢复要求原模型路由及其支持图片的投影仍可用。助手带有其他供应商的私有回放状态，而此处不能重建适配器专属投影时，不签发凭据；此类供应商切换须使用新 Session。

<a id="dev-note"></a>
### 开发备注

视频 EOF 比较夹具启动真实媒体进程，并沿用已配置的[测试和清理预算](../../../docs/testing.zh.md)。

聚焦测试使用原创合成 FFmpeg 素材、真实 PTC 执行、文件系统读取、规范化附件与无密钥脚本模型，检查实际请求中的图片块，并覆盖注册丢失与已验收记录的日志恢复。记录 Session 场景通过正式 profile 加载插件，只替换确定性的媒体进程输出。

`frameFormat` 可选 `png`（默认）或 `jpeg`；`frameJpegQuality` 指定 FFmpeg JPEG 量化值，范围 1–31（默认 2，PNG 忽略）。创作模式使用 JPEG，每次默认返回四帧，降低请求上传体积并保留源时间戳。画面尺寸应足以辨认字幕和人物；编码完成不代表模型已观察画面。

OCR 单元测试无需识别器即可覆盖多语言证据、MJPEG 边界、严格水印标记和部分覆盖。bridge 路径夹具使用本机绝对 file URL，并以本机分隔符精确比对 ASAR 展开、源码及已展开的完整路径。Windows 组合测试使用真实 FFmpeg 抽帧，只对 OCR bridge 输出使用确定性进程内替身。随包 PowerShell bridge 和已安装语言行为仍需在 Windows 打包验收中确认。

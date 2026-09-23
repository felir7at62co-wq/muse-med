---
description: "准备并渲染短剧整集、按每镜自己的音频测出字幕时间、检查成片，并按具体视频版本管理附带标签与原因的可撤销用户禁用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-episode-render

[English](README.md) | 中文

## Summary

无需手写 FFmpeg 命令，即可把选定镜头合成整集。`drama_render` 按说话的那一镜测出每条台词的时间，准备输入、按固定交付样式渲染并检查可测量的输出属性。`drama_video` 按具体视频版本记录可撤销的用户禁用，并查询标签与原因。禁用不要求审图证据；未禁用版本和技术检查成功都不代表内容审核通过。

## Table of Contents

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件作为短剧预设的一行挂载；它只需要工具注册表，以及 `PATH` 上的 `ffmpeg` 与 `ffprobe`：

```yaml
- id: tool-episode-render
  name: '@deepseek-ai/dsh-tool-episode-render'
  config:
    ffmpegPath: ffmpeg          # default
    ffprobePath: ffprobe        # default
    masterVolume: 1.45          # episode master gain, default
    bgmVolume: 0.24             # BGM gain, default
    preferNvenc: true           # probe h264_nvenc before each render, default
    fontsDir: 'C:/Windows/Fonts' # where libass finds SimHei, default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | 要启动的 ffmpeg 可执行文件 |
| `ffprobePath` | `ffprobe` | 要启动的 ffprobe 可执行文件 |
| `masterVolume` | `1.45` | 整集原声的增益，0–8 |
| `bgmVolume` | `0.24` | BGM 的增益，0–8 |
| `preferNvenc` | `true` | 是否探测 GPU 编码器 |
| `fontsDir` | `C:/Windows/Fonts` | libass 解析字幕字体所在目录 |
| `subtitleFontFamily` | `SimHei` | ASS 字幕字体族 |
| `watermarkFontFamily` | `Microsoft YaHei` | ASS 水印字体族 |

字体族是部署配置，不是模型工具参数。两者都必须是非空白字符串，不能包含逗号或换行；无效值会被 Config 校验拒绝。提供 Noto Sans CJK SC 的部署可将两者设为 `Noto Sans CJK SC`。这不会修改 `fontsDir` 或安装字体：libass 必须能访问所选字体族。正片与片尾拼接后统一烧录一份 ASS，因此片尾全程水印使用同一字体族。

### 可撤销的视频禁用

调用 `drama_video`，提供 `project`、`method: "ban"`、现有本地 `video` 和非空字符串列表 `labels`，例如 `["人物对调","字幕错误"]`；`reason` 可选。不要求审图证据。工具自行计算文件哈希：同字节副本共享决定，同路径重新生成的不同字节相互独立。`inspect` 查询一个决定，`list` 返回全部决定（含已解除项），`unban` 解除误标或撤回的禁用，不改源审核记录。旧文件已不存在时，`inspect` 与 `unban` 可以用列表返回的精确 `sha256` 代替 `video`，二者互斥。不要仅为让导出通过而解除禁用。

每个项目只保存一份 `video-bans.json`：`{version:1,videos:[{sha256,labels,reason,banned,updated_at,video}]}`。SHA256 使用小写，`video` 是标记时的绝对路径，`updated_at` 是 ISO 时间，未填原因保存为 `""`。解除后保留标签与原因，置 `banned:false`，绝不代表审核通过。写入复用 atomic-write 库的 `<file>.lock` 与同文件系统原子替换。JSON 损坏、版本不支持、哈希重复或行格式错误时拒绝继续；写入失败保留旧清单。遗留锁需要人工恢复，不会自动删除。

`prepare` 在探测前、复制前及复制后检查选定源字节。`render` 在媒体工作开始前检查当前准备源，使用编码缓存前检查其实际字节，并在持有清单写锁、发布暂存成片前复查本次实际消费的源哈希。中途禁用会保留旧成片。`verify` 从不删除文件：`video_bans` 报告直接禁用的输出，或对当前选源提示“当前选片含禁用素材，已有输出需复核”。没有不可变的输出来源记录时，`output_source_mapping` 保留在 `not_checked` 中，不宣称旧成片确实包含哪些版本。

### 四个渲染方法

| 方法 | 读取 | 写入 | 用途 |
|---|---|---|---|
| `subtitles` | 成片清单与逐镜台词计划 | `editing/<集>.srt` | 按每镜自己的音频给已写好的台词配时间，不做语音转写 |
| `prepare` | 成片清单与字幕 | `video/<集>/shot_00N.mp4`、`audio/<集>.wav`、`editing/<集>-timeline.json`、`editing/<集>.srt` | 构建渲染器要读的全部输入，不编码画面 |
| `render` | 时间线、已准备的镜头、整集原声、字幕、BGM、片尾音与片尾特效 | 成片 MP4 与 `exports/.render_cache/<集>/render.log` | 出片并回报实测参数 |
| `verify` | 成片、它的时间线与字幕 | 无 | 事后检查成片，或复查更早会话留下的成片 |

| 参数 | 必填 | 含义 |
|---|---|---|
| `method` | 总是 | `subtitles`、`prepare`、`render` 或 `verify` |
| `project` | 总是 | 项目根目录（含 `video/`、`audio/`、`editing/`、`exports/`） |
| `episode` | 总是 | 集号；所有路径都补成两位 |
| `shots` | `subtitles`、`prepare` | 成片清单：`{"shots":[{"shot":1,"video":"media/02/p1-clean.mp4","audio":"可选"}]}` |
| `lines` | `subtitles` | 逐镜台词计划：`{"shots":[{"shot":1,"lines":["第一句","第二句"]}]}`；每一项就是一条字幕，已按交付长度切好 |
| `alignment` | `subtitles` | 识别时间：`{"shots":[{"shot":1,"cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}`，镜内相对。只取时间，文本必须与剧本台词一致 |
| `timeline` | `render`、`verify` | 时间线 JSON，通常是 `prepare` 写出的那个 |
| `subtitle_srt` | `prepare`、`render`、`verify`（`subtitles` 可选） | 要写出、安装、烧录或检查的 SRT；`subtitles` 省略时写 `editing/<集>.srt` |
| `last_shot` | `render` | 本次交付覆盖到的最后一个镜头号；时间线里 `shot <= last_shot` 的镜头数必须正好等于它 |
| `bgm` | `render` | BGM，循环铺到正片结束 |
| `bgm_plan` | 可选，`render` | 现有 `episodes[].segments[]` 计划；返回声明的曲目来源、时间、理由、音轨哈希与同序复用集号，不代表试听通过 |
| `ending_audio` | `render` | 片尾音，延迟到正片结束处 |
| `ending_effect` | `render` | 叠在定格帧上的片尾特效视频 |
| `output` | `verify`（`render` 可选） | 成片文件；`render` 省略时写 `exports/<集>.mp4` |
| `force` | 可选 | `render` 忽略逐镜缓存、全部重编 |

工具调用使用上表的 snake_case 参数名；注册的执行入口将其映射为渲染器内部的 camelCase 参数。方法缺自己的必填参数时，在打开任何文件之前就失败。让渲染无法进行的一切——缺输入、命令失败、尾帧无法证明——都会抛错并给中文修法。成片自身的属性不抛错：它们作为检查项返回，所以一次调用既报清全部缺陷，也照常交回实测值。

### subtitles 做什么

`subtitles` 自己不识别，因为两半都是现成的：台词计划说明每一镜说什么，同一批成片的语音识别对齐说明什么时候说。它逐镜读对齐文档、与台词计划互相核对，字幕文字始终取剧本原文，每条 cue 夹在该镜范围内，再落到整集时钟上：cue 时间 = 该镜在时间线上的起点 + 镜内偏移。这里**不测能量**：能量只能说明有人在说话，说不出具体哪句落在哪里，而在某一段里估算切分正是字幕压错句的原因。

对齐文档里的识别文本**绝不写进字幕**：它只用来核对两份是不是同一段表演；文本或条数对不上按 `subtitle_line_coverage` failure 报出，而不是照抄一个数。

三类缺陷阻塞：声明了台词却没有这一镜的对齐；对齐里有识别结果而计划里没声明台词（说了话却没有字幕）；对齐的时间把 cue 落到该镜之外。写出的每条 cue 还会整集复核：空 cue、与上一条重叠、越出 `body_end`，以及要求超过 20 有效字/秒，都按 `subtitle_timing` failure 报出；超过 12 字/秒是 warning。SRT 仍照常写出，便于核对排了什么。

写出的文件是纯 SRT，`prepare` 安装、`render` 烧录之前，可以手工改某一条。

### prepare 写出什么

`prepare` 把每个源成片复制到 `video/<集>/shot_00N.mp4`，按 ffprobe **实测**时长（而不是声明时长）铺时间线，把每镜自己的声音按各自起点拼成整集原声（不加增益、不逐镜重采样，只做一次 48kHz 无损写入），并把字幕装到 `editing/<集>.srt`。它不编码画面。结束时刻超过整集画面的 cue 会作为警告报出。

准备成功后，`editing/<集>-sources.json` 记录 `{shots:[{shot,package?,video,audio,sha256}]}`，包含绝对源路径和准备后视频的 SHA-256。`package` 可选，必须显式指定 `episode_packages/<集>/package.json` 的 `video_tasks` 中从 1 开始的位置，绝不从 `shot` 推断。多个片段可映射到同一包。修改输入前移除旧选择记录，准备失败时不会留下声称完成的旧记录。来源选择证明复制了哪些字节，不代表内容审核通过。显式映射的行在分集包文件存在时还记录 `package_sha256`：整个文件字节的 SHA-256，覆盖其中的镜头内容。审核记录必须带有相同的实测哈希才算当前有效；分集包文件任何变化（包括格式变化）都会保守地使该集证据失效。包文件缺失时省略此字段，不阻断旧项目的准备操作。

逐镜编码缓存要求源字节哈希、可执行程序和完整编码参数（包括时长）一致。只有编码成功且输出非空才发布缓存身份；身份缺失或来源、设置变化时自动重编。`force` 仍可跳过复用。

可选 BGM 计划形如 `episodes:[{episode:"02",body_duration_seconds:12,segments:[{track:"name",source:"music.mp3",start_seconds:0,end_seconds:12,reason:"scene mood"}]}]`。正文时长必须与当前时间线一致，段落时间必须有效、按起点排序且不越界。留白、重叠、单曲和重复主题仍是创作选择。复用提示只比较同一计划内按顺序解析的来源路径，不折叠大小写、不做音频指纹。音轨哈希把声明关联到本次渲染输入，但不证明音轨确实含这些曲目或适合场景。

### 固定交付样式

| 元素 | 取值 |
|---|---|
| 画面 | 1440x2560@60，H.264 high@5.1，`yuv420p` |
| 码率控制 | 目标 24M、上限 30M、缓冲 48M、GOP 120 帧 |
| 总码率下限 | 成片整体 4.6 Mbps |
| 片尾 | 用最后一镜的真实尾帧定格 2.000 秒，叠 0.90 不透明度的片尾特效 |
| 字幕 | 配置的字体族、字号 68、字间距 -2、7px 黑描边、底部居中，另有右下角唯一的 `内容由AI生成` 标记 |
| 音频 | 整集原声 1.45、BGM 0.24 铺到正片结束、片尾音延迟到正片结束，`amix` 关闭归一化，`alimiter=0.95` |
| 容器 | AAC 192k / 48kHz，`+faststart` |

### 两个已知的坑

- **抽尾帧。** `-sseof -0.05` 在部分片子上会不写文件却返回 0，于是定格帧静默取错。本包固定用 `-sseof -0.1`，并且不轻信结果：抽出帧的 `framemd5` 必须等于顺序解码的最后一帧；不相等就按帧号重抽，仍不相等就停止渲染，绝不定格一张没验证过的帧。证据在 `tail_frame` 里返回。
- **GPU 编码。** 驱动过旧、缺 NVENC 构建、GPU 被占用，三种情况在探测上表现一致。探针编码一帧 256x256 的源（部分 NVIDIA 代次会拒绝更小的帧），失败就按设计回退 `libx264`，探测自身输出写进 `encoder_fallback_reason` 与渲染日志。

### 检查代码

`render` 跑五项交付检查，`verify` 跑表中全部检查，`subtitles` 跑它自己的两项。`ok` 仅表示已执行的 failure 级检查通过。`not_checked` 明确列出未测量的 QA，包括语音对齐、来源中不需要的内嵌字幕、内容审核与 BGM 试听。清除提供方残留字幕与最终按 SRT 烧录的设计字幕是不同事项，两者都不会禁用交付字幕样式。

| 代码 | 级别 | 通过条件 |
|---|---|---|
| `duration` | failure | 实测时长与「正片结束 + 片尾」相差不超过 0.15 秒 |
| `video_stream` | failure | 1440x2560 的 H.264 |
| `frame_rate` | failure | 帧率 60，误差 0.01 以内 |
| `audio_stream` | failure | 存在 AAC 48kHz 音轨 |
| `bitrate_floor` | failure | 总码率达到 4.6 Mbps |
| `black_frames` | failure | 没有达到 1.0 秒的黑场 |
| `fade_to_black` | warning | 没有达到 0.3 秒的黑场 |
| `silence` | failure | 没有达到 3.0 秒的静音 |
| `long_pauses` | warning | 没有达到 1.0 秒的静音 |
| `subtitle_bounds` | failure | 每条 cue 都落在 `0`–`body_end` 之内、也在文件时长之内 |
| `subtitle_present` | warning | 字幕至少有一条 cue |
| `subtitle_line_coverage` | failure | 每条声明台词都有它自己那一镜的对齐，且每一镜有识别结果就有声明台词 |
| `subtitle_timing` | failure | 仅 `subtitles`：每条 cue 非空、按序、在 `body_end` 之内，且不超过 20 有效字/秒 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内幕——点击展开</summary>

本节说明一次调用怎样执行、代码在哪里；可观察行为在[使用本包](#use-this-package)里已经写全。

### 设计取向

这个包建立在四条承诺上：

- **在产出交付物的地方执行交付样式。** 画面几何、码率控制、字幕样式、片尾与混音都是运营确认过的规格。它们是某一个模块里的常量，不是调用方可以漂移的参数；写文件的那一步就是检查它的那一步。
- **对产物报告，对障碍抛错。** 低于码率下限的成片是领域结果：运营仍需要这个文件，所以它带着 `ok: false` 与每个失败检查一行修法返回。缺输入或命令失败是环境问题：抛错，因为没有东西可以交回。
- **证明尾帧。** 片尾是事后唯一没人能逐帧检查的东西，所以它的来源是返回值而不是注释。每次都用顺序解码比对 `-sseof` 的结果，不一致就按帧号重抽，仍不行就拒绝出片。
- **只有一个可注入的进程边界。** 每个模块都拿一个 `MediaToolkit`，只有一个函数真正启动进程。整条流水线因此在测试里跑在桩通道上，而真通道由它自己的三个进程规格覆盖。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、参数解析、方法分发，以及 `drama_render` 的 schema 与描述 |
| [`src/delivery.ts`](src/delivery.ts) | 固定交付规格：画面几何、编码器参数、ASS 头与时间码、片尾滤镜、混音图 |
| [`src/ffmpeg.ts`](src/ffmpeg.ts) | 进程边界：spawn 通道、ffmpeg 与 ffprobe 包装、ffprobe 报告解析 |
| [`src/paths.ts`](src/paths.ts) | 一集的渲染输入与产物路径，以及把「缓存未命中」与「路径坏了」区分开的存在性检查 |
| [`src/timeline.ts`](src/timeline.ts) | 分集时间线的读取、校验、选取、铺排与序列化 |
| [`src/subtitles.ts`](src/subtitles.ts) | SRT 解析与写出，以及交付烧录用的 ASS 文档 |
| [`src/speech.ts`](src/speech.ts) | 读对齐文档并把台词落到整集时钟上，不做识别 |
| [`src/cues.ts`](src/cues.ts) | `subtitles`：台词计划、对齐文档与写出的 SRT |
| [`src/encoder.ts`](src/encoder.ts) | NVENC 探测，以及带原因记录的 CPU 回退 |
| [`src/ending.ts`](src/ending.ts) | 带 framemd5 证明的尾帧抽取，以及片尾片段 |
| [`src/prepare.ts`](src/prepare.ts) | `prepare`：成片清单、探测、复制出的布局与整集原声滤镜图 |
| [`src/render.ts`](src/render.ts) | `render`：编码流水线、拼接、烧录、混音与渲染日志 |
| [`src/verify.ts`](src/verify.ts) | `render` 共用的交付判定，以及 `verify` 的黑帧、静音与字幕越界检查 |
| [`src/report.ts`](src/report.ts) | canonical 结果：四个方法填同一套字段，没测到的留空值 |
| [`src/types.ts`](src/types.ts) | 只有类型：时间线、成片来源、实测事实与模型可见结果 |
| — | 不发布运行时不变式伴随包：本包在调用之间不保留状态，每个答案都是它所读文件与所启进程的函数。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页面。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-render)——模型实际收到的 `drama_render` schema 与描述。
- [Tools 子系统参考](../../../docs/subsystems/tools.zh.md)——参数 DSL、canonical 输出值与每次调用进入的流水线。
- [drama 组地图](../README.zh.md)——短剧流水线的同级包。

-----

<a id="model-experience"></a>
## 模型体验

### 渲染与视频决定工具 schema

#### 模型看到什么

请求中包含 `drama_render` 与 `drama_video`，参数及结果 schema 收录于生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-render)。渲染结果返回实测值、失败检查与未测量的 QA。视频决定结果返回标签、原因、当前禁用状态和 `review_status: "not_assessed"`；`list` 的顶层 `banned` 表示至少一个列出版本仍被禁用。两个工具都把结果呈现为格式化 JSON，不额外注册提示词。

#### Token 影响

渲染结果每镜一行 `clips`，最多十二项检查（包括可选禁用检查）。`drama_video` 增加固定 schema；`list` 结果随记录版本数逐行增长，其他方法只返回选定决定。九镜一集的渲染无论编码花多久都只返回九行 clip；通过的交付让 `failures` 为空、每个 `fix` 为空串。

#### KV Cache 影响

只追加。工具注册带稳定的名字、描述与 schema，挂载后请求前缀可复用；只有本包描述或 schema 变化才会让它失效。一次调用的结果作为那次调用自己的 tool result 追加，不改写任何更早的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包是什么、不是什么。它们是当前约束，不是任务清单。

- **ffmpeg 与 ffprobe 是外部依赖**——本包启动 `ffmpegPath` 与 `ffprobePath` 指向的任何东西。缺少 `libass`、`minterpolate` 或 `screen` 混合模式的构建会在需要它的那条命令上失败，而报告里只有那条命令的 stderr。
- **交付样式不可配置**——画面几何、帧率、码率控制、字幕布局、片尾长度与限幅器都是常量，因为它们是运营确认过的规格。只有可执行文件、两个增益、编码器偏好、字体目录与字体族是 `Config` 字段。
- **缓存与日志写入不是事务**——渲染失败可能留下中间文件，由下一次运行覆盖。最终 MP4 在同目录暂存，禁用检查后以 rename 发布；发布前失败会保留旧成片。
- **禁用不是全局媒体过滤器**——不拦截通用 FFmpeg 工具和任意外部转码。准备后的副本按实际 SHA256 检查；正式渲染以当前源哈希关联编码缓存。缺失或过期的映射不能证明任意转码文件的原始版本。
- **每次渲染都重建片尾**——尾帧会重新抽取并重新证明，片尾片段会重新编码，即使缓存里两者都在。证明正是重点，而缓存里的片尾可能早于一次重剪。
- **`prepare` 是复制而不是链接**——每个源成片都会复制进项目，九镜一集需要为审核过的成片留出双份空间。硬链接会在源文件被改写时立刻失效。
- **一次调用只处理一集**——`last_shot` 把一次渲染限定在它交付的正片镜头上，但一次调用从不渲染多集，也没有任何方法读取 `pipeline_state.json`。
- **混音不做电平表**——`normalize=0` 的 `amix` 精确保留运营给的增益，`alimiter=0.95` 是唯一的天花板。比被替换的 master 更响的素材仍可能在限幅器之前就削顶，而 `verify` 的静音检查发现不了。
- **字幕只检查不修正**——`verify` 报出越过 `body_end` 的 cue；没有任何东西去钳制它，因为一句字幕该在哪里结束是字幕作者的决定。
- **`subtitles` 信任识别给出的时间**——对齐文档决定每一句什么时候说；本包只核对它覆盖了每条声明台词、且文本就是剧本原文，判断不了识别本身有多准，所以 `speech_alignment` 一直留在 `not_checked`。对齐文档由调用方产出。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本 Dev Note 是给维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付行为、限制与已接受的取舍在上面各节、包代码与链接文档里。

本包是流水线 Python 渲染器（`tweet-drama-background-render/scripts/render_episode.py`）的移植。在会话迁移过去之前，Python 脚本仍是生产路径，所以过渡期两者并存。

移植后的行为在五处与 Python 不同，且都已记录：抽尾帧固定用 `-0.1` 而不是 `-0.05`，且每次抽取都与顺序解码比对证明；编码器探测失败会作为原因记录下来，而不是静默回退；ASS 的行尾统一成 `\n`，不随宿主平台；尾帧与片尾片段每次渲染都重建，不复用缓存；渲染日志是新文件，而 Python 的 `exports/render_tasks.json` 状态文件被刻意不写。

</details>

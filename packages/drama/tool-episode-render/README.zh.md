---
description: "准备并渲染短剧整集、按每镜自己的音频测出字幕时间、检查成片，并按具体视频版本管理附带标签与原因的可撤销用户禁用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-episode-render

[English](README.md) | 中文

## 概述

无需手写 FFmpeg 命令，即可把选定镜头合成整集。`drama_render` 按说话的那一镜测出每条台词的时间，准备输入、按明确媒介的交付样式渲染并检查可测量的输出属性。`drama_video` 按具体视频版本记录可撤销的用户禁用，并查询标签与原因。禁用不要求审图证据；未禁用版本和技术检查成功都不代表内容审核通过。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

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

字体族是部署配置，不是模型工具参数。两者都必须是非空白字符串，不能包含逗号或换行；无效值会被 Config 校验拒绝。提供 Noto Sans CJK SC 的部署可将两者设为 `Noto Sans CJK SC`。这不会修改 `fontsDir` 或安装字体：libass 必须能访问所选字体族。需要标记与片尾时，拼接后统一烧录一份 ASS，因此片尾全程使用同一水印字体族。

### 可撤销的视频禁用

调用 `drama_video`，提供 `project`、`method: "ban"`、现有本地 `video` 和非空字符串列表 `labels`，例如 `["人物对调","字幕错误"]`；`reason` 可选。不要求审图证据。工具自行计算文件哈希：同字节副本共享决定，同路径重新生成的不同字节相互独立。`inspect` 查询一个决定，`list` 返回全部决定（含已解除项），`unban` 解除误标或撤回的禁用，不改源审核记录。旧文件已不存在时，`inspect` 与 `unban` 可以用列表返回的精确 `sha256` 代替 `video`，二者互斥。不要仅为让导出通过而解除禁用。

每个项目只保存一份 `video-bans.json`：`{version:1,videos:[{sha256,labels,reason,banned,updated_at,video}]}`。SHA256 使用小写，`video` 是标记时的绝对路径，`updated_at` 是 ISO 时间，未填原因保存为 `""`。解除后保留标签与原因，置 `banned:false`，绝不代表审核通过。写入复用 atomic-write 库的 `<file>.lock` 与同文件系统原子替换。JSON 损坏、版本不支持、哈希重复或行格式错误时拒绝继续；写入失败保留旧清单。遗留锁需要人工恢复，不会自动删除。

`prepare` 在探测前、复制前及复制后检查选定源字节。`render` 在媒体工作开始前检查当前准备源，使用编码缓存前检查其实际字节，并在持有清单写锁、发布暂存成片前复查本次实际消费的源哈希。中途禁用会保留旧成片。`verify` 从不删除文件：`video_bans` 报告直接禁用的输出，或对当前选源提示“当前选片含禁用素材，已有输出需复核”。没有不可变的输出来源记录时，`output_source_mapping` 保留在 `not_checked` 中，不宣称旧成片确实包含哪些版本。

### 四个渲染方法

| 方法 | 读取 | 写入 | 用途 |
|---|---|---|---|
| `subtitles` | 成片清单与逐镜台词计划 | `editing/<集>.srt` | 按每镜自己的音频给已写好的台词配时间，不做语音转写 |
| `prepare` | 成片清单与字幕 | `video/<集>/shot_00N.mp4`、`audio/<集>.wav`、`editing/<集>-timeline.json`、`editing/<集>.srt` | 构建渲染器要读的全部输入，不编码画面 |
| `render` | 时间线、已准备的镜头、整集原声、字幕、BGM，以及该媒介所需的片尾素材 | 成片 MP4 与 `exports/.render_cache/<集>/render.log` | 出片并回报实测参数 |
| `verify` | 成片、它的时间线与字幕 | 无 | 事后检查成片，或复查更早会话留下的成片 |

| 参数 | 必填 | 含义 |
|---|---|---|
| `method` | 总是 | `subtitles`、`prepare`、`render` 或 `verify` |
| `project` | 总是 | 项目根目录（含 `video/`、`audio/`、`editing/`、`exports/`） |
| `episode` | 总是 | 集号；所有路径都补成两位 |
| `shots` | `subtitles`、`prepare` | 成片清单：`{"shots":[{"shot":1,"video":"media/02/p1-clean.mp4","audio":"可选"}]}` |
| `lines` | `subtitles` | 逐镜台词计划：`{"shots":[{"shot":1,"lines":["第一句","第二句"]}]}`；每一项就是一条字幕，已按交付长度切好 |
| `alignment` | `subtitles` | 识别时间：`{"shots":[{"shot":1,"strategy":"asr_aligned","cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}`，镜内相对。只取时间，文本必须与剧本台词一致 |
| `timeline` | `render`、`verify` | 时间线 JSON，通常是 `prepare` 写出的那个 |
| `subtitle_srt` | `prepare`、`render`、`verify`（`subtitles` 可选） | 要写出、安装、烧录或检查的 SRT；`subtitles` 省略时写 `editing/<集>.srt` |
| `last_shot` | `render` | 本次交付覆盖到的最后一个镜头号；时间线里 `shot <= last_shot` 的镜头数必须正好等于它 |
| `bgm` | `render` | BGM，循环铺到正片结束 |
| `bgm_plan` | 可选，`render` | 现有 `episodes[].segments[]` 计划；返回声明的曲目来源、时间、理由、音轨哈希与同序复用集号，不代表试听通过 |
| `ending_audio` | 带标记 `render` | 片尾音；只接受随包 `tweet-drama-background-render/assets/ending_audio.mp3`。成片只取它的前 2 秒，延迟到正片结束处 |
| `ending_effect` | 带标记 `render` | 片尾特效；只接受随包 `tweet-drama-background-render/assets/ending_effect.mp4`。按自身原速只播放一次，覆盖 2 秒片尾的开头 |
| `output` | `verify`（`render` 可选） | 成片文件；`render` 省略时写 `exports/<集>.mp4` |
| `force` | 可选 | `render` 忽略逐镜缓存、全部重编 |

所有项目输入与输出的相对路径都以 `project` 为基准，包括清单、字幕计划、对齐文档、字幕、BGM、片尾文件和显式输出。绝对路径保持不变。跨工具传递绝对 `project`；相对项目根目录只在入口按进程工作目录解析一次。项目外的片尾素材使用其安装位置的绝对路径。二进制与字体的部署配置保持不变。

工具调用使用上表的 snake_case 参数名；注册的执行入口将其映射为渲染器内部的 camelCase 参数。通用必填参数在读文件前检查；片尾参数仅在异步解析明确媒介、选定带标记交付后才要求提供。让渲染无法进行的一切——缺输入、命令失败、片尾素材不是随包字节、特效长于片尾窗口、尾帧无法证明——都会抛错并给中文修法。成片自身的属性不抛错：它们作为检查项返回，所以一次调用既报清全部缺陷，也照常交回实测值。

### 明确媒介与交付快照

`project_config.json.project_bible.visual_medium` 明确选择 `animation_3d` 或 `photorealistic`；自由文本 `style` 与画幅比例不会选择策略。`prepare` 将项目交付字段写成时间线的 `delivery: {visual_medium?, width, height, fps}`，省略的宽高/帧率默认 1440x2560@60。宽高必须为正偶数，帧率必须为不超过 240 的正整数；显式无效值（包括 null）在媒体处理前报错。

`render` 与 `verify` 保留快照画幅。项目未声明媒介时使用快照的明确值；快照未声明时使用项目明确值。两者明确值冲突时要求重跑 `prepare`，不会静默覆盖。缺少交付快照的旧时间线保留旧版画幅；两处都未声明媒介时，结果报警并沿用带标记的旧版输出。显式 `canvas` 与快照画幅冲突时拒绝继续；动画时间线若声明的 `body_end` 不等于镜头终点，也会要求重新准备仅含正片的时间线。

`animation_3d` 成片时长等于正片，不增加水印样式或事件，只混整集原声与 BGM，不打开片尾素材、不抽尾帧、不拼入缓存旧片尾，正片字幕仍启用。`photorealistic` 与未分类旧项目保留下面的带标记交付行为。所有方法的 `expected_duration_seconds` 都只增加所选策略的片尾长度。

### 带标记交付前置：两份片尾素材

带标记 `render` 要求两份随包素材，并在媒体命令前校验字节。缺失或替换素材只阻塞该模式；同目录正确哈希的另一份素材可证明安装目录存在，诊断据此指出安装缺失。

| 素材 | 技能包内路径（`packages/drama/skills/skills/`） | 字节数 | SHA-256 |
|---|---|---|---|
| 片尾特效 | `tweet-drama-background-render/assets/ending_effect.mp4` | 904,502 | `49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010` |
| 片尾音 | `tweet-drama-background-render/assets/ending_audio.mp3` | 83,432 | `d1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f` |

带标记交付的片尾严格为 2 秒（`ENDING_SECONDS = 2`）；片尾音只取前两秒，延迟至正片结束。特效按自身原速播放一次；长于窗口时直接报错，不截断。该模式必须提供两个片尾参数。

### subtitles 做什么

`subtitles` 自己不识别，因为两半都是现成的：台词计划说明每一镜说什么，同一批成片的语音识别对齐说明什么时候说。它逐镜读对齐文档、与台词计划互相核对，字幕用剧本原话，显示文字按交付要求去标点并按语义拆为单行；实测时间落到整集时钟时只加镜头起点并取毫秒精度，不为满足最短显示时长延长短句或推迟后续语音。这里**不测能量**：能量只能说明有人在说话，说不出具体哪句落在哪里，而在某一段里估算切分正是字幕压错句的原因。

正式字幕 SRT 的每条 cue 必须只有一行、无标点或其他符号，最多 14 个有效字（词间空格算半字）。`subtitles` 写入前及 `prepare`/`render` 读取时都会拒绝不合格 cue；超长句需要按语义拆分并分别对齐真实发声时间，不能靠缩小字号或换成两行放行。剧本正文不因显示排版而改写。

对齐文档里的识别文本**绝不写进字幕**：它只用来核对两份是不是同一段表演；文本或条数对不上按 `subtitle_line_coverage` failure 报出，而不是照抄一个数。

缺失或未声明的发声台词会阻塞交付。每个声明无台词的镜头也必须有基于选定原视频核对的 `no_lines` 对齐记录；缺失记录或使用其他策略均会阻塞。台词计划声明无发声，而对齐文档标为 `unmapped_speech` 时，即使没有字幕 cue 也会阻塞：识别器发现了未映射到原文的实质发声。无效、重叠、超出镜头或毫秒取整后时长为零的对齐时间也会阻塞，不夹限或重新分配时间。要求超过 20 有效字/秒的 cue 按 `subtitle_timing` failure 报出；超过 12 字/秒是 warning。`subtitles` 失败或中断会留下 `<subtitle_srt>.blocked`，且不写残缺的交付 SRT；`prepare` 和 `render` 拒绝复用该路径的旧字幕，直至成功对齐清除标记。可从对齐文档检查已接受的时间，修正缺陷后再渲染。没有自动对齐标记的手动 SRT 保持原有流程。

写出的文件是纯 SRT，`prepare` 安装、`render` 烧录之前，可以手工改某一条。

### prepare 写出什么

`prepare` 把每个源成片复制到 `video/<集>/shot_00N.mp4`，按 ffprobe **实测**时长（而不是声明时长）铺时间线，把每镜自己的声音按各自起点拼成整集原声（不加增益、不逐镜重采样，只做一次 48kHz 无损写入），并把字幕装到 `editing/<集>.srt`。它不编码画面。结束时刻超过整集画面的 cue 会作为警告报出。

准备成功后，`editing/<集>-sources.json` 记录 `{shots:[{shot,package?,video,audio,sha256}]}`，包含绝对源路径和准备后视频的 SHA-256。`package` 可选，必须显式指定 `episode_packages/<集>/package.json` 的 `video_tasks` 中从 1 开始的位置，绝不从 `shot` 推断。多个片段可映射到同一包。修改输入前移除旧选择记录，准备失败时不会留下声称完成的旧记录。来源选择证明复制了哪些字节，不代表内容审核通过。显式映射的行在分集包文件存在时还记录 `package_sha256`：整个文件字节的 SHA-256，覆盖其中的镜头内容。审核记录必须带有相同的实测哈希才算当前有效；分集包文件任何变化（包括格式变化）都会保守地使该集证据失效。包文件缺失时省略此字段，不阻断旧项目的准备操作。

逐镜编码缓存要求源字节哈希、可执行程序和完整编码参数（包括时长）一致。只有编码成功且输出非空才发布缓存身份；身份缺失或来源、设置变化时自动重编。`force` 仍可跳过复用。

可选 BGM 计划形如 `episodes:[{episode:"02",body_duration_seconds:12,segments:[{track:"name",source:"music.mp3",start_seconds:0,end_seconds:12,reason:"scene mood"}]}]`。正文时长必须与当前时间线一致，段落时间必须有效、按起点排序且不越界。留白、重叠、单曲和重复主题仍是创作选择。复用提示只比较同一计划内按顺序解析的来源路径，不折叠大小写、不做音频指纹。音轨哈希把声明关联到本次渲染输入，但不证明音轨确实含这些曲目或适合场景。

`bgm_plan` 还保留每集可选的 `intended_use`、每段的 `track_id` 与 `license_info`，并返回规范化逐曲 `license_records`。[许可信息库](../bgm-license-info/README.zh.md)定义未知字段与用途风险提示。风险只作建议并进入渲染报告，不认证使用权或替代模型许可要求。计划中的 `source_sha256` 声明保留，但不逐曲重新计算哈希。不读取计划的方法（包括 `verify`）返回 unknown 用途和空许可记录，并在 `not_checked` 中列出 `bgm_license_info`。

### 交付样式

| 元素 | 取值 |
|---|---|
| 画面 | 快照宽高与帧率，旧版默认 1440x2560@60，H.264 high@5.1，`yuv420p` |
| 码率控制 | 目标 24M、上限 30M、缓冲 48M、GOP 2 秒 |
| 总码率下限 | 成片整体 4.6 Mbps |
| 片尾 | 3D 动画无片尾；带标记交付用最后一镜的真实尾帧定格 2.000 秒。随包特效按自身原速只播放一次，覆盖开头 1.020 秒，以 0.90 不透明度叠在定格帧上；剩下 0.980 秒是纯定格帧 |
| 字幕 | 配置的字体族、1080px 宽 ASS 画布上的字号 40、字间距 -2、以 1440px 成片宽度上的 7px 为基准随输出宽度缩放的黑描边（1440px 和 480px 输出的 ASS 字段均为 5）、底部居中且底部安全距离为画布高度的 140/1920；仅带标记交付增加右下角唯一的 `内容由AI生成` 标记。`ScaledBorderAndShadow: yes` 保持描边随输出缩放；烧录链以快照帧率的 `fps` 和 `setpts` 结尾 |
| 音频 | 整集原声 1.45、BGM 0.24 铺到正片结束、带标记交付的片尾音取前 2 秒延迟到正片结束，`amix` 关闭归一化，`alimiter=0.95` |
| 容器 | AAC 192k / 48kHz，`+faststart` |

### 三个已知的坑

- **抽尾帧。** `-sseof -0.05` 在部分片子上会不写文件却返回 0，于是定格帧静默取错。本包固定用 `-sseof -0.1`，并且不轻信结果：抽出帧的 `framemd5` 必须等于顺序解码的最后一帧；不相等就按帧号重抽，仍不相等就停止渲染，绝不定格一张没验证过的帧。证据在 `tail_frame` 里返回。
- **GPU 编码。** 驱动过旧、缺 NVENC 构建、GPU 被占用，三种情况在探测上表现一致。探针编码一帧 256x256 的源（部分 NVIDIA 代次会拒绝更小的帧），失败就按设计回退 `libx264`，探测自身输出写进 `encoder_fallback_reason` 与渲染日志。
- **烧录之后的帧率。** 字幕滤镜按源帧率锚定时间基准，`fps` 放在 `ass`/`subtitles` 之前不会进入成片：容器照样报交付帧率，实际只解得出少量帧。烧录链因此以快照帧率的 `fps` 和 `setpts` 结尾（旧版 60 fps）。正文编码、特效帧率转换和字幕烧录在 EOF 保持最后一张已解码帧一个帧周期，再以声明的镜头或交付时长截断输出，并明确设置输出帧率；这保留原尾帧，不给 3D 增加片尾。画面被截断时仍不能通过验证，且没有任何检查只看元数据——`decode_probe` 会在首、中、尾各解一帧。

### 检查代码

`render` 跑五项交付检查，`verify` 跑表中全部检查，`subtitles` 跑它自己的两项。`ok` 仅表示已执行的 failure 级检查通过。`not_checked` 明确列出未测量的 QA，包括语音对齐、来源中不需要的内嵌字幕、内容审核与 BGM 试听。清除提供方残留字幕与最终按 SRT 烧录的设计字幕是不同事项，两者都不会禁用交付字幕样式。

| 代码 | 级别 | 通过条件 |
|---|---|---|
| `duration` | failure | 实测时长与「正片结束 + 片尾」相差不超过 0.15 秒 |
| `video_stream` | failure | 快照画幅的 H.264 |
| `frame_rate` | failure | 快照帧率，误差 0.01 以内 |
| `audio_stream` | failure | 存在 AAC 48kHz 音轨 |
| `bitrate_floor` | failure | 总码率达到 4.6 Mbps |
| `decode_probe` | failure | 首、中、尾（距结尾 0.1 秒）三处都能解出一帧 |
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

- **在产出交付物的地方执行交付样式。** 画面几何、码率控制、字幕样式、片尾与混音都是运营确认过的规格。经过校验的项目与时间线元数据选择画幅和媒介策略；写文件的那一步就是检查它的那一步。
- **对产物报告，对障碍抛错。** 低于码率下限的成片是领域结果：运营仍需要这个文件，所以它带着 `ok: false` 与每个失败检查一行修法返回。缺输入或命令失败是环境问题：抛错，因为没有东西可以交回。
- **证明尾帧。** 片尾是事后唯一没人能逐帧检查的东西，所以它的来源是返回值而不是注释。每次都用顺序解码比对 `-sseof` 的结果，不一致就按帧号重抽，仍不行就拒绝出片。
- **只有一个可注入的进程边界。** 每个模块都拿一个 `MediaToolkit`，只有一个函数真正启动进程。整条流水线因此在测试里跑在桩通道上，而真通道由它自己的三个进程规格覆盖。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、参数解析、方法分发，以及 `drama_render` 的 schema 与描述 |
| [`src/delivery-policy.ts`](src/delivery-policy.ts) | 校验项目/时间线元数据、拒绝媒介冲突、处理旧项目提醒与媒介策略 |
| [`src/delivery.ts`](src/delivery.ts) | 交付默认值与样式：画面几何、编码器参数、ASS 头与时间码、随包片尾素材、片尾滤镜、混音图 |
| [`src/ffmpeg.ts`](src/ffmpeg.ts) | 进程通道、ffmpeg 与 ffprobe 包装，以及共享媒体测量 |
| [`src/paths.ts`](src/paths.ts) | 一集的渲染输入与产物路径，以及把「缓存未命中」与「路径坏了」区分开的存在性检查 |
| [`src/timeline.ts`](src/timeline.ts) | 分集时间线的读取、校验、选取、铺排与序列化 |
| [`src/subtitles.ts`](src/subtitles.ts) | SRT 解析与写出，以及交付烧录用的 ASS 文档 |
| [`src/speech.ts`](src/speech.ts) | 读对齐文档并把台词落到整集时钟上，不做识别 |
| [`src/cues.ts`](src/cues.ts) | `subtitles`：台词计划、对齐文档与写出的 SRT |
| [`src/encoder.ts`](src/encoder.ts) | NVENC 探测，以及带原因记录的 CPU 回退 |
| [`src/ending.ts`](src/ending.ts) | 带 framemd5 证明的尾帧抽取、片尾素材校验，以及片尾片段 |
| [`src/prepare.ts`](src/prepare.ts) | `prepare`：成片清单、探测、复制出的布局与整集原声滤镜图 |
| [`src/render.ts`](src/render.ts) | `render`：编码流水线、拼接、烧录、混音与渲染日志 |
| [`src/verify.ts`](src/verify.ts) | `render` 共用的交付判定，以及 `verify` 的抽帧解码、黑帧、静音与字幕越界检查 |
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

渲染结果每镜一行 `clips`，最多十三项检查（包括可选禁用检查）。`drama_video` 增加固定 schema；`list` 结果随记录版本数逐行增长，其他方法只返回选定决定。九镜一集的渲染无论编码花多久都只返回九行 clip；通过的交付让 `failures` 为空、每个 `fix` 为空串。

#### KV Cache 影响

只追加。工具注册带稳定的名字、描述与 schema，挂载后请求前缀可复用；只有本包描述或 schema 变化才会让它失效。一次调用的结果作为那次调用自己的 tool result 追加，不改写任何更早的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包是什么、不是什么。它们是当前约束，不是任务清单。

- **ffmpeg 与 ffprobe 是外部依赖**——本包启动 `ffmpegPath` 与 `ffprobePath` 指向的任何东西。缺少 `libass`、`minterpolate` 或 `screen` 混合模式的构建会在需要它的那条命令上失败，而报告里只有那条命令的 stderr。
- **交付元数据不开放任意滤镜**——项目宽高/帧率与明确媒介经过校验并写入快照；码率控制、字幕样式、随包片尾哈希及限幅器保持固定。插件 `Config` 只包含可执行文件、增益、编码器偏好和字体。
- **缓存与日志写入不是事务**——渲染失败可能留下中间文件，由下一次运行覆盖。最终 MP4 在同目录暂存，禁用检查后以 rename 发布；发布前失败会保留旧成片。
- **禁用不是全局媒体过滤器**——不拦截通用 FFmpeg 工具和任意外部转码。准备后的副本按实际 SHA256 检查；正式渲染以当前源哈希关联编码缓存。缺失或过期的映射不能证明任意转码文件的原始版本。
- **需要片尾的带标记渲染每次重建片尾**——尾帧会重新抽取并重新证明，片尾片段会重新编码，即使缓存里两者都在。证明正是重点，而缓存里的片尾可能早于一次重剪。
- **`prepare` 是复制而不是链接**——每个源成片都会复制进项目，九镜一集需要为审核过的成片留出双份空间。硬链接会在源文件被改写时立刻失效。
- **一次调用只处理一集**——`last_shot` 把一次渲染限定在它交付的正片镜头上，但一次调用从不渲染多集，也没有任何方法读取 `pipeline_state.json`。
- **混音不做电平表**——`normalize=0` 的 `amix` 精确保留运营给的增益，`alimiter=0.95` 是唯一的天花板。比被替换的 master 更响的素材仍可能在限幅器之前就削顶，而 `verify` 的静音检查发现不了。
- **字幕只检查不修正**——`verify` 报出越过 `body_end` 的 cue；没有任何东西去钳制它，因为一句字幕该在哪里结束是字幕作者的决定。
- **`subtitles` 信任识别给出的时间**——对齐文档决定每一句什么时候说；本包只核对它覆盖了每条声明台词、且文本就是剧本原文，判断不了识别本身有多准，所以 `speech_alignment` 一直留在 `not_checked`。对齐文档由调用方产出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本 Dev Note 是给维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付行为、限制与已接受的取舍在上面各节、包代码与链接文档里。

本包是流水线 Python 渲染器（`tweet-drama-background-render/scripts/render_episode.py`）的移植。在会话迁移过去之前，Python 脚本仍是生产路径，所以过渡期两者并存。

移植后的行为在五处与 Python 不同，且都已记录：抽尾帧固定用 `-0.1` 而不是 `-0.05`，且每次抽取都与顺序解码比对证明；编码器探测失败会作为原因记录下来，而不是静默回退；ASS 的行尾统一成 `\n`，不随宿主平台；尾帧与片尾片段每次渲染都重建，不复用缓存；渲染日志是新文件，而 Python 的 `exports/render_tasks.json` 状态文件被刻意不写。

</details>

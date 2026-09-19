---
description: "把短剧整集渲染做成一个模型可见的工具：构建渲染输入、按固定交付样式编码 1440x2560 成片、检查成片，供运行剧变短剧流水线的使用者与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-episode-render

[English](README.md) | 中文

## Summary

当短剧会话必须把审核通过的镜头成片合成一集交付、又不能靠手写 FFmpeg 命令时，用这个包。工具 `drama_render` 独占这套操作：`prepare` 构建渲染器要读的目录布局，`render` 按运营确认过的样式出片并回报实测参数，`verify` 按时间线与字幕检查成片。交付样式在这里是常量而不是 skill 里的建议，所以产出交付物的那一步就是执行它的那一步。

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

### 三个方法

| 方法 | 读取 | 写入 | 用途 |
|---|---|---|---|
| `prepare` | 成片清单与字幕 | `video/<集>/shot_00N.mp4`、`audio/<集>.wav`、`editing/<集>-timeline.json`、`editing/<集>.srt` | 构建渲染器要读的全部输入，不编码画面 |
| `render` | 时间线、已准备的镜头、整集原声、字幕、BGM、片尾音与片尾特效 | 成片 MP4 与 `exports/.render_cache/<集>/render.log` | 出片并回报实测参数 |
| `verify` | 成片、它的时间线与字幕 | 无 | 事后检查成片，或复查更早会话留下的成片 |

| 参数 | 必填 | 含义 |
|---|---|---|
| `method` | 总是 | `prepare`、`render` 或 `verify` |
| `project` | 总是 | 项目根目录（含 `video/`、`audio/`、`editing/`、`exports/`） |
| `episode` | 总是 | 集号；所有路径都补成两位 |
| `shots` | `prepare` | 成片清单：`{"shots":[{"shot":1,"video":"media/02/p1-clean.mp4","audio":"可选"}]}` |
| `timeline` | `render`、`verify` | 时间线 JSON，通常是 `prepare` 写出的那个 |
| `subtitle_srt` | 总是 | 要安装、烧录或检查的 SRT |
| `last_shot` | `render` | 本次交付覆盖到的最后一个镜头号；时间线里 `shot <= last_shot` 的镜头数必须正好等于它 |
| `bgm` | `render` | BGM，循环铺到正片结束 |
| `ending_audio` | `render` | 片尾音，延迟到正片结束处 |
| `ending_effect` | `render` | 叠在定格帧上的片尾特效视频 |
| `output` | `verify`（`render` 可选） | 成片文件；`render` 省略时写 `exports/<集>.mp4` |
| `force` | 可选 | `render` 忽略逐镜缓存、全部重编 |

方法缺自己的必填参数时，在打开任何文件之前就失败。让渲染无法进行的一切——缺输入、命令失败、尾帧无法证明——都会抛错并给中文修法。成片自身的属性不抛错：它们作为检查项返回，所以一次调用既报清全部缺陷，也照常交回实测值。

### prepare 写出什么

`prepare` 把每个源成片复制到 `video/<集>/shot_00N.mp4`，按 ffprobe **实测**时长（而不是声明时长）铺时间线，把每镜自己的声音按各自起点拼成整集原声（不加增益、不逐镜重采样，只做一次 48kHz 无损写入），并把字幕装到 `editing/<集>.srt`。它不编码画面。结束时刻超过整集画面的 cue 会作为警告报出。

### 固定交付样式

| 元素 | 取值 |
|---|---|
| 画面 | 1440x2560@60，H.264 high@5.1，`yuv420p` |
| 码率控制 | 目标 24M、上限 30M、缓冲 48M、GOP 120 帧 |
| 总码率下限 | 成片整体 4.6 Mbps |
| 片尾 | 用最后一镜的真实尾帧定格 2.000 秒，叠 0.90 不透明度的片尾特效 |
| 字幕 | SimHei 68、字间距 -2、7px 黑描边、底部居中，另有右下角唯一的 `内容由AI生成` 标记 |
| 音频 | 整集原声 1.45、BGM 0.24 铺到正片结束、片尾音延迟到正片结束，`amix` 关闭归一化，`alimiter=0.95` |
| 容器 | AAC 192k / 48kHz，`+faststart` |

### 两个已知的坑

- **抽尾帧。** `-sseof -0.05` 在部分片子上会不写文件却返回 0，于是定格帧静默取错。本包固定用 `-sseof -0.1`，并且不轻信结果：抽出帧的 `framemd5` 必须等于顺序解码的最后一帧；不相等就按帧号重抽，仍不相等就停止渲染，绝不定格一张没验证过的帧。证据在 `tail_frame` 里返回。
- **GPU 编码。** 驱动过旧、缺 NVENC 构建、GPU 被占用，三种情况在探测上表现一致。探针编码一帧 256x256 的源（部分 NVIDIA 代次会拒绝更小的帧），失败就按设计回退 `libx264`，探测自身输出写进 `encoder_fallback_reason` 与渲染日志。

### 检查代码

`render` 跑五项交付检查；`verify` 跑全部检查。只有没有任何 `failure` 级检查失败时 `ok` 才为真。

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
| [`src/subtitles.ts`](src/subtitles.ts) | SRT 解析与交付烧录用的 ASS 文档 |
| [`src/encoder.ts`](src/encoder.ts) | NVENC 探测，以及带原因记录的 CPU 回退 |
| [`src/ending.ts`](src/ending.ts) | 带 framemd5 证明的尾帧抽取，以及片尾片段 |
| [`src/prepare.ts`](src/prepare.ts) | `prepare`：成片清单、探测、复制出的布局与整集原声滤镜图 |
| [`src/render.ts`](src/render.ts) | `render`：编码流水线、拼接、烧录、混音与渲染日志 |
| [`src/verify.ts`](src/verify.ts) | `render` 共用的交付判定，以及 `verify` 的黑帧、静音与字幕越界检查 |
| [`src/report.ts`](src/report.ts) | canonical 结果：三个方法填同一套字段，没测到的留空值 |
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

### `drama_render` 工具 schema

#### 模型看到什么

请求工具列表里一个名为 `drama_render` 的工具：本包的 `description`、它的十二个参数，以及结果的 JSON schema，三者都逐字收录在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-render)里。描述写明三个方法、固定的画面几何与码率控制、ASS 字幕样式与唯一的 AI 标记、带限幅器的三路混音、256x256 的 NVENC 探针与设计好的 CPU 回退、`-sseof -0.1` 规则与它对顺序解码的 framemd5 证明，以及「哪些问题抛错、哪些问题作为检查项返回」的分界。结果 schema 声明 `method`、`ok`、`project`、`episode`、`clips`、`body_end_seconds`、`expected_duration_seconds`、`written`、`output`、`encoder`、`gpu_requested`、`gpu_used`、`encoder_fallback_reason`、`encoded_shots`、`reused_shots`、`tail_frame`、`media`、`checks`、`failures`、`warnings`、`log_path` 与 `summary`；渲染出来的内容就是这个值的格式化 JSON。

#### Token 影响

schema 固定，结果随集的大小有界：每个镜头一行 `clips`，最多十一行检查，每行带一句中文实测值与它的修法。九镜一集的渲染无论编码花多久都只返回九行 clip；通过的交付让 `failures` 为空、每个 `fix` 为空串。

#### KV Cache 影响

只追加。工具注册带稳定的名字、描述与 schema，挂载后请求前缀可复用；只有本包描述或 schema 变化才会让它失效。一次调用的结果作为那次调用自己的 tool result 追加，不改写任何更早的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包是什么、不是什么。它们是当前约束，不是任务清单。

- **ffmpeg 与 ffprobe 是外部依赖**——本包启动 `ffmpegPath` 与 `ffprobePath` 指向的任何东西。缺少 `libass`、`minterpolate` 或 `screen` 混合模式的构建会在需要它的那条命令上失败，而报告里只有那条命令的 stderr。
- **交付样式不可配置**——画面几何、帧率、码率控制、字幕样式、片尾长度与限幅器都是常量，因为它们是运营确认过的规格。只有可执行文件、两个增益、编码器偏好与字体目录是 `Config` 字段。
- **`render` 不是事务**——缓存目录、成片与日志按顺序写入，没有回滚。渲染失败会把缓存留在原样，这正是重试便宜的原因；也意味着中断的运行可能留下半个 `base.mp4`，下一次运行会覆盖它而不是校验它。
- **每次渲染都重建片尾**——尾帧会重新抽取并重新证明，片尾片段会重新编码，即使缓存里两者都在。证明正是重点，而缓存里的片尾可能早于一次重剪。
- **`prepare` 是复制而不是链接**——每个源成片都会复制进项目，九镜一集需要为审核过的成片留出双份空间。硬链接会在源文件被改写时立刻失效。
- **一次调用只处理一集**——`last_shot` 把一次渲染限定在它交付的正片镜头上，但一次调用从不渲染多集，也没有任何方法读取 `pipeline_state.json`。
- **混音不做电平表**——`normalize=0` 的 `amix` 精确保留运营给的增益，`alimiter=0.95` 是唯一的天花板。比被替换的 master 更响的素材仍可能在限幅器之前就削顶，而 `verify` 的静音检查发现不了。
- **字幕只检查不修正**——`verify` 报出越过 `body_end` 的 cue；没有任何东西去钳制它，因为一句字幕该在哪里结束是字幕作者的决定。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本 Dev Note 是给维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付行为、限制与已接受的取舍在上面各节、包代码与链接文档里。

本包是流水线 Python 渲染器（`tweet-drama-background-render/scripts/render_episode.py`）的移植。在会话迁移过去之前，Python 脚本仍是生产路径，所以过渡期两者并存。

移植后的行为在五处与 Python 不同，且都已记录：抽尾帧固定用 `-0.1` 而不是 `-0.05`，且每次抽取都与顺序解码比对证明；编码器探测失败会作为原因记录下来，而不是静默回退；ASS 的行尾统一成 `\n`，不随宿主平台；尾帧与片尾片段每次渲染都重建，不复用缓存；渲染日志是新文件，而 Python 的 `exports/render_tasks.json` 状态文件被刻意不写。

</details>

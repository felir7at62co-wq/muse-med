---
description: "按集用实测语音生成字幕，并用与镜流共用的规则对照锁定剧本纠正文字，模型不写任何文字或时间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-episode-subtitles

[English](README.md) | 中文

## 概述

`episode_subtitles` 把一集或多集的已审核镜头变成 SRT、第 2 版时钟回执和待核清单。文字来自云转写听到的内容，并用镜流的 `subtitle_cues` 规则对照剧本纠正；时间始终是实测的字词时间。模型从不编写台词、对齐、回执或偏移。用相同参数再次调用即可续做，只重做声音、剧本或选择变化的镜头。

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

Desktop 在 Office 组合中挂载本插件，传入随附运行时目录以及交给 `jianying_draft` 的同一组媒体程序。它需要工具注册表、系统提示、Muse 账号服务和 subprocess provider；镜流项目还需要可选的、保存本机素材的 `jingliuConnection`。

```yaml
- id: tool-episode-subtitles
  name: '@deepseek-ai/dsh-tool-episode-subtitles'
  config:
    pythonPath: /path/to/python-with-pypinyin
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `source` | — | 随附主运行时目录；Windows 使用其旁边的 `media/python/python.exe` |
| `pythonPath` | — | 带 `pypinyin==0.55.0` 的解释器，优先于 `source`。两者必须给出其一 |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | 媒体程序 |
| `packSeconds` | `600` | 一次拼包上传的最长时长（含静音），等于转写分段长度，因此拼包不会被再切分 |
| `gapSeconds` | `0.8` | 拼包中每个镜头之后的数字静音 |
| `maxChars` / `spaceWidth` | `14` / `0.5` | 每条字幕的有效字数；空格按 `spaceWidth` 计 |
| `jingliuMaxChars` | `20` | 镜流项目预览的每条字数，与镜流存储的宽度相同 |
| `jingliuJobWaitMs` | `60000` | 一次调用内等待一个镜流字幕任务的最长时间 |
| `maxEpisodes` / `reviewPageSize` | `100` / `20` | 每次调用的集数和每页待核条数 |
| `rulesTimeoutMs` | `300000` | 规则进程的时限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-episode-subtitles)列出全部可用字段，包括与 `audio_transcribe` 共用的转写限制。

### 方法与文件

`build` 读取锁定分包 `episode_packages/NN/package.json` 和已审核选片 `reviews/epNN-pMM.json`，写出 `prepare` 与草稿读取的镜头清单 `editing/NN-shots.json`，并用渲染器的画面时钟测量时长。某个分包没有审核、审核后分包变化或审核后素材变化时，本集被阻止，并写出这些分包。

没有转写缓存（`transcript/shots/<audio_sha256>.json`）的镜头会拼进 `transcript/packs/` 下按内容命名的 WAV，通过 `audio_transcribe` 的执行器以 `subtitles` 用途转写。待完成的拼包只按其收据查询或续传；失败或状态不确定的拼包会阻止其镜头，且这些镜头不会再被拼包。字词按中点归回所在镜头，落在间隔里或跨越镜头边界的字词列为 `boundary` 待核项。

纠正和切条每次调用只运行一次随附的 `subtitle_rules/run.py`。每个镜头的结果缓存在 `subtitles/NN.state.json`，键由它的转写、台词、人名、规则摘要和它自己的选择构成。时钟每次调用都重新排布：超出裁剪后镜头的字幕会被截短或删除并列为 `cut_by_trim`，快于渲染器阅读上限的字幕列为 `too_fast`。只有所有镜头都到达终态时，SRT 与第 2 版回执才发布到 `editing/NN.srt`；仍在转写或被阻止的集保留原有文件。回执还记下本集台词、人名和选择的摘要，所以改了剧本后即使素材没变，草稿也会拒绝这份 SRT。该路径上已有、却没有 `episode_subtitles` 回执覆盖的 SRT（手做或手改过的）会连同其回执移到 `NN.srt.manual-<时间>`，再发布新的，结果在 `manual_srt_kept` 里写出它。

`review` 分页列出 `subtitles/NN.review.json` 中的待核项。带 `decisions` 时写入 `subtitles/NN.decisions.json`，并在不新转写的情况下重排受影响的集。选择按待核项 ID 保存，因此其他镜头修改后仍然有效，自身镜头变化后自动失效。

草稿构建方通过 `@deepseek-ai/dsh-tool-episode-subtitles/selection` 的 `localEpisodeSelection` 读取一集当前的已审核选片、实测时钟和字幕输入摘要，它执行相同的检查并重写同一份清单。同一子路径还导出 `legacyChoice`，即两个工具向用户提出的保留或重做问题。

### 镜流项目

`source: "jingliu"` 时，`project` 是镜流项目 ID，所有文件都在 `<workspace>/jingliu/<project>` 下。`build` 先读 `POST /projects/{pid}/edit-plan`，取得启用的镜头、取片窗口、速度、会被念出的台词、人名和已存字幕的状态；没有这条路由的服务器回 404，所有集都报 `jingliu_outdated`，因此字幕任务绝不会发给会自己做识别的旧服务器。每镜视频只下载一次到项目文件夹，它也是这一镜的声音；有镜头尚未出片的集报 `video_missing`，读不到的文件报 `media_unavailable`。识别的打包方式与本机项目完全相同。

纠正后的字词以每集一个 `auto_subtitles` segments 任务存到镜流，经 `subtitles/jobs/` 里的只提交一次回执发送，携带每镜的音频摘要、字词、选择和标记。镜流用同一套规则、按自己的每条字数纠正并切条，只替换这些镜头的自动字幕，保留手加的字幕并把与之重叠的 Muse 字幕列为 `manual_overlap` 待核项，并返回待核清单。同样的音频摘要与字词下，其编号与本机规则的编号相同，所以选择可以往返。只有字词、台词、选择或视频变了，或镜流不再报告 `fresh` 时，这一镜才会重发。有老数据行（镜流记录字幕来源之前写的，可能是手加的）的镜头不发送：该集为 `unverified`，结果的 `ask` 给出让用户选的问题，且不给 `next`。保留就调 `jianying_draft` 并带 `keep_legacy_subtitles: true`；重做就带 `replace_legacy: true` 再 build，镜流随即存档并替换这些行。segments 提交的答复丢失、或任务失败且没有结果时，只要同一次调用里剪辑计划已应答，就换新的尝试键重发，最多三次；云转写从不重发。任务因视频已换而拒绝某镜时，该集为 `waiting`，下一次 build 会下载新视频。预览 SRT 与回执（`subtitles/epNN.srt`）把同一套规则的字幕经取片窗口和速度排上时间轴；被裁掉或过快的字幕在这里不列为待核项，因为存储的字幕由镜流自己排位。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 —— 点击展开</summary>

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置、解释器解析和 `episode_subtitles` schema |
| [`src/tool.ts`](src/tool.ts) | 参数检查、按根目录的构建锁、待核分页、选择和精简结果 |
| [`src/source.ts`](src/source.ts) | 镜流 provider：剪辑计划、素材、segments 任务与待核清单，以及没有连接时使用的 provider |
| [`src/shots.ts`](src/shots.ts) | 本地分包、已审核选片、镜头清单、时长、台词与人名 |
| [`src/hash-cache.ts`](src/hash-cache.ts) | `<root>/.muse-hash-cache.json` 中按文件状态缓存的摘要和按摘要缓存的探测结果 |
| [`src/asr-pack.ts`](src/asr-pack.ts) | 纯函数的拼包规划、标点附着和按中点拆分 |
| [`src/asr.ts`](src/asr.ts) | 拼包清单、WAV 组装和执行器调用 |
| [`src/rules.ts`](src/rules.ts) | 规则摘要和受管 Python 进程 |
| [`src/clock.ts`](src/clock.ts) | 取片窗口与变速到整集时钟的映射 |
| [`src/build.ts`](src/build.ts) | 逐镜缓存键、时钟排布、待核项和发布 |
| [`src/types.ts`](src/types.ts) | 仅类型声明 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-subtitles) —— `episode_subtitles` 的 schema 与描述原文。
- [`tool-audio-transcribe`](../tool-audio-transcribe/README.zh.md) —— 每次上传的收据、节奏与恢复。
- [`tool-episode-render`](../tool-episode-render/README.zh.md) —— 画面时钟、`prepare` 与时钟回执。
- [短剧包目录](../README.zh.md) —— 相邻的短剧工具。

-----

<a id="model-experience"></a>
## 模型体验

### `episode_subtitles` 工具 schema

#### 模型看到的内容

挂载后贡献 `episode_subtitles`；完整参数与描述原文以生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-episode-subtitles)为准。参数为 `method`、`source`、`project`、`episodes`、`wait_seconds`、`decisions`、`offset` 和 `replace_legacy`。构建结果按状态（`ready`、`waiting`、`needs_review`、`unverified`、`blocked`）归组各集，每项最多列出十个镜头，报告转写进度并给出下一次调用；有 `unverified` 的集等用户决定时，总的 `status` 为 `needs_choice`，`ask` 带问题和两种调用，不给下一次调用。系统提示段也要求任一工具返回 `ask` 时去问用户。待核页最多包含 `reviewPageSize` 条，带听到的文字、剧本文字和整集时钟时间。 该行还加入 `tool:episode_subtitles` 系统提示段：`episode_subtitles` build、`episode_subtitles` review 与 `jianying_draft` 三步，以及镜头变化后的重跑。在只保留少量任务技能的预设里，压缩后仍按这个顺序进行。

#### Token 影响

请求增加一个固定 schema 和一段简短的固定提示。构建结果每集约 30 字节，100 集时仍小于 3 KB；待核页随条目增长，以页长为上限。

#### KV Cache 影响

只追加。挂载稳定时请求前缀可复用；修改描述或 schema 会使其失效。每次调用追加自己的结果。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **拼包识别可能跨镜头带入上下文** —— 镜头之间的静音不会重置识别器；这对文字的影响尚未在真实剧集上测量。
- **没有重新转写选项** —— 拼包失败或状态不确定的镜头保持阻止；不提供单独重转一个镜头。
- **没有字词时间的分段保持每段一条字幕** —— 这样的字幕列为 `long_cue`，不按估算切分。
- **镜流提交最多重试三次** —— 同一份载荷第三次答复丢失或任务失败后，该集保持 `subtitle_job_unknown` 或 `subtitle_job_failed`，直到字词、选择或视频变化。
- **镜流预览不看手加的行** —— 用户选了手加字幕、镜流因此没写某条 Muse 字幕时，预览 SRT 仍显示它。
- **回滚与旧服务器** —— 旧版 Muse 读这些第 2 版回执时忽略其中的输入摘要。剪辑计划不统计老数据行的镜流服务器上，每个 `unverified` 的镜头都按有老数据处理，只有用户选了重做才发送。规则照旧需要随附运行时里的 `pypinyin==0.55.0`。
- **镜流人名来自剪辑计划** —— 预览用所请求各集的人名，而镜流按每个任务所含镜头的人名纠正；待核清单始终以镜流为准。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 —— 点击展开</summary>

规则模块是 `services/jingliu/backend/app/subtitle_align.py` 与 `subtitle_cues.py` 的逐字节副本；`pnpm run verify-subtitle-rules-copy` 拒绝任何差异，`rules.ts` 计算与 `run.py` 相同的摘要。

</details>

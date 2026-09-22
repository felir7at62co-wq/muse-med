---
description: "按明确剧情段落预检、合成并核验短剧 BGM 底轨，同时让合成器与情绪匹配模型保持解耦。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-bgm-compose

[English](README.md) | 中文

## Summary

无需手写 FFmpeg 命令，即可把 Agent 已确认的单集配乐计划变成一条实测 WAV 底轨。`drama_bgm` 校验剧情完整覆盖、测量源曲起点与音量、交叉淡化选定曲目，并核验固定输出格式。它不选曲，也不判断音乐是否适合剧情。需要情绪候选时单独调用 `bgm_match`；其 m-a-p/MERT-v1-95M 骨干采用 CC-BY-NC-4.0，仅限非商业用途，合成器本身不依赖该模型。

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

把插件挂在工具注册表和 subprocess provider 之后。provider 解析并持有每个 `ffmpeg` 与 `ffprobe` 进程。

```yaml
- id: tool-bgm-compose
  name: '@deepseek-ai/dsh-tool-bgm-compose'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | FFmpeg 可执行文件或 provider 可解析的命令 |
| `ffprobePath` | `ffprobe` | ffprobe 可执行文件或 provider 可解析的命令 |
| `commandTimeoutMs` | `300000` | 单条媒体命令的最长执行时间 |
| `terminationGraceMs` | `5000` | provider 终止进程的宽限时间 |
| `outputMaxBytes` | `1048576` | 每条进程输出流的最大收集字节数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-bgm-compose)是全部可用字段的完整来源。

### 计划与方法

计划使用 `episodes[].segments[]`。选中集声明 `body_duration_seconds`、可选 `crossfade_seconds`，以及连续的段落；每段包含 `track`、`source`、`start_seconds`、`end_seconds` 与 `reason`。段落可以冻结 `source_start_seconds` 和 `source_sha256`；`valence` 与 `arousal` 可保留候选实测值，但不会调用 `bgm_match`。

| 方法 | 写入 | 结果 |
|---|---|---|
| `preview` | 不写正式产物 | 解析后的源哈希、源曲起点、实测平均音量、应用增益与同序复用提醒 |
| `compose` | 48 kHz 双声道 `pcm_s16le` WAV 及相邻 `.generation.json` | 预检事实，加上实测媒体参数与输出 SHA-256 |
| `verify` | 无 | 现有 WAV 的实测容器与音频参数；不读取原始源曲，`segments` 为空 |

`compose` 以 `-17.5 dB` 为平均音量目标，自动提升最多 `+9 dB`，让每个交叉淡化以剧情边界为中心，开头淡入 1.5 秒，结尾 2.5 秒淡出。它在无覆盖发布前暂存并探测两个产物；命令或校验失败会清除暂存文件，并保留已有目标不变。把返回的 `output` 传给 `drama_render.bgm`，同一计划传给 `drama_render.bgm_plan`。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内幕——点击展开</summary>

计划模块持有时间校验与滤镜图计算。合成器解析项目内的控制文件和输出路径，计算每首选定源曲的哈希，使用显式源偏移或检测 1–5 秒窗口内第一个可听起音，测量实际消耗的源窗口，并编译一张 FFmpeg 滤镜图。媒体模块通过 `ctx.subprocess` 发送 argv，解析有界收集输出，探测暂存 WAV，并把 WAV 与 JSON sidecar 作为一个无覆盖批次发布。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置与 `drama_bgm` schema |
| [`src/plan.ts`](src/plan.ts) | 段落覆盖、重叠时长、增益与 FFmpeg 滤镜图构造 |
| [`src/compose.ts`](src/compose.ts) | 计划读取、源曲分析、方法分发、暂存与媒体校验 |
| [`src/media.ts`](src/media.ts) | subprocess 适配、ffmpeg/ffprobe 解析与无覆盖发布 |
| [`src/types.ts`](src/types.ts) | 仅类型声明 |
| — | 不发布运行时不变式伴随包，因为本包不在调用之间保留状态。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bgm-compose)——`drama_bgm` 的精确 schema 与描述。
- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——工具注册与规范结果。
- [Subprocess 子系统参考](../../../docs/subsystems/subprocess.zh.md)——provider 持有的命令执行与取消。
- [Drama 包地图](../README.zh.md)——相邻短剧工具。

-----

<a id="model-experience"></a>
## 模型体验

### `drama_bgm` 工具 schema

#### 模型看到什么

挂载行贡献 `drama_bgm`；生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bgm-compose)持有完整参数、结果与描述原文。描述把候选匹配、Agent 选曲、确定性合成与后续 `drama_render` 使用分开。

#### Token 影响

请求增加一份固定工具 schema。`preview` 与 `compose` 结果随选中集的段落数线性增长，因为每个已分析段落都返回来源身份、时间、实测音量、增益与选曲理由；`verify` 不返回段落分析。

#### KV Cache 影响

只追加。挂载保持稳定时，请求前缀可复用；修改本包的工具描述或 schema 会使该前缀失效。每次调用增加自己的工具结果，不改写更早消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **合成器不试听剧情适配**——它执行选定曲目与理由，但不能证明情绪、音乐连续性或创作审核通过。
- **起音检测不是节拍网格分析**——未给源偏移时，工具使用 1–5 秒窗口内初始静音的结束点；窗口一开始已有声音就从第 1 秒开始，整个窗口持续静音则失败；需要精确重拍的计划必须提供 `source_start_seconds`。
- **源曲不循环**——每个源文件在选定偏移之后必须完整容纳实际消耗窗口，包括交叉淡化重叠。
- **音量归一化使用窗口平均值，不是 integrated LUFS**——增益依据 FFmpeg `volumedetect`；最终限幅仍由整集渲染器负责。
- **每次一集且使用本地文件**——控制文件和输出必须留在项目内，选定的只读源曲可以位于其它目录。
- **本工具视已发布文件为不可变**——WAV 或 sidecar 已存在时，`compose` 失败，不会覆盖。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>给维护者的工作上下文——点击展开</summary>

无。

</details>

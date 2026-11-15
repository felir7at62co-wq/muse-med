---
description: "浏览会话中记录的视频，播放本地或已核验的剧变媒体，并检测视觉切镜区间，不生成或替换媒体。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-video

[English](README.md) | 中文

## 概述

浏览会话中记录的视频，并检测已有视频中按时间排列的镜头区间。本地工作区引用、已呈现文件、上传的视频附件、受支持的生成结果，以及成功的剧变媒体结果，均保留其原始会话坐标。切镜检测在必要时下载已核验的剧变媒体，并在本地运行 FFmpeg；它不发起模型或生成请求。结果引用原视频的时间区间，并保留原始字节。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Host 组合将此插件与 Session 查询和投影、文件系统和附件提供者、子进程执行、沙箱策略，以及经过认证的 Client 连接一起挂载。Client 使用生成的 `sessionVideo` Remote 服务。

### 已记录来源与检测

`list` 返回已记录视频的标识、事件坐标、文件或提供者版本、播放地址和可用性诊断。清单接纳用户显式文件引用和上传的视频附件、已呈现视频、受支持的本地生成输出，以及成功的剧变工具结果。助手正文和任意 Client URL 不会引入视频来源。清单达到数量上限时会报告覆盖不完整，不会将省略后续内容的结果表示为完整清单。

`detect` 接收 Session 标识，以及 `list` 返回的来源标识和版本。检测会拒绝过期版本，探测时长和尺寸，然后通过 FFmpeg 检测视觉变化。就绪结果以按时间排序、非空的区间覆盖整个原视频；连续视频包含一个区间。失败结果不包含镜头区间，并提供诊断。调用者取消后，会在所属子进程结束后拒绝请求。

本地播放使用与 Session 绑定且经过认证的字节范围路由。已核验的公开剧变 URL 可以直接播放；检测通过现有的受限剧变下载器获取字节，并保存到附件存储。下载不携带凭据，拒绝重定向，并遵守配置的字节和超时上限。任何方法都不接受 Client 提供的任意来源路径或 URL。

### 配置

插件没有必填配置字段。所属 Host 组合提供注入服务；可执行文件路径和处理上限由部署配置决定。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe` | 在配置的执行环境中解析的可执行文件 |
| `sceneThreshold`, `analysisWidth`, `minShotSeconds` | `0.3`, `320`, `0.08` | 视觉变化阈值、分析宽度和保留区间边界的最小间隔 |
| `maxSources`, `maxResultBytes` | `500`, `4194304` | 清单数量和结构化工具结果解析上限 |
| `maxSourceBytes`, `maxDurationSeconds`, `maxSourcePixels` | `536870912`, `3600`, `33177600` | 输入字节、时长和视频轨像素数量上限 |
| `maxShots`, `maxConcurrent`, `maxCachedAnalyses` | `500`, `2`, `128` | 完整区间数量、并发检测和进程内缓存结果上限 |
| `commandTimeoutMs`, `downloadTimeoutMs`, `graceMs` | `180000`, `60000`, `1000` | 子进程期限、下载期限和进程终止宽限期 |
| `maxOutputBytes`, `playbackChunkBytes`, `maxPlaybackStreams` | `8388608`, `262144`, `8` | 命令输出大小、播放读取块大小和活跃播放数量上限 |

[`src/index.ts`](src/index.ts) 中经过验证的 schema 定义可接受范围。提高来源处理上限不会扩大固定的剧变下载来源允许列表。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

私有 Session 投影保留受限的来源坐标和尚未结束的受支持工具调用。显示名称取自已记录的本地路径、附件名称，或去掉查询参数的提供者 URL。文件系统补充当前可用性和版本，不改动 Session 历史。来源标识将 Session 与精确的已记录坐标绑定；镜头标识还绑定来源版本和区间端点。只有当前文件版本与缓存版本一致时，成功的分析结果才会复用。分析和下载缓存超过配置上限时，会淘汰最早插入的条目。

服务通过文件系统提供者获取执行路径，并对子进程应用 Session 沙箱策略。它在检测后，以及每次播放读取前后重新检查文件版本。插件卸载时取消操作和流，等待子进程及未完成读取结束，并移除播放路由。处理辅助函数返回完整结果或显式错误，不会截断成功的镜头列表。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote 方法、来源解析、受限下载、播放和生命周期 |
| [`src/sources.ts`](src/sources.ts) | 私有来源投影和已记录结果解析 |
| [`src/media.ts`](src/media.ts) | 子进程归属、已验证的视频信息和完整切镜区间 |
| [`src/types.ts`](src/types.ts) | Client 可见的清单、来源和区间类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

相关包分别拥有来源存储、执行和提供者下载规则。

- [Session 投影](../../session/session-projection/README.zh.md)——派生 Session 状态。
- [附件](../../attachment/attachment/README.zh.md)——二进制来源存储。
- [剧变 API](../../jubian/jubian-api/README.zh.md)——受限媒体下载。
- [子进程执行](../../subprocess/subprocess/README.zh.md)——取消和进程结束。

-----

<a id="model-experience"></a>
## 模型体验

### Client 中的视频检查

#### 模型看到的内容

`sessionVideo` 服务不添加工具、提示词、模型请求或 Session 消息。清单和切镜区间仅作为 Client 检查数据。若使用方提交用户编写的修改草稿，该使用方负责之后的模型输入。

#### Token 影响

直接请求 token 为零。清单、播放、下载和 FFmpeg 检测不构建模型输入。

#### KV Cache 影响

检查保留现有请求前缀。此包既不改变模型历史，也不负责提供者缓存的可用性。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于视频发现和切镜解释。

- **仅检测视觉切镜**——检测区间不识别剧情场景、角色、台词或戏剧情节连贯性；淡入淡出和渐变过渡可能仍在同一区间内。
- **原视频区间**——检测不创建独立片段文件、缩略图、剪辑或替换生成。Client 可以从播放来源截取预览帧。
- **仅支持已记录的特定来源**——省略任意助手链接和未识别工具结果。丢失或不可访问的已记录文件保留可见诊断；不支持的剧变来源不能下载。
- **进程内分析缓存**——Host 重启会丢弃分析和已下载来源的查询记录。已保存的按内容寻址的附件字节遵循附件存储的生命周期。
- **可执行文件与编解码器可用性**——配置的执行环境必须具有 FFmpeg、FFprobe、文件系统访问能力和兼容解码器。达到上限、不支持的输入和隔离失败返回诊断，不编造镜头。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

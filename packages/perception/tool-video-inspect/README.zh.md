---
description: "通过 Session 文件系统与持久图片附件检查本地视频元数据和带时间码的画面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-video-inspect

[English](README.md) | 中文

## 概述

`video_inspect` 探测本地视频，或向支持图片的模型返回数量受限的解码画面。每张图片带有源帧显示时间码。新的 JSON 清单保留源文件版本、选定区间、画面引用和元数据；工具回读清单后才返回。

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

均匀采样选择等长区间的中间点。`timestamps_seconds` 可指定源文件中的具体时刻。每次默认最多 12 帧、覆盖 120 秒区间；默认区间最多 60 秒。源文件还有剩余区间时，`next_start_seconds` 指明下一个区间。对白和字幕另用现有 `audio_transcribe` 工具，遵守其账号与计费要求。

`strategy=scene_dialogue` 在实际 FFmpeg 镜头切换的前后选帧；`transcript_path` 指向同一完整视频的 `audio_transcribe` JSON 时，也取发声片段中点。说话人编号用于区分识别任务中的声音，不能直接当作人物姓名。调用方必须使用相同完整视频的转写，时间范围校验本身不能确认这种关联。`sampling_plan.selected` 解释本次返回的观察点，`sampling_plan.deferred` 列出未查看的时间点；后续通过 `timestamps_seconds` 分批复看，并在行动或人物归属不明处缩小区间。切镜检测可能漏掉渐变转场。

部署可配置 `sceneThreshold`（默认 0.25）、`scenePaddingSeconds`（0.12）、`maxPlanPoints`（1000）和 `maxTranscriptBytes`（2097152）。候选点超过预算时拒绝调用并提示缩短区间，不隐藏事件。没有转写也能按镜头切换抽帧；读取或抽帧期间转写发生变更时停止发布。

<a id="execution-and-storage"></a>
## 执行与存储

读取经由 `ctx.fs`；探测和解码经由 `ctx.subprocess`，遵守当前 Session 文件策略。受限执行要求有可用沙箱提供方。FFmpeg 只接受本地文件与管道协议。源文件大小、编码画面面积（`maxSourcePixels`，默认 33,177,600）、时长、画面尺寸、完整 PNG 字节数、进程超时和同时检查数量均可按部署配置。每条命令都等待进程范围退出，包括取消和失败。卸载插件会取消并等待其活动检查。

画面先进入规范化附件存储，再作为图片块返回。清单在当前工作区创建，不覆盖已有文件，之后回读核对。源文件版本发生变化时中止发布。原视频保持不变；结果不包含远程媒体链接或账号凭证。清单与附件各有唯一的存储所有者，因此不发布 invariant 配套模块。


自适应抽帧在输出切镜元数据前按所选来源时间区间裁定解码帧，并按返回帧数预算划分区间，在每个时段内优先选择切镜、再选择发声片段。开头密集切镜不会占满整次概览；其余观察点仍保留为待复看，概览不代表连续观看。

<a id="model-experience"></a>
## 模型体验

### `video_inspect` 工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-video-inspect) 记录参数。结果追加精简元数据、清单路径、采样区间、适用时的下一区间，以及前置源时间码的真实图片块。结果明确写出“These are sampled frames, not continuous viewing. Audio has not been transcribed.” 通用持久工具卡展示调用及元数据。

#### Token 影响

工具参数定义增加固定请求开销。结果增加受限文字及最多配置数量的图片输入；图片计费与请求缩放归选定供应商所有。完整视频字节不会进入模型上下文。

#### KV Cache 影响

工具结果追加，不改写之前的消息。参数定义或描述改变会改变可复用的请求前缀；画面附件在后续请求中增加视觉输入，直到常规图片卸载策略生效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 采样可能漏掉短暂动作、转场和口型变化。需要检查有疑点的时间码和后续区间；采样不证明全片已覆盖。
- 画面观察不能证明对白、说话人归属或声线一致。语音转写与人工听辨是独立步骤。
- 解码支持取决于安装的 FFmpeg。工具不获取网页链接、不使用供应商原生视频输入，也不自动识别人物。

<a id="dev-note"></a>
### 开发备注

专项测试使用真实 FFmpeg、文件系统读取和规范化附件。记录 Session 场景通过正式 profile 加载插件，只替换确定性的媒体进程输出。

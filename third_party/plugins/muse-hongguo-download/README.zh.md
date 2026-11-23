---
kind: package-reference
description: "使用固定版本的 GPL 引擎和 Muse 会话权限下载红果分集。"
---

# Muse 红果下载

[English](README.md) | 中文

<a id="use"></a>
## 使用

0.2.1 使用 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的固定版本 7.5（`4ffff289d6dd289e589a0fd0e65aa7aa5c2a7567`） 替换旧 Java/Python 及授权 v2 下载后端，保留 `hongguo_download_info` 和 `hongguo_download`。独立的数据搜索插件仍单独存在。播放适配使用上游 Android v5 签名和播放器接口，修复旧协议返回 HTTP 200 空响应的取流失败。上游源码、GPL-3.0 许可和原始声明位于 `upstream/`。

创作预设按会话启用插件。部署配置 `quality` 默认 `1080p`，也支持 `720p` 和 `auto`；`ffmpegExecutable`、`ffprobeExecutable`、`bytevc2Executable` 必须是绝对路径。ByteVC2 片源保持分辨率转换为 H.264/AAC；`bytevc2Concurrency` 限制并行转换数（默认 1），`bytevc2Threads` 限制解码及编码线程数（默认 2）。ByteVC2 密钥只在线程内传递，不进入进程参数。`decryptionConcurrency` 默认 1，`maxDecryptionBytes` 默认 256 MiB，`decryptionWorkerHeapMb` 默认 128。桌面预设使用内置媒体工具。新下载引擎不需要旧 Java 签名器、原 Python 模块或 v2 授权服务。共享 Python 准备仍供独立的番茄下载使用。

下载参数为十进制字符串 `seriesIds`，可选正整数集号 `episodes`、`quality`（`1080p`、`720p`、`auto`）和 `outputDir`。每次请求固定所选画质，并发请求和重试不会改变其他请求的来源。开源引擎省略 `quality` 时采用部署配置；官网公开播放器和授权媒体目录则默认 `auto`，保持原有的源文件语义。固定画质要求实际短边至少达到对应像素数，不会暗降级；更高分辨率保留原样。`auto` 沿用上游兼容优先的选源规则。

默认写入当前会话工作区的 `downloads`。只读会话拒绝下载，工作区权限仅允许写工作区；只有完全权限可以指定外部绝对目录。输出路径的符号链接被拒绝。

成功回执前会核对完整有序目录、传输完整性、解密后的 MP4 结构、预期尺寸和时长、请求清晰度、全部音视频解码以及 SHA256。取消和失败保留已验证分集与恢复日志，以相同参数再次调用可续下。只有声明全集均验证成功才设置 `complete: true`；目录成功不代表媒体可下载。卸载插件会中止调用并等待清理完成。

<a id="model-experience"></a>
## 下载任务

向 `hongguo_download` 传入 `mode: background` 可启动会话拥有的后台任务；默认 `wait` 保留前台取消语义。`hongguo_download_task` 可以列出、查看、暂停、继续、取消、重试任务，或移除已结束的记录。暂停和取消必须携带状态查询返回的精确 `expectedRunId`；只有 `acknowledged` 才表示清理和最终状态写入均已完成，`pending` 不表示停止成功。

当前工作区在 `.muse-downloads/hongguo` 保存私有记录，可通过 `taskDirectory` 配置。任务固定原会话或 CLI 所有者、规范工作区、输出目录、清晰度和来源标识。显式继续时重新检查当前写入权限与已验证进度。重启不会自动请求；进程清理未知时保持阻塞。移除记录保留视频和下载进度。指定分集的任务完成不代表整剧已下载。

[CLI profile](CLI.md) 提供不调用模型、不共用 Desktop 账号的本地命令。CLI 前台操作复用同一任务库，显式选择已有会话所有者时仍限定在该工作区。

## 合并分集

`hongguo_merge` 与 CLI 的 `merge` 命令从已停止下载任务的验证回执中合并分集，不访问网络。多剧任务须指定 `seriesId`。省略 `episodes` 保留原任务的选集；原任务选全集时则使用完整目录，缺少任一集即停止。显式选集按数字排序。每个输入重新核对路径、大小与 SHA256，合并期间持有原任务与下载进度的写入锁。

`mode: auto` 在 H264/HEVC 流配置完全一致时直接拼接，否则使用 `compatible`。`copy` 遇不同流参数拒绝。`compatible` 输出 H264；全部无音频时保留无音轨，否则使用 AAC 双声道 48 kHz，并为无音轨分集补静音。共同的偶数画布取各输入最小尺寸，保持宽高比缩放并补边。原分集不变。`outputFile` 可指定原任务下载进度目录中的 `.mp4` 文件名，已有视频或回执不覆盖。成功结果另附 JSON 回执、所选集号、实测尺寸和时长、完整解码验证及 SHA256。只选部分集时保持 `complete: false`。

`maxMergeEpisodes` 默认 1000，`maxMergeBytes` 默认 8 GiB；字节上限约束源文件与归一化文件的暂存合计，并单独约束最终 MP4。`mergeTimeoutMs` 默认两小时，`mergeThreads` 为 2，`mergePreset` 为 `veryfast`，`mergeFrameRate` 为 30，`mergeCrf` 为 23，`mergeAudioBitrate` 为 128000，`mergeDurationToleranceMs` 为 2000。时长差异取配置容差与“两输出帧或所选总时长百分之一的较大值”中较小者。取消会等待原生进程退出；清理未知时保留暂存和进程标记并阻止复用。合并重验当前权限，外部输出目录仍须完全权限。

## 模型体验

无法确认进程退出时，`cleanup_unconfirmed` 保留私有暂存目录及持久进程记录；重启后仍拒绝复用，需先检查对应进程和文件。已有目标文件不会被覆盖。

模型看到目录集数、真实文件路径、校验值和安全错误。下载回执区分 `requestedQuality` 与各集实测的 `width`、`height`、`quality`、`videoCodec`。旧已验证文件缺少测量记录时返回 `null`，不会用请求画质编造尺寸；只有来源和画质标识匹配才允许复用。结果不含媒体直链、签名、匿名设备信息或解密密钥。工具结果进入普通会话日志；只查目录不会下载媒体。

`hongguo_download` 的工具描述同时告知模型：抖音上有的完整短剧也用本工具下载，先用 `hongguo_search` 按剧名取得 `seriesId`，再下载全集或指定集，不逐条下载抖音视频。Muse Desktop 将 `hongguo_download` 设为常驻；目录、任务与合并工具按需通过工具搜索加载。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

ByteVC2 使用内置 Librempeg 解码组件；组件缺失或不兼容时停止操作。转换结果同样经过完整解码和校验，保留独立的原始传输哈希。上游可能变化或拒绝请求。超时、网络失败或 5xx 响应会重新取源，最多重试 `sourceRetries` 次（默认 2），每次等待 `sourceRetryDelayMs`（默认 2000）乘以重试序号。网页只提供预览且其余来源返回空的播放信息时，也按暂时失败重试。下载需要完整片源。App 或设备明确拒绝时立即停止取源。开源引擎模式下，重试后仍暂时失败的集会延后：先下载其余集，等待 `deferredSourceCooldownMs`（默认 60000）后对每个延后集再执行一轮取源，沿用同一个重试上限。仍缺的集列在可重试的错误中，重复同一请求即可续下载。取源失败只在 `sourceFailures` 中报告上游枚举代码，不返回上游原文。媒体重定向被拒时报告目标主机，确认是官方 CDN 后可加入 `mediaHosts`。尚未验收所有剧目、集数、地区和平台。旧进度文件保留，但不同引擎标识或清晰度不复用。组合插件以 GPL-3.0 分发，并附带上游和所打包依赖的对应源码。

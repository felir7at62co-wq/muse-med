---
kind: package-reference
description: "使用固定版本的 GPL 引擎和 Muse 会话权限下载红果分集。"
---

# Muse 红果下载

[English](README.md) | 中文

<a id="use"></a>
## 使用

0.2.0 使用 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的固定版本 `bb4aec994a1fc6336da55b269481ae2196124e8d` 替换旧 Java/Python 及授权 v2 下载后端，保留 `hongguo_download_info` 和 `hongguo_download`。独立的数据搜索插件仍单独存在。上游源码、GPL-3.0 许可和原始声明位于 `upstream/`。

创作预设按会话启用插件。部署配置 `quality` 默认 `1080p`，也支持 `720p` 和 `auto`；`ffmpegExecutable`、`ffprobeExecutable`、`bytevc2Executable` 必须是绝对路径。ByteVC2 片源保持分辨率转换为 H.264/AAC；`bytevc2Concurrency` 限制并行转换数（默认 1），`bytevc2Threads` 限制解码及编码线程数（默认 2）。ByteVC2 密钥只在线程内传递，不进入进程参数。`decryptionConcurrency` 默认 1，`maxDecryptionBytes` 默认 256 MiB，`decryptionWorkerHeapMb` 默认 128。桌面预设使用内置媒体工具。新下载引擎不需要旧 Java 签名器、原 Python 模块或 v2 授权服务。共享 Python 准备仍供独立的番茄下载使用。

下载参数为十进制字符串 `seriesIds`，可选正整数集号 `episodes`、`quality`（`1080p`、`720p`、`auto`）和 `outputDir`。每次请求固定所选画质，并发请求和重试不会改变其他请求的来源。开源引擎省略 `quality` 时采用部署配置；官网公开播放器和授权媒体目录则默认 `auto`，保持原有的源文件语义。固定画质要求实际短边至少达到对应像素数，不会暗降级；更高分辨率保留原样。`auto` 沿用上游兼容优先的选源规则。

默认写入当前会话工作区的 `downloads`。只读会话拒绝下载，工作区权限仅允许写工作区；只有完全权限可以指定外部绝对目录。输出路径的符号链接被拒绝。

成功回执前会核对完整有序目录、传输完整性、解密后的 MP4 结构、预期尺寸和时长、请求清晰度、全部音视频解码以及 SHA256。取消和失败保留已验证分集与恢复日志，以相同参数再次调用可续下。只有声明全集均验证成功才设置 `complete: true`；目录成功不代表媒体可下载。卸载插件会中止调用并等待清理完成。

<a id="model-experience"></a>
## 模型体验

无法确认进程退出时，`cleanup_unconfirmed` 保留私有暂存目录及持久进程记录；重启后仍拒绝复用，需先检查对应进程和文件。已有目标文件不会被覆盖。

模型看到目录集数、真实文件路径、校验值和安全错误。下载回执区分 `requestedQuality` 与各集实测的 `width`、`height`、`quality`、`videoCodec`。旧已验证文件缺少测量记录时返回 `null`，不会用请求画质编造尺寸；只有来源和画质标识匹配才允许复用。结果不含媒体直链、签名、匿名设备信息或解密密钥。工具结果进入普通会话日志；只查目录不会下载媒体。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

ByteVC2 使用内置 Librempeg 解码组件；组件缺失或不兼容时停止操作。转换结果同样经过完整解码和校验，保留独立的原始传输哈希。上游可能变化或拒绝请求，拒绝后停止取源。尚未验收所有剧目、集数、地区和平台。旧进度文件保留，但不同引擎标识或清晰度不复用。组合插件以 GPL-3.0 分发，并附带上游和所打包依赖的对应源码。

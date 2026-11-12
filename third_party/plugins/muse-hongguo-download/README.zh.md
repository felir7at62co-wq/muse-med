---
kind: package-reference
description: "使用固定版本的 GPL 引擎和 Muse 会话权限下载红果分集。"
---

# Muse 红果下载

[English](README.md) | 中文

<a id="use"></a>
## 使用

0.2.0 使用 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的固定版本 `bb4aec994a1fc6336da55b269481ae2196124e8d` 替换旧 Java/Python 及授权 v2 下载后端，保留 `hongguo_download_info` 和 `hongguo_download`。独立的数据搜索插件仍单独存在。上游源码、GPL-3.0 许可和原始声明位于 `upstream/`。

创作预设按会话启用插件。部署配置 `quality` 默认 `1080p`，也支持 `720p` 和 `auto`；`ffmpegExecutable`、`ffprobeExecutable` 必须是绝对路径。桌面预设使用内置媒体工具。新下载引擎不需要旧 Java 签名器、原 Python 模块或 v2 授权服务。共享 Python 准备仍供独立的番茄下载使用。

下载参数为十进制字符串 `seriesIds`，可选正整数集号 `episodes` 和 `outputDir`。默认写入当前会话工作区的 `downloads`。只读会话拒绝下载，工作区权限仅允许写工作区；只有完全权限可以指定外部绝对目录。输出路径的符号链接被拒绝。

成功回执前会核对完整有序目录、传输完整性、解密后的 MP4 结构、预期尺寸和时长、请求清晰度、全部音视频解码以及 SHA256。取消和失败保留已验证分集与恢复日志，以相同参数再次调用可续下。只有声明全集均验证成功才设置 `complete: true`；目录成功不代表媒体可下载。卸载插件会中止调用并等待清理完成。

<a id="model-experience"></a>
## 模型体验

模型看到目录集数、真实文件路径、校验值和安全错误；结果不含媒体直链、签名、匿名设备信息或解密密钥。工具结果进入普通会话日志；只查目录不会下载媒体。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

Muse 未内置 ByteVC2 解码器，因此此类片源在下载前明确拒绝。上游可能变化或拒绝请求，拒绝后停止取源。尚未验收所有剧目、集数、地区和平台。旧进度文件保留，但不同引擎标识或清晰度不复用。组合插件以 GPL-3.0 分发，并附带上游和所打包依赖的对应源码。

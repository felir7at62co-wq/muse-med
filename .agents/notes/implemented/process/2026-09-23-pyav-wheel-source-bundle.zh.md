# Agent Note: 独立保留 PyAV wheel 包源码，不与 FFmpeg 可执行文件混用

Status: implemented

[English](2026-09-23-pyav-wheel-source-bundle.md) | 中文

## 问题

保留的 PyAV Windows wheel 包内嵌 FFmpeg 8.1.2 DLL，独立于桌面的 FFmpeg 9.0.2 可执行文件。DLL 许可字符串报告 LGPL3，但上游 `patches/ffmpeg.patch` 将 x264/x265 从 GPL 列表中移出。不能凭此字符串省略随包 GPL 代码的许可声明或源码。

## 决定

[纯源码收集器](../../../../apps/desktop/scripts/pyav-source-bundle/README.zh.md)保留现有 wheel 包和桌面媒体锁文件。它收集固定仓库、全部 `pkg.py` 源码归档且不执行该文件、精确的 MSYS2 配方及其补丁／原生源码，以及 certifi/tqdm 的 sdist，组成带 SHA256 清单的源码集合。

PyAV 标签 [v18.1.0](https://github.com/PyAV-Org/PyAV/tree/v18.1.0) 选择 pyav-ffmpeg `8.1.2-1`。[锁文件](../../../../apps/desktop/scripts/pyav-source-bundle/lock.json)持有精确的仓库、MINGW-packages 配方和原生 pthread 源码版本。

[上游运行 `28393781929`、作业 `84127236786`](https://github.com/PyAV-Org/pyav-ffmpeg/actions/runs/28393781929/job/84127236786) 的经认证 Windows 日志确定 gcc/gcc-libs `16.1.0-5`、iconv `1.19-1`、pthreads `14.0.0.r92.g818fa6510-1` 和 zlib `1.3.2-2`，而不是根据当前软件包版本推断。

## 考虑过的替代方案

**使用 FFmpeg 可执行文件的源码配对。** 其 9.0.2 源码不匹配 wheel 包的 8.1.2 DLL。[现有源码配对决定](2026-09-23-muse-ffmpeg-source-pairing.zh.md)仍然有效且独立；此收集器既不取代它，也不修改其配方。

**认为 DLL 许可字符串已经足够。** 上游补丁及包含的 GPL x264/x265 与此捷径矛盾。分发审查必须检查实际代码并保留其许可声明。

## 验证

在收集器目录中，`python -B test_build.py` 通过七项测试，`python -B build.py --help` 确认 `build`／`verify` 接口。README 记载的完整收集命令成功完成，包括其内置字节校验。

## 后果

此收集方式避免替换 wheel 包，同时让源码输入可供审查。完整源码集合的构建和验证仍是分发前提，之后还须保留许可声明，并在同一版本发布中链接匹配的源码归档。这不能证明法律合规、wheel 包逐字节可重现或完整安装包已就绪。本地测试不能替代完整下载和归档验证。

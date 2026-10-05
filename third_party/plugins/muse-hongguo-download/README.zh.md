# Muse 红果下载工具

[English](README.md) | 中文

`hongguo_download_info` 检查来源及总集数；`hongguo_download` 接受多部 `seriesIds`，省略 `episodes` 时下载完整列表。工具默认使用 `legacy`，读取所提供完整 `Hongguo Downloader/app` 目录及其原接口。真实多部全集验收要求下载成功并完成媒体验证；源码文件齐全本身不代表验收通过。

下载先检查来源声明总集数和从 1 到 N 的连续集号，再按每 5 集请求视频地址，保留全部批次。每集检查传输长度和来源声明大小，经原离线模块处理加密视频，再用 ffprobe 检查可播放媒体流、ffmpeg 完整解码每个视频，并计算最终 SHA256。整批所有请求集完成后才发布目录及 `download-manifest.json`；某集失败或取消会等待所有工作停止并清理本次文件。Muse 工具从当前会话取得工作区，默认写入 `downloads`，`outputDir` 必须在该工作区内，目录中的符号链接被拒绝。文件路径和摘要会进入会话工具结果，带签名的媒体地址、设备值、Cookie、签名器响应、密钥和令牌不会写入结果。

`complete: true` 表示下载集号覆盖来源声明的 1–N。成功下载返回 `fullDecodeChecked: true` 和 `validationLevel: 'ffprobe-full-decode-sha256'`。所有来源模式都需要配置 ffmpeg 和 ffprobe；原加密视频还需要兼容的 Python 运行时及离线模块。缺少运行时、HLS、不支持的加密、网页响应及长度不完整的文件都会明确失败。插件不合并或转码。

## 来源配置

内置工具配置在 Muse preset 中；独立安装可通过 `dsh plugin --profile headless add /absolute/path/muse-hongguo-download-0.1.1.tgz` 加入 headless profile。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `sourceMode` | `legacy` | `legacy` 为原接口；`manifest` 为修复源码的授权目录；`public` 为显式官网公开播放器 |
| `legacyAppDir` | 空 | 包含 `config.json`、`devices.json`、签名素材及离线模块的原 `app` 绝对目录 |
| `signServer` | 空 | 原签名器 `http://127.0.0.1:端口`，请求 `/sign`；签名器程序不包含在插件中 |
| `signTokenEnv` | `MUSE_HONGGUO_SIGN_TOKEN` | 仅保存环境变量名称，令牌在运行时读取 |
| `pythonExecutable` | 空 | 用于原加密媒体模块、装有 PyCryptodome 的 CPython 3.11 可执行文件绝对路径 |
| `ffmpegExecutable` / `ffprobeExecutable` | 空 / 空 | 用于完整解码及媒体流检查的可执行文件绝对路径 |
| `catalogPath` | 空 | 修复源码 `HG_SOURCE_CATALOG` 格式的本地 JSON 绝对路径 |
| `outputRoot` | 空 | 独立客户端显式工作区；Muse 工具使用发起会话的工作区 |
| `mediaUserAgent` | `Mozilla/5.0 (Linux; Android 12)` | 媒体请求标识；原源媒体请求不携带官网 Referer 或会话凭据 |
| `retryDelayMs` | 1500 | 再次下载前的等待；原源重试会为失败集重新获取视频模型 |
| `mediaHosts` | `*.qznovelvod.com`、`*.douyinvod.com`、`*.pkoplink.com`、`*.bdcgslb.com` | 允许的原源媒体和实际观察到的 CDN 跳转域名，每次重定向同样验证 |
| `mediaPorts` | 443、9305 | 允许的 HTTPS 媒体端口；页面和原源 API 始终使用 443 |
| `maxSeries` / `maxEpisodes` | 10 / 200 | 单次最多剧数 / 每剧最多集数 |
| `concurrency` / `retries` | 3 / 2 | 同批并行下载上限 / 短暂网络错误重试次数 |
| `requestTimeoutMs` / `downloadTimeoutMs` / `callTimeoutMs` | 20000 / 600000 / 7200000 | 源请求 / 单集下载 / 全部调用时限 |
| `maxResponseBytes` / `maxEpisodeBytes` | 8388608 / 1073741824 | 元数据响应 / 单集大小上限 |
| `mediaProcessGraceMs` | 1000 | 强制终止本次媒体进程前的等待时限 |

原源必须返回声明总集数，缺少或与列表不一致时明确失败。修复版 `manifest` 只保证授权目录中的条目完整，不证明红果平台全集。`public` 必须显式选择；官网一般只开放部分集，默认整剧请求遇到未开放集会失败，不自动改为试看下载。缺少原源时同样不会自动切换到其他模式。

原运行目录包括 `config.json`、`devices.json`、`sign/unidbg-sign.jar`、`capture/fq_oversea` 中的两份签名素材，以及 `frida` 下的五个离线 `.pyc` 模块。签名器需要 Java 17，使用原 `com.hongguo.sign.FqTrace serve` 入口，工作目录设为 `app/sign`。其 `BIND_HOST` 应设为 `127.0.0.1`；插件只接受明确端口的 `http://127.0.0.1:端口` 地址。签名器 `HG_SIGN_TOKEN` 必须与 `signTokenEnv` 指向的值一致。插件不启动或公开签名器。

加密视频通过 [python/decrypt.py](python/decrypt.py) 调用所提供的离线模块。它们需要真实 CPython 3.11 和 PyCryptodome；较新 Python 无法导入这些字节码文件。此操作使用媒体模型中的密钥素材和下载文件在本地处理，无需 Android 或 ADB。桥接只通过 stdin 传递私密字段，并屏蔽原模块诊断输出。不支持的加密版本或媒体验证失败会终止整批。

内置 patch 从 `MUSE_HONGGUO_LEGACY_APP_DIR`、`MUSE_HONGGUO_SIGN_SERVER` 和 `MUSE_HONGGUO_PYTHON_PATH` 读取原源、签名器和 Python 配置；媒体路径读取 `DSH_FFMPEG_PATH` / `DSH_FFPROBE_PATH`，也可用 `FFMPEG_PATH` / `FFPROBE_PATH`。原源配置、Java/JAR、字节码模块、会话数据和令牌都不进入 tarball；[SOURCE.json](SOURCE.json) 记录供核对的源码指纹及 Muse host 版本。

## 开发验证

在此插件目录运行 `npm test` 和 `npm run check`。运行 `python3.11 -B -m unittest discover -s tests -p test_decrypt_bridge.py` 检查桥接；这些测试创建独立字节码样本，不加载用户原模块，也不发送平台请求。`node scripts/pack.mjs --out /绝对输出目录` 打包当前版本。原源验收必须下载至少两部完整声明列表，并对每个请求集完整解码。在此工作区配置前述原源和运行时环境变量，将至少两个真实 ID 以逗号分隔设为 `MUSE_HONGGUO_LIVE_IDS`，再运行 `npm run test:live`；它使用真实受管子进程服务并写出 `live-evidence.json`。公开试看及授权目录测试必须与真实原源多部全集验收分别记录。

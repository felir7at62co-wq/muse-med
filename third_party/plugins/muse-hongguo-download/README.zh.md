# Muse 红果下载工具

[English](README.md) | 中文

`hongguo_download_info` 检查来源及总集数；`hongguo_download` 接受多部 `seriesIds`，省略 `episodes` 时下载完整列表。工具默认使用 `legacy`，读取所提供完整 `Hongguo Downloader/app` 目录及其原接口。真实多部全集验收要求下载成功并完成媒体验证；源码文件齐全本身不代表验收通过。

下载先检查来源声明总集数和从 1 到 N 的连续集号，再按每 5 集请求视频地址，保留全部批次。每集检查传输长度和来源声明大小，经原离线模块处理加密视频，再用 ffprobe 检查可播放媒体流、ffmpeg 完整解码每个视频，并计算最终 SHA256。整批所有请求集完成后才发布目录及 `download-manifest.json`；某集失败或取消会等待所有工作停止并清理本次文件。Muse 工具从当前会话取得工作区，默认写入 `downloads`，`outputDir` 必须在该工作区内，目录中的符号链接被拒绝。文件路径和摘要会进入会话工具结果，带签名的媒体地址、设备值、Cookie、签名器响应、密钥和令牌不会写入结果。

`complete: true` 表示下载集号覆盖来源声明的 1–N。成功下载返回 `fullDecodeChecked: true` 和 `validationLevel: 'ffprobe-full-decode-sha256'`。所有来源模式都需要配置 ffmpeg 和 ffprobe；原加密视频还需要兼容的 Python 运行时及离线模块。缺少运行时、HLS、不支持的加密、网页响应及长度不完整的文件都会明确失败。插件不合并或转码。Desktop 将解密桥接脚本放在 ASAR 外，供外部解释器读取。

## 来源配置

Muse Desktop 内置本地 Java 17、CPython 3.11、PyCryptodome、签名素材及离线模块。首次原源请求通过原设备生成器创建一份私有设备配置，并自动启动带认证的本机签名器。独立安装可通过 `dsh plugin --profile headless add /absolute/path/muse-hongguo-download-0.1.2.tgz` 加入 headless profile。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `sourceMode` | `legacy` | `legacy` 为原接口；`manifest` 为修复源码的授权目录；`public` 为显式官网公开播放器 |
| `legacyAppDir` | 空 | 包含 `config.json`、`devices.json`、签名素材及离线模块的原 `app` 绝对目录 |
| `signServer` | 空 | 原本机签名器 `http://127.0.0.1:端口`，请求 `/sign`；显式设置时使用外部管理的签名器 |
| `signTokenEnv` | `MUSE_HONGGUO_SIGN_TOKEN` | 仅保存环境变量名称，令牌在运行时读取 |
| `pythonExecutable` | 空 | 用于原加密媒体模块、装有 PyCryptodome 的 CPython 3.11 可执行文件绝对路径 |
| `javaExecutable` | 空 | 省略 `signServer` 时使用的 Java 17 可执行文件绝对路径 |
| `bootstrapDevices` / `deviceBootstrapTimeoutMs` | false / 30000 | 使用锁定的原生成器初始化一份私有设备 / 初始化时限；Desktop 启用初始化 |
| `signerStartupTimeoutMs` / `signerHeapMb` | 120000 / 1024 | 延迟启动时限 / Java 最大堆内存 MiB |
| `signerPollIntervalMs` / `signerPortAttempts` | 25 / 4 | 就绪轮询间隔 / 本机端口被占用后的尝试次数 |
| `ffmpegExecutable` / `ffprobeExecutable` | 空 / 空 | 用于完整解码及媒体流检查的可执行文件绝对路径 |
| `catalogPath` | 空 | 修复源码 `HG_SOURCE_CATALOG` 格式的本地 JSON 绝对路径 |
| `outputRoot` | 空 | 独立客户端显式工作区；Muse 工具使用发起会话的工作区 |
| `mediaUserAgent` | `Mozilla/5.0 (Linux; Android 12)` | 媒体请求标识；原源媒体请求不携带官网 Referer 或会话凭据 |
| `retryDelayMs` | 1500 | 再次下载前的等待；原源重试会为失败集重新获取视频模型 |
| `mediaHosts` | `*.qznovelvod.com`、`*.douyinvod.com`、`*.idouyinvod.com`、`*.pkoplink.com`、`*.bdcgslb.com`、`*.vegslb.com`、`*.jspcdn.cn`、`*.qrstuvwxyzab.com` | 允许的原源媒体和实际观察到的 CDN 跳转域名，每次重定向同样验证 |
| `mediaPorts` | 443、9305 | 允许的 HTTPS 媒体端口；页面和原源 API 始终使用 443 |
| `maxSeries` | 10 | 单次最多剧数；集数按完整原源目录确定，不另设集数上限 |
| `concurrency` / `retries` | 3 / 2 | 同批并行下载上限 / 短暂网络错误重试次数 |
| `requestTimeoutMs` / `downloadTimeoutMs` / `callTimeoutMs` | 20000 / 600000 / 7200000 | 源请求 / 单集下载 / 全部调用时限 |
| `maxResponseBytes` / `maxEpisodeBytes` | 8388608 / 1073741824 | 元数据响应 / 单集大小上限 |
| `mediaProcessGraceMs` | 1000 | 强制终止本次媒体进程前的等待时限 |

原源必须返回声明总集数，缺少或与列表不一致时明确失败。修复版 `manifest` 只保证授权目录中的条目完整，不证明红果平台全集。`public` 必须显式选择；它返回的视频 ID 必须有效、不重复，数量与声明总集数一致。下载计划使用这份实际列表，不另设集数上限。官网一般只开放部分集，默认整剧请求遇到未开放集会失败，不自动改为试看下载。缺少原源时同样不会自动切换到其他模式。

原运行时使用通用 `config.json`、私有 `devices.json`、`devicepool.pyc`、原签名素材及五个离线模块。Muse 将校验过摘要的不可变源码资源安装到私有产品数据目录，并在重启后保留该设备。设备初始化失败会等待所拥有的进程停止，再返回固定的安全错误。首次使用才通过 Java 17 在私有签名目录启动 `com.hongguo.sign.FqTrace serve`，设置 `BIND_HOST=127.0.0.1` 和随机实例令牌。释放时等待进程及其子进程全部停止。显式 `signServer` 保留外部本机配置，其 `HG_SIGN_TOKEN` 必须与 `signTokenEnv` 一致。

加密视频通过 [python/decrypt.py](python/decrypt.py) 调用所提供的离线模块。它们需要真实 CPython 3.11 和 PyCryptodome；较新 Python 无法导入这些字节码文件。此操作使用媒体模型中的密钥素材和下载文件在本地处理，无需 Android 或 ADB。桥接只通过 stdin 传递私密字段，并屏蔽原模块诊断输出。不支持的加密版本或媒体验证失败会终止整批。

内置 patch 从 `MUSE_HONGGUO_LEGACY_APP_DIR`、`MUSE_HONGGUO_JAVA_PATH` 和 `MUSE_HONGGUO_PYTHON_PATH` 读取源码、Java 和 Python 路径；`MUSE_HONGGUO_BOOTSTRAP_DEVICES=1` 为通用源码安装启用原设备生成器。Desktop 提供这些配置。媒体路径读取 `DSH_FFMPEG_PATH` / `DSH_FFPROBE_PATH`，也可用 `FFMPEG_PATH` / `FFPROBE_PATH`。独立 tarball 包含两个 Python 桥接脚本，不含 Java、原字节码、已保存的设备配置和令牌。Desktop 分发独立锁定的运行时；[SOURCE.json](SOURCE.json) 记录源码指纹及所属锁定文件。

## 开发验证

在此插件目录运行 `npm test` 和 `npm run check`。运行 `python3.11 -I -B -m unittest discover -s tests -p 'test_*.py'` 检查桥接；这些测试创建独立字节码样本，不加载用户原模块，也不发送平台请求。`node scripts/pack.mjs --out /绝对输出目录` 打包当前版本。原源验收必须下载至少两部完整声明列表，并对每个请求集完整解码。在此工作区配置前述原源和运行时环境变量，将至少两个真实 ID 以逗号分隔设为 `MUSE_HONGGUO_LIVE_IDS`，再运行 `npm run test:live`；它使用真实受管子进程服务并写出 `live-evidence.json`。公开试看及授权目录测试必须与真实原源多部全集验收分别记录。

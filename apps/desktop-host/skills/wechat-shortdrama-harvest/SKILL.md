---
name: wechat-shortdrama-harvest
description: Use when 用户提供微信小程序、视频号或 #小程序:// 短剧资源，需要在 Windows 登录的微信中取得可访问的视频，批量下载、判集归档后转写。
---

# 微信短剧资源导入

这是所有可加载技能的 Muse 模式共用的能力。使用随包 `python` 和本目录 `scripts/`，不向安装目录写配置，不在运行时 pip 安装依赖。Windows 微信须已登录并打开用户指定的小程序或剧目；脚本利用当前播放产生的缓存与媒体地址下载。不同微信版本、平台页面和视频号格式可能不兼容，不保证所有链接可下载。付费、登录或访问受限时报告实际缺口，不点击购买、不解密受保护视频。

## 项目与状态

先选择用户授权的项目根目录，为本次任务设置绝对的 `SHORTDRAMA_WORK=<项目>/source/media/wechat/<任务名或版本>`。后续每次调用都传入相同环境变量；恢复同一任务时复用，新任务用新目录。脚本默认落到当前目录的 `source/media/wechat`，不能把安装目录作为工作目录。配置和票据只在该任务目录保存，不打印或上传 `config.json`、原始状态、Cookie、session、ticket 或带签名的 URL。

在项目 `source/links.md` 记录用户给的分享页、平台、剧名、集数、取得时间和下载状态，不写临时媒体签名。视频在任务目录 `<剧名>/episodes/`，原始下载在 `<剧名>/raw/`，判集报告和缺集列表留在该任务目录。已有用户视频只读引用；归档遇到不同内容的同名文件会停止，应换新版本目录，不能覆盖。

## 获取与核对

`<skill-dir>` 指本文件目录。下面命令使用 Muse 随包 Python，调用时使用 `-B` 并设置上述环境变量。

1. `python -B "<skill-dir>/scripts/doctor.py"`：检查微信和随包 numpy、OpenCV、SciPy。缺少微信时请用户登录并打开目标资源；缺少随包依赖时报安装问题，不擅自改用户 Python。
2. `python -B "<skill-dir>/scripts/drive.py" --check --window "<目标窗口标题>"`：查看目标窗口状态。导航前阅读 `drive.py --help`。`--open-miniapp`、`--open` 可打开用户指定资源；默认后台点击，`--fg` 会占用前台，应先说明。
3. `python -B "<skill-dir>/scripts/discover.py"`：发现缓存中的候选剧目。按用户剧名核对后，用 `discover.py <drama_id>` 选择并读取集数、时长与封面。只有一个候选且与用户目标相符时可用 `--auto`；历史缓存里的其他作品不是下载授权。
4. 已有目标播放记录时先运行 `harvest.py --once`，核对命中的剧目、时长和封面。遍历多集时运行 `drive.py --auto --window "<目标窗口标题>" --max-minutes 20`，该命令结束时会自动归档候选文件，归档数量不代表已核对完成；分段检查 `status.py --json`。同一任务只跑一个采集流程，不用 `--force`；不能仅凭新出现的缓存就把其他作品计入目标全集。
5. `finalize.py --report-only` 检查时长与画面判集报告；手动采集后用 `finalize.py` 归档，自动采集后复核已归档文件；`verify.py` 可反查疑似错集。必须对照预计集数、实际可解码文件、缺集与重复集，再报告完成范围。没有证据时只能说已取得若干集，不能说全集已完成。

结束后停止自己启动的采集进程。只交付核对过的 `episodes/` 路径与简明缺集报告；辅助 `salvage.py`、`supervisor.py` 仅在了解其 `--help` 后用于当前任务，不能无限轮询。

## 进入转写与编辑

取得可读视频后加载 `audio-transcribe`，再按需求加载 `transcript-to-script` 或 `transcript-to-novel`。原始转写放项目 `transcript/raw/`，校订稿放 `transcript/reviewed/`，大纲放 `outline/`，过程稿放 `draft/`，最终交付放 `final/`，核对记录放 `qa/`。剧本正文不带时间轴；原始转写可保留时间码供核对。编辑模式再沿用案例入库、换梗方案、用户定大纲和写作交付流程；缺集须在交付说明中标明，不编造缺失情节作为转写结果。

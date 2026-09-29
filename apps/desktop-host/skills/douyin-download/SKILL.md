---
name: douyin-download
description: 当用户提供抖音分享短链、视频页或带 modal_id 的精选页，要下载视频用于转写、剧本改编或分析时使用；所有 Muse 模式共享。
---

# 抖音视频获取

收到 `v.douyin.com`、`douyin.com/video/…` 或 `douyin.com/jingxuan?modal_id=…` 时先用本技能，不把直链导入器的限制当作 Muse 无法处理抖音的理由。用户要求对所给视频做转写或改编时，先尝试获取该视频，不要求用户再手动下载一遍。单条链接只代表该视频；剧名或全集需求先搜索并核对目标作品、版本和集数，不把单条成功报告为全集下载完成。

## 下载与核对

使用 Muse 随包 Python 和本目录的 `scripts/download.py`；所需 yt-dlp 已随技能内置并锁定版本与 SHA-256，不运行 pip，不写安装目录。先取得随包 ffprobe 的可执行路径；可从媒体运行环境或 `load_workspace_dependencies` 发现，不能臆造路径。

```text
python -B "<skill-dir>/scripts/download.py" --url "<用户提供的抖音链接>" --project "<已存在的项目绝对目录>" --ffprobe "<随包 ffprobe 路径>"
```

脚本会把 `modal_id` 规范化为作品页、解析抖音分享短链，再让平台提取器取得当前媒体地址。平台返回的带参数、临时签名媒体地址可以交给该提取器下载，不应以“带参数”一律拒绝。公开视频先无凭据尝试；只有实际遇到登录、Cookie 或验证要求，才请用户在自己浏览器打开目标并完成必要操作。用户可明确提供本地 Netscape Cookie 文件路径，随后追加 `--cookie-file "<本地文件路径>"`；不要让用户把 Cookie 粘贴进会话，不自动搜集浏览器账号，也不复制开发者个人凭据到用户安装包。访问受限或受保护的视频如实报告，不购买或解密。

视频保存到 `<项目>/source/media/douyin/<作品ID>.<格式>`，旁边的 `.source.json` 记录公开作品页、大小、SHA-256、媒体时长与取得时间，不包含 Cookie 或临时媒体地址。已有同名文件不覆盖；先检查原件和来源记录，缺失、失败或验证未通过不能声称已下载。脚本仅在 ffprobe 确认有可读视频流后报告成功，默认单条上限 2 GiB。网络失败、页面变化或平台验证仍可能导致下载失败；按实际返回说明缺项，不能把失败泛化为所有抖音页面不支持。

## 衔接编辑

把公开作品页、作品ID、原件路径、任务范围和下载状态写入 `source/links.md`。取得视频后加载 `audio-transcribe`，再按任务加载 `transcript-to-script` 或 `transcript-to-novel`，不要求用户重复上传已下载文件。原始转写放 `transcript/raw/`，核对剧本放 `transcript/reviewed/`，大纲放 `outline/`，最终 Markdown/Word 放 `final/`；剧本正文不带时间轴。云转写鉴权失败时先核对 Muse 账号状态并报告真实错误，不把随意重启说成已验证的修法。

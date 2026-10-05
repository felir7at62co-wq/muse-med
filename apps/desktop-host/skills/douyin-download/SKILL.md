---
name: douyin-download
description: 用户提供抖音分享短链、视频页或带 modal_id 的作品页，并要求取得视频用于转写、改编或分析时使用；所有 Muse 模式共享。
---

# 抖音视频获取

接受官方 HTTPS 视频页、分享短链或带唯一 `modal_id` 的作品页。用户提供具体链接时，调用内置 `douyin_download`，传 `url`；已核对的多条链接用 `urls` 数组，两者二选一。工具自动使用当前会话工作区，默认先无凭据尝试平台提取器和官方手机分享页 `_ROUTER_DATA`。`publicOnly:true` 只做公开尝试。单条或多条剪辑不等于全集覆盖；需要搜索时使用当前模式的公开网页搜索，先核对作品、版本和集数再下载。

## 内置页面与登录

公开访问失败后，配套 Desktop Host 可以打开 MUSE 内置 Browser 官方页面。工具调用自动开始下载；需要登录或验证时，请用户在官方页面正常完成。抖音登录按工作区保存在 MUSE 内置浏览器中，重启后可继续使用。不要替用户处理验证码，不读取外部 Chrome 数据库、钥匙串或 Cookie 文件，不要求用户提供配置路径、安装 Python 或粘贴 Cookie。

其他网页继续使用进程内的临时存储。缺少配套 Host 时返回 DESKTOP_HOST_REQUIRED，缺少验证程序则 blocked；报告维护方依赖，不把插件单独安装说成开箱即用。Host 可以按确切播放器地址识别作品，或按页面自身收到的成功官方详情响应、确切作品 ID 和视频参数识别普通 MP4；后者不声称播放器与详情转码地址完全相等。来源不能可靠关联到确切作品、blob/分片或页面无目标公开元数据时返回 unsupported。403、验证码、DRM 或平台拒绝访问时停止，不制造签名或绕过限制。

## 下载与后续核对

内置浏览器最多一个任务、100 MiB、120 秒，页面/租约关闭、切换会话或作品、取消和过期会撤销。普通浏览器下载始终默认拒绝。HTTP 200/206、页面能播放或 STAGED 均不代表成功。只有工具返回 downloaded 且真实文件通过 ffprobe 视频流/时长检查、大小和 SHA-256 核对，且 ffmpeg 完整解码成功，才可报告下载完成。

输出位于 `source/media/douyin/`，旁边 `.source.json` 记录公开作品页、作品 ID、大小、时长、哈希、完整解码及脱敏来源证据，不含临时媒体地址或凭据。批量只有全成功为 complete，部分成功为 partial，其余 blocked。失败应报告确切缺项，不声称真实下载成功，也不泛化为所有抖音页面都不支持。

取得已验证视频后加载 `audio-transcribe`，按任务加载 `transcript-to-script` 或 `transcript-to-novel`。把作品链接、原件路径和任务范围写入 `source/links.md`；转写放 `transcript/raw/`，核对稿放 `transcript/reviewed/`，大纲放 `outline/`，最终文件放 `final/`。不要要求用户重复上传已取得的文件；鉴权失败如实报告，不把重启说成已验证修法。

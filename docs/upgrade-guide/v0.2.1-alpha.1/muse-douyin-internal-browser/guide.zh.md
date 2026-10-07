---
kind: upgrade-guide
description: Muse 抖音浏览器获取要求版本 4 和显式原生超时预算。
---

# Muse 抖音内置浏览器

[English](guide.md) | 中文

## 变更

`douyin_download` 移除 `browser`、`browserProfile`、`rememberBrowser`、`cookieFile`。公开请求忽略保存的外部浏览器选择。授权内置播放依赖 配套 Desktop Main 与 Host 协议 6 和浏览器获取接口版本 4；仅安装此插件不能启用。获取接口版本不匹配时，在发起原生请求前返回 `DESKTOP_HOST_REQUIRED`。

原生来源记录区分 `player-exact`、`provider-detail-verified` 和 `player-metadata-verified`。详情方式将页面自身收到的成功官方详情响应绑定到确切作品 ID 和普通 MP4 地址，记录 `currentSrcMatched:false`，下载后比对本地时长及宽高比。不同播放器/详情转码地址无需相等。来源记录消费者必须保留识别方式；所有方式均绑定 Host、会话、浏览器页面和作品。播放器元数据保留独立的父节点来源标记，不宣称观察到详情响应。

Host 就绪消息包含 `hostProtocolVersion:6`；版本不匹配或缺失时拒绝启动。浏览器获取接口版本 4 提供 `data(agent, selection, signal)`，并要求 `download(agent, url, signal, maxDownloadBytes, nativeTimeoutMs)`。内置插件对两种方法均拒绝版本 2 和 3；不支持混用应用与插件版本。`douyin_data` 返回确切作品的公开计数、独立评论查询状态及可选的已验证下载。缺失的公开播放量与零占位值均标为不可用。正常 Creator 页面仅在字符串作品 ID、修改权限和统计中的作品 ID 匹配后返回所选本人作品的计数。未核验归属返回 `CREATOR_OWNERSHIP_UNVERIFIED`；正常登录不声称获得官方 OAuth 授权。

## 迁移

1. 一起安装配套 Muse 应用及其内置 `muse-douyin-download`。自定义 Host 集成须同时将 Main 与 Host 更新至协议 6，将浏览器获取接口更新至版本 4，在准备、下载和文件验证阶段传递经过验证的 `maxDownloadBytes` 与 `nativeTimeoutMs`。
2. 调用方移除四个外部浏览器参数，传官方 `url` 或 `urls`。用 `publicOnly:true` 禁用浏览器回退。
3. 随包提供或解析 ffmpeg/ffprobe 和已验证主运行环境。只有正常页面播放、自动获取 和完整解码的文件来源记录均通过，才算真实验收。已有外部浏览器选择文件不读取、不迁移、不删除。

`maxDownloadBytes` 默认 512 MiB，可配置为 1 字节到 8 GiB。公开请求与内置浏览器文件使用同一设置。`nativeTimeoutMs` 默认 1800000 毫秒，接受 1000 到 7200000 的整数。原生传输与完整本地验证分别获得等长的独立预算；准备与媒体关联分别另有 120 秒截止。传输预算从选定媒体后开始；宿主下载 IPC 还包含关联时长及 10 秒送达时间。公开 Python 的 `timeoutMs` 保持独立。组合批次截止超过 Node 计时器范围时，请降低 `maxVideos` 或预算。

官方抖音视频页按工作区保留登录，应用重启后可继续使用。工具调用开始每个作品的下载，不再重复询问权限；首次登录和平台验证需要用户完成。其他浏览器页面继续使用临时存储。

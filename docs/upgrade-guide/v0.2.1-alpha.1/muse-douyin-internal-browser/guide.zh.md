---
kind: upgrade-guide
description: Muse 抖音工具不再接受外部浏览器配置或 Cookie 文件参数。
---

# Muse 抖音内置浏览器

[English](guide.md) | 中文

## 变更

`douyin_download` 移除 `browser`、`browserProfile`、`rememberBrowser`、`cookieFile`。公开请求忽略保存的外部浏览器选择。授权内置播放依赖 Desktop Host 协议 5 和浏览器获取接口版本 2；仅安装此插件不能启用。获取接口版本不匹配时，在发起原生请求前返回 `DESKTOP_HOST_REQUIRED`。

原生来源记录区分 `player-exact` 与 `provider-detail-verified`。详情方式将页面自身收到的成功官方详情响应绑定到确切作品 ID 和普通 MP4 地址，记录 `currentSrcMatched:false`，下载后比对本地时长及宽高比。不同播放器/详情转码地址无需相等。来源记录消费者必须保留识别方式；两种方式均绑定 Host、会话、浏览器页面和作品。

## 迁移

1. 一起安装配套 Muse 应用及其内置 `muse-douyin-download`。自定义 Host 集成须将浏览器获取接口更新至版本 2，并在准备、下载和文件验证阶段传递经过验证的 `maxDownloadBytes`。
2. 调用方移除四个外部浏览器参数，传官方 `url` 或 `urls`。用 `publicOnly:true` 禁用浏览器回退。
3. 随包提供或解析 ffmpeg/ffprobe 和已验证主运行环境。只有正常页面播放、自动获取 和完整解码的文件来源记录均通过，才算真实验收。已有外部浏览器选择文件不读取、不迁移、不删除。

`maxDownloadBytes` 默认 512 MiB，可配置为 1 字节到 8 GiB。公开请求与内置浏览器文件使用同一设置。

官方抖音视频页按工作区保留登录，应用重启后可继续使用。工具调用开始每个作品的下载，不再重复询问权限；首次登录和平台验证需要用户完成。其他浏览器页面继续使用临时存储。

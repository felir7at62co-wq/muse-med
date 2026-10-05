---
kind: upgrade-guide
description: Muse 抖音工具不再接受外部浏览器配置或 Cookie 文件参数。
---

# Muse 抖音内置浏览器

[English](guide.md) | 中文

## 变更

`douyin_download` 移除 `browser`、`browserProfile`、`rememberBrowser`、`cookieFile`。公开请求忽略保存的外部浏览器选择。授权内置播放依赖 Desktop Host 协议 5 和单次下载接口；仅安装此插件不能启用。

原生来源记录区分 `player-exact` 与 `provider-detail-verified`。详情方式将页面自身收到的成功官方详情响应绑定到确切作品 ID 和普通 MP4 地址，记录 `currentSrcMatched:false`，下载后比对本地时长及宽高比。不同播放器/详情转码地址无需相等。来源记录消费者必须保留识别方式；两种方式均绑定 Host、会话、浏览器页面和作品。

## 迁移

1. 将 Host 补丁与 MUSE 应用一起安装，并安装 `muse-douyin-download-0.2.0-dev.native.1.tgz`。
2. 调用方移除四个外部浏览器参数，传官方 `url` 或 `urls`。用 `publicOnly:true` 禁用浏览器回退。
3. 随包提供或解析 ffmpeg/ffprobe 和已验证主运行环境。只有正常页面播放、自动获取 和完整解码的文件来源记录均通过，才算真实验收。已有外部浏览器选择文件不读取、不迁移、不删除。

官方抖音视频页按工作区保留登录，应用重启后可继续使用。工具调用开始每个作品的下载，不再重复询问权限；首次登录和平台验证需要用户完成。其他浏览器页面继续使用临时存储。

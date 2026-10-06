# Muse 抖音下载工具

[English](README.md) | 中文

`douyin_download` 接受已选择的官方 HTTPS 视频/分享 `url`，或已核对的 `urls` 列表，验证后保存到发起会话的 `source/media/douyin/`。公开请求始终忽略保存的浏览器设置；`publicOnly:true` 禁用内置浏览器回退。工具不接受浏览器配置、Cookie 文件、记住账号或任意输出目录。

## 运行环境与配置

此包的内置浏览器获取功能依赖 Desktop Host 协议 5和 `douyinBrowser.version === 1`。单独安装插件不会增加浏览器下载接口。Desktop 自动选择经过验证的随包 Python，保留显式媒体程序设置，并从随包媒体目录或普通 PATH 查找已有 ffmpeg/ffprobe；不安装依赖或修改 PATH。Mac 安装包包含对应架构的媒体程序，运行时查找不会安装依赖。打包后的 Python 脚本及提取器归档位于 ASAR 外，使内置解释器可以读取。

公开执行器需要 `agents`、`tools`、`subprocess`；浏览器回退还需要宿主下载接口。部署配置保留 `pythonExecutable`、`ffprobeExecutable`、`ffmpegExecutable`、`settingsHome`、`requestTimeoutMs`、`timeoutMs`、`maxDownloadBytes`、`graceMs`、`maxVideos`。执行器默认 120 秒、100 MiB、20 条链接；公开执行器的部署配置可能不同。内置浏览器固定最多一个任务、100 MiB、120 秒，含准备时间。缺少验证程序时返回 blocked。

## 内置播放与结果

公开访问失败后，MUSE 在当前会话的隔离 Browser 面板打开官方页面。用户正常完成登录、验证和播放；发起工具调用后，Host 自动开始下载确切作品。官方抖音视频页按工作区保留登录，应用重启后可继续使用；其他浏览器页面使用进程内临时存储。下载器不访问外部浏览器数据库，不导出会话凭据，不制造签名，不绕过访问控制、验证码或 DRM。

传输通过两种方式识别媒体：`player-exact` 要求匹配作品的公开 `_ROUTER_DATA` 和唯一可见播放器来源的成功 MP4 响应；`provider-detail-verified` 要求页面自身收到的官方目标详情 JSON、确切作品 ID、有界普通 MP4 地址，以及匹配的可见播放器时长。后者只观察主文档的成功目标响应，记录 `currentSrcMatched:false`，不改写签名地址、不主动请求 API。CDN 请求和重定向必须解析为公网地址。缺失元数据、推荐视频、受保护媒体、blob、分片或来源关联不明确均为 unsupported。观察到 200/206 不代表完整下载。单次授权绑定 Host、窗口 owner、会话、任务、租约和目标作品，只放行确切原生请求；普通浏览器下载继续拒绝。切换会话、替换文档、关闭页面、过期、取消或 Host 断开都会撤销并停止验证。

成功必须有上限内的非零真实字节、ffprobe 视频流/时长/尺寸检查、ffmpeg 完整解码和 SHA-256。按详情选择的文件还须匹配详情时长（误差不超过 0.25 秒）和宽高比（误差不超过 1%）。来源记录包括公开作品页、任务/作品 ID、大小、时长、尺寸、识别方式、媒体主机名及临时 URL 哈希，不包含 Cookie、Authorization 或签名媒体地址。已有输出不覆盖；`STAGED` 仅表示传输完成，不是工具下载成功。批量结果按验证后的各项返回 complete、partial 或 blocked。

## 验证与打包

执行 `node --test tests/*.test.js` 和 `node scripts/pack.mjs --out /absolute/output/directory`。包内包含锁定的公开 Python 提取器；内置浏览器获取依赖配套 Host 补丁。离线和合成媒体测试不能证明真实验收链接可下载，真实验收还需正常播放和该链接对应的文件验证记录。

# Muse 抖音数据与下载工具

[English](README.md) | 中文

`douyin_download` 接受已选择的官方 HTTPS 视频/分享 `url`，或已核对的 `urls` 列表，验证后保存到发起会话的 `source/media/douyin/`。公开请求始终忽略保存的浏览器设置；`publicOnly:true` 禁用内置浏览器回退。工具不接受浏览器配置、Cookie 文件、记住账号或任意输出目录。

## 运行环境与配置

随包集成的页面数据与内置浏览器获取功能依赖 Desktop Host 协议 6 和 `douyinBrowser.version === 3`。下载工具也接受现有的版本 2 下载服务。单独安装插件不会增加浏览器下载接口。Desktop 自动选择经过验证的随包 Python，保留显式媒体程序设置，并从随包媒体目录或普通 PATH 查找已有 ffmpeg/ffprobe；不安装依赖或修改 PATH。Mac 安装包包含对应架构的媒体程序，运行时查找不会安装依赖。打包后的 Python 脚本及提取器归档位于 ASAR 外，使内置解释器可以读取。

公开执行器需要 `agents`、`tools`、`subprocess`；浏览器回退还需要宿主下载接口。部署配置保留 `pythonExecutable`、`ffprobeExecutable`、`ffmpegExecutable`、`settingsHome`、`requestTimeoutMs`、`timeoutMs`、`maxDownloadBytes`、`graceMs`、`maxVideos`、`dataTimeoutMs`、`maxComments`。执行器默认 120 秒、512 MiB、20 条链接；页面数据默认每条链接 30 秒、每页 20 条评论。`requestTimeoutMs` 还用于在外层传输截止前等待页面结果送达。`maxDownloadBytes`（1 字节到 8 GiB）同时用于公开下载、内置浏览器传输和本地文件验证。内置浏览器最多一个任务、120 秒，含准备时间。缺少验证程序时返回 blocked。

## 页面数据与可选下载

`douyin_data` 接受 `url` 或 `urls`，数量不超过 `maxVideos`，按顺序读取所选作品。`source` 可选 `public`、`creator` 或 `auto`；成功结果标明 `public-page` 或 `creator-page` 以及观察时间。创作者数据要求正常登录，并有证据将确切作品关联到该账号。浏览器登录不授予 OAuth API 权限。`auto` 使用公开页。`creator` 打开正常的创作者内容管理页，要求字符串作品 ID、同一位置的修改权限和统计中的作品 ID 一致。仅返回所选作品；未核验归属时返回 `CREATOR_OWNERSHIP_UNVERIFIED`。必要时完成页面加载或在正常页面中定位较早作品。公开数据不替代不可用的创作者数据。

五项计数分别是播放、点赞、评论、分享和收藏，每项返回精确数值、取整显示值，或带原因的 `null`。公开计数来自确切作品的正常详情响应、页面初始数据或唯一可见的作品操作栏，保留源提供的正数播放量；缺失值和占位零仍为不可用。`includeComments:true` 请求一个已观察的评论页，数量受 `commentLimit` 和 `maxComments` 限制；`commentCursor` 只适用于单条作品链接。总评论数与返回的评论条目分开。Desktop 的评论内容和分页返回 `COMMENTS_UNAVAILABLE`，保留已观察计数，并将结果标为 partial。数据格式支持有界的评论文本、评论 ID 和数值计数，不包含账号标识或凭据。

`download:true` 通过现有下载器获取每条所选作品；页面数据已解析分享链接时，使用已核验的作品正式地址，并包含独立的下载结果。下载失败仍保留可用数据；数据不可用也可伴随经过验证的下载。批量结果为 complete、partial 或 blocked，各项保持输入顺序。取消会等待已接入的浏览器读取或子进程结束，在已记录的取消结果中保留已观察数据，并阻止下一条链接开始。只读页面数据不需要 Python 或媒体程序。数据保存在模型可见且持久记录的工具结果中；此工具不另建统计文件。

## 内置播放与结果

公开访问失败后，MUSE 在当前会话的隔离 Browser 面板打开官方页面。用户正常完成登录、验证和播放；发起工具调用后，Host 在初始主文档导航结束后自动开始下载确切作品；播放检查也等待主文档加载结束。播放检查、DNS 解析、暂存和原生下载启动失败分别返回独立的 blocked 代码。官方抖音视频页按工作区保留登录，应用重启后可继续使用；其他浏览器页面使用进程内临时存储。下载器不访问外部浏览器数据库，不导出会话凭据，不制造签名，不绕过访问控制、验证码或 DRM。

传输通过两种方式识别媒体：`player-exact` 要求匹配作品的公开 `_ROUTER_DATA` 或播放器父节点中有界的 `awemeInfo` 属性，以及唯一可见播放器来源的成功 MP4 响应；`provider-detail-verified` 要求页面自身收到的官方目标详情 JSON、确切作品 ID、有界普通 MP4 地址，以及匹配的可见播放器时长。后者只观察主文档的成功目标响应，记录 `currentSrcMatched:false`，不改写签名地址、不主动请求 API。CDN 请求和重定向必须通过租约所属浏览器的网络环境解析为公网地址。同源的普通 blob 播放可提供详情关联的时长依据，下载地址仍须是确切官方详情响应中的普通 HTTPS MP4；player-exact 分支拒绝 blob 来源。公开播放器属性支持字符串地址或 `{src}` 条目。播放器加载媒体数据后，暂停状态仍可用于来源关联；下载不会改变播放状态。播放器添加的 `__vid` 必须等于精确字符串作品 ID，且是与提供地址的唯一差异；原生传输仍使用未改写的可见播放地址。当前文档最多保留媒体或 XHR 请求中 16 个成功的 MP4 响应地址；播放检查只选择其精确观察到的来源，替换文档时清空这些地址。缺失元数据、推荐视频、受保护媒体、分片或来源关联不明确均为 unsupported。观察到 200/206 不代表完整下载。单次授权绑定 Host、窗口 owner、会话、任务、租约和目标作品，只放行确切原生请求；普通浏览器下载继续拒绝。切换会话、替换文档、关闭页面、过期、取消或 Host 断开都会撤销并停止验证。

成功必须有上限内的非零真实字节、ffprobe 视频流/时长/尺寸检查、ffmpeg 完整解码和 SHA-256。按详情选择的文件还须匹配详情时长（误差不超过 0.25 秒）和宽高比（误差不超过 1%）。来源记录包括公开作品页、任务/作品 ID、大小、时长、尺寸、识别方式、媒体主机名及临时 URL 哈希，不包含 Cookie、Authorization 或签名媒体地址。已有输出不覆盖；`STAGED` 仅表示传输完成，不是工具下载成功。批量结果按验证后的各项返回 complete、partial 或 blocked。

## 验证与打包

执行 `node --test tests/*.test.js` 和 `node scripts/pack.mjs --out /absolute/output/directory`。包内包含锁定的公开 Python 提取器；内置浏览器获取依赖配套 Host 补丁。无密钥页面数据 fixture 使用明确编写的计数和传输结果，不能证明真实公开页或创作者页可用。[批量阻塞会话回放](../../../snapshots/session/muse-douyin-blocked-batch/snapshot.yml)通过真实工具和智能体循环执行隔离的获取失败，并保留各条诊断。离线和合成媒体测试不能证明真实验收链接可下载，真实验收还需正常播放和该链接对应的文件验证记录。

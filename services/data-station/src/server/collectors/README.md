# 红果公开榜单采集

`collectHongguo()` 只对 `https://hongguoduanju.com/rank/<支持的榜单>` 发起只读 HTTP GET，请求不带 Cookie 或账号，不跟随重定向，不接受任意 URL，不执行页面脚本，也不访问视频资源。默认七榜各一页，每次请求间隔一秒；每榜最多配置五页，响应大小、请求时限和不完整流式页面重试次数均有上限。红果分类持续发现、分页校验与主指标语义见 [hongguo/README.md](hongguo/README.md)。

一次批次中的任何页面访问或结构解析失败都会抛错，不发布部分成功批次。调用方应保留原有成功记录并展示失败原因。验证码、403、429 等访问限制不会被自动绕过或重试。正在运行的批次可通过 `signal` 取消。

作品 ID 保持字符串；同一作品在不同榜单的观察会保留在 `works` 中，因此数据库需要按作品、榜单、观察时间区分历史。未知热度、收藏、点赞使用 `null`，不能把它们当作播放量或零。页面的“万/亿”指标可能取整；页面没有显示作者、上线日期或集数时保留未知。

榜单的 `episodeVids` 是卡片提供的视频预览链接，不能用数组长度代表全集集数；该字段不会填入作品总集数。

`coverage` 明确列出抓取范围和截断情况。完成所选榜单分页不等于取得红果全平台剧库或后台实时指标。`sourceUpdatedAt` 保留网页原始更新文本，不替它编造精确时间。

## 代码来源

`hongguo-parser.js` 抽取自 Muse 主分支 `cdd9d259948b5e9149a999d913394167f9447b45` 的 `third_party/plugins/muse-hongguo-search/src/parser.js` 的榜单解析部分，移除了详情和搜索实现。源项目为 [muse-hongguo-search](https://github.com/felir7at62co-wq/muse-hongguo-serch)，MIT 许可全文保存在 `HONGGUO-LICENSE`。此次只读取原仓库代码，没有修改、运行或安装原 Muse 插件。

MIT 许可覆盖解析代码，不覆盖来源网站的文字、图片或数据。当前数据站仅作为本地开发预览；数据再分发范围应在正式接入公司网站前确定。

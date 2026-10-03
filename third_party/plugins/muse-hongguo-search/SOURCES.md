# 数据源与接口参考

## 官方公开网页（2026-10-02 验证）

- https://hongguoduanju.com/search/%E4%BA%8C%E5%AB%81
- https://hongguoduanju.com/detail?series_id=7687919221593885758
- https://hongguoduanju.com/rank/hot-drama
- https://hongguoduanju.com/rank/hot-real-drama
- https://hongguoduanju.com/rank/hot-ai-drama
- https://hongguoduanju.com/rank/hot-comic-drama
- https://hongguoduanju.com/robots.txt

插件独立实现 JSON 提取，不执行网页脚本：`_ROUTER_DATA.loaderData` 和 `mergeLoaderData` 的 JSON 属性。搜索首屏只选 `doc_type === 23` 的剧集；详情仅使用请求 ID 的 `seriesDetail` 和 `seriesSocialInfo`，不误用推荐列表，不输出用户评论、网络请求内部字段或视频资源。

公开详情 `series_favorite_count`、`series_like_count` 与 `hot_score_data` 是不同指标。官方详情显示格式化会缩写万级数字；源整数是否经过上游处理仍未证明。榜单更新日期原文保留，不补造缺失年份。

官方当前 robots.txt 允许一般抓取，但这不构成无限请求、内容复制或商业利用的授权。网站条款和访问限制仍适用。实现采用串行、缓存、限速、超时和响应体大小上限。

## Muse/DSH 接口参考

参考仓库：https://github.com/felir7at62co-wq/muse-med

参考提交：`22b5e1cb171cddefcc48a671b6ff0c8d6d73a80a`

- `docs/cookbook/adding-a-tool.md`
- `docs/user/develop/basic/publish.md`
- `packages/core/tools/src/index.ts` 的 `ToolDefinition`
- `packages/core/tools/src/json-schema.ts` 支持的 JSON Schema 子集
- `dsh.bundle.patch` 组合包机制

未复制没有明确许可证的红果项目源码，也不依赖第三方付费代理、App 私有接口、签名算法或下载服务。所有随包测试页面均为手写合成数据。

# 红果榜单与分类发现

榜单刷新支持综合、真人、AI、漫剧四个热播榜及综合新剧榜、收藏榜、必看榜，每榜按官网公开分页最多抓取五页。解析代码不执行网页脚本，不登录、不发送 Cookie，不读取视频媒体。缺失指标保持 `null`；完成这些榜单的分页不等于取得全平台作品。

`heat`、`collection`、`likes` 分别来自 `heatText`、`favoriteText`、`likeText`。`shares`、`rating`、`rating_count` 分别来自 `shareText`、`scoreText`、`scoreCountText`；卡片没显示评分时三者各自保持未知。详情页指标刷新另读 `seriesSocialInfo` 的 `rating`、`rating_count` 和 `reviews.total_count`（评论数）；详情页不显示分享数。`ranking_primary` 单独保存 `primaryMetricText`，标签区分榜单热度、榜单收藏和最高热度。必看榜的历史最高热度不替换当前热度，收藏榜的主展示值不替换独立收藏字段；官网两处收藏展示可能不同。流式 JSON 未完成但页面卡片完整时，只恢复卡片实际显示的字段，未显示的独立字段仍为未知。

`createHongguoDiscovery()` 位于 `src/server/discovery/hongguo.ts`，提供普通定时工作流使用的 `DiscoveryAdapter`。入口为官网实际公开的 `/category/real-drama`、`/category/comic-drama`、`/category/ai-drama`。每页读取 inert loader `category_$`，校验请求路径、官网 canonical URL、剧种、页码、总数、页容量、完整行数和唯一字符串作品 ID。下一页必须同时由分页数据声明并在页面中提供真实链接；题材路径只从实际同源分类锚点发现，不组合分类 ID、不猜测新路径。任一校验失败都不返回成功批次或下一页。

非空页面返回完整的 `CollectionBatch` 与 `next`；管理器先保存本页作品及发布进度，再交给 Crawlee 保存后继任务与确认本页。官方合法空分类要求第一页、总数和总页数均为零、作品列表为空，记录已核对的空分类而不发布空批次或清除已有作品；任何字段不一致仍失败。根入口由管理器按周期安排回访，题材与历史分页的 `uniqueKey` 跨周期稳定，保留未完成的历史队列。HTTP 间隔、时限、响应字节上限可通过工厂选项配置；队列页预算、重试和调度由管理器负责。

分类记录使用空 `board` 和 `rank:null`，不把分类顺序当作热榜排名。作品链接指向官方详情页，发现页面和官网分类名称保存在 `metadataNote`，覆盖范围保存在批次说明。集数仅使用 `series_episode_info.episode_total_cnt`，不使用预览视频列表长度；`episode_right_text` 保留为来源状态原文。来源未显示的热度、收藏、点赞、作者和发布日期均不补造。

2026-11-13，官网真人剧分类第 1、2 页各返回 24 部，第 34 页返回 8 部；当前目录声明 800 条、34 页。题材目录也有自己的结果窗口，目录之间存在重合，不能相加声称全平台规模。读完当前窗口只表示当前路径的已声明分页完成；新周期继续检查入口和新题材。上述三类新增榜单及分类页均经过少量匿名官方请求核验，研究和原生 handler 验收记录保存在本项目忽略的 `artifacts/`，不提交抓取内容。

同日使用独立端口 4319 和空测试库完成原生整合验收：七榜全部公开分页取得 492 部唯一剧目；连续两轮各处理六个分类任务，累计新增 137 部，作品库达到 629 部，仍有 43 个持久待办。该结果是这次实际读取范围，数量会随官网变化；不表示已经读完所有目录。目录写入与进度同事务提交，并验证旧榜单指标和原观测时间不会被缺少指标的目录记录覆盖。

运行 `pnpm exec vitest run tests/hongguo.test.ts tests/hongguo-discovery.test.ts` 验证指标语义、拒绝访问壳、错路径或错页、不完整和重复记录、真实链接发现、稳定后继任务键、分页末页、取消及响应上限。

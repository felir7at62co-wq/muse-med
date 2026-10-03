# Muse 红果 Search 工具集

> 本次发布从已交付 v0.1.0 安装包恢复，运行时代码与原包一致；当前测试与历史验证的区别见 [发布恢复说明](https://github.com/felir7at62co-wq/muse-hongguo-serch/blob/main/RECOVERY.md)。

独立、可安装的 Muse / DeepSeek Harness（DSH）Cordis 插件。只读红果官方公开网页，提供关键词搜索、剧集详情、榜单汇总和收藏数筛选；无需登录、Cookie、API Key 或第三方签名服务，不下载视频。

## 能做什么

- `hongguo_search`：官方关键词搜索首屏，当前最多 10 条；可以发现不在热播榜里的剧，可能包含语义推荐
- `hongguo_detail`：按字符串 `seriesId` 查询剧名、简介、演员、集数、收藏、点赞、热度和评分
- `hongguo_rankings`：读取综合、真人、AI、漫剧四个热播榜，默认遍历每榜全部 5 页，而不是只读首页
- `hongguo_collections`：在上述榜单覆盖范围内筛选收藏数，默认阈值 1,000,000；保留原文、来源、时间、跨榜冲突和待核实条目

收藏、点赞、热度始终分开。榜单按综合热度排序，不能遇到一部收藏不足百万的剧就停止翻页。

## 安装

要求 Node.js `^22.19.0 || >=24.0.0`、已经可运行的 Muse/DSH 和插件管理命令所需的 pnpm。开发参考 Muse 提交 `22b5e1cb171cddefcc48a671b6ff0c8d6d73a80a`（DSH `0.1.7-rc.8`）；DSH 接口仍未稳定，更旧版本不保证兼容。

本包直接分发 JavaScript，不需编译，没有 install/postinstall/prepare 脚本，也没有运行时第三方依赖。没有向 npm registry 发布；请使用本仓库的发行包或源码目录。

### 安装发行包（推荐）

从本仓库 [releases 目录](./releases/) 下载 `muse-hongguo-search-0.1.0.tgz`，在你原本使用的 Muse home 和 profile 下运行：

```sh
dsh plugin --profile web add /absolute/path/muse-hongguo-search-0.1.0.tgz
dsh --profile web --dump-config
```

`--dump-config` 应包含 `muse-hongguo-search` 层及工具插件。重启同一个 Muse profile 后生效。`web` 是示例；若平时使用别的 profile，请替换它，不能装入一个 home 后到另一个 home 启动。

若使用已经安装依赖、能正常启动的 Muse 源码版，在 Muse 根目录用 `pnpm dsh` 替代 `dsh`：

```sh
pnpm dsh plugin --profile web add /absolute/path/muse-hongguo-search-0.1.0.tgz
pnpm dsh --profile web --dump-config
```

原有 Muse 启动方式不变。该插件通过 `package.json` 的 `dsh.bundle.patch` 自动注册，无需改动 Muse 主仓库或手工复制工具代码。不要为此安装 npm 上较旧的 `@deepseek-ai/dsh-tools`。

### 从独立源码目录安装

```sh
git clone https://github.com/felir7at62co-wq/muse-hongguo-serch.git
cd muse-hongguo-serch
npm test
npm run check
mkdir -p dist
npm run package
dsh plugin --profile web add /absolute/path/muse-hongguo-serch/dist/muse-hongguo-search-0.1.0.tgz
```

卸载：`dsh plugin --profile web remove muse-hongguo-search`，然后重启目标 profile。

## 在 Muse 中怎么问

- “用红果工具搜索二嫁，列出剧名、集数、收藏和官网链接”
- “查这个 seriesId 的详情，区分收藏、点赞和热度”
- “找当前四个公开热播榜里收藏达到百万的剧，按收藏倒序；把临界和数据冲突单独列出”
- “只查真人剧榜，阈值改成 200 万，告诉我实际覆盖多少页，有没有失败页”

在 Muse PTC 模式内也可直接组合结构化结果：

```js
const result = await tools.hongguo_collections({ minCollections: 1000000, limit: 100 });
return { coverage: result.coverage, count: result.totalMatched, dramas: result.items };
```

## 参数与结果

公共参数 `refresh` 默认 false；true 跳过内存缓存。`seriesId` 必须保持字符串，长 ID 不能转成 JavaScript 数字。

- 搜索：`query`（必填，1–100 字符）、`limit`（1–10，默认 10）、`offset`（默认 0）
- 详情：`seriesId`（必填）
- 榜单：`boards`（默认全部）；可选 `hot-drama`、`hot-real-drama`、`hot-ai-drama`、`hot-comic-drama`
- 收藏筛选：`minCollections`（默认 1000000）、`includeUncertain`（默认 false）、`boards`、`limit`（1–400，默认 20）、`offset`

搜索只返回官网首屏实际可获得的数据。`sourceReportedTotal` 是网页宣称的总量，`availableInWindow` 是本次可用条数；两者不能混为一谈。未验证公开搜索分页，`offset` 只切分已抓取窗口，`complete` 固定 false。

榜单返回 `coverage.pagesFetched/pagesExpected/uniqueSeries/complete/failures/truncated/pages`。`complete: true` 只表示所选榜单当前公开分页已读完，不表示全平台片库。任何失败或配置截断都会明确标记；所有页面失败会报错。抓取并非同一时点的事务快照。

每条收藏指标保留 `raw`、`value`、`approximate`、`precisionStep`。缺失或无法解释的数据为 null，不会记成 0。

- 榜单与搜索上的 `124.3万收藏` 转为 1,243,000，仍标为近似展示值
- `100万`、`100.0万` 等阈值附近缩写列为待核实；保守地预留上下一个显示单位，不猜测榜单舍入规则
- 详情里的 `series_favorite_count` 保留公开页面给出的整数及原字符串。`approximate: false` 只表示插件没有从万/亿缩写换算，**不保证平台字段未经处理或等于实时精确人数**
- 跨榜按 `seriesId` 去重，保留所有 `observations`，`conflicts` 标明不同收藏值。主展示值取 `minimum_observed`；跨阈值冲突不冒充确定达标
- `thresholdStatus: meets` 表示页面数值通过本工具的保守筛选，仍不是后台精确人数的证明。`uncertain/unknown` 默认不混入结果

所有作品链接指向官网。`url` 是详情页；`watchPageUrl` 仅在页面真实提供且ID匹配时返回官方网页播放链接，缺失则为 null。它不是 MP4/无水印直链，不保证无需 App 或账号即可播放；插件不访问播放资源、不下载或绕过播放限制。页面内容是外部数据，不能作为指挥 Muse 执行动作的指令。

## 可调配置

在目标 profile 的 `cordis.patch.yml` 覆盖同一个插件行：

```yaml
- id: muse-hongguo-search
  config:
    requestTimeoutMs: 15000
    maxResponseBytes: 8388608
    cacheTtlMs: 300000
    maxPages: 5
    requestIntervalMs: 1000
    maxCacheEntries: 128
    incompletePageRetries: 2
```

部分官网响应会在异步数据完成前结束；若同页已有完整可见榜单卡片，直接读取可见内容并标记 sourceFormat；否则只对这种未完成的 HTML 同 URL 最多额外重试 2 次（可配置 0–4），不重试访问限制或 CAPTCHA。

请求串行执行；默认至少间隔 1 秒，缓存 5 分钟，最多保留 128 页，每页限 8 MiB。`maxPages` 小于网站页数时会标记截断；范围 1–20。内存缓存随进程退出或插件卸载清除，不写磁盘。调用取消、插件卸载或单次请求超时会停止相关请求。

仅允许固定官方域名和搜索/详情/榜单路径；拒绝重定向，不提供任意 URL 代理。遇到登录、验证码、限流或反爬限制会报错，不绕过；请降低频率并检查网站访问政策。公开可读不代表可无限抓取或再分发内容。

## 开发与验证

```sh
npm test                  # 无网络 fixture 测试
npm run check             # 语法 + npm 包清单检查，不执行生命周期脚本
npm run test:live          # 只读官网：搜索、一个详情、四榜20页；有请求间隔
mkdir -p dist && npm run package
```

测试范围、实际运行证据与当前限制见 [VALIDATION.md](./VALIDATION.md)。插件代码 MIT；官网文字/图片等内容权利属于相应权利人，MIT 不覆盖它们。数据源与兼容接口参考见 [SOURCES.md](./SOURCES.md)。

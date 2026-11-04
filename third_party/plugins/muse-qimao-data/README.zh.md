---
description: "七猫公开榜单与筛选书库元数据，供 Muse 用户选择小说来源及维护者诊断采集覆盖不全。"
kind: "package-bundle"
---

# Muse 七猫元数据

[English](README.md) | 中文

## 概述

Muse 创作预设通过本组合包中按作用域启用的提供方读取七猫公开榜单窗口、筛选书库页及书籍详情。提供方保留平台指标原名、观察时间、缺失值及采集覆盖情况。它不登录、不执行网页 JavaScript、不跟随章节链接，也不下载小说正文。当前在读人数和 App 金选状态保持未知。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用本包

### 预设启用

Desktop 源码包清单携带本组合包。标准、PTC、Cordis、短剧、编辑及 Bot 主控预设在各自作用域中启用提供方，极简预设不启用。组合补丁只贡献一个默认关闭的全局条目，因此仅将包装入 profile 并不会让工具全局可用。自定义组合必须在目标 Agent 作用域中明确启用 `muse-qimao-data` 条目。

### 公开元数据与覆盖情况

`qimao_rankings` 默认读取两个频道、全部五种榜单的首屏窗口，其中大热榜分别读取日榜和月榜。榜单翻页尚未验证，不能请求。`source:library` 读取公开“近期短篇连载”筛选书库的真实页码：近三天更新、三十万字以下、连载中、按点击量排序。默认页数预算为三页，结果明确描述这些筛选条件，不声称覆盖七猫全部书籍。

`qimao_search` 仅在请求采集的窗口内按书名和作者过滤。它始终报告 `complete:false`，并分别返回匹配数和扫描数；窗口内未出现不能说明七猫没有此书。`qimao_detail` 将请求的十进制书 ID 与主信息区核对，不返回章节正文。书 ID 始终保持字符串。

每项计数保留展示名称、原文、数值解释、精度、观察时间和缺失原因。热度、累计人气值和次阅读分别保存。次阅读不能证明当前在读人数，累计人气值不能证明当日投票。`currentReaders` 和 `goldenPick` 始终为 `null`。同一本书有多次观察时，保留采集时间最近的元数据，并按各指标自己的观察时间保留最近已知值；即使旧缓存窗口较晚遍历，也不会覆盖新值，缺失值同样不会抹去已知指标。

`coverage.complete` 表示所请求公开页面全部成功；`coverage.siteWide` 始终为 false。`coverage.metrics` 另行统计已抓取观察的已知和缺失字段。实际选中状态错误、书库重复页或详情 ID 不符会被拒绝。部分采集成功时保留成功页和明确的失败信息；全部失败时抛出错误。失败请求不会用旧缓存数据冒充成功。

### 配置

经校验的配置为 `requestTimeoutMs`（默认 15,000）、`maxResponseBytes`（5 MiB）、`requestIntervalMs`（800）、`cacheTtlMs`（300,000）、`maxCacheEntries`（128）、`maxPages`（3，范围 1–10）和 `allowLegacyResponseHeaders`（true）。缓存保留每次原观察时间并按 TTL 失效，`refresh:true` 跳过缓存。客户端仅接受程序生成的官方 HTTPS 元数据路径，不发送账号凭据，拒绝重定向，卸载时取消自身读取任务。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[解析器](src/parser.js) 使用 parse5 仅读取已经观察到的元数据 DOM 类。[客户端](src/client.js) 管理选择条件校验、限速请求、页面缓存、去重和明确的覆盖信息。[传输层](src/transport.js) 保持 TLS 校验并限制响应体大小。优先使用严格 fetch；配置允许时，已观察到的响应头解析或 Undici 响应长度异常可转为一次仅限当前请求的 HTTPS 兼容读取。兼容读取要求 HTTP 帧完整，提供 Content-Length 时还核对实际字节数；有歧义的帧与不完整正文均失败。这条固定来源路径不会放宽全局 HTTP 或 TLS 设置，也不会对拒绝访问响应或验证页面重试。

[补丁](cordis.patch.yml) 默认全局关闭；[入口](src/index.js) 通过当前作用域注册工具，并等待自身请求清理。[公开类型](src/index.d.ts) 为有类型消费者标记书 ID 品牌。[打包脚本](scripts/pack.mjs) 在私有暂存目录中打包审核过的文件，将文件哈希、匹配的 Host 版本、依赖及上游参考写入 `SOURCE.json`。[第三方声明](THIRD_PARTY_NOTICES.md) 保留 MIT 参考采集器的署名；不携带其 Chrome/CDP 驱动。

</details>

<a id="model-experience"></a>
## 模型体验

按作用域启用的提供方贡献三个只读工具说明及结果 schema。榜单首屏窗口、书库筛选范围、未知 App 字段及仅在窗口内搜索，都明确保留在模型可见结果中。通用读取／搜索卡片展示原始工具结果，不额外推断完成状态。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

公开 HTML、榜单组成和访问可用性可能变化。遇到验证或访问拦截页面时明确失败，不绕过限制。本包不提供 App 专有的当前在读或金选字段、小说正文下载、全站公开关键词搜索或已验证的榜单翻页。元数据成功不代表拥有改编权或小说全文可获取。合成测试不能证明当前实站可用性。

<a id="dev-note"></a>
## 开发说明

<details>
<summary>维护者工作背景</summary>

合成 fixture 保留观察到的元数据类名，并替换书名、简介和计数。它们包含章节与脚本哨兵，供真实解析器和按作用域工具核验这些内容均未进入工具结果。实站验收仍限于对所选公开元数据页面的有界读取。

</details>

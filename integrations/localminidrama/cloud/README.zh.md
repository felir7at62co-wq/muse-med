---
description: "经过 Muse 账号鉴权、按账号隔离 SQLite 与媒体的制作工作进程。"
kind: "reference"
---

# Muse 云制作平台

[English](README.md) | 中文

## 概要

Muse 账号网关使用已核验的账号 ID 选择私有制作平台。每个工作进程拥有独立 SQLite 数据库、配置和媒体目录。浏览器通过 Muse Origin 下的 `/studio/`、`/studio/api/v1/*` 和 `/studio/static/*` 请求，不选择账号，也不接触工作进程凭据。网关仍是唯一登录系统。

## 部署

`MUSE_STUDIO_CONFIG` 是可选设置。未配置时，已鉴权的制作平台路由返回 HTTP 404 `studio_not_configured`。它须指向发布目录之外、仅所有者可读写的常规绝对路径 JSON 文件。以下字段全部必填；路径仅作示例，须改为已暂存的 Node 可执行文件、完整安装的固定后端，以及使用 `/studio/` 为 base 构建的前端。

```json
{
  "version": 1,
  "nodeExecutable": "/opt/muse/runtime/node/bin/node",
  "backendRoot": "/opt/muse/studio/releases/current/backend-node",
  "webDistRoot": "/opt/muse/studio/releases/current/frontweb/dist",
  "tenantRoot": "/var/lib/muse/studio-tenants",
  "outboundOrigins": [],
  "trustedLocalOrigins": [],
  "limits": {
    "maxActiveInstances": 4,
    "maxConcurrentStarts": 1,
    "maxRequestsPerAccount": 16,
    "maxRequestsTotal": 64,
    "maxOutboundRequests": 4,
    "maxRequestBytes": 33554432,
    "maxTenantBytes": 1073741824,
    "startupTimeoutMs": 30000,
    "requestTimeoutMs": 300000,
    "idleTimeoutMs": 900000,
    "idleSweepMs": 1000,
    "shutdownGraceMs": 60000
  }
}
```

运行时从已安装的后端包解析 `express`、`js-yaml`、`better-sqlite3`、`undici` 与 `ipaddr.js`。固定后端锁文件提供这些依赖。移除独立助手依赖时，须保留云工作进程使用的网络依赖。服务不初始化 Mastra 助手；拒绝 `/api/v1/agent/*`、其他 API helper，以及路径或账号选择覆盖。已安装的音频、包、准入、修订、后期、预算、LibTV、编辑与迁移扩展使用明确允许的 `/api/v1/muse/` 命名空间。

为此网关暂存发布文件前，使用 `node integrations/localminidrama/build-web.mjs <checkout> --base /studio/` 构建已打补丁的检出目录。构建器包含 Muse 图标，拒绝缺失资源、错误 URL 前缀及缺失原生内嵌桥接的产物。独立部署使用 `--base /`。运行 `node --test integrations/localminidrama/tests/web-build.test.mjs` 验证离线拒绝用例；两条命令均要求 Python 和已安装的前端 Vite 依赖。

## 网关接线

从 `config.mjs` 导入 `loadStudioConfig`，从 `runtime.mjs` 导入 `createStudioRuntime`，从 `proxy.mjs` 导入 `studioRoute`。加载可选文件后，以 `await createStudioRuntime(config, {publicOrigin})` 创建运行时。两项操作均不读取既有账号数据库。把可选运行时传入账号服务器工厂；保留网关现有的账号、飞书、组织和工作间行为。

在既有鉴权与 Origin 检查之后、工作间转发之前，等待 `studioRoute(req, res, {runtime, session, isAuthorized, publicOrigin, signal})`。`session.id` 是已核验的稳定账号 ID；`isAuthorized()` 重新核对同一登录令牌和账号。Host 可使用私有 Cookie 或 Bearer 登录，因此网关凭据解析须识别 `/studio/*`。把可选中止信号登记到既有登录撤销与过期清理。其他 URL 返回 `false`；制作平台请求在所属上游流关闭后才完成。代理删除浏览器 Cookie、Authorization、账号／路径覆盖头及任何传入工作进程凭据，再注入每实例的私有头。后端 Cookie 不回传浏览器。

GET `/studio` 跳转至 `/studio/`。普通写请求要求配置的 Origin。兼容后端拒绝旧版以 GET 生成分镜的接口，须改用经过准入检查的 POST 接口。上传、下载、Range 请求和事件流保留背压。客户端取消或账号撤销关闭代理，不取消已接受的后台生成。代理设置私有 no-store 缓存和 `nosniff`，不添加 CSP、frame、COOP 或 COEP 策略。已鉴权的桌面代理负责独立 Origin 的嵌入策略，并须拒绝上一登录创建的 iframe。

## 工作进程生命周期与存储

账号首次请求在独立进程中通过 `createApp()` 启动既有后端，原子绑定 `127.0.0.1:0`。工作目录是 `tenantRoot/<accountId>`，配置只指向本人数据库和 storage。环境保留操作系统执行及语言变量，不继承网关 Cookie、供应商密钥或 Node loader。子进程输出不复制到网关日志。私有 PID／nonce 所有权文件阻止旧进程存活时由替代进程重复打开同一账号。只有操作系统确认原 PID 不存在才回收遗留文件；被复用的存活 PID 会拒绝接管。

空闲清理检查当前 HTTP 租约、进行中的图片／视频／任务记录、可选 TTS 表的 generating 行、原生请求预留记录，以及后台任务派生的未完成 Promise。安装提交准入扩展时，其活动处理器计数会使已断开的请求继续保持忙碌，直到原处理器完成；仅持久化的 unknown 行不会让重启后的 Worker 一直存活。浏览器断开后仍保留活动工作。`await runtime.close()` 停止接收新请求并排空工作进程。宽限到期返回 `studio_busy`，不终止任务；监管继续，并在已接受工作结束后关闭进程。启动失败、容量不足和工作进程不可用返回固定错误，并保留账号数据。发布与回滚须保留 `tenantRoot` 和其版本化清单。

`maxTenantBytes` 是根据当前文件字节与入站写入预约执行的准入配额。进行中的模型下载、SQLite 增长、解压和 FFmpeg 输出可能超额；它不是操作系统文件系统硬限额。超额拒绝新写入，不删除文件，也不终止制作任务。实例、启动、入站请求和出站请求上限相互独立。工作进程是受信任的固定应用，不是容器、操作系统用户沙箱或 CPU／内存配额。

## 出站访问与参考资源

`outboundOrigins` 列出管理员审核过的供应商及媒体 CDN 精确 HTTPS Origin。示例空数组不启用任何供应商请求。`trustedLocalOrigins` 是明确允许私网／本机供应商服务的子集，正式环境通常为空。HTTP 必须显式列入该例外。普通用户不能通过模型设置覆盖该策略。保存模型配置前检查地址；调用、轮询、下载和跳转还须经过 HTTP／HTTPS、原始 Socket 与 fetch／Undici 守卫。每次新连接解析全部 DNS 结果；未列入例外时，任一地址非公网即拒绝，并把实际 Socket 固定到核验后的地址。自定义 Agent、lookup、dispatcher 与 Unix socket 不能绕过这些已审核通道。固定后端的 JavaScript 网络路径已覆盖；加载任意原生扩展或新的未审核传输须另行审查。

本地媒体字段拒绝路径穿越与文件系统 URL。Worker 存储 URL 使用根相对地址 `/studio/static`，使内嵌预览、上传和下载保留在其已认证的代理来源。`/studio/static/` 或配置的 Muse 公开 Origin 下的临时生成参考映射为本人 `/static/` 文件，供内联或供应商上传；采用资源字段不重写。Host iframe 须保留相对参考，不把它变为 `dsh-app:` 或回环地址。经过鉴权的 Muse 媒体不是可供供应商匿名读取的图床。需要公网参考的协议须使用明确授权的上传服务或内联传输。

<a id="native-production-usage"></a>
## 制作用量

`studio-usage.mjs` 的 `createStudioUsageReader(config)` 创建惰性读取器。其 `await query(accountId, {from, to, limit, cursor})` 只以只读方式打开已核验账号的既有数据库，完成一次快照后关闭，不启动或租用 Worker。已鉴权网关选择 `accountId`；本人路由不能接受其他账号 ID，管理员须明确选择一个既有账号。日期包含首尾 UTC 日，默认最近 30 天，最多跨 366 天；每页默认 50 条、最多 100 条，游标绑定账号与日期。

结果使用 `version: 2` 和 `scope: studio-all`，汇总原生提交准入、独立 TTS、Fal、LibTV API 与 LibTV CLI 记录。独立任务与其预算预占只计一次，原生子调用预占归入原操作。没有保存任务的预算记录仍可见，缺失的原生操作标记为未知。关联图片／视频／音频／任务数表示关联记录，不代表成功成片或额外付费提交。免费导入、本地合成及此前未埋点历史不会被虚构为付费请求。读取器支持声明的既有 schema 版本，包括 CLI 版本 1–3，不执行迁移。解除未知 CLI 操作的生成锁后，其公开结果仍为未知，预算预占保持不变。

输入／输出别名只计一次，不用其他字段推算总数。缺失回报保持 `null`，真实零值仍为零，覆盖计数描述已保存的供应商快照。重复轮询更新同一条资源回报。回报格式损坏、持久化错误或整数溢出使健康状态降级；溢出的指标独立保持未知，不影响其他指标。`budgetTotals` 按币种分别汇总：`reservedMinor` 记录原预占金额，`heldMinor` 表示仍待核销的金额，`settledMinor` 在用户确认账单前保持 null。这些是预算观测值，不是核验后的供应商收费。聊天中继用量仍属于独立范围。

记录按原操作创建日期归属，包含后来收到的供应商回报及关联预占。不透明游标编码 `[2, accountId, from, to, createdAt, source, sequence, operationId]`，以渠道和操作身份区分同一时间的插入记录；旧游标须清除。Fal 任务错误优先，其次取分段顺序中的首个错误；提交不完整或媒体未验证时为 `awaiting-review`，结果未知仍保持未知。持久阶段不能证明 Worker 正在运行或供应商已结束。缺失数据库和未埋点数据库具有明确状态，不把历史用量断言为零。读取器不选择提示词、回执、供应商配置、CLI 输入捕获或媒体；所有权描述不符、链接与不支持的 schema 均拒绝读取。

## 验证

运行 `node --test integrations/localminidrama/cloud/cloud.test.mjs integrations/localminidrama/cloud/network-policy.test.mjs integrations/localminidrama/cloud/proxy.test.mjs`。真实后端测试要求 `.local/localminidrama` 或 `LOCALMINIDRAMA_SOURCE` 下已安装固定源码；缺失时明确跳过相关测试。测试使用新建 Muse 账号、独立真实 SQLite 工作进程、生成的 PNG 和本地 HTTP 供应商，覆盖账号／静态文件／配置／历史隔离、DNS／跳转拒绝、并发、取消、优雅关闭和数据保留，不读取既有会话，也不调用付费模型。

内嵌媒体浏览器用例还需要安装 `apps/web` 开发依赖及 Playwright Chromium。它通过账号代理渲染已上传图片，并核对同一参考以内联形式送达本机供应商。浏览器资源缺失时明确跳过该用例；跳过不代表浏览器验收通过。

运行 `node --test integrations/localminidrama/cloud/studio-usage.test.mjs` 验证只读元数据读取器。其独立 SQLite 测试库覆盖全部已接入渠道、账号隔离、活动 WAL 读取、回报替换、未知／溢出数值、分页和不安全文件系统选择，不请求模型，也不读取既有账号数据。相邻 `studio-usage-fal.test.mjs` 对照真实后期服务的阶段判断，检查缺失分段时拒绝且不写入。

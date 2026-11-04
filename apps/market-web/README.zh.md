---
description: "构建与部署复用现有账号网关的 Muse 共享市场网页。"
kind: "reference"
---

# Muse 市场网页

[English](README.md) | 中文

## 概述

浏览公开 Bot 与 Skill 版本，在本地预览 ZIP，再上传为团队私有草稿。网页与桌面复用 [Muse 市场界面](../../packages/client/ui-muse-account/README.zh.md)；下载的发布包在 Muse 中导入和启用。

## 目录

- [构建与部署](#build-and-deployment)
- [验证](#verification)
- [开发说明](#dev-note)

-----

<a id="build-and-deployment"></a>
## 构建与部署

安装工作区依赖后，在仓库根目录运行 `pnpm --filter @deepseek-ai/dsh-market-web run build`。构建写入 `tmp/market-cloud-web/`，资源绝对路径前缀为 `/market/ui/`。在 `/market/` 与 `/market/manage` 提供 HTML，在 `/market/ui/assets/` 提供资源，在 `/market/ui/config.json` 提供公开配置。管理路径显示创作者的发行列表。该路径带 `?view=upload` 时打开独立上传页，返回操作打开发行列表。公开发现页同时读取 /market/catalog.json 的首批资源，原始 ZIP 和 TGZ 继续通过 /market/downloads/ 下载。部署时同时保留这些路由和发行接口。查询结果中若已有摘要相同的新版发行，发现页只展示该发行。`/api/market/v1/*` 与 `/account` 继续由现有认证网关处理；此应用不读取或构造浏览器 Cookie。[网关部署参考](../../services/muse-accounts/MARKET.md)负责私有进程配置。

公开 JSON 包含 `limits`（`archiveBytes`、`expandedBytes`、`fileCount`）、`allowedPlugins`、`requestTimeoutMs` 与 `metadataBytes`。创建接口适配层前校验这些值。配置缺失或无效时显示重试入口。发布包限制和允许的插件须与云端策略一致；本地元数据预览不代表服务端接受该包。确认上传创建私有草稿，重试保留原请求标识。下载先核对字节数与 SHA-256，再创建浏览器文件。

HTML 与配置不缓存，带内容摘要的资源可使用不可变缓存。页面需要同源脚本、连接、图片和字体；预制图片、预览及内嵌字体也使用 `data:` 或 `blob:` URL。组件样式需要支持内联样式。部署 CSP 保留对象、框架与基准地址限制。部署提供对应路由时，`/market/legacy` 与 `/market/basic` 分别链接到保留的资源页和网关管理页。

首批资源按目录 ID 选择 Bot 形象，并按分类展示 Skill 插画。发现页的 Bot 形象支持动画，并遵循减少动态效果设置。

浏览者接近当前列表末尾时，发现页自动显示下一批首批资源。

<a id="verification"></a>
## 验证

`pnpm exec tsc -b apps/market-web` 编译供构建后集成测试使用的浏览器适配层。`pnpm exec vitest run apps/market-web/tests/api.spec.ts` 验证受限响应、认证传输、发布包校验及请求释放。[网关联调参考](../../services/muse-accounts/MARKET.md#operations)说明构建后网页到 Host 的测试。设置 `DSH_SNAPSHOT=replay` 后，`pnpm run test:web:built apps/market-web/tests/browser.e2e.ts` 将正式网页构建到测试专用目录，使用隔离身份素材验证角色卡片、悬停稳定性、本地上传预览、浏览器下载字节与手机布局。网页下载不代表完成安装、启用或模型回答。

<a id="dev-note"></a>
## 开发说明

网页优先使用市场中文词条，缺少的词条从共享中文词表补充，查找顺序与桌面一致。

选择 Bot ZIP 后，预览沿用发布包已绑定的形象，或根据标题、描述和分类从 50 个内置角色中自动匹配。浏览器将匹配结果绑定到上传的 ZIP，审核页和发现页据此显示同一形象。

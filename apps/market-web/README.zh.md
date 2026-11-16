---
description: "构建并部署独立 Muse Skill 市场网页，复用 Desktop 展示与现有账号网关。"
kind: reference
---

# Muse Skill 市场网页

[English](README.md) | 中文

## 概述

浏览公开 Skill、检查使用前提、下载可供 Muse 使用的发布包，并将 Skill ZIP 上传为团队私有草稿。网页与 [Desktop 市场界面](../../packages/client/ui-muse-market/README.zh.md)共用卡片、详情、角色、发布状态筛选和指引。网页下载不会安装、启用或运行 Skill；请在 Muse 中导入下载的 ZIP，再选择新聊天使用的版本。

## 目录

- [构建与部署](#build-and-deployment)
- [发布包与账号权限](#packages-and-account-access)
- [验证](#verification)
- [开发备注](#dev-note)

-----

<a id="build-and-deployment"></a>
## 构建与部署

安装工作区依赖后，在仓库根目录运行 `pnpm --filter @deepseek-ai/dsh-market-web run build`。Vite 将静态网页写入 `tmp/market-cloud-web/`，资源基础路径为 `/market/ui/`。此私有工作区应用没有 npm 发布内容；其静态构建部署到网关。构建只准备文件，部署是单独的操作。

在以下既有路由提供同一份构建 HTML。应用根据路径和查询参数选择页面，并支持浏览器历史导航。

| 路由 | 页面 |
|---|---|
| `/market/` | 公开 Skill 发现页 |
| `/market/manage` | 当前账号的发布记录与审核 |
| `/market/manage?view=upload` | 独立 ZIP 预览与上传页 |

在 `/market/ui/assets/` 提供构建产生的带内容哈希文件，并设置不可变缓存。HTML 和部署方提供的 `/market/ui/config.json` 不缓存。配置请求不能落到 HTML 回退页面。保留 `/market/catalog.json`、`/market/downloads/`、`/api/market/v1/*`、`/api/muse.account` 及既有账号路由的当前归属；部署本网页不会替换网关或其账号逻辑。

公开配置提供 `limits.archiveBytes`、`limits.expandedBytes`、`limits.fileCount`、`requestTimeoutMs` 和 `metadataBytes`。可选的 `limits.recordBytes` 默认为 4 MiB；可选的 `catalogLimit` 默认为 100，且不能超过 100。配置不包含凭据或私有存储路径。配置缺失或无效时，页面显示重试入口。[传输实现](src/transport.ts)定义了可接受范围。

<a id="packages-and-account-access"></a>
## 发布包与账号权限

公开目录不携带登录 Cookie，避免过期登录阻断浏览。私有发布记录、上传、需要成员权限的下载及审核使用浏览器现有的同源 Muse 登录状态，并受网关当前权限控制。网页不读取 Cookie，也不构造认证密钥。账号变化会使私有结果失效，并阻止上传重试切换到另一个账号。

选择 ZIP 只在本地预览。预览会校验完整发布包，并使用已保存的角色；未绑定角色时，按与 Desktop 相同的规则自动匹配。确认后，将这份已准备字节上传为私有草稿。重试保留原文件、账号、团队和请求 key。提交审核和审核通过是单独的操作；上传不会自动公开发布。

已发布包只有在字节数、摘要和清单核验通过后才会下载。来自 `/market/catalog.json` 的原有 Skill 先按目录摘要核验 ZIP，再在浏览器中转换成规范的 Muse 发布包供下载。转换不会修改原目录或 ZIP 文件。下载的发布包可直接导入当前 Muse 市场；安装和默认版本选择仍须在 Desktop 中明确执行。

<a id="verification"></a>
## 验证

[适配器测试](tests/api.spec.ts)覆盖同源请求、公开配置限制、账号身份变化、归档校验、形象绑定和已核验下载。共享界面的[浏览器测试](../../packages/client/ui-muse-market/tests/browser.client.spec.tsx)覆盖目录独立失败、下滑加载、私有内容可见性和上传尝试保留。这些检查不能替代生产登录、发布或模型运行验收。

<a id="dev-note"></a>
## 开发备注

当前网页使用共享中文文案，主题入口支持浅色和深色展示。本应用不启动本地 Host，也不维护另一份安装清单。

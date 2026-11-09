---
kind: upgrade-guide
description: Skill 云端身份响应必须包含已认证账号 id，独立市场界面使用配套公共解析器。
---

# Skill 市场账号身份与界面

[English](guide.md) | 中文

## 变更

云端 `identity()` 响应现在必须在 `publishers` 和 `admin` 之外包含 `accountId`，即已认证的 16 位 Muse 账号 id。缺少该字段时解析器会拒绝响应。它用于识别结果不确定的上传所属原账号，不是会话 cookie，也不是发布团队 id。云端发行包和发布团队 id 仍为 32 位；本地版本 id 仍为归档 SHA-256。

`@deepseek-ai/dsh-client-ui-muse-market` 提供可独立卸载的市场导航与本地管理。账号登录仍由原有插件负责。本地安装、显式选择默认值与云端发布均为独立操作。浏览器安全的 `@deepseek-ai/dsh-muse-market/cloud-values` 入口复用 Host 的 JSON 校验器；Host 服务仍从 `./cloud` 导入。

## 迁移

1. 一同升级云端目录、Host 解析器与 UI。确认已认证身份响应包含真实账号 id。旧的两字段身份响应会被拒绝；不得替换为本地生成的 id，也不得从发布团队名称推断身份。
2. 为每次结果不确定的上传保留原账号 id、请求 key、归档 SHA 和发布团队。重新登录同一账号后，可显式使用原 key 重试。其他账号不得复用该尝试。显式放弃重试前请核对原记录；放弃不会撤回服务端草稿。
3. 在具名 profile 中为本地存储与激活添加独立 UI 插件。可选云端使用配置中的 Muse Account origin。Desktop profile 已挂载这些行；停用市场 UI 会保留账号设置。所有应用均通过具名 `dsh` profile 配置。
4. 浏览器通过 `./cloud-values` 校验 JSON 并构造 id。独立站部署将正常构建的 `lib/cloud-values.browser.js` 作为解析器资源提供。保持完整 JSON 与归档字节预算，确认云端请求悬挂时仍可执行本地导入、导出及默认值更改。

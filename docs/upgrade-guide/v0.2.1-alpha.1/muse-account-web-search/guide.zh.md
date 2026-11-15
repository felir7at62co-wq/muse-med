---
kind: upgrade-guide
description: Muse Desktop 的网页搜索改用已登录账号的网关，不再使用本地配置的搜索提供商。
---

# Muse 账号授权网页搜索

[English](guide.md) | 中文

## 变更

Muse Desktop 在产品补丁中选择 `searchProvider: muse` 并启用 `webSearch: true`。现有 `web_search` 工具使用保存的 Muse 会话调用账号网关的 `/api/web/search`。官方搜索密钥保留在服务器，客户端既不接收密钥，也不需要本地 `DEEPSEEK_API_KEY`。搜索要求登录 Muse，且网关提供该接口。仅更新服务器不会给旧客户端安装此提供商。

由于 `webSearch` 默认为 `false`，自定义配置继续使用原有搜索提供商。网页抓取仍使用 `fetchProvider: http`；模型路由、默认模型，以及 1M 模型容量和 475k 估算工作预算均保持不变。超时、来源校验和失败行为见[账号搜索参考](../../../../packages/host/muse-account/README.zh.md)。

## 迁移

1. 安装 Muse 客户端更新前，先部署账号网关中需要登录授权的 `POST /api/web/search` 接口。官方密钥保存在服务器私密配置中，不要将搜索密钥添加到客户端设置或模型凭据。
2. 安装更新后的 Muse Desktop Host 并登录 Muse。[产品补丁](../../../../apps/desktop-host/config/desktop.cordis.patch.yml)会选择此提供商。自定义配置如需启用，还必须加载网页服务、在 `muse-account` 上设置 `webSearch: true`，并选择 `searchProvider: muse`，同时保留自己的抓取提供商。
3. 运行[无密钥搜索用例](../../../../snapshots/session/muse-web-search-account-proxy/snapshot.yml)，验证来源映射和会话过期处理，不产生付费请求。真实环境下搜索成功还要求服务器配置正确、Muse 会话有效且上游服务可用；本指南不代表这些部署条件已经满足。
4. 如需恢复原搜索提供商，关闭 `webSearch`、恢复该配置的 `searchProvider`，然后重新加载 Host。原提供商可能需要自己的凭据。无需恢复数据库或会话日志，已有来源结果仍有效。

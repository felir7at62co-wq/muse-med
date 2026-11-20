---
kind: upgrade-guide
description: "Muse Desktop 和账号网关不再把供应商凭据交给桌面端；所有 Muse 模型请求都经网关中转。"
---

# Muse 供应商直连已移除

[English](guide.md) | 中文

## 变更

以 `MUSE_DESKTOP_MODEL_TRANSPORT=direct` 启动的网关，会通过 `GET /api/desktop-models/access` 把真实的供应商地址和密钥交给每个已登录的桌面端。桌面端把它们保存在账号 `session.json` 旁的 `model-access.json` 中，并自行调用供应商。官方智谱则可以通过 `/api/desktop-models/zhipu-official/leases` 为每次请求签发短期令牌；桌面端把这些直连调用的 Token 计数上报到 `POST /api/muse.account/usage`。

以上全部移除。桌面端带着已登录的 session，把每次 Muse 模型请求发往账号网关的 `/api/desktop-models/<provider>/chat/completions`，由网关用只保存在服务器上的密钥调用供应商。桌面端不再请求直连或短期令牌，忽略目录响应中的供应商地址和密钥，并在启动时及每次目录刷新时删除遗留的 `model-access.json`。网关不再提供领取凭据、短期令牌和用量上报这些路由。`MUSE_DESKTOP_MODEL_TRANSPORT` 取 `relay` 以外的值，或设置了 `MUSE_ZHIPU_DIRECT_TOKEN_MS`、`MUSE_ZHIPU_DIRECT_REQUEST_MS`、`MUSE_ZHIPU_DIRECT_CHECK_MS`、`MUSE_ZHIPU_DIRECT_GRACE_MS` 或 `MUSE_USAGE_RATE_PER_MINUTE` 时，网关拒绝启动。

旧版桌面端仍可使用：网关不提供直连时，它们本来就走中转，并会删除自己的 `model-access.json`。此前以 `desktop-direct` 来源上报的用量记录仍可读取。

## 迁移

1. 部署此版本前，从每个网关环境中删除 `MUSE_DESKTOP_MODEL_TRANSPORT=direct`，以及已移除的 `MUSE_ZHIPU_DIRECT_*` 和 `MUSE_USAGE_RATE_PER_MINUTE` 设置。设置 `MUSE_DESKTOP_MODEL_TRANSPORT=relay` 仍然有效。
2. 曾以 `direct` 运行的网关已把供应商密钥发给每个登录过的桌面端，网关之外的副本在供应商撤销之前一直有效。对每把这样的密钥，先在供应商处创建替换密钥，用它更新网关的模型配置，确认 Muse 模型能正常回复，再停用旧密钥。先停用旧密钥会让所有人的中转都失败。
3. 删除网关账号文件旁遗留的 `model-direct-leases.json`；它不含密钥，也不再被读取。
4. 确认结果：桌面端能收到 Muse 模型回复，账号 `session.json` 旁不再出现 `model-access.json`。

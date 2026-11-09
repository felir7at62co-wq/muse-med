---
kind: upgrade-guide
description: 可选 Skill 云端入口要求显式配置 profile，并区分云端发行身份与本地归档摘要。
---

# 显式 Skill 云端发布

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-muse-market/cloud` 提供独立的账号绑定 Remote 命名空间 `museMarketCloud`，依赖基础本地存储服务、配置中的 Muse Account origin，以及匹配该 origin 的私有会话文件。云端发行包与发布团队 id 为 32 位十六进制字符；本地版本 id 仍为 64 位归档 SHA-256。上传创建私有草稿；提交、审核、安装与激活均为独立操作。

`./cloud-host` 在专用具名 `dsh` profile 中提供私有回环目录。其存储、管理员策略及网关 secret 均独立于 Desktop 存储。网关在请求准入时检查当前账号权限；撤权不会取消已准入或已提交的工作。

## 迁移

1. 如需启用可选客户端，在具名 profile 的基础服务旁添加 `@deepseek-ai/dsh-muse-market/cloud`。将 `baseUrl` 设为登录所用的规范化 HTTPS Muse Account origin，或回环 HTTP。profile 使用其他私有账号文件时，显式指定 `sessionFile`。完整 JSON 预算和单请求超时应与本地归档限制分别配置；参见[包参考](../../../../packages/host/muse-market/README.zh.md#account-bound-cloud)。
2. 仅通过专用具名 profile 部署私有服务端，并为现有账号网关代理配置匹配的 secret。备份完整服务端存储，包括 SQLite 与不可变 blob。参见[网关部署](../../../../services/muse-accounts/README.zh.md)。
3. 更新显式调用方，在 `publishDraft` 前保留原上传请求 key 和精确的本地归档。查看返回草稿后，才通过 `review(id, revision, 'submit', '')` 提交。上传未确认时复用同一 key 和归档；审核冲突时读取原 id，并要求新的显式决定，不得自动提交更新的修订。
4. 将目录中所选的 SHA-256 传给 `installPublication`，确认完整的返回发行包和停用状态安装记录。选择默认版本仍需独立的激活服务；云端审核通过或下载均不会选择默认值。目录最多返回 100 条记录，请缩小搜索范围，不要将一次结果视为完整目录。

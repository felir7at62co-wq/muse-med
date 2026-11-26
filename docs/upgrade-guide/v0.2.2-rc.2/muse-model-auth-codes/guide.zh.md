---
kind: upgrade-guide
description: "Muse 桌面端用具体错误码记录带网关标记的鉴权失败，此前统一记录为 AUTH。"
---

# Muse 模型鉴权错误码

[English](guide.md) | 中文

## 变更

模型请求尚未输出时，如果网关确认上游 API 密钥无效，新版桌面端记录 `UPSTREAM_CREDENTIAL_REJECTED`。如果网关拒绝 Muse 会话，则记录 `MISSING_CREDENTIAL`。这两种错误此前均记录为 `AUTH`。旧网关响应没有新标记时仍记录 `AUTH`。

## 迁移

1. 如果按 `AUTH` 筛选桌面端会话错误，请将 `UPSTREAM_CREDENTIAL_REJECTED` 纳入供应商错误筛选，将 `MISSING_CREDENTIAL` 纳入登录错误筛选。现有会话日志无需迁移。
2. 配合使用新版桌面端和网关。在测试环境中确认上游密钥被拒时可切换到符合条件的供应商，并确认 Muse 会话过期时会提示重新登录。

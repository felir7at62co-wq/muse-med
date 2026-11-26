---
kind: upgrade-guide
description: "剧变 HTTP 403 现在报告访问被拒，不再误称登录过期。"
---

# 区分剧变权限和登录失败

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-jubian` 现在把 HTTP 403 分类为 `PERMISSION_DENIED`，与应用信封 403 一致。HTTP 或信封 401 仍为 `AUTHENTICATION_REQUIRED`。本地凭据失败保留该错误码，并通过包自有说明区分未配置、格式错误和凭据提供方读取失败。不清除凭据，也不重试失败请求。

`jubian_catalog` 新增 `method: auth`：使用 Muse 当前凭据，免费只读请求一次项目列表，丢弃项目内容，记录结构化错误或可读确认。它不验证指定项目权限和生成能力。设置显示已配置或在剧变网页登录，均不能证明 Muse 凭据已刷新。

## 迁移

1. 此前把 HTTP 403 当成登录过期的消费者应处理 `PERMISSION_DENIED`，将其视为访问被拒，不仅凭该响应反复要求重登。
2. 登录更新后，在 Muse 的剧变设置更新凭据，再调用 `jubian_catalog` 的 `{"method":"auth"}`。下次调用直接解析更新值，无需重启；来源为只读时检查设置里的凭据来源。
3. 确认预检返回 `read_access_confirmed`，或保留认证、权限、网络和响应错误。可读确认不授权也不提交付费工作。预检范围见[工具包](../../../../packages/jubian/tool-jubian/README.zh.md)。

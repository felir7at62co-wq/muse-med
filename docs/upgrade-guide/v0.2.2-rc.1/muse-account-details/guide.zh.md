---
kind: upgrade-guide
description: "自定义 Muse 账号网关和控制器实现必须提供必需的 details 方法。"
---

# 自定义 Muse 账号实现需要 details 方法

[English](guide.md) | 中文

## 变更

传入 `MuseAccountController` 或 `MuseAccountService` 的自定义实现，必须在既有账号操作之外实现 `details`。网关接收 `details(cookie, request)`，服务控制器接收 `details(request)`，两者均返回 `Promise<MuseAccountDetails>`。仅提供登录、状态和登出操作的既有实现将无法通过 TypeScript 检查。内置网关和控制器已提供此方法。

`MuseAccountDetails` 是完整个人详情与仅含中转观测的 `account-data-v1` 用量的联合类型。消费者必须先根据 `protocol` 缩窄类型，再读取资料、分组或用量分页。仅含中转观测的分支明确标记资料与分组的可用性，并保留可为 null 的 Token 合计、UTC 日期范围和不透明游标。

## 迁移

1. 尽量使用 `createMuseAccountGateway(baseUrl, requestTimeoutMs)` 和 `MuseAccountController`。自定义网关必须使用传入的 cookie 读取已认证账号的 `/api/muse.account/details` 响应，不接受调用方指定的账号标识。
2. 按照[账号类型](../../../../packages/host/muse-account/src/types.ts)为自定义服务控制器和测试替身添加 `details(request)`。当 `result.protocol === 'account-data-v1'` 时，显示 `availability` 和仅含中转观测的 `usage`，并将 `usage.nextCursor` 作为下一次请求的 `cursor`；此协议不提供全部历史选项。否则读取完整资料、分组和偏移分页。未知 Token 计数保留为 `null`。未登录或本地登录在响应完成前发生变化时，应拒绝读取结果。
3. 运行集成的 TypeScript 检查，登录后打开**设置 → MUSE**。确认账号详情正常加载，并且切换账号后不会出现其他登录账号的资料和用量。

---
kind: upgrade-guide
description: "设置引导 owner props 要求提供 onVisible 回调，自定义弹窗在可见挂载时调用它。"
---

# 引导弹窗可见时通知设置

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-settings/client` 的 `SettingsOnboardingOwnerProps` 要求提供 `onVisible(): void`。此前，选中引导步骤就会关闭设置；现在仅在该步骤通知弹窗可见时关闭。自定义设置外壳和 `settings.onboarding` 贡献方必须实现此通知。

`@deepseek-ai/dsh-client-ui-settings-models/client` 的可选 `settings.models.sign-in` slot，其 owner props 同样要求提供 `onVisible`。父步骤将同一回调转发给这一账号登录选项。

## 迁移

1. 自定义设置外壳构造 `SettingsOnboardingOwnerProps` 时，提供稳定、幂等的 `onVisible` 回调，用于关闭设置。
2. 自定义 `settings.onboarding` 贡献方通过稳定的 callback ref，在可见弹窗的 DOM 挂载时、绘制前调用 `onVisible()`，避免设置面板在新弹窗后方仍可交互。隐藏或加载分支不得调用它。[设置 slot 参考](../../../../packages/client/ui-settings/README.zh.md#filling-the-settings-slots)定义此回调。
3. `settings.models.sign-in` 贡献方应将 `onVisible` 转发给可见登录弹窗的 DOM 挂载回调。加载中或凭证已保存的状态不得发出通知。
4. 确认 TypeScript 消费方编译通过，隐藏或加载中的步骤保持设置打开，可见的引导或登录弹窗关闭设置。

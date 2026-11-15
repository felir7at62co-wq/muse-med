---
kind: upgrade-guide
description: "Settings onboarding owner props require an onVisible callback that custom dialogs call when they mount visibly."
---

# Notify Settings when an onboarding dialog becomes visible

English | [中文](guide.zh.md)

## Change

`SettingsOnboardingOwnerProps` from `@deepseek-ai/dsh-client-ui-settings/client` requires `onVisible(): void`. Settings previously closed whenever an onboarding step was selected; it now closes when that step reports a visible dialog. Custom Settings shells and `settings.onboarding` contributors must implement this notification.

The optional `settings.models.sign-in` slot from `@deepseek-ai/dsh-client-ui-settings-models/client` also requires `onVisible` in its owner props. The parent step forwards the same callback to this account-login choice.

## Migration

1. In custom Settings shells, supply a stable, idempotent `onVisible` callback that closes Settings when constructing `SettingsOnboardingOwnerProps`.
2. In custom `settings.onboarding` contributors, use a stable callback ref to call `onVisible()` when the visible dialog's DOM attaches, before paint, so the Settings panel cannot remain interactive behind the new dialog. Hidden or loading branches must not call it. The [settings slot reference](../../../../packages/client/ui-settings/README.md#filling-the-settings-slots) defines the callback.
3. In `settings.models.sign-in` contributors, forward `onVisible` to the visible sign-in dialog's DOM attachment callback. Loading or stored-credential states must not notify.
4. Confirm that TypeScript consumers compile, a hidden or loading step leaves Settings open, and either a visible onboarding or sign-in dialog closes Settings.

---
kind: upgrade-guide
description: "The Muse Desktop profile no longer mounts the session coordinator, so Main Sessions stop routing and `coordinator_*` tools are gone."
---

# Muse session coordinator archived

English | [中文](guide.zh.md)

## Change

The Muse Desktop profile mounted `@deepseek-ai/dsh-session-coordinator`, its worker and Client entries and `@deepseek-ai/dsh-session-activity`. It opened a Main Session on startup and offered `main-session` for new conversations. Main searched Sessions and dispatched work with `coordinator_*` tools, and dispatched Sessions answered with `coordinator_report`.

The profile now mounts none of these entries. No Main Session opens on startup, `main-session` is not selectable, the `coordinator_*` tools are not registered, and the short-drama prompt no longer tells a conversation to report to Main. The `main-session` preset remains only to reopen an existing Main Session: it carries no routing role and no tools, so the conversation shows its history and dispatches nothing. Sessions that Main dispatched remain ordinary short-drama conversations. Session logs and the `muse_coordination` storage domain are neither modified nor deleted. The coordinator packages stay in the repository, and a custom composition can still mount them.

This affects anyone who routed work through the Main Session and any automation that called `coordinator_*` tools in the Desktop profile.

## Migration

1. Before upgrading, finish or write down the tasks that are still open in the Main Session. After the upgrade Main no longer tracks or reconciles them.
2. After upgrading, start new work in a Bot or in an ordinary conversation under “Muse 会话”. Continue earlier work in the Session that did it; it is listed in its workspace like any other conversation.
3. Remove `main-session` from any profile patch that names it in `selectablePresets` or as a default preset.
4. A custom composition that still needs routing inserts the coordinator entries itself, as the [Web test overlay](../../../../apps/web/tests/muse-session-coordinator.overlay.yml) does.
5. Confirm the result: the app starts without opening a Main Session, an existing Main Session opens with its history, and the tool list of a new conversation contains no `coordinator_*` name.

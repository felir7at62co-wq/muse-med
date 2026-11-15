---
kind: upgrade-guide
description: "Muse removes the bundled Bot interface and starts new work in ordinary Sessions while retaining historical data."
---

# Muse uses ordinary Sessions

English | [中文](guide.zh.md)

## Change

Muse Desktop no longer loads the bundled `ds-bot` interface, team services or phone-control entry. New conversations use `short-drama`. The `bot-coordinator` preset remains registered only to recover existing Sessions with ordinary tools; it is unavailable for new conversations and does not restore Bot teams or automatic orchestration.

Bot roster and group management, cross-Bot messages, `show_view`, `ask_user`, `read_browser`, secret cards, Bot memory and saved Bot capabilities are unavailable in the product. Native Session history, `ask_user_question`, `present`, credential settings, web search, background Jobs, subagents and the collection/download tools remain available. Ordinary Web Sessions remain supported; the archived Bot phone-control interface is not replaced by a new phone entry.

Session logs, working files, model selections and Bot state are not deleted or converted. Keeping those files does not reactivate the archived interface or import Bot memory into ordinary Sessions.

## Migration

1. Finish active work before upgrading. Preserve the existing application home, Electron userData, Session logs, Bot state and source archive. No credential, workspace or historical Session rewrite is required.
2. Desktop profile preparation removes the built-in Bot bundle and disables its legacy profile rows. Original package metadata is backed up as `package.json.<UTCstamp>-<UUID>.bak`; affected profile patches are backed up byte-for-byte as `cordis.patch.yml.bot-retired-<UUID>.bak`. Keep these backups with the unchanged Bot data. The reserved `$DSH_HOME/profiles/desktop` profile rejects adding, updating or enabling `ds-bot`/`muse-bot`; retained disabled inventory remains readable. Separate custom deployments of the archived plugin remain their owner's responsibility.
3. Open ordinary conversations from history or create a new conversation. Existing `bot-coordinator` Sessions can use their retained general tools; select the desired native model and workspace before further work. Use `ask_user_question` for decisions and `present` for file delivery. Credentials remain in their existing settings rather than Bot secret cards.
4. Confirm that the product offers ordinary conversations without Bot navigation or phone-control entry. Check existing Session history and model selection, then inspect `job_list` and search for a collection/download tool. The hidden legacy preset must not appear among new-conversation choices. Do not remove old Bot files merely because their interface is inactive.

---
kind: upgrade-guide
description: Skill activation adds a version-2 local ledger and required Session release bindings that older builds may refuse.
---

# Skill publication storage and Session bindings

English | [中文](guide.zh.md)

## Change

The private Desktop composition now mounts local Skill storage and the separate `@deepseek-ai/dsh-muse-market/activation` component. Loading activation migrates version-1 `installations.json` to version 2 with empty defaults. It retains an exclusive byte-exact `installations.v1.backup.json` before bounded atomic replacement. Base installation records still return `enabled: false`; activation state comes from `defaults()` and `binding()`.

The Session header remains [V4](../../../session-format-status.md), but participating Sessions record required `muse-market/bound` before their first model request. A build that does not recognize that required event refuses the log safely. A newer reader accepts older logs; an executed Session without a binding keeps an empty market selection, while a blank Session selects current defaults on its first task. A full-prefix fork inherits its recorded selection. Compatibility depends on the exact reader build and known event types, not the product version label alone.

## Migration

1. Stop the affected profile and back up its complete publication `root` alongside raw Session logs. Keep `installations.json`, `installations.v1.backup.json` when present, and all referenced package directories together. Session backups alone do not include publication storage.
2. Named profiles needing activation mount the base service and its separate `/activation` entry as shown in the [package README](../../../../packages/host/muse-market/README.md). Storage-only profiles can keep the base row alone. Existing filesystem Skills are neither moved nor selected automatically. Flat Markdown Skills still require a separate directory containing `SKILL.md` and only their intended resources before preparation.
3. After migrating version 1, confirm the version-2 ledger initially has empty defaults and preserves the original backup bytes. Existing version-2 choices remain unchanged. An oversized successor or conflicting backup refuses migration; retain the original files and resolve the error instead of overwriting the backup. A version-1-only reader cannot read the successor ledger; retaining its backup does not establish automatic downgrade support.
4. Read `ctx.museMarketActivation.defaults()`, then explicitly call `setDefault({skillName, expected, target})` with the observed archive SHA or null and the selected exact SHA or null. Verify a new task binds that release and an already-bound Session retains its previous release. Use `binding({sessionId})` to distinguish `blank`, `bound` and `legacy`; the storage `enabled` field does not answer this question.
5. Keep every recorded release available with its exact ZIP and matching extracted resources. Missing or changed cache bytes refuse loading without selecting another version; restore the complete matching cache from backup. Disabling a default does not release Session references, so removal can still refuse. Before switching builds, verify required-event and ledger support against copies; retain raw logs and the complete storage backup for recovery.

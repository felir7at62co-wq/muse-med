---
kind: upgrade-guide
description: Muse Desktop removes the bundled Ponytail plugin, its commands, and its six skills.
---

# Desktop Ponytail removal

English | [中文](guide.zh.md)

## Change

Muse Desktop no longer ships or automatically activates `@mengyuly/dsh-ponytail`. Its coding persona, `/ponytail` command, and six `ponytail*` skills are unavailable in the bundled environment. Other community plugins and drama skills remain available.

## Migration

1. Start the updated Desktop application. Startup backs up the active profile's `package.json` before removing the retired package from `dsh.profile.bundles`; other user-installed bundles remain in order.
2. Remove explicit Ponytail rows from any personal `cordis.patch.yml` or custom composition that you added yourself. The migration does not edit these personal rows or remove separately installed npm dependencies.
3. Confirm that the profile starts and the bundled plugin inventory no longer includes Ponytail. Existing Session logs and previously exported documents remain unchanged.

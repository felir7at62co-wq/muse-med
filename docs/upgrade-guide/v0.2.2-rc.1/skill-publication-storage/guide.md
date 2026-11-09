---
kind: upgrade-guide
description: Local Skill publications require their own storage backup in addition to Session data.
---

# Local Skill publication storage

English | [中文](guide.zh.md)

## Change

Explicit deployments of `@deepseek-ai/dsh-muse-market` store local publication archives, extracted resources and installation records under a separate absolute `root`. Session backups do not include this package-owned version-1 storage. Existing filesystem Skills are neither moved nor activated, and Desktop does not mount this private component by default.

## Migration

1. When mounting the component in a named `dsh` profile, select an absolute `root` and back up that entire directory alongside your existing Session data. Keep archive and record files together; do not copy an installation ledger without its referenced packages.
2. To prepare a flat Markdown Skill, create a separate directory with `SKILL.md` and only the intended resources, register that bundle and explicitly select it. Keep the original Skill until the exported ZIP has been inspected. Shared parent directories are not packaged automatically.
3. Confirm that importing the exported ZIP returns the same SHA-256 release identity and `enabled: false`. This checks local publication storage, not activation, cloud publication or execution authorization. See the [package README](../../../../packages/host/muse-market/README.md).

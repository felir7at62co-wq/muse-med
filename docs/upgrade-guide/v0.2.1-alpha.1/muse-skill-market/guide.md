---
kind: upgrade-guide
description: "Muse market discovery and publication accept Skills only and remove Bot authoring and launch actions."
---

# Muse Skill market

English | [中文](guide.zh.md)

## Change

The Muse website and Desktop market distribute Skills. Bot discovery, preparation, upload, download and launch actions are removed from the market. Direct market requests also reject Bot packages. Existing installation records remain readable so retained sessions can recover their bound resources.

Skill cards and creation previews automatically choose a Muse character from the Skill name and purpose. The prepared or uploaded archive stores the selected portrait identifier, keeping the preview and published card consistent.

## Migration

1. Update the market Host, cloud service and website together. Use the matching generated Remote client because `sources()` returns local Skills and `prepare(metadata, skillNames)` prepares a Skill package.
2. Authors open **Create Skill**, select a local Skill or upload a Skill ZIP, then inspect the automatic character preview before submitting a draft for review. A package must declare `kind: "skill"` and include its referenced instruction files and resources.
3. Verify that discovery and creator lists contain Skills, that Bot ZIP uploads are rejected, and that the same Skill character appears in preview, review and public discovery. Open an existing session to verify its retained resources still load.

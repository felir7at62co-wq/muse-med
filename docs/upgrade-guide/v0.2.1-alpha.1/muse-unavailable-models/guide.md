---
kind: upgrade-guide
description: "Muse withdraws built-in GLM-5 and GLM-5.1 routes that the upstream model catalog no longer supplies."
---

# Select an available Muse model for saved GLM-5 conversations

English | [中文](guide.zh.md)

## Change

The Muse built-in model directory withdraws `yunying/glm-5` and `yunying/glm-5.1`: both return HTTP 404 and are absent from the upstream model inventory. Conversations that saved either selection must choose a currently supplied model before continuing. Other configured model IDs retain their identity. Existing Session logs and conversation content remain readable; this change does not alter the Session format or substitute a different model automatically.

## Migration

1. Refresh the Muse model list after signing in, then open the affected conversation's model picker.
2. Select an available Muse model, such as `glm-5.3` or `glm-5.3-flash`, and continue the task. Confirm that the picker shows the new selection and the next request completes.
3. Administrators should retain a private directory backup before removing the two entries from `providers.yunying.models`. Edit through the global model settings or restart the account gateway after directly editing its private directory file. Confirm that authenticated `GET /api/desktop-models/providers` no longer advertises the withdrawn IDs. Restore an ID only after its provider supplies it again and a tool call with continuation succeeds.

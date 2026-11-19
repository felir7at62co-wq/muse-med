---
kind: upgrade-guide
description: "Jubian tools give local project binding failures their own error code."
---

# Jubian project binding errors

English | [中文](guide.zh.md)

## Change

Jubian tools now report `PROJECT_BINDING_INVALID` instead of `CONTRACT_CHANGED` when `project_config.json` is missing, invalid, or identifies another project. Existing project configuration remains valid.

## Migration

1. In callers that classify Jubian errors, handle `PROJECT_BINDING_INVALID` by asking for the correct local project directory and a valid `jubian_script_id`.
2. Verify the handler with a missing file in a test directory. Preparation must report the local error and leave the remote task list unchanged.

---
kind: upgrade-guide
description: Drama plugin entry points move reusable helpers to named subpaths and remove internal tool factories.
---

# Drama plugin helper imports

English | [中文](guide.zh.md)

## Change

Host callers that imported helper values from the drama settings, Jingliu connection, or Workbench connection package roots now import them from named subpaths. The Jingliu and Script Workshop tool packages no longer export tool factories and their private constants. Cordis profile entries still use the package roots.

## Migration

1. Import `draftDirectory` from `@deepseek-ai/dsh-drama-settings/draft-directory`.
2. Import `boundedBytes`, `mediaPath`, and `projectMediaFolder` from `@deepseek-ai/dsh-jingliu-connection/media`.
3. Import `WorkbenchSessions`, `boundedBytes`, `isRecord`, `requestJson`, and `workbenchOrigin` from `@deepseek-ai/dsh-workbench-connection/transport`. Import `scriptDetail`, `scriptList`, `scriptOf`, and `scriptSummary` from `@deepseek-ai/dsh-workbench-connection/scripts`.
4. Mount the Jingliu and Script Workshop tools through the package roots and call the registered tools. The previous `workflowTools`, Script Workshop factories and constants, and `SCRIPT_WORKSHOP` were internal implementation values and have no public replacement.
5. Rebuild the consumer and run one scenario that mounts the affected plugins and calls the helper imports.

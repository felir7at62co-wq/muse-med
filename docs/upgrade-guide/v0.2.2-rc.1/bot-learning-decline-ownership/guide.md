---
kind: upgrade-guide
description: "Legacy Bot skill refusals without an owner stop suppressing learning proposals."
---
# Bot skill refusals belong to one Bot

English | [中文](guide.zh.md)

## Change

Bot learning stores new declined skill proposals with their Bot identifier in `<Bot home>/learning/state.json`. A learning review receives only that Bot's declined skills. Existing skill refusals without a Bot identifier remain saved but no longer enter model requests or suppress proposals; their source cannot be determined safely. A previously declined idea can therefore appear again after upgrading. AGENTS.md refusals keep their existing project-folder scope.

## Migration

1. Keep the existing Bot home and `learning/state.json`; no file edit or Session-log migration is required.
2. If an old idea appears again, decline its card in the originating Bot conversation. The new refusal records that Bot's identifier.
3. Confirm that the card closes and a later review by that Bot recognizes its refusal. Other Bots' learning reviews do not receive it.

---
kind: upgrade-guide
description: "DTK deployment receipts remove the unverified profiles field and require observed private runtime settings."
---

# DTK verification receipts

English | [中文](guide.zh.md)

## Change

The DTK deployment verifier no longer emits `profiles` in its JSON receipt. Required running services are identified by the existing `images` keys; they do not establish historical Compose profile flags. New receipts include observed `publishedBindings`, `networkModes` and `transcriberRuntime`. Public bindings, unknown runtime state or configured transcription now refuse a successful receipt.

## Migration

1. Update receipt consumers to stop reading `profiles`; use `images` when checking which required services were observed.
2. Follow the [deployment verification procedure](../../../../services/muse-media/deploy/README.md) and rerun `python3 services/muse-media/deploy/verify.py --source /opt/muse/dtk/source-v5.1.10` from the repository root. The readiness phase has a 120-second budget, with possible operating-system process creation or termination overhead; `--readiness-timeout <seconds>` accepts a positive finite replacement.
3. Require a successful exit and a fresh receipt `verifiedAt`. Read `listen` and `transcriberEnabled` from that newly verified receipt; older receipts remain historical records and are not rewritten after a failed check.

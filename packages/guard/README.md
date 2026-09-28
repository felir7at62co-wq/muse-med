---
description: "Package map for the guard family: the advisory repeat-tool reminder, the per-tool-call timeout policy, the composition guard that reports tools withdrawn by a live reload, and the short-drama gate that refuses a workshop write or paid submission breaking the format's rules, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene and composition guard family

English | [中文](README.zh.md)

## Summary

The `guard/` packages surface repeated tool calls, end calls that exceed declared timeouts, and report tools withdrawn by live reload. The short-drama guard rejects workshop writes that break spoken-track or shot limits and paid generation before the official-asset check. `repeat-tool-reminder` and `timeout-policy` ship in the `dsh` base bundle; the package READMEs explain configuration and recovery.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Four small plugins cover the four patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`composition-guard/`](composition-guard/README.md) | Reports a session whose tools a live composition reload withdrew, so the person knows to restart the host |
| [`drama-gate/`](drama-gate/README.md) | Refuses a short-drama workshop write or paid submission that breaks the format's rules, and names the fix |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline and scope views all three guards build on, then the reminder's configuration, the timeout-library decision, and the reload defect the composition guard reports.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and the scope views the guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.
- [Live-reload port traps Agent Note](../../.agents/notes/implemented/architecture/2026-09-17-product-capability-plane-and-port-traps.md) — the defect `composition-guard` detects, and why only a restart recovers it.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

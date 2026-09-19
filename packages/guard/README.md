---
description: "Package map for the guard family: the advisory repeat-tool reminder, the per-tool-call timeout policy, the composition guard that reports tools withdrawn by a live reload, and the short-drama gate that refuses a workshop write or paid submission breaking the format's rules, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene and composition guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps a session honest about what it is doing. `repeat-tool-reminder` notices when the model repeats the exact same tool call and asks it to change approach or finish, so a stuck loop stops burning time and tokens. `timeout-policy` puts a time limit on tool calls that declare one, so a hung call returns a clear timeout error. `composition-guard` watches the composition itself: when a live reload withdraws tools from a running session, it says so in the log and inside that conversation, naming the recovery. `drama-gate` is the domain guard a short-drama composition mounts: it refuses a workshop write that would put narration in the spoken track, overrun the shot length or character budget, or submit a paid generation before the official-asset gate passed, and every refusal names the exact fix. Both original guards ship in the `dsh` base bundle.

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

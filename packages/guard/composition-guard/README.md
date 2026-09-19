---
description: "Composition guard plugin that detects and reports a running session whose preset-provided tools were withdrawn by a live composition reload, for users and maintainers diagnosing a session that lost its tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-composition-guard

English | [中文](README.zh.md)

## Summary

Use this package to learn immediately when a running session silently loses the tools its composition gave it. DSH can live-reload a profile patch; when a host-plane row changes under a running host, an agent published before the change can lose the tools its scope chain gave it, and DSH never re-composes a standing mount in process. The guard reports that shape — tools gone while the agent's preset did not change — in one log line and one message inside the conversation, naming the recovery: restart the host. It cannot put the tools back.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin once on the host plane. There is nothing to learn: it watches, and stays silent until a composition change withdraws tools from a session that is already running.

### When to choose it

Choose it when a deployment reloads composition while sessions are live — the shipped `web` profile reloads patches live by default — and a session that quietly loses its file or shell tools would be discovered late, by a model that reports it cannot edit anything. Avoid expecting it to repair: nothing in process re-composes an agent that already ran a turn, so the guard's whole contribution is telling a person what happened and what to do.

### Setting it up

Mount it in the host composition, beside the guards that already ship there:

```yaml
- name: '@deepseek-ai/dsh-composition-guard'
  config:
    announceInSession: true   # also deliver the notice into the affected conversation
    maxAgentsPerUpdate: 64    # cap on live agents inspected per loader update
```

| Field | Default | Meaning |
|---|---|---|
| `announceInSession` | `true` | Whether the affected session also receives the notice in its own conversation; the log line is always written |
| `maxAgentsPerUpdate` | `64` | How many live agents one loader update inspects; agents beyond the cap are inspected by the next update |

An invalid `maxAgentsPerUpdate` fails at load with a clear error rather than falling back to a default. Both fields carry JSDoc on {@link Config}, which is what the generated configuration catalog reads from.

### What you get

When a live reload withdraws tools from a session whose preset did not change, the host logs one line naming the session, its preset, and the missing tool names, and the conversation receives a short notice naming the tools and the recovery. The same regression is announced once: further updates stay silent until the names come back, at which point a later regression is news again. A session that changes preset is a legitimate re-composition and is never reported — the new composition simply becomes the baseline.

Mounting it into an already-running host is the point: sessions that exist when the guard activates are adopted with the composition they have right now, so those sessions are watched from that moment on. The one thing the guard deliberately does not do is announce a composition that was already incomplete when it arrived: it has no earlier observation to compare against, and a notice that fires on every start would be worse than silence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard records baselines, when it re-checks them, and how it reports; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on five commitments:

- **Detect, never repair.** The framework does not re-compose an existing standing mount, so the honest contribution is a report; a guard that pretended to fix the composition would be a second source of truth about it.
- **Baseline from the creation dispatch.** `agent/created` runs after the factory's setup composed the agent and before anything started it, so the names recorded there are the composition the agent's history will be produced under.
- **Adopt what is already running.** The guard is composed into a live host, so activation enumerates `ctx.agents.list()` and baselines every existing agent, marking them as adopted rather than born under this plugin.
- **Report only an unexplained loss.** A disappeared name is reported only when the composed preset did not change; a preset change is a re-composition, and the guard re-baselines instead.
- **Contain every failure.** A guard that breaks the host is worse than the defect it reports, so each check is wrapped and reports itself at most once per agent.

### How a scope's visible tools are read

One agent's visible names come from `ctx.tools.schemas(scope)`, the registry's documented enumeration of a scope's visible tools — one schema per visible name, after restrictions, scoped shadowing, and the PTC transport, which is exactly what the model would be offered. Its argument is a `ScopeKey`, not an Agent: the guard passes `scopeOf(agent.ctx)`, the agent's own key, so it reads the view that agent sees rather than the process-global one. An agent with no scope has no agent view to compare, so it is skipped rather than judged against the global layer.

### When the comparison runs

The trigger is the loader's config update, `ctx.on('internal/update', …)` — the same waterfall `dsh-app-boot` and the Loader observe when a fiber's config is applied and the plugin restarts behind it. The guard registers globally, because the row that changed need not be its ancestor, and never prepends, so it sits downstream of Cordis's own `internal/update` chain driver: `next()` therefore returns the restart the update runs behind, and the comparison sees the post-reload state rather than the state the reload is about to replace. A reload that failed sweeps too, because withdrawn rows are equally gone and the recovery is the same one.

Two details keep the check honest. The comparison is per agent against that agent's own baseline, never against another agent, and the preset is re-read from the roster on every comparison (`ctx.get('agentPresets')?.composedPreset(agent.ctx)`, optional because a rosterless deployment is a supported composition). Records are keyed by session id and removed when the registry announces `agent/disposed`, and the whole record set is owned by the guard's own context effect, so unloading the row — including a whole-tree teardown — drops it.

### Reporting once per regression

Each record carries the names already announced for the current regression. A comparison that finds nothing missing re-arms the record, so a later regression is announced again; a comparison that finds the same regression already announced returns silently. A report is marked only after a channel accepted it, so an announcement that reached nobody is retried on the next update rather than declared delivered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, baseline recording, adoption, the `internal/update` sweep, and both announcement channels |
| [`src/baseline.ts`](src/baseline.ts) | The per-runtime record set and its state transitions; bundled into the package entry, so the companion shares it rather than a second copy |
| [`src/invariant.ts`](src/invariant.ts) | The invariant companion: every agent that addresses a model must be one the composed guard holds a baseline for |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the scope model the guard reads through to the defect it exists for and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the registry views and scope layers `ctx.tools.schemas()` resolves.
- [Agent presets package](../../preset/agent-presets/README.md) — the standing mount whose registrations a frozen agent can lose.
- [Live-reload port traps Agent Note](../../../.agents/notes/implemented/architecture/2026-09-17-product-capability-plane-and-port-traps.md) — the measured defect, its evidence, and why the recovery is a restart.
- [Composition guard Agent Note](../../../.agents/notes/implemented/architecture/2026-09-17-composition-guard-detects-live-tool-withdrawal.md) — what this guard can and cannot do, and the alternatives it rejected.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Withdrawn-composition notice

#### What the model sees

When a live composition reload withdraws tools from a session whose preset did not change, that agent's conversation receives one user-role message attributed to this plugin (`{ kind: 'plugin', plugin: 'composition-guard', form: 'notice' }`). The missing tool names are data-dependent; the surrounding text is fixed. The collapsed transcript row shows the bounded summary `工具被热加载撤掉：缺少 <toolNames>`.

##### Withdrawn-composition notice

```markdown
这个会话的部分工具被一次配置热加载撤掉了（缺少：<toolNames>）。**重启一次 DSH 宿主**即可恢复；已经打开的会话不方便重启时，可新开一个会话继续。
```

#### Token effect

Zero tokens until a regression is detected: the plugin adds no prompt section, no tool schema, and no text to a healthy session. One detected regression adds one short retained message, naming at most the withdrawn tool names; a re-armed regression adds one more.

#### KV Cache effect

Append-only; the notice is added after the reusable request prefix and does not invalidate existing KV Cache entries. Setting `announceInSession: false` removes this message entirely and leaves the log line as the only record.

## Known Limitations and Deferred Work

These limits define what this guard is and is not. They are current package constraints, not a task backlog.

- **It detects; it does not repair** — the framework does not re-compose an existing standing mount, so a withdrawn session stays withdrawn until the host restarts. The guard's contribution is the report and the stated recovery.
- **A composition already incomplete at activation is not announced** — baselines come from observation, and an agent the guard adopts has no earlier observation to compare against. Reconstructing a durable expectation from the session log's recorded request headers is the deferred alternative; the guard deliberately does not guess, because a notice on every start is worse than silence.
- **Only tool names are compared** — a reload that withdraws a prompt section, a skill, or a projection from a frozen agent is not reported, and a reload that swaps one tool for another of the same name is invisible.
- **One guard row per runtime** — a second instance's baselines are a second answer to the same question, so the newest record replaces the previous one and the companion reads only that.
- **In-memory only** — baselines live and die with the host process, so a restart starts every agent from a fresh observation.
- **The notice text is Chinese** — it is written for the person whose session lost its tools, and the repository's client copy is locale-owned while this is a host-side message to the conversation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The durable fix for the underlying defect — a live reload withdrawing host-plane rows without re-registering them for already-materialized agents — belongs in the harness core as a patch to the reload path, and is not owned by this package. If that lands, the guard's detection becomes a narrow backstop rather than the only signal.

`tools/change` is the registry's own notification that a scope's visible set changed, and it fires on exactly the withdrawals this guard cares about. It is deliberately not a trigger here: it also fires for every scoped registration and shadow, so a comparison on it would run far more often than the update that must be explained. Revisit the trigger if a reload path stops emitting `internal/update`.

This README does not yet link this package's anchored section of the generated configuration catalog: regenerating it is currently blocked by unrelated packages whose config fields carry no JSDoc prose, so the anchor does not exist yet. Add the link back when `pnpm run doc-sync` regenerates the catalog cleanly.

</details>

# Agent Note: Detecting the tools a live reload withdraws, instead of re-composing them

Status: implemented

English | [中文](2026-09-17-composition-guard-detects-live-tool-withdrawal.zh.md)

## Problem

A host-plane composition change under a running host can withdraw the tools an already-published agent resolves through its scope chain. The framework does not re-compose a standing mount in process, so the withdrawal is permanent for that session: a later host restart does not heal it either, because the agent's tool view resolves through the scope chain the published agent already holds. Re-selecting the session's preset is refused once it has taken a turn (`agent-preset/locked`, `session "<id>" has already started; its agent preset is fixed`).

The defect and its measured evidence are recorded in [the port-traps Agent Note](2026-09-17-product-capability-plane-and-port-traps.md), which also states the recovery available today: a cold restart, or a new session. That note closes by saying the durable fix — re-registering withdrawn host-plane rows for already-materialized agents — belongs in the harness core and has no committed owner.

What it left open is the interval between the withdrawal and the person noticing. The failure is silent from the affected session's side: the model simply stops having the tools, and the first evidence is usually a request the session cannot carry out. A user who is mid-task has no signal that anything changed, no way to tell this apart from their own mistake, and no statement of what to do.

## Decision

A **host-plane guard package detects the withdrawal and says it in plain language.** It ships as [`packages/guard/composition-guard`](../../../../packages/guard/composition-guard), mounted once in the host composition:

```yaml
- name: '@deepseek-ai/dsh-composition-guard'
```

The guard does not repair anything, and the package README says so before it says anything else.

### A row inserted into a profile must be resolvable from that profile's `node_modules`

Mounting the row is half of installing this package. `dsh_plugin_packages` — the tool contributed by [`@deepseek-ai/dsh-plugin-package-inventory-deepseek`](../../../../packages/llm/plugin-package-inventory-deepseek), enabled by default in the base composition bundle ([packages/bundle/base/cordis.patch.yml](../../../../packages/bundle/base/cordis.patch.yml)) and therefore running on every DeepSeek request — resolves the owning package of **every** activated Loader entry through `PackageIdentityResolver.resolve()` → `barePackageManifest(packageName, anchors, this.packages)`, which walks `createRequire(parentURL).resolve.paths()`. That walk starts from the **profile directory's `node_modules`** (`$DSH_HOME/profiles/node_modules`), not from the checkout.

A row that a profile patch inserts but that `node_modules` cannot reach resolves to `undefined`, and the resolver throws `plugin-package-inventory-deepseek: cannot resolve active package "<name>"` — which fails the model request. Nothing warns at load: launched from source (`tsx`), the Loader resolves the same row through the `tsconfig.base.json` paths mapping it already carries, so the row activates normally while the inventory cannot see it, and the failure surfaces only as a failed turn.

Inserting `@deepseek-ai/dsh-composition-guard` into `C:\Users\EDY\.dsh\profiles\web\cordis.patch.yml` reproduced the failure. Creating the junction `C:\Users\EDY\.dsh\profiles\node_modules\@deepseek-ai\dsh-composition-guard` → `E:\deepseek-harness\packages\guard\composition-guard` fixed it, and an A/B check run with the resolver's own function reported exactly that one package MISSING before and every package FOUND after — the profile composition is 164 lines and no other row failed.

So installing this guard, exactly like inserting any package into a profile patch, is two steps: mount the row, and make the package resolvable from that profile's `node_modules`. For a workspace package that reachability is a junction into the checkout under work:

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-composition-guard" `
  -Target "E:\deepseek-harness\packages\guard\composition-guard"
```

### The real client load error needs a wrapped `window.__ModuleLoader__.load`

Cordis's client module loader swallows a plugin's real error, and the browser reports only `Failed to load plugins: <id>` — the symptom, never the cause. Wrapping `window.__ModuleLoader__.load` over CDP and try/catching the target module's `exports.apply` revealed the true error in one run.

The shell rewrites that object in place, so a wrapper installed once in the setter is gone before the next load: the getter must return a **fresh Proxy on every access**.

### Baselines come from observation, and a running host is observed at activation

Each agent's baseline is the set of tool names its scope resolves, read through the registry's documented enumeration for a scope (`ctx.tools.schemas(scopeOf(agent.ctx))` — a `ScopeKey`, not an Agent) and paired with the preset the agent composes at that moment (`ctx.agentPresets.composedPreset(agent.ctx)`, read optionally so a rosterless deployment still works).

Two paths record a baseline. `agent/created` records one at publication, where the factory's setup has already composed the agent and nothing has started it. Activation records one for **every agent already live**, because the guard's whole use case is joining a host that is already running: a guard that only baselined later creations would be blind to exactly the long-lived session that already lost its tools.

An adopted baseline is the guard's first observation of that agent, so a composition already incomplete when the guard arrives is recorded as seen and **not announced**. There is no earlier observation to call a regression, and a notice that fires on every start is worse than silence. Reconstructing a durable expectation instead — the session log records the request headers actually sent — is deferred rather than guessed at.

### The comparison runs where the reload is reconciled, and after it

The trigger is `ctx.on('internal/update', …)`, the waterfall `dsh-app-boot` and the Loader observe when a fiber's config is applied and its plugin restarts behind it. The listener registers globally, because the row that changed need not be the guard's ancestor, and it does **not** prepend: sitting downstream of Cordis's own `internal/update` chain driver means `next()` returns the restart the update runs behind, so the comparison sees the post-reload state instead of the state the reload is about to replace. Both outcomes sweep, because a reload that failed leaves the same rows withdrawn and the same recovery applies.

### Only an unexplained loss is reported, and only once

A name that disappeared is a finding only when the agent's composed preset did not change; a preset change is a legitimate re-composition, and the guard re-baselines instead of reporting. Each record carries the names already announced for the current regression: a comparison that finds nothing missing re-arms it, so a later regression is news again, and a repetition of an announced one stays silent. A report is marked only after a channel accepted it, so an announcement that reached nobody is retried rather than declared delivered.

### Two channels, because the affected reader is a person

A regression writes one log line naming the session, its preset, and the missing tool names, and it injects one plugin-sourced notice into the affected conversation, naming the missing tools and the recovery in the language the person reads. The notice is authored by this package (`{ kind: 'plugin', plugin: 'composition-guard', form: 'notice' }`) so it renders as a labeled plugin message rather than an unexplained user prompt.

The notice text is Chinese, deliberately, and the package README records why: the repository's client copy is locale-owned, but this is a host-side message addressed to one person inside their own conversation.

### A failing guard must not be worse than the defect

Every check is contained, and a contained failure is logged at most once per agent rather than once per update. A logger that throws is one failed channel, not a failed announcement. The whole record set is owned by the guard's own context effect, so unloading the row — including a whole-tree teardown — drops it.

### The invariant companion checks the one relation that makes the guard useful

A guard that is blind is worse than no guard, and its blind spot is coverage. The package's [`./invariant`](../../../../packages/guard/composition-guard/src/invariant.ts) companion therefore asserts, on `system-prompt/assemble` — the same trigger the preset roster's companion uses, and for the same ordering reason, since an assembling agent has been published and its creation dispatch has settled — that an agent addressing a model is one the composed guard holds a baseline for. It reports nothing when no guard is composed in that runtime: the relation belongs to the guard, and a deployment that mounts the companion without the guard owes it nothing.

## Alternatives considered

**Fix the reload path in the harness core.** This is the durable fix and remains the right one; it is not this change. It is a core patch with no committed owner, and the interval it leaves open is what the guard closes. If it lands, the guard's detection becomes a narrow backstop rather than the only signal — which is why the guard reports instead of repairing, and why nothing in the package depends on the defect surviving.

**Ship the detection as a dynamic Cordis plugin.** Rejected for the reasons the port-traps note already records: a dynamic plugin lives only in the running process, cannot be reviewed, versioned, released, or rolled back with the deployment, and disappears on restart — which makes it exactly the wrong shape for a guard whose entire job is to outlive one run.

**Trigger the comparison on `tools/change`.** The registry's own notification that a scope's visible set changed fires on precisely the withdrawals this guard cares about. Rejected because it also fires for every scoped registration, restriction, and shadow, so the comparison would run far more often than the update that must be explained. It stays the documented fallback if a reload path ever stops emitting `internal/update`.

**Baseline from the session log's recorded request headers.** The durable log holds the tool schemas the model was actually sent, so it could tell an adopted agent what it used to have and make an already-incomplete composition reportable. Deferred: it makes the guard's first act a history reconstruction with its own failure modes (truncated or compacted logs, several headers across turns), and a wrong reconstruction produces a false alarm on every start. The recorded limitation states the gap rather than promising a check that can guess.

**Report every disappeared name, preset change included.** Rejected as noise: re-composition is a supported operation, and reporting its tool-set delta would train a reader to ignore the one message that matters.

**Log only, with no in-session notice.** Kept as configuration (`announceInSession: false`) and rejected as the default. The log reaches whoever reads host logs; the person whose session just lost its tools is inside the conversation, and they are the one who can restart the host.

**Require an explicit opt-in row per deployment.** Rejected: the defect is silent by construction, so a deployment that has not been bitten has no reason to opt in and the guard would be absent exactly when it is first needed. The package is a host-plane row a composition adds deliberately, which is the same placement the shipped guards already have.

## Consequences

A withdrawal that used to be discovered late is now stated where it happens: one line in the host log and one message in the affected conversation, naming the missing tools and the recovery. The session still cannot be repaired in process, and the guard does not pretend otherwise — the package README's first sentence after the summary is that it detects rather than repairs.

The cost is a standing host-plane row and a small amount of per-agent state: one baseline per live agent, refreshed on re-composition and dropped on disposal, plus one map lookup per agent per loader update. The cap (`maxAgentsPerUpdate`, default 64) bounds that work in a deployment with very many concurrent sessions. Installing it also costs one step beyond mounting a row: the profile's `node_modules` must resolve the package, per the installation rule above.

Two limits are recorded rather than solved. Only tool names are compared, so a reload that withdraws a prompt section, a skill, or a projection from a frozen agent is still silent; and a composition that was already incomplete when the guard activated is not announced, because the guard will not guess at history it did not observe. Both are stated in the package README's limitations, and the second names the durable reconstruction it deferred.

The guard's own coverage is now an enforced contract rather than a hope: the invariant companion fails an assembly by an agent the composed guard has no baseline for, so a broken creation listener or a missed adoption is a loud gate failure instead of a guard that quietly watches nothing.

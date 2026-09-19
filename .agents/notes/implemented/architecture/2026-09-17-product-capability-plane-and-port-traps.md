# Agent Note: Shipping a product capability on the right plane, and the traps a port hits

Status: implemented

English | [中文](2026-09-17-product-capability-plane-and-port-traps.zh.md)

## Problem

A product that replaces filesystem, spill, roster, and browser-shell behavior was first prototyped as temporary dynamic Cordis plugins mounted inside a running session. That approach cannot ship. The user rejected it outright and the port was redone as workspace packages composed by profile rows.

The rewrite also cost the port several hours to the same class of trap: a capability written on a plane it cannot act from, a live patch reload that strands an already-materialized session, a per-agent boundary computed once for a preset the session later left, and build or resolution settings that fail silently rather than loudly. Each trap below is recorded with the evidence that identifies it and the recovery that clears it.

## Decision

A **product capability ships as a persistent package plus composition rows, never as a temporary dynamic plugin.** A dynamic plugin (`cordis_define` and `cordis_run` in this harness) exists only in the running process: it cannot be reviewed, versioned, released, or rolled back with the product, and it disappears on restart. It is acceptable for a one-off experiment inside one session and never for anything a deployment depends on.

This port ships the product as [packages/bundle/muse-product](../../../../packages/bundle/muse-product) (host rows, preset, tool surface) and [packages/client/muse-browser](../../../../packages/client/muse-browser) (browser half), composed by the profile's `bundles` list and the bundle's own `cordis.patch.yml`, with its decisions recorded as Agent Notes and its contracts as package specs. A repair that needs to reach another live session belongs to the harness core as a patch, not to a plugin.

### A service belongs on the host plane; a preset contributes per-session capabilities

A row that publishes a service belongs in the host composition, or inside an `isolate` realm when one preset genuinely owns that service. An agent preset contributes only per-session capabilities: tools, prompt sections, skills, and projections that resolve through the agent's scope chain.

Presets do not inherit each other's rows. Each preset mounts once as its own standing composition ([`AgentPresets.mount`](../../../../packages/preset/agent-presets/src/index.ts)), and an agent joins exactly one of them by parenting its scope key to that mount's key. A child agent joins its parent's existing generation ([`composeFrom`](../../../../packages/preset/agent-presets/src/index.ts), documented in [child agents join their parent's preset](../bug-fix/2026-08-10-child-agents-join-their-parent-preset.md)); it never composes a second preset's rows.

A product that must *replace* host services can therefore only do that from a bundle's patch layer. A preset row cannot publish a root-realm service at all: [`mountPreset`](../../../../packages/preset/agent-presets/src/mount.ts) audits the mounted subtree and rejects it with `row(s) published process-global service(s) [names]; a preset service must sit behind an isolate realm or move to the host composition`. When a takeover port needs its own `fs`, `spill`, preset registry, or the whole browser shell, the replacement rows live in the bundle's `cordis.patch.yml`; the product's per-session capabilities live in its preset. The ownership criterion is [what stays host-plane once presets own the agent plane](2026-08-10-host-plane-ownership-after-presets.md).

### A live host-plane patch reload can strand a running session

`dsh.profile.patchReload: live` applies a host-plane patch to a host that is already running; `startup` applies it once at boot ([apps/cli/reference/README.md](../../../../apps/cli/reference/README.md), [packages/boot/app-boot/src/profile.ts](../../../../packages/boot/app-boot/src/profile.ts)). The shipped `web` profile is `live` by default, and omission keeps `live` for a custom profile.

Changing host-plane rows under a running session can leave that session with a half-withdrawn tool composition: the preset-provided tools disappear while host-plane tools remain, because the agent's composition was already materialized and its scope parent no longer reaches a live composition. A later host restart does not heal that session: its tool view resolves through the scope chain the already-published agent holds, and a restart recomposes nothing that a live session is already running. `AgentPresets.select` states the same rule for the same reason: a session that has started keeps the composition its history was produced under.

Two rules follow. Prefer a cold restart for any composition change. Never edit a live profile patch while the session you are working in depends on it.

### Recovery without a plugin

A session whose agent joined its preset while that join was resolvable can be rejoined by re-linking the agent's scope parent, which is what the preset registry's `recompose` performs: it re-links through the binding the roster kept, ensures the standing mount, and publishes `tools/change` so Agent-owned overlays reconcile against the new ancestry.

Two supported paths reach that. Selecting a different preset for the session in the GUI calls `AgentPresets.select`, which recomposes the agent and records the choice; selecting the session's own preset again is a no-op in the client because [the seat store](../../../../packages/client/ui-agent-preset/src/client/seat-store.ts) returns early when the staged id already equals the session's id. The broader path is a new session, which composes its preset fresh at creation.

Both paths require a session that has produced nothing: `select` reads the session's turn boundary first and refuses a started conversation with `agent-preset/locked` (`session "<id>" has already started; its agent preset is fixed`). A conversation that is already under way therefore has no in-place recovery; its capabilities return in a new session. The durable fix for the underlying defect, a live reload withdrawing host-plane rows without re-registering them for already-materialized agents, belongs in the harness core as a patch to the reload path.

### A boundary computed at agent creation does not survive a preset switch

A per-agent boundary derived once from the preset the agent was created on is stale the moment that agent runs a different one. A session can be created on the deployment's default preset and switched to the intended preset afterwards: `AgentPresets.select` re-parents the agent's scope key, ensures the target standing mount, and emits `tools/change` ([packages/preset/agent-presets/src/index.ts](../../../../packages/preset/agent-presets/src/index.ts)). It does **not** re-emit `agent/created`, so a listener registered on creation alone never re-evaluates.

The measured consequence: a session switched into a product preset still listed `write` and `edit` in its schema view, and a `write` call through it succeeded. The boundary had been computed for the preset the session was created on.

Derive a per-agent permission from the *current* composed preset, re-evaluate it when the composition changes, and retire the previous restriction as the new one is installed. The supported shape is a reconciliation function driven by `tools/change`, holding one restriction per agent:

```ts
// One restriction per agent, recomputed from what the agent composes NOW.
const masks = new Map<Agent, () => void>()
const reconcile = (): void => {
  for (const agent of ctx.agents.list()) {
    const composed = ctx.agentPresets.composedPreset(agent.ctx)
    const candidates = ctx.tools.schemas(agent.ctx).map(tool => tool.name)
    masks.get(agent)?.()          // retire the previous mask before installing the next
    masks.set(agent, ctx.tools.restrict({ deny: denyFor(composed, candidates) }))
  }
}
ctx.on('tools/change', reconcile)
```

`tools.restrict()` intersects masks and returns the exact disposer that lifts its own, so a stale mask left installed keeps denying what the new composition allows ([packages/core/tools/src/index.ts](../../../../packages/core/tools/src/index.ts)). [browser-use-runtime](../../../../packages/experimental/browser-use-runtime/src/mcp.ts) is the in-tree precedent for recomputing on the notification: it holds a per-agent mask scope, recomputes the denied names from the agent's current view in `refreshBlockedMasks`, and re-runs that from `ctx.on('tools/change', …)`.

### A table lookup with an early return is a silent boundary hole

The port wrote its guard as "look the session's preset up in a table of presets this product owns; if the table has no entry, do nothing". Every preset the table does not mention is then unguarded, and the deployment default is always one of them, so the product's restrictions did not apply on exactly the sessions it had not yet enumerated. A deny rule for "everything that is not ours" must name that case explicitly, and it must fail closed. The same shape hides wherever a guard resolves something by table lookup and treats absence as "nothing to do": absence means unguarded, not permitted-elsewhere.

### Bundle versus row

A package listed in `dsh.profile.bundles` contributes its patch layer. Inserting the same package as a row mounts the plugin *without* that layer ([packages/util/package-manifest/src/types.ts](../../../../packages/util/package-manifest/src/types.ts), and the layer application in [profile.ts](../../../../packages/boot/app-boot/src/profile.ts)). A bundle declares the layer under `dsh.bundle.patch`, and that layer may disable, reconfigure, and insert rows, so one package serves a takeover deployment and a merged deployment at once. That distinction is why [muse-product/cordis.patch.yml](../../../../packages/bundle/muse-product/cordis.patch.yml) disables `agent-presets`, `fs-sandbox`, and `spill-local`, inserts `muse-agent-presets` as a host row, and inserts `@deepseek-ai/dsh-client-muse-browser` as a client row, while a merged deployment mounts the rows it wants one at a time.

### A `./typert` export must be registered in the aggregate tsconfig

The Typert generator discovers candidate packages by walking project references from `tsconfig.host.json` and `tsconfig.client.json`: [`WorkspaceAnalyzer.loadRegistrations`](../../../../packages/typert/generator/src/analyzer.ts) reads `aggregate.parsed.projectReferences`, keeps only entries under `packages/`, and ignores every package absent from those lists. A package exporting `./typert` but not registered as a referenced project therefore generates nothing while the build reports success, and the `lib/typert.host.js` its manifest advertises never exists. Add the package project to the aggregate solution in the same change (`{ "path": "./packages/bundle/muse-product" }` in [tsconfig.host.json](../../../../tsconfig.host.json)).

The codec field is `create` in current DSH. A generated artifact built by an older fork that emitted `schema` fails at load with `parameter codec has no create() factory` ([packages/typert/loader/src/index.ts](../../../../packages/typert/loader/src/index.ts), [packages/typert/registry/src/service.ts](../../../../packages/typert/registry/src/service.ts)); the generator path reports the same cause as `has no create() factory`.

### Profile resolution can load a different checkout

`$DSH_HOME/profiles/<name>/node_modules` wins resolution over the checkout, and its entries are junctions; a stale one can point into a different checkout entirely. A profile-owned copy then loads silently in place of the package just edited, and every subsequent observation describes the wrong tree. Log the resolved path of the module actually loaded before debugging anything else:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai" |
  ForEach-Object { "$($_.Name) -> $((Get-Item $_.FullName -Force).Target)" }
```

This is also the mechanism a port uses on purpose: a profile junction can point at the checkout under work, which is how a locally built product package reaches a running profile without publishing it.

### A row the request-time inventory cannot resolve fails the turn, not the mount

`dsh_plugin_packages` — the tool contributed by [`@deepseek-ai/dsh-plugin-package-inventory-deepseek`](../../../../packages/llm/plugin-package-inventory-deepseek), enabled by default in the base composition bundle ([packages/bundle/base/cordis.patch.yml](../../../../packages/bundle/base/cordis.patch.yml)) and therefore running on every DeepSeek request — resolves the owning package of **every** activated Loader entry through `PackageIdentityResolver.resolve()` → `barePackageManifest(packageName, anchors, this.packages)`, which walks `createRequire(parentURL).resolve.paths()` from the **profile directory's `node_modules`** (`$DSH_HOME/profiles/node_modules`). The Loader that activated the row resolved it along the other path, the `tsconfig.base.json` paths mapping, because the app was launched from source (`tsx`); the two disagree without a word, so a row inserted into a profile patch mounts normally while the inventory cannot see it.

The symptom is not a mount error but a failed model request: `plugin-package-inventory-deepseek: cannot resolve active package "<name>"`. The measured case inserted `@deepseek-ai/dsh-composition-guard` into `C:\Users\EDY\.dsh\profiles\web\cordis.patch.yml`; an A/B check with the resolver's own function reported exactly that one package MISSING, and every package FOUND after the junction `C:\Users\EDY\.dsh\profiles\node_modules\@deepseek-ai\dsh-composition-guard` → `E:\deepseek-harness\packages\guard\composition-guard` existed (the profile composition is 164 lines; only that row failed). Any package a profile patch inserts must be resolvable from that profile's `node_modules`; [the composition-guard Agent Note](2026-09-17-composition-guard-detects-live-tool-withdrawal.md) owns the installation rule, the exact command, and the diagnostic that recovered the client half — Cordis's client module loader swallows a plugin's real error, so the browser reports only `Failed to load plugins: <id>`, and only a `window.__ModuleLoader__.load` wrapped over CDP returned the true error.

### Build order and per-package builds

The host build is `tsc -b tsconfig.host.json` and then `tsdown --env.DSH_BUILD_FACE host` ([package.json](../../../../package.json)), and tsdown's entries are `lib/types/{index,invariant,startup}.js` ([tsdown.config.ts](../../../../tsdown.config.ts)). tsc must run first: running `tsdown` alone after editing sources bundles the previous compile's output and silently changes nothing.

A client package's bundle config is named `<package>/client` ([packages/client/tsdown.client.ts](../../../../packages/client/tsdown.client.ts)), so a filter that builds one package by name builds only its node half. The node half is also restated per package because a package-level `tsdown.config.ts` replaces the root workspace layout. Use the repository's full build for a client package, or add the client face explicitly.

Never debug a plugin through a stale build. The first probe of the port's permission boundary read `lib/index.js` from 15:14 while `src/index.ts` had been edited at 15:32; the stale artifact produced a confident but wrong mechanism, and correcting it cost more than the rebuild would have. Record the artifact's modification time and size beside any probe evidence, and rebuild before drawing a conclusion:

```powershell
Get-Item packages/bundle/muse-product/src/index.ts, packages/bundle/muse-product/lib/index.js |
  Select-Object FullName, LastWriteTime, Length
pnpm run build:lib:host    # tsc -b tsconfig.host.json, then tsdown --env.DSH_BUILD_FACE host
pnpm run build:lib:client  # tsc -b tsconfig.client.json, then the client face
```

### The traps at a glance

| Trap | Evidence | Avoidance |
|---|---|---|
| Capability written on the wrong plane | `mountPreset` rejects a root-realm service; presets never inherit rows | Host composition or `isolate` realm for services; bundle patch layer to replace host rows |
| Live reload strands a running session | `patchReload: live`; materialized agent composition | Cold restart for composition changes; never edit a live patch a session depends on |
| Boundary computed only at agent creation | `select` re-parents the scope and emits `tools/change`, never `agent/created`; a `write` call succeeded after the switch | Derive from the current composed preset and reconcile on `tools/change`, retiring the previous restriction |
| A guard whose table lookup returns early | The deployment default is absent from a product's preset table | State the deny rule for everything not owned explicitly, and fail closed |
| A conclusion drawn from a stale artifact | Probe read `lib/index.js` at 15:14 against `src/index.ts` edited at 15:32 | Record artifact mtime and size with probe evidence; rebuild first |
| Bundle patch layer missing when mounted as a row | `dsh.profile.bundles` maps to `dsh.bundle.patch` | List the package as a bundle when its layer is required |
| `./typert` artifact never generated | `loadRegistrations` walks aggregate references | Register the package project in the aggregate tsconfig |
| Codec built by an older fork fails at load | `codec has no create() factory` | Rebuild the artifact against the current generator |
| Stale profile junction loads another checkout | `$DSH_HOME/profiles/<name>/node_modules` wins resolution | Check the resolved path before debugging |
| A profile row the request-time inventory cannot resolve | The Loader mounts it through `tsconfig.base.json` paths while `dsh_plugin_packages` walks `$DSH_HOME/profiles/node_modules`; `cannot resolve active package "<name>"` | Make every inserted package resolvable from the profile's `node_modules` (a junction into the checkout) |

## Alternatives considered

**Ship the repair as a temporary dynamic Cordis plugin.** Rejected by the user, and the reasons are structural rather than stylistic: a dynamic plugin lives only in the running process, so it cannot be reviewed, versioned, released, or rolled back with the product, and it disappears on restart. It also mounts into the composition rather than the session that mounted it, which makes a session-owned repair the wrong shape of fix even while it works.

**Keep the product's per-session capabilities in the host composition so a replacement deployment needs no patch layer.** Rejected because it inverts the ownership rule the presets established: model-facing capabilities belong to the agent plane, where a preset decides what its sessions can do, and a host-plane copy of the same tools would be visible to every session in the process.

**Document the live-reload hazard instead of changing the reload path.** Accepted only as the interim state. The recovery above is what a user can do today, and the durable fix is a core change to re-register withdrawn host-plane rows for already-materialized agents; documenting it is a note, not a fix.

**Make `tools.get` reject an Agent at the type level.** Attractive and out of scope. `ScopeKey` is deliberately opaque, and closing the hole changes a public signature every caller of `schemas`, `get`, and `presentAs` shares. An Agent passed where a scope key belongs is a real hazard, but it was not the cause of this port's permission gap: the measured boundary was computed for the wrong preset, and the restriction itself denied ten of eleven named tools. The type question stays open and separate.

**Explain the permission gap as an empty deny-list.** Recorded because it was believed first and disproved second: the argument that a scope resolution returned nothing and silently emptied the filter does not survive measurement, and an Agent Note that enshrines a plausible mechanism over the measured one teaches the next person to trust the wrong signal. The recorded cause is the one the probe supports, and the probe's build is recorded beside it for the same reason.

## Consequences

The plane rule costs a port one extra package split. A product that replaces host behavior needs a bundle with a patch layer and a client package for its browser half, and only its per-session capabilities can live in its preset; the reward is that the same package serves both a takeover deployment and a merged one, and every row stays reviewable in the repository.

Dynamic plugins remain the right tool for a single-session experiment and for an out-of-band look at a live process. They are not a delivery channel, and the user's rejection of one makes that boundary explicit rather than conventional.

The traps above now cost minutes instead of hours, and the four that fail silently (a boundary computed for a preset the session later left, a guard whose table lookup returns early, a `./typert` package absent from the aggregate solution, and a profile row the request-time inventory cannot resolve) are each named with the evidence or the exact string that identifies them, so the next person recognizes them immediately. The permission gap's wrongly believed cause is recorded beside its measured one, because a confident wrong mechanism costs more than no mechanism. The live-reload defect stays open in the core with no committed owner; until it is fixed, a session that loses its composition is recovered by re-selecting its preset while it is still blank, or by starting a new session.

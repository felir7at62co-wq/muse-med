# Agent Note: The deleted preset path in the Desktop loader spec, and the preset ids the shipped rows shadow

Status: implemented

English | [中文](2026-09-28-merge-rc2-loader-preset-path-and-shadowed-preset-ids.zh.md)

## Problem

Two residues of the `0.1.7-rc.2` merge were still open after §17, and neither is visible to a build gate.

`apps/desktop/tests/short-drama-loader.spec.ts` read `packages/preset/agent-presets/presets/short-drama/agent.cordis.yml`.
Upstream deleted that package together with the preset engine it belonged to, so the spec died at runtime with `ENOENT`
while `pnpm run build:lib` and `tsc -b tsconfig.host.json` stayed green: nothing in the file is a type error.

`apps/desktop-host/presets/ptc/agent.cordis.yml` and the `standard` one beside it are one-row delegations written for the
pre-merge adapter — `name: '@deepseek-ai/dsh-desktop-host/native-preset'` with `config: { preset: ptc }` — while the
merged adapter's `Config` is `{ id, directory }`. The Desktop Host declares a row for each packaged preset directory only
when the composed layers do not already use that id (`apps/desktop-host/src/index.ts:191-205`), and the base bundle
declares `preset-ptc` and `preset-standard` itself, so both directories were reported as shadowed and never mounted. What
the shadowed rows would have done mattered more than that they were dead: they are where `main`'s adapter applied its own
patch to the composition it included.

## Decision

**The loader spec reads the product's preset and keeps its subject.** `presetPath` is now
`apps/desktop-host/presets/short-drama-local/agent.cordis.yml`, the composition the desktop roster registers. Retiring
the file was rejected because nothing else mounts the Host's Jubian row and a skill row through a real Loader against the
bundled source root, which is the behaviour it was written for.

Three of its four row assertions keep their subject unchanged: the overlay's Jubian insert is
`@deepseek-ai/dsh-tool-jubian`, the preset's skill row is `@deepseek-ai/dsh-tool-skill`, and the preset declares no
`tool-jubian`. The fourth changes owner. The deleted shipped composition declared its own `skill-filesystem`; the merged
presets declare none, because the product re-enables the Host's own row (`desktop.cordis.patch.yml:19-22`,
`disabled: false`, `includeDefaultRoots: false`) and injects its runtime directories there
(`apps/desktop-host/src/index.ts:216-223`). The spec therefore sources that provider from the overlay, asserts
`includeDefaultRoots: false` on it, and asserts that the preset declares no `skill-filesystem` — the product rule that the
Host owns the only provider. The mounted composition, its module map, and every assertion on the mounted services are
unchanged.

**The shadowed product rows are measured and left in place.** A probe composed the real Desktop profile — the bundle
layers, the user patches and `desktop.cordis.patch.yml`, the same layers `src/index.ts:176-180` composes — and applied
the Host's own product-row rule to the packaged directories. It confirms the shipped rows `preset-standard`, `preset-ptc`,
`preset-minimal` and `preset-cordis` (`@deepseek-ai/dsh-agent-preset`) win, that `ptc` and `standard` are shadowed, and
that only `short-drama-local` is declared by a product row.

Deleting the dead directories was rejected, because the measurement says the rows that do take effect are **not
equivalent** to the ones they shadow. `main`'s adapter patched `standard` and `ptc` with
`{ id: 'skill-filesystem', disabled: true }` — "the Host owns the only provider that selects default roots, so no adapted
composition may leave its own provider selecting them" — and both shipped compositions did declare that provider. The
winning shipped rows here carry it enabled, and `includeDefaultRoots` defaults to `true`
(`packages/skill/skill-filesystem/src/index.ts:86`), so a `ptc`/`standard` agent mounts a second filesystem provider with
default-root discovery beside the Host's where `main` mounted one. That is a behaviour question for the Lead, not a
cleanup, and it is reported rather than resolved.

## Verification

Every command ran from the repository root with `TEMP`/`TMP` on `E:`.

| Command | Before | After |
|---|---|---|
| `pnpm exec vitest run apps/desktop/tests/short-drama-loader.spec.ts` | exit **1**, `ENOENT … packages\preset\agent-presets\presets\short-drama\agent.cordis.yml` at `:30` | **exit 0, 1 passed** |
| `pnpm exec tsc -b tsconfig.host.json` | exit 0 | exit 0 |

The probe printed the composed rows (`preset-standard`→`standard`, `preset-ptc`→`ptc`, `preset-minimal`→`minimal`,
`preset-cordis`→`cordis`, all `@deepseek-ai/dsh-agent-preset`), the packaged directories
(`ptc`, `short-drama-local`, `standard`), the shadowed set (`ptc`, `standard`), the winning `ptc`/`standard` presets'
`skill-filesystem` row with `disabled` undefined, and the overlay's own provider patch
(`{ id: 'skill-filesystem', disabled: false, config: { includeDefaultRoots: false } }`). It was a throwaway file and is
not part of the commit.

The re-expressed assertions were falsified by the file's own failure history: the spec read a path that does not exist
and failed at that line, so its reading is not vacuous, and the provider assertion fails if the overlay stops disabling
default roots. The composition assertions below it are the ones that were already running.

## Alternatives considered

**Retire the loader spec.** Rejected: the mount it performs — the Host's Jubian row beside a preset's skill row, against
the bundled skill root, with the teardown that proves both leave with their rows — has no other coverage, and the ruling
allows retirement only for behaviour covered elsewhere.

**Point `presetPath` at the deleted path's nearest survivor, `packages/bundle/web-app/presets/*.patch.yml`.** Rejected:
that is the shipped roster, not the product's. The behaviour under test belongs to the product's own composition, whose
directory the roster registers.

**Take the skill provider row from the shipped `cordis` preset's plugin list.** Rejected: it carries
`customSkillDirs` pointing at a package directory and leaves default roots on, so the spec would be composing a provider
no product agent uses and asserting the wrong owner.

**Delete `presets/ptc` and `presets/standard` as dead data.** Rejected for this round: the shipped rows that shadow them
drop the adapter patch `main` applied, so the deletion would settle a behaviour question that is not the merge agent's to
settle. The measurement is recorded and the rows are untouched.

**Make the product rows effective by removing the shadowing.** Rejected: the rows are written for the pre-merge adapter
(`config: { preset: … }`), so declaring them fails at mount rather than at startup; a takeover needs the product
compositions rewritten, which is the roster work the merge into `main` owns.

## Consequences

The product directories `ptc` and `standard` remain dead data on this branch, and the shadow check in
`src/index.ts:191-209` is the only thing keeping that invisibility quiet: it reports them on startup and skips them,
which is also why nothing has failed on them.

The merge into `main` takes `main`'s roster as authoritative — five ids (`cordis`, `minimal`, `ptc`, `short-drama`,
`standard`), default `short-drama`, `main`'s adapter — and `short-drama-local` is a branch-only name that the merge drops.
Each id's adapter semantics must be re-checked on the merged tree; for `ptc` and `standard` they are already not carried,
and `cordis`, whose product directory returns with `main`, differs the same way (`includeDefaultRoots` left at its
default, `customSkillDirs` pointing at the `@deepseek-ai/dsh-agent-preset` package's own `skills` directory).

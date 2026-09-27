# Agent Note: The merge's silent capability losses and the ports that closed them

Status: implemented

English | [中文](2026-09-28-merge-rc2-settings-row-and-preset-ports.zh.md)

## Problem

Merging upstream `0.1.7-rc.2` into the product line left 34 TypeScript errors, and the largest group of them was not a typing inconvenience: the short-drama settings row had stopped existing in the composed settings service of every deployment. `DramaSettingsSchema` marked no field `.volatile()`, so `volatileForm()` returned `undefined` for that entry and `describe()` skipped the row entirely (`packages/settings/settings/src/index.ts:308-309`). Three capabilities disappeared without an error anywhere: the Settings page bound to `ctx.configForms.get('drama-settings')` reported its namespace as unavailable and could never write (`index.ts:385-386` refuses a write with `Plugin entry "drama-settings" has no volatile fields`), the per-drama automatic spending ceiling read as `undefined` (`packages/jubian/tool-jubian/src/budget-settings.ts`), and the pinned paid-image row degraded to the tool row's own composition config (`src/image.ts`). A money ceiling that vanishes because a schema annotation went missing is a product defect, not a merge artifact to be tidied later.

The same merge dropped two more things that no type error could show, and one that it could:

- `apps/desktop/tests/profile-mcp.spec.ts` lost the layer that applies the Desktop Host's own overlay, so the tree it composed had no `drama-settings` and no `tool-jubian` row at all — the assertion that the drama budget namespace survives the overlay was testing a composition no Desktop launch ever mounts.
- `apps/desktop-host/src/native-preset.ts` parsed the product's preset compositions with a plain `yaml.parse`, which resolves the `!!js` tag to its own source text. `disabled: !!js process.platform !== 'win32'` therefore reached the Loader as a non-empty string, and the Loader reads any non-expression `disabled` value with `Boolean()` (`vendor/loader/src/config/entry.ts:89-93`): both shell rows of every product preset mounted disabled on every platform, and `fontsDir`, `pythonExecutable`, `dataDir`, `weightsPath` would have mounted as their literal expression text.
- Two `apps/desktop/tests/smoke-runtime.spec.ts` cases were red at runtime because they still drove `DesktopHostProcess.fetch`, which upstream deleted.

## Decision

The settings row is repaired in place rather than retired. Every editable field of `DramaSettingsSchema` is `.volatile()` — the same migration `ui-theme`, `locale`, `tool-subagent`, and `web-search-deepseek` already carry — so the row publishes a namespace again and all three capabilities return. Retiring the fields (or the row) was rejected: `seriesBudgetLimit` and `pinnedStandardId` are the deployment's own money and preference statements, and dropping them is the "merge silently swallowed a capability" failure this branch exists to avoid.

### The schema's own type, and the delivery spec's identity

A volatile field's output is a live `Volatile` reference while its input stays the plain value, so no single object type is both (§16a). `DramaSettingsSchema` therefore drops its `z<DramaSettings>` annotation, and `DramaSettings` becomes what it always described: the value view the Settings transport, the page, and the readers below it hold. `deliverySpec` is volatile as a whole, which keeps the page's whole-object set/unset operations valid (`isVolatilePath` accepts a path under a volatile ancestor, and `validatePaths` recurses into a non-volatile child), and `plainConfig` unwraps it in one step when the service builds a descriptor. `DRAMA_SETTINGS_DEFAULTS.deliverySpec` is still the same object as `DEFAULT_DELIVERY_SPEC` — no default is wrapped, because the nested field carries no `.default()` of its own — and a spec asserts both facts.

### The ceiling fails loud when it cannot be read

`seriesBudgetLimit` distinguishes a composition with no settings provider (the supported Jubian-only shape, which keeps manual authorization) from a composed settings service that serves no readable `drama-settings` section (a misconfiguration). The second case now logs a warning through `ctx.logger.warn` naming the namespace, the explicit `id: drama-settings` mount the fix requires, and the ledger's authorization file, and still returns `undefined` — which the ledger refuses to turn into a spending allowance: with no automatic ceiling and no authorization entry, `checkBudget` refuses the paid call (`packages/jubian/jubian/src/budget.ts:209-214`). The ceiling is never invented and never silently dropped.

### Preset assertions move to the layer that owns the behavior

`@deepseek-ai/dsh-agent-presets` is gone, and the capability moved to `@deepseek-ai/dsh-agent-preset-registry` plus the product's own rows. The three spec files around it now assert against that layer: the roster a registry row plus one `native-preset` row per product composition directory produces, `readDocument()` for the composition content, and the adapter's own refusals. `authorable: false` is retired — the merged registry has no authoring surface at all, and its counterpart is the new assertion that the roster contains exactly the registered product rows and nothing discovered from a directory.

`native-preset.ts` now parses with the composition dialect's `!!js` tag, so an expression reaches the Loader as the expression node it is (`{ __jsExpr }`) instead of as text. That is the one product-source change in this round; without it the `!!js` assertions of the re-expressed preset spec cannot be kept, and both shell rows of every product preset stay disabled.

## Verification

Every command ran from the repository root with `TEMP`/`TMP` on `E:`.

| Command | Before | After |
|---|---|---|
| `pnpm run build:lib` | exit 1, 34 `error TS` in the host face | **exit 0, 0 `error TS`** — host `tsc`, both `tsdown` faces, the Desktop bundle, and the client face all completed |
| `pnpm exec vitest run packages/drama/drama-settings/tests/settings.spec.ts` | file failed to collect | 10 passed |
| `pnpm exec vitest run packages/jubian/tool-jubian/tests/budget-settings.spec.ts` | file failed to collect | 5 passed |
| `pnpm exec vitest run packages/jubian/tool-jubian/tests/budget-loader.spec.ts` | file failed to collect | 1 passed |
| `pnpm exec vitest run apps/desktop/tests/smoke-runtime.spec.ts` | 2 failed / 11 passed | 13 passed |
| `pnpm exec vitest run apps/desktop/tests/profile-mcp.spec.ts` | 1 failed | 1 passed |
| `pnpm exec vitest run apps/desktop/tests/{product-preset,native-preset,product-skill-isolation}.spec.ts` | files failed to collect | 4 passed |
| `pnpm exec vitest run apps/desktop/tests/{development-project,preload}.spec.ts` | type errors | 4 passed |
| `pnpm exec vitest run packages/drama packages/jubian packages/settings` | — | 73 files passed, 4 skipped; 1096 tests passed, 0 failed |

Two more tool-jubian specs were red for the same reason as the two ported above and are ported the same way:
`image.spec.ts` (3 of 6 cases) and `budget-tools.spec.ts` (1 case) answered the removed `settings.get(ns)` from a
file-local fake, so `dramaSection()` threw `settings.describe is not a function`. Both now answer one descriptor keyed
by `DRAMA_SETTINGS_NAMESPACE`, and both pass (7 cases together). The package-wide run above is what found them.

The settings fix is falsified rather than asserted: removing the six `.volatile()` calls turns 7 of the 10 drama-settings cases red and the real-composition ceiling case red, because `describe()` then serves no such row. The preset fix is falsified the same way: without the `!!js` tag the adapter registers literal expression text and the re-expressed content assertion fails on `fontsDir`, which is how the defect was found.

## Alternatives considered

**Retire the drama settings fields (option B).** The ceiling and the pinned image row are the deployment's own statements about money and routing; retiring them removes the capability the merge already tried to swallow once.

**Make `seriesBudgetLimit` throw when the row is missing.** A composition with a settings service for other plugins and no drama row is a supported shape that keeps manual authorization, and a hard failure there would refuse every paid call of a Jubian-only deployment. The warning plus the ledger's existing refusal keeps the money safe without breaking that shape.

**Keep `settings.get`-style reads in the ported specs.** The service has no getter by construction: the namespace is the composition entry id, and a plugin's section is its own resolved Config. The ported specs therefore drive `describe()`/`update()`/`replace()`/`mutate()` over a real profile, which is also the only bench that can see a row the service refuses to publish.

**Leave the `!!js` assertions out of the re-expressed preset spec.** That would record a passed suite over a preset whose shell rows are disabled everywhere — the silent-coverage-loss shape this round is fixing.

## Consequences

The `drama-settings` row must be composed with an explicit `id: drama-settings`; a bare package row is mounted under a generated id (`vendor/loader/src/config/tree.ts:51-58`), which addresses a namespace nobody serves. Both shipped compositions already do this (`apps/desktop-host/config/desktop.cordis.patch.yml`, `packages/drama/drama-settings/cordis.patch.yml`), and the tool-jubian test composition was corrected to match.

The product's `presets/ptc` and `presets/standard` compositions are still one-row delegations to the deleted engine (`config: { preset: … }`), which the base bundle's shipped `preset-ptc`/`preset-standard` rows shadow in every Desktop composition; they are dead data on this branch and the roster re-validation recorded in §14h still owns their fate.

`apps/desktop/tests/short-drama-loader.spec.ts` still reads `packages/preset/agent-presets/presets/short-drama/agent.cordis.yml`, a path upstream deleted. It fails at runtime and carries no type error, so no build gate sees it; it needs the same treatment the three ported preset specs received.

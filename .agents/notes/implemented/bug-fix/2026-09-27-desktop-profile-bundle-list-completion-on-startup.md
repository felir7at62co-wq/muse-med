# Agent Note: Complete the desktop profile bundle list on every startup

Status: implemented

English | [中文](2026-09-27-desktop-profile-bundle-list-completion-on-startup.zh.md)

## Problem

An installation of `0.1.6-alpha.2` that reported `desktop project: profile must begin with the built-in desktop bundle list` and then chose the startup page's **Restart** action came back usable but without the settings section the appended bundle owns. Restart only relaunches the application, so the profile still held the six built-in bundles of the release before it.

The failed startup had already recorded this release's runtime state. `prepareProfile` links or records the profile and then evaluates `profilePluginNames`, which is what refuses the six-entry list, so `desktop-runtime-state.json` matched the installed release before the failure was reported. The next startup's early return in `applyRelease` compares exactly that state and returns without reconciliation, and no other startup path reads `dsh.profile.bundles`. The Host therefore composed the six stored bundles, `@deepseek-ai/dsh-feishu-settings` was never a Loader entry, and the client bundle roster — built from `ctx.loader.entries()` — carried no registration for the `feishu` settings section. The remaining recovery actions were not affected: **Disable third-party plugins and retry** writes the full built-in list, and **Reset Desktop** recreates the profile; only Restart left the list alone.

## Decision

[`project-manager.ts`](../../../../apps/desktop/src/project-manager.ts) reads the stored list through `profilePluginNames` in `applyRelease` before the early return, whenever the profile manifest exists. Completion, validation, the manifest copy, and the rewrite stay in that reader; startup only reaches it under the same transaction lock that guards every other profile write, and no package command runs.

## Alternatives considered

**Record the runtime state only after validation passes.** The state file is also the ownership record of the links `linkDesktopHostPackages` creates, so withholding it until a later step would leave links no later unlink may replace. Keeping the state honest inside the linker costs the shared link lifecycle more than the startup read costs the caller.

**Reconcile instead of returning early.** Re-linking every shared package and rescanning installed manifests on each start is what the early return exists to avoid, and it is unrelated to a stored list that is decidable from the manifest alone.

**Let the Host complete the list while composing it.** The Host composes from `dsh.profile.bundles` but writes no profile files; the shell owns that profile ([bundled-runtime decision](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md)).

**Refuse startup when the recorded state is current and the list is short.** That converts a silent omission into a start failure without returning the missing first-party row, while the list is decidable and completable.

## Consequences

Every startup now reads the profile manifest and completes the list when it only lacks built-in bundles this release added; a complete list is not written and gets no copy, so unchanged profiles keep their bytes and modification time. A list that is not a prefix now fails loudly at startup on paths that previously composed short. A preparation that fails after the state is recorded still leaves that state current, so the next start skips re-linking; the list is completed either way, and plugin-graph defects keep surfacing where installed plugins are inspected.

The completion repairs profiles that a release containing it starts on. Installations still running the shipped `0.1.6-alpha.2` shell, which has no such read, need the next installer or one of **Disable third-party plugins and retry** and **Reset Desktop**; a restart alone cannot complete their list.

## Testing

`apps/desktop/tests/project-manager.spec.ts` adds one case: a prepared profile carrying an installed plugin has its stored list rewritten to the six older built-in bundles followed by that plugin while the recorded runtime state stays current, and a second `applyRelease()` then resolves `false`, stores the seven built-in bundles followed by the plugin, keeps the dependency and the plugin inventory, runs no pnpm command, and leaves exactly one copy holding the bytes that were stored before. The case failed before this change with the appended bundle missing from the stored list.

The [migration decision](2026-09-27-desktop-profile-bundle-list-migration.md) continues to own which stored lists are completable, what the copy is for, and the refusal rule; this note covers only which startup paths reach that reader.

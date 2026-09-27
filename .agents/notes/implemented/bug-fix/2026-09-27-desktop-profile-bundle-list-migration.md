# Agent Note: Complete the desktop profile bundle list on upgrade

Status: implemented

English | [中文](2026-09-27-desktop-profile-bundle-list-migration.zh.md)

## Problem

Release `0.1.6-alpha.2` appends `@deepseek-ai/dsh-feishu-settings` as a seventh entry of `DESKTOP_PROFILE_BUNDLES`, the built-in bundle list of the reserved desktop profile. A profile is created with that list and then stores its own third-party bundles after it, so a profile written by the release before it holds the six built-in bundles of that release. Validation required the stored list to begin with the full built-in list, which a six-entry prefix fails at index 6, and the failure was fatal: the shell reported `desktop project: profile must begin with the built-in desktop bundle list` in its startup dialog and the profile could not be opened.

The failing installation was not an unusual one. The profile this was diagnosed on stored exactly the six older built-in bundles and no third-party bundle at all, so every user upgrading an existing installation was affected rather than only users who had installed plugins. The check lives in `profilePluginNames`, which startup reconciliation, the plugin inventory, and dependency mutations all read, so the profile stayed unusable on every path.

## Decision

[`project-manager.ts`](../../../../apps/desktop/src/project-manager.ts) reads a stored list through `pendingBuiltInBundles`, which finds the first index where the stored list departs from `DESKTOP_PROFILE_BUNDLES` and treats the remainder as that profile's third-party bundles only when the remainder names no built-in bundle. When it does, `profilePluginNames` inserts the missing built-in bundles at that index in built-in order, keeping the third-party bundles after them. The completed list then goes through the same duplicate check and package-name validation as an already-complete list, and the manifest is rewritten only after both pass, so a list that cannot be completed is reported without the file being modified.

The rewrite copies `package.json` to a sibling `package.json.<UTC timestamp>.bak` first and preserves every other manifest field. It happens once: the completed list satisfies the check on the next read.

Every other mismatch stays fatal with the original message. A missing middle bundle, a reordered list, and an unknown bundle placed ahead of the built-in list all leave a built-in name in the remainder, and that is the rule that makes the prefix decidable. Without it, a corrupted list would be repaired into a plausible one instead of being reported.

## Alternatives considered

**Keep failing and document a manual repair.** Editing `~/.muse/profiles/desktop/package.json` by hand is what the first affected installation needed, and it requires knowing which bundle the release added. The product's own supported recovery, Reset Desktop, deletes all profile configuration and third-party plugins, so guiding users there trades a startup failure for data loss.

**Complete any stored list that contains every built-in bundle in some order.** Reordering the missing bundles into place would accept a list that a hand edit or a different writer produced in an order nothing guarantees. The prefix rule is decidable from the stored list alone; "contains all of them" is not.

**Complete the list only in `applyRelease`.** `listPlugins` and `mutate` read the same stored list through `profilePluginNames`, so a profile first reached through the plugin inventory or a dependency mutation would still fail. Completing the list inside the reader covers every path with one rule.

**Rewrite the list without keeping a copy.** The rewrite is the product's first modification of a file a user may have edited deliberately. One sibling copy costs a few hundred bytes and keeps the previous list readable after the upgrade.

## Consequences

An upgrade from any release whose built-in list is a prefix of this one now completes the profile and starts. A profile whose stored list is not a prefix still fails loudly with the original message, is left byte-identical, and gets no copy.

Profiles written by this release are unaffected: their list already begins with the full built-in list, so the manifest is not touched and no copy is written. `createPluginProfile`, `createRuntimeProjectMetadata`, and `createDevelopmentProjectMetadata` keep writing the current built-in list, and `DESKTOP_PROFILE_BUNDLES` keeps its members and order.

Copies accumulate only across releases that add a built-in bundle, and a profile gains at most one per such release. They sit inside the profile directory, so Reset Desktop removes them with the rest of the profile, and a later release that adds a bundle writes a new copy rather than overwriting an older one.

## Testing

`apps/desktop/tests/project-manager.spec.ts` covers the three paths. A profile holding the six older built-in bundles plus a third-party plugin, upgraded to a runtime with a different release identity, starts successfully, stores the seven built-in bundles followed by that plugin, and leaves one copy holding the exact bytes that were stored before; the same case pins the installed dependency. A list missing a middle bundle and carrying a valid third-party tail is refused with the original message, leaves the manifest byte-identical, and writes no copy. A complete list survives an upgrade with its bytes and modification time unchanged and no copy written.

The [bundled-runtime decision](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continues to own profile manifest ownership, shared package identity, and plugin lifecycle; the [Feishu opt-in decision](../architecture/2026-09-24-desktop-feishu-bridge-opt-in.md) owns what the seventh bundle is for. Neither is superseded.

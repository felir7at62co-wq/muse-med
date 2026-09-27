# Agent Note: Dead product preset directories removed

Status: implemented

English | [中文](2026-09-28-dead-product-preset-directories.zh.md)

## Problem

`apps/desktop-host/presets/ptc/` and `apps/desktop-host/presets/standard/` each hold one row
(`config: { preset: ptc }` / `config: { preset: standard }`) written for the directory-discovery preset
engine. The 0.1.7-rc.2 merge composes the upstream registry instead, where a preset row carries
`{ id, directory }` and the adapter reads a composition file: a bare `preset` constant resolves no
directory, so those rows fail at mount rather than at startup.

They also cannot take effect even after that is fixed. The base bundle already declares the preset ids
`ptc` and `standard` through its own shipped rows, which compose first, so the product rows for the same
ids are never declared. The shipped rows are not equivalent to what they shadow: the removed adapter
disabled each adapted composition's own `skill-filesystem` row because the Host owns the only provider
that selects default roots, while the shipped compositions leave that row enabled with default-root
discovery on.

## Decision

Delete both directories and the four files they hold. A shadowed row that cannot mount and does not
carry the product's provider rule is dead data: it is invisible at runtime, and the next rewire that
declares it fails at mount.

Dependents move with them: `DESKTOP_HOST_RUNTIME_FILES` no longer requires `presets/{ptc,standard}/…`,
the package-set spec asserts the same list, the product-preset spec asserts the remaining product
directory, the runtime smoke expects the remaining product preset, and `apps/desktop/README.md` with
its Chinese counterpart states one product preset instead of three.

`apps/desktop-host/presets/short-drama-local/` is deliberately **not** removed here. It is the third
branch-only directory, and whether its row is equivalent to `main`'s `short-drama` is a measurement
taken after this branch merges into `main`.

## Alternatives considered

**Keep them for a later rewire.** They would still be shadowed, so nothing changes at runtime while the
broken `preset` constant stays available to be declared by mistake.

**Re-point them at the merged adapter.** Either directory would then register a preset the base bundle
already declares under the same id, which is a duplicate row; disabling the shipped row instead is a
roster rewiring decision, not cleanup, and belongs with the post-merge verification recorded in the
merge addendum.

**Leave the dependents alone.** The package-set requirement would name files that no longer exist, so a
packaged Desktop would fail its own file check.

## Consequences

Four files removed, five dependents adjusted, and the product roster on this branch exposes only the
`short-drama-local` directory. The provider rule the two removed directories were meant to carry —
`skill-filesystem` disabled inside each adapted composition, so no preset adds a second default-root
provider beside the Host's — is now an explicit acceptance item for the merge into `main`: it is
verified on the merged tree, and a preset that mounts its own default-root provider is a defect, not a
detail.

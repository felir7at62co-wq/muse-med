# Agent Note: Separate bundled inventory from installable plugins in the desktop shell

Status: implemented

English | [中文](2026-09-24-desktop-plugin-catalog-and-transactions.zh.md)

## Problem

The desktop profile ships community packages built from pinned source, and the profile's plugin list cannot describe them: they are not profile dependencies, so they carry no recorded version, activation flag, or removal action there. The marketplace package itself cannot be mounted either, because its Web UI registers HTTP routes on a service the portless desktop composition disables. Users still need to see what ships, whether the profile mounts it, and which community plugins are installable, on a machine that may have no network.

## Decision

Bundled packages are inventoried from the runtime root's own package manifests, with `mounted` read from the profile's `dsh.profile.bundles` list. They are not profile dependencies, and the package transaction only ever adds or removes profile dependencies, so the installed list can never show them: `dshmarket` ships without being mounted, and the other four community packages sit in the fixed built-in bundle prefix. [Plugin catalog](../../../../apps/desktop/src/plugin-catalog.ts) reads this inventory without a network request and never mixes it with the profile's plugin records, so a bundled package is not offered for install, update, or removal.

The marketplace's `dshmarket` 1.47.0 source (MIT, upstream commit a8401c46fb45d9d18a76b918fab6b56ab3c32ab1) is consumed only as a library: the product build adds `./catalog` to the generated manifest as `types: ./lib/types/registry.d.ts` and `default: ./lib/registry.js`, records it in the tarball's `SOURCE.json` as `compatibilityOverlay.catalogExport`, and imports it to require a `loadRegistry` function before packing. The pinned upstream manifest has no such export, and its plugin row is absent from the product's bundle list, so the catalog loader is the only part of the package the product runs.

The trusted plugin-manager window owns discovery: it renders bundled inventory and installed plugins from local reads, performs one online catalog load when the user asks for it, filters the loaded entries locally, and installs nothing by itself. A confirmed npm-backed entry is handed to the existing desktop package transaction as an ordinary npm spec, which stops the backend, installs with scripts disabled, rewrites the profile, and restarts it.

The remote catalog is untrusted input, and the shell validates every leaf field it displays or installs: the entry name, an HTTPS `github.com` repository URL, the per-locale description strings, and an npm spec resolved to a package name. Entries are rebuilt as the shell's own objects, so unknown upstream fields — an upstream `install` command among them — never reach the window. An entry without an npm spec stays listed with its repository link and no install action; the profile records exact registry versions, so a repository or tarball URL cannot become a profile dependency.

Every IPC channel that reads or changes packages asserts that the sender frame is the desktop-owned shell document, and the backend application document (`dsh-app://app`) is refused. Development mode is read-only for package changes: the window reports that they require a packaged application, the installed list is empty, and each mutating channel throws.

A failed catalog load is reported in the window and leaves the bundled inventory in place. The bundled loader has no snapshot fallback, so the failure surfaces as a message and a retry rather than a stale list, and nothing is downloaded until the user confirms one spec.

## Alternatives considered

**Mount the marketplace bundle in the desktop profile.** Its plugin injects the web server service and registers its UI routes there; the desktop composition disables that row, so a mounted copy would contribute a second, non-working surface while leaving the product without catalog metadata.

**Write a desktop catalog client.** It would duplicate the maintained catalog fetch, its region routing, and its entry fields, and drift from the marketplace on every upstream release. Consuming the pinned loader keeps one owner of catalog contents.

**Install entries from their repository link.** The transaction accepts an npm spec and the profile stores exact registry versions; synthesizing a dependency from an external URL would widen both for entries the marketplace itself distributes as source only.

**Validate the catalog response in the renderer.** The response is network data and the renderer's only privilege is the preload bridge; parsing in the main process keeps every unvalidated field out of the window.

## Consequences

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continues to own package transactions, shared package identity, and plugin lifecycle; the [independent-product decision](2026-09-23-muse-med-independent-desktop.md) owns the product home and composition; the [community-source proposal](../../proposed/process/2026-09-23-muse-med-community-plugin-source.md) owns retaining the pinned upstream source. None is fully superseded.

Unit tests cover the offline inventory and its `mounted` flag, the five bundled names, rejection of malformed catalog entries and unsafe repository URLs, offline-first rendering with one explicit discovery per request, local search, the confirm-then-install handoff, built-ins surviving a failed load, and the development read-only path. No real external plugin installation and no packaged rebuild of the catalog window were performed, and the shell has not loaded the live marketplace from a packaged application; those paths remain unverified.

# Agent Note: Isolate the muse-med desktop product and its production preset

Status: implemented

English | [中文](2026-09-23-muse-med-independent-desktop.zh.md)

## Problem

A branded desktop shell can still read the development installation's credentials and sessions. Combining independently discovered short-drama presets by deleting one also discards production instructions or breaks sessions that retain its ID. A distributable product needs its own configuration without modifying the running DSH installation.

## Decision

The packaged Electron entry sets the backend's `DSH_HOME` to `~/.muse-med`, or an explicit `MUSE_MED_HOME`, before profile access. An inherited `DSH_HOME` cannot silently import developer data. Unpackaged development retains the launcher-managed home. The product does not migrate existing sessions or credentials. Windows executable and installer artifact names use `muse-med`, with the same prefix enforced by macOS artifact promotion and upload validation. Package IDs, application IDs, updater endpoints, and protocols are not renamed by this artifact branding.

The Desktop Host discovers only its product root, containing the default `short-drama-local` and two read-only native adapters: `standard` and `ptc`. The adapters reuse the upstream compositions without maintaining copies or changing roster discovery APIs. The upstream `minimal` composition is not adapted: it keeps its shell inside a nested group, and a group's rows are not imported into a composition nested this way, so that mode would mount without its only tool. The short-drama preset combines maintained drama tools with the production workflow rules, keeps shared Jubian services on the Host, and uses the public BGM catalog. Neither the deployment's shipped presets nor the user's existing Web presets are modified. The current user's explicit production authorization is required by the persona; the existing automatic per-project budget ceiling remains a separate execution policy, not a new authorization mechanism.

Packaged Windows startup prepends its media Python and FFmpeg directories to the child environment, removes inherited Python import overrides, and provides the bundled ASR model directory. Runtime preparation and installed-artifact verification own the existence and compatibility of those resources; environment wiring alone does not establish a complete installer.

The Host enables one filesystem skill provider with explicit bundled and product-home `skills` roots, and creates the writable directory during boot. Default-root discovery remains disabled. The Standard and PTC adapters disable their nearer native filesystem providers so all product presets inherit the Host provider instead of selecting old `.agents` or project roots. Short-drama, Standard, and PTC expose the skill tool. Explicit plugin skill registration remains available.

External Python and the Codex CLI require real filesystem paths, so their complete resource packages are unpacked from ASAR and their consumers resolve those unpacked paths before launch. PTC retains the non-secret `ELECTRON_RUN_AS_NODE` startup flag because the packaged Host's executable is Electron; the model program still receives an empty environment and no API credentials.

Snatch commands prefer `JUBIANAI_ADMIN_TOKEN`, retain explicitly supplied `JUBIAN_TOKEN` compatibility, and read only the current home’s primary credential file. A nonempty `DSH_HOME` never falls back to `~/.dsh` or an alternate-account file. Missing credentials stop requests; the Python scripts have no automatic bridge to the desktop UI credential Service or Vault.

The product uses user-supplied reference images rather than a Xiaohongshu search dependency. The core `style_references.py` import/check commands reuse `asset_style_references.json` and require real images, per-image review and user confirmation. This is a skill-workflow prerequisite, not a new paid-tool authorization check. Product distribution policy excludes the Xiaohongshu skill; without browser redistribution evidence, neither browser bundling nor automatic download is included.

Product media pins one official SIL OFL Noto Sans CJK SC OTF and its license. Startup passes `MUSE_FONTS_DIR` and `MUSE_FONT_FAMILY` through the child environment to both Python and TypeScript rendering paths. Non-product SimHei/Microsoft YaHei defaults remain unchanged; the product does not depend on those system fonts being installed.

Development uses the same source-owned community tarballs and compatibility overlays as packaging, built into its own `development/community-plugins` directory. Preparation validates every archive and its runtime dependencies before replacing the disposable project, rejects archive traversal and links, and never substitutes an installed user profile or unbuilt upstream source. Missing artifacts in skip-build mode fail with rebuild guidance. Workspace peers and the frozen community toolchain supply development dependencies without a second installation protocol.

Profile resolution starts from the materialized runtime root's `package.json`, which owns the CLI, Desktop Host, and all source-owned plugins. A CLI-only or Host-only dependency graph omits product or community packages even when their files are present. Development records its validated installed community packages in that same root dependency map.

The private preparation smoke waits for the credentials Service, mounts two concurrent Agents for each of the three product presets, checks tools, bundled skills, and product-owned custom skills against same-name legacy decoys, and records the failure reason for an incomplete run. The parent requires the completion record; Host readiness alone does not imply successful plugin activation. Startup is bounded to 60 seconds, and the smoke neither supplies credentials nor sends a model request.

## Alternatives considered

**Reuse the developer home.** This preserves local accounts automatically but couples a new product to personal credentials, plugins, and session state. Explicit account setup avoids accidental distribution or activation of those resources.

**Edit or remove a shipped preset.** The active deployment also reads this checkout's shipped presets, so an edit affects existing sessions and may be overwritten by deployment updates. A private product root leaves the original installation intact.

**Introduce preset aliases or hidden IDs.** A new product with a fresh home has no legacy sessions to migrate. A product-owned root and native composition adapters require no roster protocol extension; migrating an existing Web installation remains separate work.

## Consequences

The existing [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continues to own package sharing and plugin lifecycle. The [short-drama source decision](2026-09-22-short-drama-source-and-bgm-library-ownership.md) continues to own skill resources and BGM distribution. Neither is fully superseded.

Startup tests cover default and explicit product homes, development behavior, and Windows media environment propagation. A Loader test covers the product roster and reversible guard behavior; it does not replace complete preset activation, clean-machine media execution, GUI checks, or installer qualification. Offline snatch tests cover fake-account home isolation and request refusal without credentials. Both rendering paths pass real Chinese-text smoke checks with the existing FFmpeg binary; the new package is not yet qualified on clean Windows. Existing DSH accounts and sessions remain in their original home, and the current Web installation can still show its original two modes.

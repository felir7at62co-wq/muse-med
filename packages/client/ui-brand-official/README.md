---
description: "muse-med spider artwork for the sidebar and conversation hero in local and release builds."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package displays the muse-med spider artwork in the sidebar and conversation hero in every build profile. The sidebar supplies the localized muse-med name and retains version, commit, and dirty-state metadata. The package keeps its internal identifier, holds no runtime state, and does not affect model requests.

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

Mount this plugin in the browser roster of a muse-med deployment. Its image occupants register in local and release builds.

### Artwork and build profiles

The Web application supplies the original transparent 1254 × 1254 artwork as `./muse-med-logo-black.webp` and `./muse-med-logo-white.webp`. Brand marks use black for the application's resolved light theme and white for its resolved dark theme, including manual selection and system-following mode. The browser favicon always uses black artwork independently of the application theme. The packaged desktop and PWA install icons remain theme-independent. `DSH_CLIENT_BUILD_PROFILE` does not gate registration. This plugin does not occupy `sidebar.brand.name`; the sidebar owns its localized name and build metadata.

### Replacing the brand

A deployment with another identity leaves this package out and composes another package occupying the sidebar and hero image slots. Occupying a slot is the composition route; this package has no brand configuration fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half, [`src/client/index.ts`](src/client/index.ts), installs two independent, declaration-aware `ctx.slots.inject()` effects for `sidebar.brand.mark` and `conversation.hero.brand.mark`. Each registration waits for its declaration, leaves when that declaration collapses, and is disposed with the plugin fiber. The node half is an empty Loader seat. The browser title is outside the slot system: `DSH_CLIENT_TITLE` overrides the Web build's default `muse-med` title.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the slots and shell that render the artwork.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


Brand presentation depends on the host application's assets and slot declarations.

- **Host-owned artwork** — the Web application must serve both theme artwork URLs; the plugin does not embed the images. It updates an existing `link[rel="icon"]` and restores its original URL and type when unloaded.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state; its two slot occupants are owned by independent plugin-fiber effects.

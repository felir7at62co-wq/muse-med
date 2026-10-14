---
description: "Read-only character reference browser for shared Web/Desktop compositions, with search, filters, details and local image previews."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-character-library

English | [中文](README.zh.md)

## Summary

Browse character references from the Session Sidebar guide without uploading or binding assets. The shipped source displays an unconfigured state and makes no network requests. Controlled fixture sources show a persistent test-data banner; neither a preview nor an approved label grants production use.

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

The shared Web composition used by Muse and the Harness Web/Desktop profiles registers one `character-library` page in the right Sidebar. Open its guide entry to view the library. Search uses display IDs, names and tags; filters combine category, gender, style, appearance and review status. Missing optional fields remain unknown. Cards open details, and permitted local raster or browser object URLs open a contained preview. Missing or failed images show a fallback. Source errors show a retry action, and source changes or unmount cancel pending loads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry is inert and registers no TOS routes, metadata parser, project binding or writers. The [browser entry](src/client/index.ts) registers its page and keyed body/title slots through Cordis effects, removing them when the plugin unloads. Components receive a read-only source and typed localized copy. `LibraryDisplayItem` and `LibraryBrowserSource` are temporary presentation types internal to Phase 2; they are not a shared TOS catalog contract. A catalog adapter must supply normalized display records at the [source interface](src/client/types.ts); the UI parses no cloud metadata. Test fixtures stay under `tests/` and are absent from the shipped reader.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The browser shares the standard Client composition and Sidebar extension points.

- [Web Client architecture](../../../docs/subsystems/web-client.md) — the browser layers and data flow.
- [Slots reference](../../../docs/subsystems/slots.md) — registration, props and disposal.
- [Right Sidebar](../ui-sidebar-right/README.md) — guide pages and tab types.

-----

<a id="model-experience"></a>
## Model Experience

### Browser-only character references

#### What the model sees

None. The `character-library` page registers no tools, prompt sections or Session events and never adds a selected card to a model request.

#### Token effect

None; search, filters and image previews assemble no model request.

#### KV Cache effect

None; browser interactions do not change model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The shipped reader has these limits.

- The default source is unconfigured. This package provides no live TOS adapter or cloud metadata parser.
- Browsing is read-only. It provides no project binding, persistence, upload, approval or generation action, including for records labeled approved.
- Preview accepts inline PNG/JPEG/WebP and browser object URLs. Remote image retrieval, private access and URL refresh belong to a controlled source adapter.
- Review labels are display data, not reuse authorization or copyright verification. Pending and unknown records never become approved through browsing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Read-only browser access to the Host character reference library."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-character-library

English | [中文](README.zh.md)

## Summary

This plugin exposes the composed [character library](../../drama/character-library/README.md) to browser clients through the `characterLibraryBrowser` Remote namespace. It offers status, bounded catalog browsing and verified image previews. It has no upload, edit, delete or metadata approval operation.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host composition supplies `characterLibrary` before this plugin. `status()` reports its read-only configuration state without reading storage. `browse()` delegates collection, query and cursor validation to the domain service. `preview()` returns a verified image as an in-memory data URL and SHA-256, without exposing an object-storage URL or credentials. Domain read failures produce the stable `character-library/read-failed` Remote error with a domain error code.

The [browser plugin](../../client/ui-character-library/README.md) mounts this package's generated Remote contribution and displays these read operations.

<a id="model-experience"></a>
## Model Experience

### Browser reference reads

#### What the model sees

The `characterLibraryBrowser` namespace contributes no model tools, prompts or Session events. Browser navigation and previews do not add model context.

#### Token effect

Browser reads consume no model tokens.

#### KV Cache effect

Browser reads do not change the model request prefix or its KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider owns cloud connectivity and credentials. A mounted browser facade does not itself make an unconfigured library readable.
- Previews retain the domain service's byte bounds and image verification; the browser does not receive a permanent public download URL.

<a id="dev-note"></a>
### Dev Note

The Remote methods remain read-only. Agent reference selection is owned by the separate character-reference tool plugin.

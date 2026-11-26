---
description: "Read-only character references in the Muse left navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-character-library

English | [中文](README.zh.md)

## Summary

The Character library entry in the left navigation opens a read-only catalog of ancient and urban character references. People can search, page through image cards and open a verified full-image preview. The page offers no upload, edit, delete or approval controls.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The browser composition provides slots, locale, resources and Remote services, while the Host mounts the [read-only browser API](../../api/character-library/README.md). This plugin owns its generated Remote contribution and resource providers. Each page contains up to twelve catalog cards. Collection, query, pagination and preview selection are local viewing state. Missing connectivity and failed reads display an in-place notice with a refresh or retry action.

Images are provided through the framework resource model. Thumbnail and full-image views share the same verified image resource. A preview describes its reference-only use and does not approve the asset for project production.

The Host projects its volatile `syncIntervalMs` through the `ui-character-library` configuration form. Only catalog loading waits for that projection and validates its value; application startup remains available while settings are pending. Missing or invalid settings appear as a catalog failure with the page's retry action. Later completed reads use the latest interval. The delay defaults to 30000 and accepts whole milliseconds from 1000 to 300000. An open catalog reads again after each completed request and this delay, so new and removed cloud references appear without reopening or manually refreshing the page. Subscribers to the same catalog address share one read stream; leaving the page or disposing the plugin cancels its request or waiting interval. A failed catalog read retains the last result and retries at the next interval.

<a id="model-experience"></a>
## Model Experience

### Reference browsing

#### What the model sees

This presentation plugin contributes no model tools, prompts or Session events. Browsing a reference does not add it to a model request. Muse's separate `drama_character_references` and `drama_character_reference_view` tools own model-visible candidate lookup and image viewing, including their logged results.

#### Token effect

Browsing the library consumes no model tokens.

#### KV Cache effect

Library navigation and previews do not change the model request prefix or its KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The library requires a configured Host provider. This page cannot configure cloud credentials or change a reference's permission or review state.
- Previews use the domain's verified original image bytes rather than a separate thumbnail derivative.

<a id="dev-note"></a>
### Dev Note

The feature owns the `character-library` main panel and its left-navigation entry. Its providers and registrations are disposed with the plugin.

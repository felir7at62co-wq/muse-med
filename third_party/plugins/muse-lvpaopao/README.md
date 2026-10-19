---
description: "Add a shared Lvpaopao Windows connection and scoped director-Agent tools."
kind: "package-bundle"
---

# muse-lvpaopao

English | [中文](README.zh.md)

## Summary

Muse's director Agent can search Lvpaopao dramas, read details and actual episode numbers, and copy an authorized first episode through a separately configured Windows helper. One Host provider owns the target connection; each Agent receives its own tool contribution. The package does not install the Windows helper or supply account credentials. An unconfigured installation keeps the service available and reports `unconfigured` without starting a process.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Desktop composition mounts `muse-lvpaopao/bridge` globally and the package root only inside the unified director Agent. The internal preset ID remains `short-drama`; it does not add a user-selectable mode. The standalone [bundle patch](cordis.patch.yml) mounts only the provider, never a global tool. Desktop already supplies that provider and does not select this standalone bundle again. A consumer requires the normal Tools, Agents and subprocess services plus that provider.

```yaml
- insert:
    - id: muse-lvpaopao-bridge
      name: muse-lvpaopao/bridge
```

Mount the consumer in the intended Agent composition without connection parameters:

```yaml
- id: muse-lvpaopao
  name: muse-lvpaopao
```

The provider reads its private connection file at `<Muse home>/lvpaopao/connection.json` by default. Configure the fixed SSH alias, local process directory, absolute Windows Python/helper paths and exact helper SHA256 there, then restart or recompose the provider to load changed settings. The helper separately verifies its complete imports manifest and local process attestation. Do not put keys, live proof, playback addresses or account data in the profile, source tree or model arguments. A missing file is an expected unconfigured state; a malformed existing file is a configuration error.

| Provider configuration | Default | Meaning |
| --- | --- | --- |
| `connectionFile` | Muse home `lvpaopao/connection.json` | Private connection settings; no model-controlled path. |
| `maxQueuedRequests` | `8` | Waiting requests shared by Agents, excluding the active request. |

| Consumer configuration | Default | Meaning |
| --- | --- | --- |
| `maxQueryChars` | `80` | Maximum Unicode code points in a title query. |
| `maxEpisodeCount` | `20` | Maximum requested episode count per call. |
| `maxResultItems` | `50` | Maximum search candidates retained in a result. |

The `lvpaopao` tool offers `status`, `search`, `detail`, `episodes` and `download_first_episode`. Ordinary drama IDs remain opaque strings of at most 128 allowed ASCII characters; the download action uses the narrower 64-character letter/digit/underscore/hyphen form. Episode results preserve actual returned numbers and partial flags. An empty or partial response does not establish a complete catalog. Optional diagnostics retain only fixed categories and a numeric-or-null native code, never raw errors or signed URLs.

Downloads require `downloadEnabled:true` in the private connection and the actual requesting Session. The default destination is `downloads/lvpaopao` beneath that Session's workspace; an explicit tool `outputDir` follows its sandbox/file policy. The transport file's destination does not override the Session. File validation occurs before acquiring media or starting a copy. A successful result requires exact local bytes and SHA256 matching the helper's decoded file. A returned path does not automatically call `present` or send a chat attachment.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Connection ownership and cleanup</summary>

The Host serializes access to one target and owns connection disposal. Closing one Agent cancels its own queued/native/copy work. A confirmed cancellation keeps the shared SSH connection when its transport remains live; unconfirmed cleanup or a terminal transport failure closes that generation. Native cancellation may still invalidate the target lease and require a later explicit `status` to rebuild it after cleanup. A failed or unknown business request is never automatically replayed. The provider creates the transport lazily, and cancellation does not claim completion until the original request or owned process settles.

The current helper is limited to a ten-minute lifetime including target-launch waiting. Status can report that the operator must reopen the selected target. Cleanup requires the helper's complete disposal/unload/detach/server-closed confirmation and a successful managed process exit. Native instrumentation can leave application-object changes until those objects are destroyed or the target restarts; removing a hook does not promise complete rollback.

</details>

<a id="further-exploration"></a>
## Further Exploration

The [plugin build overview](../README.md) describes Desktop package delivery. The [provider](src/bridge.ts) owns connection lifetime, and the [consumer](src/index.ts) owns the logged tool result and Session-scoped file destination.

<a id="model-experience"></a>
## Model Experience

### Scoped tool

#### What the model sees

The director Agent sees one `lvpaopao` tool with business arguments, readiness, actual catalog results and verified local-file metadata. Unconfigured or failed actions return explicit safe results. The provider alone contributes no tool schema and adds no system-prompt section.

#### Token effect

One tool declaration is present in the consumer scope. Each call appends its bounded canonical result through normal logged tool history.

#### KV Cache effect

Results append to the conversation. Mounting or changing the consumer schema can change subsequent tool declarations; the package does not guarantee provider cache reuse.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Live qualification is limited to the fixed Windows x64 WeChat 4.1.13.65 / WMPF 25560 build and one saved-receipt first-episode transfer, including full decode and local hash readback. Reuse made no new playback-address request. Safe cancel-ack handling is covered offline; continued native business after active cancellation is not live-qualified. Other target versions, fresh address acquisition through the adapter, other dramas and complete-series media download are not qualified. Technical access does not grant content reuse rights.

The npm package contains owned adapter code, not the helper, WeChat binaries, extracted target source, credentials, private attestation or media. The repository's `native/` directory contains versioned helper source for separate deployment on the fixed Windows build; it does not provide automatic installation. Every Windows deployment needs its own genuine process identity and proof before sealing. Installing this source into local main does not establish that a running app or a released installer has been updated. The helper remains a separately controlled local beta.

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>

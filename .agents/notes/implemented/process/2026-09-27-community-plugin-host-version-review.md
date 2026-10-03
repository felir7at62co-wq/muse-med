# Agent Note: Review community plugins against the pinned Host

Status: implemented

English | [中文](2026-09-27-community-plugin-host-version-review.zh.md)

## Problem

Community source imports Host APIs directly. A removed export fails compilation; a service method whose meaning changed can compile and misbehave. Moving a Host pin without reviewing both cases would ship an unchecked compatibility claim.

## Decision

The [community builder](../../../../third_party/plugins/build.mjs) requires the reviewed Host version, currently `0.2.0-rc.2`, and records it in artifact peer alternatives and `SOURCE.json`. A Host upgrade requires review before that guard moves. [upstream.json](../../../../upstream.json) independently records the fork's upstream source pin.

### Message-source ownership

Ponytail declares its own `ponytail` member of `MessageSourceMap` and sends `{ kind: 'ponytail' }`. A removed catch-all `plugin` source does not justify weakening assertions or inventing a kind outside the documented extension point.

### Config-derived credential settings

The current settings service names sections by composition entry ID and derives each section from that row's Config. The [Feishu setup checks](../../../../packages/host/feishu-settings/tests/service.spec.ts) boot the real config-editor/settings pair and address `feishu-channel`. The [Desktop Loader checks](../../../../apps/desktop/tests/feishu-setup-loader.spec.ts) use the shipped patch layers to verify activation and credential saving.

The [reviewed bridge provider](../../../../third_party/plugins/compatibility/muse-feishu-channel.mjs) consumes resolved Config and dereferences its volatile credentials. Credential persistence uses `settings.update(entryId, values)`; `settings.get(namespace)` and plugin-owned section registration are not supported replacements. Volatile schema output contains references while input contains plain values, so one object type cannot describe both.

### Source review

The [bridge overlay](../../../../third_party/plugins/compatibility/bridge-desktop.mjs) checks retained upstream module hashes before staging adaptation. Runtime API imports must exist in built ESM exports; an erased TypeScript enum cannot be imported by a JavaScript plugin. The artifact retains the upstream source pin and license while exposing only reviewed product providers.

The [Codex pi-ai overlay](../../../../third_party/plugins/compatibility/codex-pi-ai.mjs) requires the retained runtime module and catalog fixture hashes and binds its copied admission guard and artifact peer to `0.87.1`. Copied catalog assertions exercise currently advertised models, preserving custom-context checks without inventing offline aliases for removed models. The staged provider shares the Host adapter's installed dependency, so their model preparation and streaming APIs use the same release. The independent toolchain lock and retained source manifests remain unchanged.

## Verification

Build each selected source against the checkout's built Host packages and run its artifact checks before accepting a Host pin. The [build test](../../../../third_party/plugins/build.test.mjs) rebuilds from clean staging and compares exported files and tarball bytes. [Codex streaming checks](../../../../third_party/plugins/checks/codex-pi-ai.mjs) exercise pi-ai's actual OAuth request-token resolution, preference payloads, and SSE output through the provider and Host adapter without a paid API request. [Bridge checks](../../../../third_party/plugins/compatibility/bridge-desktop.test.mjs) reject unreviewed source and exercise current Host metadata services; [transport checks](../../../../third_party/plugins/compatibility/bridge-remote.test.mjs) cover streaming, native WebSocket frames, cancellation, rejection, and reconnects. Live Feishu delivery and packaged activation remain separate unverified checks.

## Alternatives considered

**Move the pin and compile only.** Compilation cannot detect changed activation, settings ownership, or teardown semantics.

**Give the bridge its own settings namespace.** The product credentials page and the bridge would address different sections.

**Drop credential records instead of marking fields volatile.** Settings refuses writes to ordinary fields; bypassing it through another editor does not preserve the product page's section semantics.

**Remove activation checks with a retired provider.** The replacement still needs coverage where product composition and saved credentials meet the real Loader and settings service.

## Consequences

Artifact peer alternatives and source records claim only the reviewed Host. Capability and lifecycle checks accompany compilation, and another Host upgrade repeats them before moving the pin. Staging changes remain separate from retained upstream snapshots. Built checks require the current Host artifacts and cannot substitute source-only imports for shipped ESM entry points.

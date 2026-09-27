# Agent Note: Community plugin review against Host 0.1.7-rc.2

Status: implemented

English | [中文](2026-09-27-community-plugin-host-version-review.zh.md)

## Problem

The [community plugin build](../../../../third_party/plugins/build.mjs) compiles five pinned upstream snapshots against the built Host packages and refuses to start whenever the checkout version differs from the one its guard records (`host … needs a new compatibility review`). Merging upstream `0.1.7-rc.2` therefore stops at that guard, and moving the pin without the review it demands would ship plugins nobody compiled against this Host. The snapshots import Host packages directly, so a deleted export is a build failure while a service method that still exists but changed meaning compiles and misbehaves — the first review run found one of each.

## Decision

The five plugins compile against Host `0.1.7-rc.2`, and every pin site records that version: the `build.mjs` guard, `approvedVersion` in [the Codex check](../../../../third_party/plugins/checks/codex-subagent.mjs), the peer-alternative and `SOURCE.json` expectations in [the build test](../../../../third_party/plugins/build.test.mjs), the plugin [README](../../../../third_party/plugins/README.md) with its Chinese pair, and the DSH row of [the ponytail README](../../../../third_party/plugins/dsh-ponytail/README.md). [upstream.json](../../../../upstream.json) keeps its own `pinnedVersion`: that field records the upstream commit this branch forked from, not the Host the plugins were compiled against.

### The deleted shared message-source kind (dsh-ponytail)

Upstream removed the catch-all `plugin` kind from `MessageSourceMap`, and each producer now declares its own `kind` in its own module. Ponytail steered eight status notices with `{ kind: 'plugin', plugin: name }` and failed to compile on all eight. It declares `ponytail: { kind: 'ponytail' } & ContextFormed` in its own module and sends `{ kind: 'ponytail' }` — the migration the Host applied to its own former `plugin` producers (`time-context`, `runtime-context`, `repeat-tool-reminder`). No assertion was relaxed, and no kind outside the documented extension point was invented.

### The deleted settings provider (dsh-lark-bridge)

Our [Lark runtime check](../../../../third_party/plugins/checks/lark-desktop-runtime.mjs) imported `@deepseek-ai/dsh-settings-file`, which upstream deleted when the settings service became Config-derived forms over the active profile. The migration is not a rename: the check composes a real profile — a bundle layer inserting the rows, the profile's own patch layer storing the row's values — and boots the real `config-editor`/`settings` pair, so it addresses the plugin's section by its composition entry id `feishu-channel` exactly as a deployment does, and a new case drives a successful QR scan end to end.

That migration exposed the plugin's own port. `settings.get(ns)` never existed on the current service: the namespace is the entry id, and the section is the entry's own resolved Config, which the Loader already hands to `apply`. The bridge reads that Config, resolves the two credential fields through their live references, and persists a completed onboarding with `settings.update(entryId, credentials)`. Because the settings service writes live fields only, `appId`, `appSecret`, and the scan record `registeredBy` are volatile in the schema; without that the credential save this check exercises is refused, and the fork's "scan once, keep the app" behavior is lost. Two consequences: the schema is no longer annotated `z<Config>` (a volatile field's output is a reference while its input stays the plain value, so no single object type is both; the Host's `llm-deepseek` Config is laid out the same way), and `resolveConfig` accepts either the mounted Config or a plain one, unwrapping the two references in one place.

### Retired overlay rules

Two [staging overlay](../../../../third_party/plugins/compatibility/lark-desktop.mjs) rules are gone and stay gone: `host.ts`'s `options?` parameter and `runtime.ts`'s `settings.register(...)` call. Both adapted the fork's `register(ns, schema, { base, applies })` signature, which has no caller left — a namespace the plugin registered itself would address a section nobody serves.

## Verification

Run from the repository root with `npm_execpath` pointing at the pnpm entry (`build.mjs` requires it) and the built Host packages present:

```sh
node third_party/plugins/build.mjs --only <name> --out <dir>   # dshmarket, dsh-codex-subscription, dsh-ponytail, dsh-lark-bridge, dsh-ffmpeg
node --test third_party/plugins/build.test.mjs
```

All six runs exit 0; `build.test.mjs` also rebuilds every plugin from clean staging and compares the tarballs byte for byte. The Lark check reports 5 passing tests (three activation cases, the scan-and-persist case, and the schema flags), Codex 32, and the staging overlay review 2. A future Host upgrade re-runs exactly this set before moving the pin again: the guard exists to make that review unavoidable, and no constant in it may move to turn a red build green.

## Alternatives considered

**Move the pin and build only.** The guard is the review's trigger, so a build with the new version is the first step either way; shipping it without the checks above would ship the two failures it hides — the ponytail compile break and the Lark check's import of a deleted package.

**Keep `settings.get` and give the bridge its own namespace.** Registering a namespace is what upstream removed; a plugin-owned section would be invisible to the settings service, which names one namespace per composition entry, so the credentials page and the bridge would address different sections.

**Drop the credential record instead of marking fields volatile.** Writing only `appId`/`appSecret` would still be refused without volatile paths, and writing through the config editor instead would leave the section unaddressable for the product's own credentials page.

**Retire the Lark runtime check with the provider it imported.** The check is the only place the bridge's activation switches and its credential save meet a real Loader and a real settings service; nothing else covers that path.

## Consequences

The pinned community artifacts now claim Host `0.1.7-rc.2` in their peer alternatives and `SOURCE.json`, and the next upstream merge must repeat the review before its build can run. The Lark snapshot no longer equals its pinned upstream text in `config.ts`, `host.ts`, and `runtime.ts` — the same standing deviation the settings port already introduced, now with the credential fields, and it must be re-applied when the snapshot is re-pinned. Ponytail's notices carry a new source kind, so a transcript reader that special-cased `{ kind: 'plugin', plugin: 'ponytail' }` would no longer match it; the Host's own readers fall through unknown kinds by design. The Lark check gained a dependency on the built `config-editor`, `settings`, and `app-boot` packages, so it can only run from a checkout whose Host packages are built — which `build.mjs` already requires.

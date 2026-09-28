# Agent Note: The Feishu switch on the upstream settings service

Status: implemented

English | [中文](2026-09-28-feishu-switch-on-the-upstream-settings-service.zh.md)

## Problem

Upstream `0.1.7-rc.2` deleted `@deepseek-ai/dsh-settings-file`, the legacy `settings.yaml` provider, and
composes `@deepseek-ai/dsh-settings` under the same row id. The replacement has no `get`, no `register`,
and no document: a settings section belongs to one composition entry, is named after that entry's id, and
consists of that entry's own `Config` fields, of which only the `volatile()` ones are writable.

The whole Feishu stack was built on the document. `apps/desktop-host/src/feishu-gate.ts` parsed
`<home>/settings.yaml` to decide the bridge row's entry-level `disabled`; `@deepseek-ai/dsh-feishu-settings`
registered the `feishu` and `dsh-lark-bridge` sections through `SettingsProvider` and stored the credential
pair in the document; `apps/desktop/tests/desktop-feishu-config.spec.ts` asserted the reader's behaviour on
unreadable documents. After the merge every one of those consumers failed to compile: 85 of the host face's
`error TS` lines named this stack and nothing else.

## Decision

**The switch is a composition row's own Config.** `@deepseek-ai/dsh-feishu-settings` is composed as id
`feishu` and exports `Config = z.object({ enabled: z.boolean().default(false).volatile() })`.
`feishuGateLayer(rows)` reads `enabled` from the composed `feishu` row and restates it into the
`feishu-channel` row's own `enabled` key, which is the control the staged package reads before it starts
its sync layer, its control server, its peer heartbeat, or a QR app registration. Only an explicit `true`
opens the gate; an absent row, an absent key, and the string `"true"` all mean off.

**The bridge row stays mounted and inert instead of entry-disabled.** In this harness a plugin's settings
section IS its own resolved Config, so an entry-disabled row has no section to write — and storing the
credential pair before the bridge ever runs is exactly what `main`'s `ea97c5dbe4` ("store the credential
pair while no bridge row owns the section") exists to provide. The shipped desktop patch therefore carries
`enabled: false` plus the activation controls as its fail-safe, and the gate replaces that config
wholesale. The observable guarantee is unchanged: with the switch off, the staged bridge returns before
every side effect, and no `settings.yaml`-style document is read at all.

**The credential pair is that row's section.** `FeishuSetupService` writes it with
`settings.update('feishu-channel', …)` and clears it with `settings.mutate(...)`, and reads it back through
`describe({ redactSecrets: true })`, which reports the app id, the scanner's open id, and whether the
secret is set — never the secret. Failures keep the bounded codes `main` publishes
(`feishu/credentials-unwritable` with `section-unregistered` or `write-rejected`,
`feishu/secret-required`, `feishu/login-failed` with the platform's code) and are declared in
`RemoteErrorDetailsMap`; the page renders each reason as its own copy and keeps a typed secret after a
refusal so the operator can retry it.

**Stored values move with the document.** `SettingsForms` renames `<home>/settings.yaml` to
`settings.yaml.imported` on the first boot after the upgrade and imports every section through the same
`update()` path the page uses, so a section lands in the profile patch under its entry id; the rename
happens first, which is what makes a partial import non-repeating, and the backup keeps anything the
running composition rejected. The name mapping is explicit, because three sections are not spelled like
their entry: `dsh-lark-bridge` → `feishu-channel`, `agent-presets` → `agent-preset-registry`,
`ui-developer-tools`/`ui-onboarding`/`shell` → their owning rows.

## Alternatives considered

**Keep the entry-level `disabled` and move the pair to the product row.** This preserves the composition-time
switch at the cost of `ea97c5dbe4`: with the bridge row disabled there is no section to write, so an
operator could not store a scanned pair before turning the switch on — the reported defect that commit
fixed. It would also make the gate name the credential fields, which the shipped patch deliberately never
composes.

**Revive `@deepseek-ai/dsh-settings-file` for the product row.** Ruled out: it reverts an upstream-owned
composition row and keeps a package upstream deleted only to carry one boolean.

**Keep the bare `Error` the branch migration used for a refused write.** `main` publishes the coded
`RemoteError` because the settings service's own message quotes the entry and path it wrote, and a schema
refusal can quote the refused value — here the secret. The page cannot name a failure it cannot classify.

## Consequences

- `apps/desktop-host/tsconfig.json` references `packages/host/feishu-settings/tsconfig.host.json`, and that
  package's client face names `../../client/{locale,ui-settings}/tsconfig.client.json` instead of the
  directories, which is the TS6306 shape the merge addendum records.
- `ensureBridgeSection()` retires with the file provider: `register()` no longer exists, so a composition
  that mounts no bridge row cannot be given one, and the page reports `writable: false` with the reason
  `section-unregistered` instead of creating a section.
- `desktop-feishu-config.spec.ts` is retired: its document-reader cases lost their referent with the
  provider, and its remaining composition cases are owned by `apps/desktop/tests/feishu-setup-loader.spec.ts`,
  which boots the same shipped patch files through the real Loader.
- Measured: `pnpm run build:lib` `error TS` 64 → 39 in this block (the 39 remaining are
  `apps/desktop/scripts/package-target.ts` and its spec, block 2); `pnpm exec vitest run
  packages/settings/settings/tests packages/host/feishu-settings/tests` → 84 passed; `pnpm exec vitest run
  apps/desktop/tests/feishu-setup-loader.spec.ts` → 5 passed. The client face's `tsc -b` still cannot run,
  because the host face stops on block 2 before generating the typert remote artifacts.

# Agent Note: The short-drama settings section and its two Web surfaces

Status: implemented

English | [中文](2026-09-20-drama-settings-panel.zh.md)

## Problem

The short-drama pipeline's operator-facing choices had no home. The permission tier an operator wants for a production, the directory finished episodes are delivered to, the JianyingPro draft root, the delivery spec the renderer must hit, and the local BGM library all lived in prose: the preset's prompt described them, each skill rediscovered them, and `tweet-drama-key-manager` kept a parallel local configuration for the editing paths. A person running the Web GUI could not see or change any of it, and a host-side gate that wanted to enforce a tier had nothing to read.

A dynamic Cordis prototype had already proved the interaction — a settings page over a durable value — but a process-local plugin definition does not survive a restart, is invisible to every other package, and cannot be depended on by a host row.

## Decision

`@deepseek-ai/dsh-drama-settings` owns the durable `drama` settings namespace and the one Web GUI surface that edits it. It is a dual-face package: the Host half registers the namespace with `ctx.settings`, and the browser half renders a **Settings → 短剧** page.

The Host half is `src/index.ts`, and it is only that registration: `ctx.inject(['settings'], settingsCtx => settingsCtx.settings.register('drama', DramaSettingsSchema))`. The row publishes no service, holds no state of its own, and takes no `Config` — every default is the schema's own default, so there is one home per fact and the settings document is the only place a deployment changes one. A composition without a settings provider registers nothing, and the browser half then reports the namespace as unavailable rather than inventing a value.

`src/settings.ts` is shared by both compiler faces. It holds the namespace, the field names, the defaults, and the schemastery schema that the Host registers and the browser scope validates its section against. The `jianyingDraftDir` default is empty: a root copied from one operator's installation cannot identify another operator's editor. The page asks for an explicit root rather than presenting an invented machine default.

The browser half binds exactly one scope — `ctx.settingsScope.bind({ namespace: 'drama' })`. `src/client/section.ts` compiles the page's form into path operations: a field already stating the intended value is untouched, and a field whose intended value is the schema default is *cleared*, so the user layer never stores a copy of a default that says nothing. `src/client/DramaSettingsSection.tsx` is a pure props component: the scope and the write arrive through the inject face and the renderer binds the hook.

The write verdict is read from the resolved section, not from the transport. The settings scope does not throw when a write is refused — it recovers the host's current state and settles — so the page compares the section it renders with the one the draft asked for and reports a failure when they differ. That keeps the package off a second wire contract while still refusing to show a refused write as saved.

The page registers through `ctx.slots.inject`: this package does not own the Settings shell, the registration waits for the declaring entry, and it leaves with that declaration or with this row's fiber.

The page also answers "what is a production made of", as a read-only list: the six packages a short-drama session is composed from — `dsh-guard-drama`, `dsh-tool-drama-assets`, `dsh-tool-shot-script`, the independent `dsh-perception-bgm` matcher, `dsh-tool-bgm-compose`, and `dsh-tool-episode-render` — each with the one-line role it plays. The status beside each row comes from the Host's read-only `pluginInventory` projection, which reports Loader entries and each mounted preset's composition rows with their enablement and fiber phase. That namespace is read through `ctx.get`, because it belongs to a deployment that composes the inventory: with none, the page still renders the list and every package reads as 无法查询 with the note that these rows load with the short-drama preset or the host cordis patch. Silence is never rendered as 已加载, and a package the answer does not name reads as 清单里没有 rather than as inactive.

The page's last group, **资产图生成通道**, is the second such optional cross-package read and the one place this package stores a choice another package consumes. The account catalogue lists `gpt-image-2` once per platform at its own price, and `jubian_video image_generate` refuses to choose between those rows, so somebody has to pin one. The picker lists them — platform, that row's own price, and the id that pins it — over the read-only `jubianImage` Remote namespace that `@deepseek-ai/dsh-tool-jubian` owns, which is where the credential and the transport for that read already live; the page reaches it through `ctx.get` for the same reason it reaches `pluginInventory` that way, and re-resolves it per call because the owning plugin may mount after this page. The chosen row id is stored in the `drama` section like every other field, so it rides the page's single atomic write, and the tool row resolves it ahead of its own composition config. A row the section pins but the catalogue no longer lists stays in the select and stays saved: a list this page could not read is not permission to drop a choice somebody made.

## Alternatives considered

**Reuse the dynamic prototype's own mechanism and ship a process-local plugin.** The prototype is exactly what this package replaces: its definitions live in one DSH process, other packages cannot read its values, and a restart loses it. The operator's delivery directory and BGM library have to outlive a restart and be readable by a host row.

**A dedicated Typert Remote namespace, as `dsh-tool-jubian` does for its admin token.** That page needed a namespace because it writes one credential reference and the credential seam's generic namespace takes the reference as an argument. Here the values belong to the settings seam, which already owns registration, layering, revision fencing, redaction, and the browser transport. A second namespace would have duplicated all of that for one section and left two stores for the same facts. The one value that is not a plain settings field — the account's live `gpt-image-2` rows — is read over a namespace owned by the package that already holds its credential, rather than by giving this package a provider client of its own.

**Write the section through `ctx.remote.settings` directly, as `ui-agent-preset` does for its roster defaults.** That path reports a refusal as a value the caller must handle, which is why it is attractive; it also requires the caller to own a describe mirror and a revision fence. Binding the scope gets both for free, and the landed check described above supplies the missing refusal signal from the same snapshot the page renders.

**Put these values in the row's `Config` instead of a settings namespace.** Composition config is the wrong lifetime for an operator's per-production choice: changing it means editing a composition file and restarting, and the Web GUI could not offer it at all. Config would also give each default two homes, which is what the schema-only decision above removes. The image-route pin is the one value with a config field of its own, and it is deliberately the *fallback*: config cannot show a person what each platform charges.

**Store the image-route pin in a `jubian` namespace owned by `dsh-tool-jubian`, rendered inside the 短剧 page.** Ownership would match the consumer, and that package could have used `installSection` to make its existing `imageStandardId` config the base layer. It lost because the page's form would then write two namespaces per save, so a refusal could land half a section, and because the field's schema would live in one package while the surface that explains it lives in another. The pin rides the same `drama` section as the delivery spec instead, and the tool row resolves the section ahead of its config.

**Store a permission tier and switch it from a composer control.** The first cut of this package did exactly that: a `permissionTier` field (`generate` / `video` / `full`) plus a chip in `conversation.input.left` beside the permission picker. It was removed before landing. Two reasons decided it: a stored tier is a second, staler answer to a question the agent answers better per call — the pipeline's own rule is that the human is asked when a specific submission is on the table, not by a global switch set days earlier — and a tier that no executor reads is worse than no field, because the page would imply an enforcement that does not exist. The drama gate keeps its hard pre-checks either way; what changed is that no setting claims to decide when a paid step asks.

## Consequences

The pipeline's operator-facing values now have one durable home, visible and editable in the GUI, and a host row can read them without knowing anything about the browser. That now includes which `gpt-image-2` catalogue row the paid asset-image route buys from, which is the first value here that another package resolves on every paid call.

The page shows the resolved section rather than its own echo, which is why a refused write leaves the operator's edits in place for another attempt.

The component list answers "what is this made of" without asserting "it is running". Where the deployment composes no inventory, where a package is mounted under a different module specifier, or where a preset row is only conditionally enabled, the page reports what it could establish — unqueryable, not listed, conditional — instead of a green state nobody observed.

When a paid step asks for confirmation is the agent's judgement, recorded where it happens: in the conversation, next to the request it concerns. Nothing in this package can be read as a standing permission.

The package does not publish a runtime invariant companion: it registers one settings namespace and one slot contribution, owns no independent lifecycle stream, and the disposal of both is proven by its registration spec.

## Testing

`tests/settings.spec.ts` drives the real settings service over an in-memory provider: the defaults a client reads, a partial section, the schema's own rejections (a fractional frame count, a zero bitrate floor, a row id that is not a positive integer), the reset path, and removal with the row's fiber. `tests/apply.client.spec.ts` boots the production `SlotRegistry`, a real `LocaleRuntime`, and the real settings-domain base over a scripted `remote.settings`, then asserts the registration, the resolved scope, the operations each write sends, the invalid-draft path, the refused-write verdict, late declaration, and teardown; it also drives the component probe with no inventory, with an answering one, with a refusal, and with a throwing read, and the image-route probe with no namespace, with an answering one, with a refusal, and with a throwing call. `tests/components.client.spec.ts` covers the fold from an inventory answer to each status, including the two row kinds it reads and an answer that never came. `tests/settings-page.client.spec.tsx` feeds the component its props directly and asserts the copy a person reads in each state, including the route options, the preselected row, and the pin that survives a catalogue that no longer lists it; `tests/section.client.spec.ts` covers the draft compiler, including a namespace that has not resolved yet and a select that pins nothing. `npx vitest run --coverage packages/drama/drama-settings` reports 66 tests and per-file 100% statements, branches, functions, and lines.

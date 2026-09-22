---
description: "Short-drama settings for the Web GUI: the durable `drama` settings section (delivery directory, JianyingPro draft root, delivery spec, BGM library, paid image-route row), the Settings page that edits it, and its read-only component list; for users and maintainers of the short-drama pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-drama-settings

English | [中文](README.zh.md)

## Summary

Owns the durable `drama` settings section, the **Settings → 短剧** page that edits it, and that page's read-only component list. The section carries what the pipeline reads: the delivery and JianyingPro draft directories, the delivery spec, the BGM library, and the paid image route's `gpt-image-2` catalogue row. The Host half registers the schema with the settings service; the browser half binds that namespace, renders the page, and reports a refused write rather than showing it as saved. Whether a paid step asks first stays the agent's call, so no tier is stored here.

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

Mount the row wherever the Web GUI runs. The Host half needs a composed settings provider; without one it registers nothing and the browser half reports the namespace as unavailable.

```yaml
- insert:
    - id: drama-settings
      name: '@deepseek-ai/dsh-drama-settings'
```

There is no config. A default is the schema's own, and a deployment that wants another one changes it in the user settings document — the page, or the same namespace in `$DSH_HOME/settings.yaml` — rather than in a second composition layer.

| Field | Default | Meaning |
|---|---|---|
| `deliveryDir` | empty | Absolute directory finished episodes are delivered to; empty means `<project>/delivery`, the root the delivery template fills (`00成片`, `01主角`, `02海报`, `05剧本&简介`) |
| `jianyingDraftDir` | this machine's JianyingPro root | Absolute draft root an editable draft is written under; empty means the default |
| `deliverySpec` | `1440` × `2560`, `60` fps, `4.6` Mbps | Resolution, frame rate and bitrate floor of a delivered episode |
| `bgmDir` | (empty) | Where a downloaded track lands; empty keeps the published catalogue and the matcher's own download cache as the only source |
| `imageStandardId` | absent | The `gpt-image-2` catalogue row the paid asset-image route buys from, named by that row's own `id`; absent means the route decides for itself, which works only while the account lists exactly one such row |

### The Settings page

**Settings → 短剧** holds one group per field: the two directories, the four delivery-spec numbers, the BGM library, and the asset-image route. Every group shows the resolved value, and a path box left blank means the schema default — its placeholder is that default.

**保存** compiles the form into one atomic namespace write and reports what happened: `已保存。`, the failure line when the host kept a different section, or the number line when a delivery-spec box holds no number (nothing is sent in that case). **恢复默认** clears every field in one write, which is what returns the section to the schema defaults. A field that already holds its default stays cleared rather than storing a copy of it, so the user layer never says something it does not mean. A read-only settings document disables both buttons and says why.

### The asset-image route

The account catalogue lists `gpt-image-2` once per platform at its own price, and a paid `image_generate` refuses to choose between them: without a pinned row it fails and names every candidate. This group pins one. The select offers 不指定 plus one option per `gpt-image-2` row — `KU_AI · 0.12 元/条 · #66` — read live through the `jubianImage` Remote namespace that `@deepseek-ai/dsh-tool-jubian` owns, so the token behind the read never reaches the browser. A row the section pins but the catalogue no longer lists stays selectable as `#66（当前目录里没有这一行）`, and saving never drops it: a list this page could not read is not permission to clear a choice somebody made. A deployment with no Jubian tools, a catalogue that cannot be read, and a catalogue with no `gpt-image-2` row each say which of the three it is.

Pinning a row here beats the tool row's own `imageStandardId`/`imagePlatformId` config, because the page is the only surface that can show each candidate's price.

### The component list

The page ends with the composition, in pipeline order, and what the read-only plugin inventory reports about each package right now: `@deepseek-ai/dsh-guard-drama` (the tool-dispatch gate), `@deepseek-ai/dsh-tool-drama-assets` (asset reconciliation before image generation), `@deepseek-ai/dsh-tool-shot-script` (`drama_shot`), `@deepseek-ai/dsh-perception-bgm` (`bgm_match`), `@deepseek-ai/dsh-tool-bgm-compose` (`drama_bgm`) and `@deepseek-ai/dsh-tool-episode-render` (`drama_render`). The matcher is an independent plugin rather than part of the drama packages; its row says so, and the BGM **directory** is a separate setting above it.

Each row carries one status: 已加载, 启动中, 加载失败, 按条件加载, 未加载, 清单里没有, or 无法查询. The page reads `pluginInventory` — the Host's read-only Loader and preset projection — through `ctx.get`, so the namespace is optional: a deployment that composes no inventory shows 无法查询 for every package plus the note that these packages load with the short-drama preset or the host cordis patch. Silence is never rendered as `已加载`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/settings.ts`](src/settings.ts) | Shared by both faces: the namespace, the field names, the defaults, and the schemastery schema the Host registers and the browser validates against |
| [`src/index.ts`](src/index.ts) | Host half: `ctx.inject(['settings'])` then `settings.register('drama', DramaSettingsSchema)` — no service, no config, no state of its own |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: one `ctx.settingsScope.bind({ namespace: 'drama' })`, the dictionaries, the page registration, and the optional inventory and image-route probes |
| [`src/client/section.ts`](src/client/section.ts) | The page's draft compiler: form values to a section, a section plus the current one to path operations, and the "did it land" verdict |
| [`src/client/routes.ts`](src/client/routes.ts) | The paid image route's rows as the page reads them: what one `jubianImage.routes` answer means, including the two ways it can carry none |
| [`src/client/components.ts`](src/client/components.ts) | The composed packages and the fold from one inventory answer to the status each row shows |
| [`src/client/DramaSettingsSection.tsx`](src/client/DramaSettingsSection.tsx) | The Settings page component, the route picker and the component list included |
| [`src/client/locales.ts`](src/client/locales.ts) | The page's copy, including every component role and status label |


The page registers through `ctx.slots.inject`, which waits for the Settings shell to declare its slot and removes the contribution when that declaration collapses.

The write verdict is read, not assumed. The settings scope does not throw when a write is refused — it recovers the host's current state and settles — so [`section.ts`](src/client/section.ts) compares the resolved section with the intended one, which is the same snapshot the page renders: a write that did not land reports a failure, and one that did reports the values the host stored.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the surfaces above are not enough. They move from this package's settings section to the seam that stores it and the rows that read it.

- [Settings subsystem reference](../../../docs/subsystems/settings.md) — namespace registration, the defaults → composition base → user layer resolution, and the browser transport a page writes through.
- [ui-settings](../../client/ui-settings/README.md) — the `settingsScope` service this package binds and the Settings shell it registers into.
- [drama-gate](../../guard/drama-gate/README.md) — the tool-dispatch gate that owns the pipeline's hard rules; when a paid step asks first is the agent's call, not a stored tier.
- [dsh-tool-jubian](../../jubian/tool-jubian/README.md) — the package that owns the `jubianImage` namespace this page lists the payable rows over, and the tool row whose `imageStandardId` config is the fallback pin.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the durable `drama` settings section: this package stores and renders values that a consuming row resolves, and that row owns every model-visible effect of the value it reads.

#### KV Cache effect

No direct invalidation: the section reaches no prompt, tool schema, or session event, so writing it cannot move a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits mark where the package is deliberately incomplete or needs the operator's cooperation. They are current constraints, not a task backlog.

- **The two directories are opaque strings** — the page validates that a delivery-spec box holds a number and validates nothing about a path: no existence check, no normalization, no expand of an environment variable. A path that does not exist on the host is stored as typed.
- **The delivery spec is stored, not applied** — `dsh-tool-episode-render` still renders its own fixed 1440x2560 style; this section is where that contract will be read from, and until then a change here does not move the delivered file.
- **The defaults are the package's** — a deployment that wants different defaults edits the schema; the composition declares no `base` layer for this namespace, so there is exactly one home for each default. The flip side is that an upgrade may change a default a deployment was relying on, which is why the page shows every resolved value.
- **A blank path box means "the default", not "empty"** — clearing one and saving removes the override, and the box then shows the default again. There is no way to store an intentionally empty string in those two fields, which matches what their consumers do with one.
- **The component list is only as good as the inventory it reads** — the status comes from `pluginInventory`, which a deployment may not compose; the page then reports every package as 无法查询 rather than assuming anything. Even with an inventory, a package mounted under a different module specifier than the one listed reads as 清单里没有, and a preset row that is only conditionally enabled reads as 按条件加载, because the Loader owns that decision.
- **The route picker is only as good as the catalogue read** — the rows come from the `jubianImage` namespace, which belongs to `@deepseek-ai/dsh-tool-jubian`; a deployment that composes no Jubian tools reports 暂时列不出通道, and a catalogue the credential cannot read reports the transport's own reason. The stored pin survives all of that: what the page cannot read, it also never clears.
- **The stored row id is not checked against the catalogue at write time** — the schema accepts any positive integer, so a row id typed or written into the document directly is stored even when the account never listed it. It fails loudly at the next paid call, which names every candidate instead of buying from a row nobody selected.
- **The component list names packages, not capabilities** — it says which plugins a production is composed from, not whether a later step will succeed: a loaded `drama_render` does not mean the delivery spec is achievable, and the row's role text is one sentence rather than live configuration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published because this row owns no independent lifecycle stream: it registers one settings namespace and one slot contribution against a slot it does not declare, and the HMR-safety specs prove that disposal removes both.

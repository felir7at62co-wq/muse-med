---
description: "Agent Notes settings section for the dsh web client: browse the markdown notes under the deployment's configured notes directory by category, search them, and edit one note in place."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-agent-notes

English | [中文](README.zh.md)

## Summary

The **Agent notes** Settings page lets you browse the markdown engineering notes under the deployment's configured notes directory and edit one in place, without leaving the Web GUI. Notes are grouped by category and searchable by title, id, or status; opening one shows rendered Markdown, and Edit switches to a raw text editor over the same bytes. Every save presents the version token its read returned, so a note changed elsewhere is refused and reloaded instead of silently overwritten. The page neither creates nor deletes notes, and nothing it renders enters model context.

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

Open Settings and select **Agent notes** to browse the notes tree the Host `agentNotes` namespace serves. Mount `@deepseek-ai/dsh-client-ui-settings-agent-notes` in a Web composition that already provides the Settings shell and that Host namespace; the page registers its own navigation entry and takes no configuration of its own.

### Reading the catalog

The page lists the notes under the configured root, grouped by the category the Host derives from each note id: a note directly in the root appears under the uncategorized label, and each group keeps the Host's own listing order. Every row shows the note title, its trailing file name, and its status when the note declares one; the header names the notes directory and how many notes the listing carried. The search box filters the loaded catalog by title, note id, or status. A notes root that does not exist yet is reported by name rather than as an empty tree, an empty directory and a query that matches nothing report different messages, and a listing the Host capped says so instead of quietly shortening the tree.

### Opening and editing a note

Selecting a row opens the note with its title and id in the header, its optional status tag, and the rendered Markdown. Edit replaces the rendered view with a text area over the note's raw Markdown; Save stays disabled until the draft differs from the text the read returned, and Cancel restores that text. A save sends the complete draft with the version token of the read it is based on, and a successful write reloads the catalog.

### Notes that changed elsewhere

A note that changed since it was read is refused by the Host instead of overwritten: the page says the note changed elsewhere, reloads its newest text, and keeps your draft in the editor so nothing typed is lost. A failed read reports the Host's own diagnostic and falls back to the failure's stable code when the Host sent no message; a failed write leaves the editor open for another attempt.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a browser half with a deliberately empty Host entry: `src/index.ts` exports an `apply` that does nothing, and the row exists so Loader can mount the package whose browser bundle registers the page.

### Registration and data flow

`apply()` registers this package's own `settings.agentNotes` locale namespace inside a `ctx.effect` disposer, binds it, and contributes one `settings.section` entry with id `agent-notes`, order 30, a locale-following nav label, and that namespace as its locale. The contribution goes through `ctx.slots.inject('settings.section', …)`, so a section slot declared late still reaches the page, and unloading the fiber releases the seat and the dictionary together. The plugin also injects `slots`, `locale`, `remote`, and `remote.agentNotes`, so it waits for the generated namespace instead of half-activating. The injected face turns every Remote result into a value — `{ ok: true, … }` or `{ ok: false, code, message }` — so the page renders a Host failure rather than throwing it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host loader entry: an empty `apply` that keeps the row mountable while the browser half owns the page |
| [`src/client/index.ts`](src/client/index.ts) | Browser plugin: the locale namespace, the `settings.section` registration, and the injected `list`/`read`/`save` face |
| [`src/client/AgentNotesSection.tsx`](src/client/AgentNotesSection.tsx) | The page: catalog grouping, search, the rendered and editing views, and save outcomes |
| [`src/client/locales.ts`](src/client/locales.ts) | Chinese and English dictionaries for every visible and accessible string |
| [`src/client/AgentNotesSection.module.css`](src/client/AgentNotesSection.module.css) | Page styles |
| — | No runtime invariant companion is published because this browser-side section owns one localized contribution over an existing Remote namespace and no mutable cross-plugin relation. |

The page holds only view state — the query, the open note, its draft, and the version token it was read with — while the Host owns the notes root, the note id grammar, containment inside that root, and the version fence, so nothing here decides what a note id may name or when a write is allowed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings surface that hosts the page, the Remote namespace behind it, and the browser layers both run in.

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section` and the settings scope service.
- [ui-settings-general](../ui-settings-general/README.md) — the Settings shell whose navigation lists this page and mounts it.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF that mounts `ctx.remote.agentNotes` in the browser.
- [ui-primitives](../ui-primitives/README.md) — the shared controls and the Markdown renderer this page reads notes through.
- [Web client subsystem](../../../docs/subsystems/web-client.md) — the browser layers, Remote communication, and connection recovery.
- [Client package map](../README.md) — adjacent browser packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings section over the `agentNotes` Remote namespace; it renders and edits user-authored notes and registers no tool, prompt section, or session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what this page can do with the notes tree; they are current package constraints.

- **Editing only, never authoring** — Save replaces the text of a note that already exists; the page cannot create, rename, or delete a note, and a note removed between the listing and the open reports a failed read instead.
- **The catalog is a snapshot** — the page reads it when it mounts, after a successful save, and when you select Reload; it does not watch the notes directory, so a note written by an agent or another editor appears only after a reload, and a listing the Host capped shows only its first part.
- **A stale save is refused, not merged** — the write presents the version token of the read it is based on; when the file changed in the meantime the Host refuses it, the page reloads the newest text, and your draft stays in the editor to re-apply by hand.
- **An unsaved draft is not preserved** — returning to the list discards the editor without asking, and the page keeps no per-note draft, so leaving a note is the one silent way to lose typed text.
- **Rendered or raw, never both** — the note view shows either rendered Markdown or the raw text editor, so there is no side-by-side preview and no diff against the text the read returned.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The shipped Web graph mounts this row in the web-app bundle patch, and the notes root belongs to the Host `agentNotes` row there: its default is `<process cwd>/.agents/notes` unless a deployment sets `DSH_AGENT_NOTES_ROOT` or overrides `root` in a later patch layer.

</details>

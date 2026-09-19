---
description: "Agent Notes service for the web GUI: the markdown notes under one configured notes root as a category-ordered catalog of headline facts, one note's complete text with the version a save must present, and version-fenced saves that never create a file."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-agent-notes

English | [中文](README.zh.md)

## Summary

Use this package to browse and edit the markdown engineering notes under one configured root from a web Settings page. It lists the tree as a category-ordered catalog of headline facts, reads one note's complete text with the version token a save must return, and replaces that text only while the token still matches. Note ids are root-relative paths, so a note whose resolved target leaves the root is unreachable, and a save never creates a note. The Host serves all three operations over the `agentNotes` Remote namespace.

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

Mount `@deepseek-ai/dsh-api-agent-notes` in a composition that already provides `ctx.fs`; the service declares `fs`, and the row must supply `root`. The shipped web client composition mounts it as the `agent-notes` row with `root: process.env.DSH_AGENT_NOTES_ROOT ?? process.cwd() + '/.agents/notes'`, which is the repository-local convention, and a deployment whose notes live in another checkout overrides `root` in its own later patch layer. The notes root is deployment state rather than session state, so one row serves every Session and a Settings page that is not scoped to a session can still reach it.

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Directory holding the notes tree; the service stores `join(root)`, so a relative value resolves against the Host process working directory and an omitted field fails the mount instead of quietly reading a tree nobody named |
| `maxNotes` | `2000` | Cap on the notes one listing reports; a larger tree is cut and reported as `truncated` |

The namespace carries exactly three Remote methods, all confined to the configured root and none accepting a filesystem path from the browser:

| Method | Returns | Purpose |
|---|---|---|
| `list()` | `AgentNotesCatalog { state, root, notes, truncated }` | Every note under the root as headline facts, ordered by category and then by title |
| `read(id)` | `AgentNoteText { id, title, status?, text, version, bytes }` | One note's complete text and the version token a following save must present |
| `save(id, text, expectedVersion)` | `AgentNoteWriteResult { id, version, bytes }` | Replace one note's complete text while `expectedVersion` is still its current version |

### The notes catalog

`list` reports only regular `.md` files, and a row's category is the first segment of its own id, so a note sitting directly in the root has no category. The walk descends at most eight directory levels and skips a deeper directory without reporting it. An uncreated root is the normal empty state `state: 'absent'` with no rows, while a root that exists but is not a directory fails the call with `agent-note/not-regular-file`. `maxNotes` stops the walk and sets `truncated`. Title, `status`, and `summary` come from each note's own text, and `modifiedMs` is present only when the Host can observe the file's modification time.

### Note ids and the root boundary

A note is named by its id: the `/`-separated path from the notes root ending in `.md`, such as `implemented/architecture/2026-06-13-capability-seams.md`. Each segment must carry at least one letter or digit and may otherwise hold only letters, digits, `_`, `-`, and `.`; a backslash is refused rather than treated as a separator. An absolute path, a drive letter, a UNC prefix, a `..` segment, a percent-encoded name, a NUL-bearing name, and a non-markdown path therefore never reach the filesystem and fail with `agent-note/bad-id`. The resolved target must then remain inside the canonical root, checked with `ctx.fs.contains`, so a path that escapes through a link is refused with `agent-note/outside-root`. The final entry is inspected with `lstat` before resolution follows it, so a note that is a directory or a link fails as `agent-note/not-regular-file` instead of being read through.

### Saving a note

`save` replaces one note's complete text and never creates one: an id with no note behind it fails with `agent-note/not-found`. The write is fenced by the version the caller read, so an editor left open across somebody else's write fails with `agent-note/stale` and the newer bytes stay intact instead of being silently overwritten. An accepted save reports the note's new version and byte size, which is the token the next save must present. A text that is not a string is the protocol's `gateway/bad-request`.

### Failures

Each refusal is one `RemoteError` code with typed details, declared in [`src/types.ts`](src/types.ts): `agent-note/bad-id`, `agent-note/not-found`, `agent-note/not-regular-file` (with `kind`), `agent-note/outside-root`, and `agent-note/stale`. Callers branch on the code, never on message text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One service owns one configured root: `AgentNotes` extends `TypertRemoteService`, declares `fs`, and publishes the `agentNotes` namespace, and every file operation goes through `ctx.fs`, so a sandboxed or remote backend replaces the local one without changing this package. The single exception is the modification time: the composed filesystem exposes an opaque version and a size but no wall-clock time, so `list` reads one `stat` field over a path the filesystem itself resolved, and a backend whose targets are not visible in the Host's own namespace reports rows without a time.

A row's id is derived from the two resolved targets rather than assembled during the walk, so it always names the file that was listed and the same value round-trips through the id grammar that `read` and `save` validate. The headline facts are pure parsing over untrusted note content: front matter `title`, `status`, and `description`, the `# Agent Note:` heading, a plain `# ` heading, a `Status:` line, and the first body prose line, in that order of precedence, with the file stem as the last resort. A note the parser cannot make sense of still lists, because the package never rewrites note content. The version token is opaque and goes straight back into the filesystem's `replaceIfVersion` write, and the backend's stale-version refusal is recognized by its stable code rather than by class identity, because that class belongs to whichever `dsh-fs` instance the provider loaded.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `AgentNotes`: the `agentNotes` service and Remote namespace, `Config`, the id, containment, and regular-file gates, the bounded catalog walk, `list`, `read`, and `save` |
| [`src/types.ts`](src/types.ts) | Wire types (`AgentNotesCatalog`, `AgentNoteSummary`, `AgentNoteText`, `AgentNoteWriteResult`) and the `RemoteErrorDetailsMap` codes, published as `./types` for Client packages |
| [`src/note-text.ts`](src/note-text.ts) | Pure note-text processing: `noteIdSegments`, `noteStem`, `readHeadline`, and `NoteHeadline` |
| — | No runtime invariant companion is published; every boundary answer is derived at call time from `ctx.fs` and the configured root. |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The browser Agent Notes section (`@deepseek-ai/dsh-client-ui-settings-agent-notes`) is this namespace's consumer; these pages cover the capability it reads through, the transport it answers on, and the note convention its catalog parses.

- [Filesystem capability](../../fs/fs/README.md) — the `ctx.fs` contract this service reads and writes through, including `resolve`, `listDir`, `readText`, `writeText`, `lstat`, and `contains`.
- [Remote assembly](../../api/remotes/README.md) — how a Client package reaches the `agentNotes` namespace.
- [Typert protocol](../../typert/protocol/README.md) — `TypertRemoteService`, the `@Remote` marker, and the typed `RemoteError` details a refusal carries.
- [Settings shell](../../client/ui-settings/README.md) — the surface that renders a Settings section over a Remote namespace.
- [Agent Note convention](../../../.agents/notes/README.md) — the title heading, `Status:` line, and front matter the catalog's headline facts are read from.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package serves a web Settings surface over `ctx.fs`: it registers no tool, contributes no prompt section, and appends no session event, and the notes it stores are user-authored files rather than model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A save edits an existing note only** — the service replaces the complete text of a note that already exists and never creates, renames, or deletes one, so authoring a new note stays with the person or agent who owns the tree.
- **The catalog reads every note to list it** — each row's title, `status`, and `summary` come from the note's own text, so one listing reads every markdown file it reports, up to `maxNotes`.
- **The cap cuts before the sort** — `maxNotes` stops the walk in filesystem enumeration order and the surviving rows are sorted afterwards, so which notes a cut catalog reports depends on the order `listDir` returned rather than on the catalog's own order.
- **Deep directories disappear silently** — the walk skips a directory more than eight levels below the root without setting `truncated`, so a note that deep is absent from a catalog that reports no truncation.
- **`modifiedMs` needs a Host-visible path** — the modification time comes from one `node:fs` stat over the path the filesystem resolved, so a remote or sandboxed backend whose targets are not in the Host's own namespace reports rows without a time.
- **Front matter parsing is intentionally partial** — only simple `key: value` scalars are read, so a note whose `status` or `description` arrives as a nested structure, a block scalar, or a multi-line value lists under its first heading or its file stem instead.
- **`agent-note/root-absent` is declared but never raised** — the published error map declares the code and no operation produces it today, because an uncreated root answers `state: 'absent'` instead; a Client branching on that code takes no branch.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

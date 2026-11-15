# Working Directory

English | [中文](working-directory.zh.md)

A Session's active directory is owned by [`dsh-working-directory`](../../packages/session/working-directory/README.md). The immutable header identifies the original project; `working-directory/change` records the effective directory used by later directory-based operations. The generated [persistence catalog](../persistence-catalog.md) owns the event declaration.

## Directory selection

`ctx.workingDirectory.get(session)` reads the logged value. `ensure(agent)` validates it and restores the original project when the directory disappeared. `set(agent, path)` validates and records a requested change. Sessions without a header directory use the configured runtime fallback; an unavailable fallback produces an error.

Changes are local to one Session. Relative filesystem operations, newly started processes, instruction discovery, skills, and file completion use the active directory. Existing terminals and persistent shells retain their own directories. Sandbox writable roots and project membership remain anchored to the original project.

`guard(agent, expected, signal)` holds an exact logged directory in this process and returns a `WorkingDirectoryGuard` with the selected `directory`, a cancellation `signal` and an idempotent `release()`. A guarded Session cannot select another directory or recover a missing directory. Cancellation, Session changes and owner disposal release the guard. It does not freeze filesystem contents, models or Workspace membership, or coordinate another process; consumers must hold those owners separately.

## Model context

The initial value and subsequent current values reach the model as required user-context snapshots, even when optional runtime context is disabled. Each committed change attempts to queue a notice through the ordinary Agent inbox; cancellation or disposal can discard notices before request admission. The directory event survives, and the next admitted request receives the current value. Directory context never enters the system prompt. [`working_directory`](../../packages/session/tool-working-directory/README.md) exposes one optional `cd` argument.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkingdirectory--workingdirectoryservice"></a>

### `ctx.workingDirectory` — `WorkingDirectoryService`

One owner for each Session's effective directory and its model-visible changes. Agent and service disposal cancel queued operations and await in-flight filesystem work.

```ts cordis-catalog
/**
 * Read the committed directory without filesystem I/O.
 * @param session - Session whose directory is requested.
 * @returns its effective absolute directory.
 */
get(session: Session): string

/**
 * Validate the current directory and restore the original project when it disappeared.
 * @param agent - live or unpublished Agent owning the Session.
 * @param signal - cancellation for filesystem inspection.
 * @returns the existing directory; recovery is committed before fulfillment.
 * A notice failure is warned without reverting the committed state.
 * @throws when the original project is also unavailable.
 */
ensure(agent: Agent, signal?: AbortSignal): Promise<string>

/**
 * Change one Session's directory without changing existing processes or permissions.
 * @param agent - live or unpublished Agent owning the Session.
 * @param path - absolute path or a path relative to its current directory.
 * @param signal - cancellation before the durable change.
 * @returns the canonical absolute directory, committed before fulfillment.
 * A notice failure is warned; the next request still receives the committed directory.
 * @throws when the requested path is not an existing directory.
 */
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>

/**
 * Hold a same-process directory choice until cancellation or release.
 * This guard does not authenticate the Agent, freeze the model, protect workspace membership,
 * lock the filesystem or serialize other processes. Consumers must provide those separately.
 * @param agent - Existing Agent whose effective directory must remain selected.
 * @param expected - Exact effective directory previously selected by the owner.
 * @param signal - Owner lifetime; cancellation rejects a queued acquisition or releases a held guard.
 * @returns The directory and cancellation signal while the guard is held.
 */
guard(agent: Agent, expected: string, signal: AbortSignal): Promise<WorkingDirectoryGuard>
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)
<!-- END GENERATED cordis-surface -->

/**
 * Wire types of the `agentNotes` Remote namespace. Types only: the generated
 * Remote client consumes this module without Host runtime code, and the
 * Settings section reads the same declarations.
 *
 * A note is named by its **note id**: the note's path relative to the notes
 * root, `/`-separated, always ending in `.md` — for example
 * `implemented/architecture/2026-06-13-capability-seams.md`. The id is the only
 * handle the Client ever holds; the Host root path never crosses the wire.
 *
 * @module @deepseek-ai/dsh-api-agent-notes/types
 */

// Import the protocol module so the declaration at the end of this file
// augments its error map rather than defining an unrelated ambient module.
import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * The catalog state of the configured notes root.
 *
 * `absent` is a normal, empty state rather than a failure: a deployment whose
 * notes root has not been created yet renders an empty list, not an error.
 */
export type AgentNotesRootState = 'ready' | 'absent'

/** One note as the catalog lists it: identity and headline facts, never content. */
export interface AgentNoteSummary {
  /** Note id: root-relative `/`-separated path ending in `.md`. */
  readonly id: string
  /**
   * First path segment of {@link id}, or the empty string for a note that sits
   * directly in the notes root. The Settings section groups by this value.
   */
  readonly category: string
  /** Display title resolved from the note's own text; never empty. */
  readonly title: string
  /** Front-matter or `Status:` value when the note carries one, else `undefined`. */
  readonly status?: string
  /** Front-matter `description`, else the note's first body line, when one exists. */
  readonly summary?: string
  /** Last-modification time as Unix epoch milliseconds, when the Host can observe it. */
  readonly modifiedMs?: number
}

/** One complete listing of the notes root. */
export interface AgentNotesCatalog {
  /**
   * Whether the configured root exists and could be read.
   *
   * `absent` is the not-yet-created root, not a failure. A root that exists but
   * is not a directory, or one that cannot be read, fails the call instead.
   */
  readonly state: 'ready' | 'absent'
  /**
   * Absolute path of the configured notes root.
   *
   * The path is reported so an empty or unexpected catalog is diagnosable in
   * the UI: a person who configured the wrong tree needs to see which tree the
   * Host actually read. It is the only path this namespace ever sends, and no
   * note operation accepts a path back.
   */
  readonly root: string
  /** Notes in the Host's stable order: by category, then by title. */
  readonly notes: readonly AgentNoteSummary[]
  /**
   * Whether the configured note cap dropped entries from {@link notes}. A cut
   * catalog is reported rather than silently shortened.
   */
  readonly truncated: boolean
}

/**
 * One complete note, with the version needed to save it back.
 *
 * `version` is the filesystem's opaque freshness token for the bytes returned
 * in {@link text}. It is never parsed or displayed; it is handed straight back
 * to `save` so a save written against stale bytes is refused instead of
 * overwriting somebody else's edit.
 */
export interface AgentNoteText {
  /** Note id, exactly as requested. */
  readonly id: string
  /** Display title resolved from this content. */
  readonly title: string
  /** Front-matter or `Status:` value when the note carries one. */
  readonly status?: string
  /** The note's complete UTF-8 text. */
  readonly text: string
  /** Opaque freshness token of the bytes in {@link text}. */
  readonly version: string
  /** Size of the complete note in bytes. */
  readonly bytes: number
}

/** What one accepted `save` reports back. */
export interface AgentNoteWriteResult {
  /** Note id, exactly as requested. */
  readonly id: string
  /** The note's version after the write; the token a following save must present. */
  readonly version: string
  /** Size of the complete note in bytes after the write. */
  readonly bytes: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The note id is not a root-relative `/`-separated path to one `.md` file. */
    'agent-note/bad-id': { readonly id: string }
    /** The notes root has not been created, so it holds no notes to read. */
    'agent-note/root-absent': {}
    /** No note exists at that id inside the notes root. */
    'agent-note/not-found': { readonly id: string }
    /**
     * The path entry is not a regular file, so it has no note text to read.
     * The notes root itself reports through this code too: a root that is not a
     * directory is a configuration error, and it fails loudly rather than
     * listing nothing.
     */
    'agent-note/not-regular-file': {
      readonly id: string
      readonly kind: 'file' | 'directory' | 'symlink' | 'other'
    }
    /** The resolved path leaves the configured notes root; the operation is refused. */
    'agent-note/outside-root': { readonly id: string }
    /**
     * The bytes changed since the version the caller read; the write is refused
     * rather than overwriting content the caller never saw.
     */
    'agent-note/stale': { readonly id: string }
  }
}

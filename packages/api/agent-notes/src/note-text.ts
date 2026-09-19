/**
 * Note text parsing: the headline facts a catalog row shows, derived from the
 * note's own markdown so an edited note re-lists correctly without a sidecar
 * index.
 *
 * Every function here is pure and total: note text is untrusted input from a
 * file on disk, and a note the parser cannot make sense of still lists (by its
 * file stem) rather than failing the whole catalog. Nothing here touches the
 * filesystem, so it is directly spec-able.
 *
 * The shapes this reads are the ones `.agents/notes/README.md` defines for
 * Agent Notes — a `# Agent Note: <title>` heading and a `Status: <status>`
 * line, optionally preceded by YAML front matter carrying `status` and
 * `description`. A note outside that convention degrades to its first heading
 * or its file name; the package never rewrites note content.
 */

/** The leading `---` fence that opens a front matter block. */
const FRONT_MATTER_FENCE = '---'

/**
 * One admissible path segment of a note id: at least one alphanumeric
 * character, and otherwise letters, digits, `_`, `-`, and `.`.
 *
 * `[A-Za-z0-9]` is required rather than optional so that `.` and `..` — the
 * only escapes a relative path can spell — cannot match a segment at all. That
 * makes traversal unrepresentable here instead of something a later edit could
 * forget to check.
 */
const SEGMENT = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+$/

/** The only extension a note may carry. */
const NOTE_EXTENSION = '.md'

/**
 * Split a note id into its validated path segments.
 *
 * The id grammar is deliberately narrow: `/`-separated segments, each matching
 * {@link SEGMENT}, the last ending in `.md`. A backslash is refused outright
 * rather than treated as a separator, so the id has exactly one spelling and
 * the path built from it cannot differ from the path that was validated —
 * splitting on both would let `a\b.md` and `a/b.md` name one note on Windows
 * while a POSIX host has a file literally named `a\b.md`. Anything outside the
 * grammar — an absolute path, a drive letter, a UNC prefix, a `..` segment, a
 * percent-encoded or NUL-bearing name, a non-markdown file — yields no
 * segments and is refused by the caller.
 *
 * @param id - the caller-supplied note id.
 * @returns the segments, or `undefined` when the id is not admissible.
 */
export function noteIdSegments(id: string): readonly string[] | undefined {
  if (id.length === 0) return undefined
  if (id.includes('\0') || id.includes('\\')) return undefined
  const segments = id.split('/')
  if (segments.some(segment => !SEGMENT.test(segment))) return undefined
  const last = segments.at(-1)
  /* v8 ignore next -- `segments` is nonempty: split always yields at least one entry for a nonempty id. */
  if (last === undefined || !last.toLowerCase().endsWith(NOTE_EXTENSION)) return undefined
  if (last.length === NOTE_EXTENSION.length) return undefined
  return segments
}

/** A leading level-one heading, as `# Title`. */
const H1 = /^#\s+(?<title>\S.*)$/

/** The Agent Note title heading, whose prefix is convention rather than title text. */
const AGENT_NOTE_H1 = /^#\s+Agent Note:\s*(?<title>\S.*)$/

/** The Agent Note body status line, `Status: implemented`. */
const STATUS_LINE = /^Status:\s*(?<status>\S.*)$/

/** A `key: value` front matter entry. */
const FRONT_MATTER_ENTRY = /^(?<key>[A-Za-z][A-Za-z0-9_-]*):\s*(?<value>.*)$/

/** The headline facts one note's text yields. */
export interface NoteHeadline {
  /** Display title, resolved from the note itself; never empty. */
  readonly title: string
  /** Status when the note declares one, else `undefined`. */
  readonly status: string | undefined
  /** Short description when the note declares or opens with one, else `undefined`. */
  readonly summary: string | undefined
}

/** One parsed front matter block: its simple scalar entries and where the body starts. */
interface FrontMatter {
  readonly fields: ReadonlyMap<string, string>
  /** Index of the block's first body line, one past the closing fence. */
  readonly bodyStart: number
}

/**
 * Parse a leading YAML front matter block, if the text opens with one.
 *
 * Only simple `key: value` scalars are read. Nested structures, block scalars,
 * and quoted forms are deliberately not interpreted: this package displays a
 * status and a description, and a parser that guessed at YAML would be a
 * second, silent source of truth for note content it does not own.
 *
 * @param lines - the note split into lines, no terminators.
 * @returns the parsed scalars and the body offset, or `undefined` when no fence opens the text.
 */
function parseFrontMatter(lines: readonly string[]): FrontMatter | undefined {
  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER_FENCE)
  // An unterminated fence is not front matter; the note body starts at line 0.
  if (end < 0) return undefined
  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const match = FRONT_MATTER_ENTRY.exec(line)
    const key = match?.groups?.key
    const value = match?.groups?.value?.trim()
    if (key === undefined || value === undefined || value.length === 0) continue
    fields.set(key.toLowerCase(), unquote(value))
  }
  return { fields, bodyStart: end + 1 }
}

/**
 * Strip one layer of matching single or double quotes from a front matter value.
 * @param value - the trimmed raw value.
 * @returns the value without its surrounding quotes.
 */
function unquote(value: string): string {
  const first = value.at(0)
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1).trim()
  }
  return value
}

/**
 * The first body line that reads as prose: not blank, not a heading, not a
 * list marker, not a fence or anything inside one, not a definition/quote
 * block, and not the status declaration, which is a fact about the note rather
 * than a sentence from it.
 * @param lines - the note split into lines, front matter already removed.
 * @returns the line, or `undefined` when the body holds no prose.
 */
function firstProseLine(lines: readonly string[]): string | undefined {
  let fenced = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced
      continue
    }
    if (fenced || line.length === 0) continue
    if (line.startsWith('#') || line.startsWith('---')) continue
    if (line.startsWith('>') || line.startsWith('|')) continue
    if (/^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) continue
    if (STATUS_LINE.test(line)) continue
    return line
  }
  return undefined
}

/**
 * Resolve the headline facts of one note.
 *
 * Title precedence follows the repository's own convention: the Agent Note
 * heading, then a front matter `title`, then any leading `# ` heading, then the
 * file stem. Status precedence is front matter, then the `Status:` line. The
 * summary is the front matter `description`, else the first body prose line.
 *
 * @param stem - the note's file name without its `.md` extension, used as the last-resort title.
 * @param text - the note's complete text.
 * @returns the resolved headline facts.
 */
export function readHeadline(stem: string, text: string): NoteHeadline {
  // Normalize line endings once: notes are written on several platforms.
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const frontMatter = parseFrontMatter(lines)
  const body = frontMatter === undefined ? lines : lines.slice(frontMatter.bodyStart)

  let agentNoteTitle: string | undefined
  let headingTitle: string | undefined
  let statusLine: string | undefined
  for (const raw of body) {
    const line = raw.trim()
    const agentNote = AGENT_NOTE_H1.exec(line)
    if (agentNote?.groups?.title !== undefined && agentNoteTitle === undefined) {
      agentNoteTitle = agentNote.groups.title.trim()
      continue
    }
    if (headingTitle === undefined) {
      const heading = H1.exec(line)
      if (heading?.groups?.title !== undefined) headingTitle = heading.groups.title.trim()
    }
    if (statusLine === undefined) {
      const status = STATUS_LINE.exec(line)
      if (status?.groups?.status !== undefined) statusLine = status.groups.status.trim()
    }
  }

  const title = agentNoteTitle ?? frontMatter?.fields.get('title') ?? headingTitle ?? stem
  const status = frontMatter?.fields.get('status') ?? statusLine
  const summary = frontMatter?.fields.get('description') ?? firstProseLine(body)
  return {
    title: title.length === 0 ? stem : title,
    status: emptyToUndefined(status),
    summary: emptyToUndefined(summary),
  }
}

/**
 * Collapse an absent or blank parsed value to `undefined`, so the wire carries
 * "no status" rather than an empty string the UI would have to special-case.
 * @param value - the parsed value.
 * @returns the trimmed value, or `undefined` when it is blank.
 */
function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Derive the display stem from a note id's final segment.
 * @param id - the root-relative note id ending in `.md`.
 * @returns the file name without its extension.
 */
export function noteStem(id: string): string {
  const last = id.slice(id.lastIndexOf('/') + 1)
  return last.endsWith('.md') ? last.slice(0, -3) : last
}

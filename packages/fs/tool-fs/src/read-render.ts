/**
 * Pure read presentation: turn provider-decoded text into a bounded, line-numbered window and
 * model-facing envelope. Unicode columns retain a bounded part of a line and identify the exact
 * next unread character without buffering the rest of a newline-free file.
 * @module @deepseek-ai/dsh-tool-fs/read-render
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Default maximum Unicode code points returned per line (`readMaxLineLength`). */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for selected file lines (the `readMaxBytes` config). */
export const READ_MAX_BYTES = 50 * 1024

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** 1-based Unicode code-point column on the first line; defaults to 1. */
  column?: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum Unicode code points returned for one line fragment. */
  maxLineLength: number
  /** Maximum bytes of selected output; overflow stops the scan and marks `truncatedByBytes`. */
  maxBytes: number
}

/** Exact next unread position; columns count Unicode code points, not grapheme clusters. */
export interface ReadPosition {
  offset: number
  column: number
}

/** One line returned from a text file. */
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}

/** The windowed result {@link buildWindow} produces from a file's decoded text. */
export interface WindowResult {
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes: boolean
  /** Present when characters or later lines remain unread. */
  continuation?: ReadPosition
}

/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
export interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Requested first-line Unicode column; defaults to 1. */
  column?: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Exact next unread position, absent only at EOF. */
  continuation?: ReadPosition
  /** Provider version callers can retain for the next read. */
  version?: string
}

/**
 * Build one window from streamed or whole-file chunks, enforcing line and byte caps while still
 * scanning to an exact total line count, and throwing `FS_NOT_FOUND` when the requested offset is
 * past EOF.
 * @param chunks - Chunks of valid decoded Unicode text in file order; boundaries may split surrogate pairs.
 * @param request - the resolved window; the caller has already applied its defaults and caps.
 * @param displayPath - the caller-facing path used in the offset-out-of-range error.
 * @returns Exact line fragments, total line count, and the next unread position when capped.
 * @throws {FsError} When the position is outside the file or the byte budget cannot fit one code point.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const lines: FileTextLine[] = []
  const column = request.column ?? 1
  let totalLines = 0
  let outputBytes = 0
  let truncatedByBytes = false
  let continuation: ReadPosition | undefined
  let lineBuffer = ''
  let lineLength = 0
  let retainedCharacters = 0
  let retainedLine = false
  const lineState = { hasInput: false }
  let carriageReturn = false
  let highSurrogate = ''

  function nextPosition(): ReadPosition {
    return { offset: totalLines + 1, column: 1 }
  }

  function retainLine(): boolean {
    if (retainedLine) return true
    if (continuation || totalLines + 1 < request.offset) return false
    const separatorBytes = lines.length === 0 ? 0 : 1
    if (lines.length >= request.limit || outputBytes + separatorBytes > request.maxBytes) {
      truncatedByBytes = lines.length < request.limit
      continuation = nextPosition()
      return false
    }
    outputBytes += separatorBytes
    retainedLine = true
    return true
  }

  function appendCharacter(character: string): void {
    lineState.hasInput = true
    lineLength += 1
    if (continuation || totalLines + 1 < request.offset || (totalLines + 1 === request.offset && lineLength < column)) return
    if (!retainLine()) return
    const bytes = Buffer.byteLength(character, 'utf8')
    if (retainedCharacters >= request.maxLineLength || outputBytes + bytes > request.maxBytes) {
      truncatedByBytes = retainedCharacters < request.maxLineLength
      if (truncatedByBytes && lines.length === 0 && retainedCharacters === 0) {
        throw new FsError(`readMaxBytes ${request.maxBytes} cannot fit the next Unicode character (${bytes} bytes)`, 'FS_TOO_LARGE')
      }
      if (retainedCharacters === 0) {
        retainedLine = false
        outputBytes -= 1
      }
      continuation = { offset: totalLines + 1, column: lineLength }
      return
    }
    lineBuffer += character
    retainedCharacters += 1
    outputBytes += bytes
  }

  function flushLine(): void {
    if (totalLines + 1 === request.offset && column > lineLength + 1) {
      throw new FsError(`column ${column} is out of range for line ${request.offset} of "${displayPath}"`, 'FS_NOT_FOUND')
    }
    if (retainedLine || retainLine()) lines.push({ number: totalLines + 1, text: lineBuffer })
    totalLines += 1
    lineBuffer = ''
    lineLength = 0
    retainedCharacters = 0
    retainedLine = false
    lineState.hasInput = false
  }

  function consume(character: string): void {
    if (character === '\n') {
      carriageReturn = false
      flushLine()
      return
    }
    if (carriageReturn) appendCharacter('\r')
    carriageReturn = character === '\r'
    if (carriageReturn) lineState.hasInput = true
    else appendCharacter(character)
  }

  for await (const chunk of chunks) {
    const text = highSurrogate + chunk
    const last = text.charCodeAt(text.length - 1)
    const end = last >= 0xD800 && last <= 0xDBFF ? text.length - 1 : text.length
    highSurrogate = text.slice(end)
    for (const character of text.slice(0, end)) consume(character)
  }
  if (lineState.hasInput) flushLine()
  if (request.offset > totalLines && !(totalLines === 0 && request.offset === 1 && column === 1)) {
    throw new FsError(`offset ${request.offset}, column ${column} is out of range for "${displayPath}" (${totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines, totalLines, truncatedByBytes, ...continuation === undefined ? {} : { continuation } }
}

/**
 * Format a read outcome as one OpenCode-style line-numbered text block body.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param outcome - the windowed read to render.
 * @returns the model-facing envelope: numbered lines plus a continuation or end-of-file footer.
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.continuation) {
    const next = outcome.continuation
    const position = `offset=${next.offset}, column=${next.column}`
      + (outcome.version === undefined ? '' : `, expected_version=${JSON.stringify(outcome.version)}`)
    footer = next.column > 1
      ? `(Partial line ${next.offset}. Use ${position} to continue.)`
      : `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use ${position} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/**
 * Derive the persisted `lang` hint from a read path's file extension. The shared
 * table in `@deepseek-ai/dsh-util-code-language` owns the recognized suffixes and
 * the path rules (both separators, a leading dot as the extension separator, and
 * prototype-key safety); `readLangHintForPath` projects the read card's short ids
 * over it, so a suffix whose value a recorded session already holds keeps it
 * byte-identical while every other suffix uses its language's short name.
 * @param path - the model-facing path the read reported.
 * @returns the persisted language hint, or `undefined` when the extension maps to none.
 */
export { readLangHintForPath as langFromPath } from '@deepseek-ai/dsh-util-code-language'

/**
 * The `read` tool's private `tool/result` `meta` payload: the structured
 * line-numbered window a capable UI renders as a code view. Attached opaquely (as
 * `unknown`) on the tool result and persisted with the session log — it must be
 * JSON-serializable (the session validates this at `append`), so `presentResult`
 * reproduces the read card on replay when the raw structured output is no longer
 * on the wire. The producing tool owns and narrows this opaque shape.
 */
export interface FsReadMeta {
  /** The read file's model-facing path. */
  path: string
  /** The 1-based first line the window requested, kept even when `lines` is empty. */
  offset: number
  /** First-line Unicode column; absent in older saved results. */
  column?: number
  /** Observed provider version; absent in older saved results. */
  version?: string
  /** Exact next unread position; absent at EOF and in older saved results. */
  continuation?: ReadPosition
  /** The returned window's lines, each keeping its file line number. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Syntax-highlighting language hint from the extension, or omitted for plain text. */
  lang?: string
}

/**
 * Whether `value` is a valid {@link FileTextLine} (defensive narrowing from
 * opaque `meta`). `number` must be a 1-based integer line number, since a card
 * rendered from a zero, fractional, or non-finite line number would violate the
 * 1-based numbering contract the read window promises.
 */
function isFileTextLine(value: unknown): value is FileTextLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as Record<string, unknown>
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/**
 * Narrow opaque live or replayed result metadata to a structured read window.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic text card instead of throwing during replay. Beyond shape, the
 * semantic contract of a read window is enforced against replayed JSON that is
 * well-typed but out of range: `offset` must be a 1-based integer, `totalLines`
 * must be a non-negative integer, each line number must be a 1-based integer no
 * less than `offset`, the line numbers must strictly increase, and no line number
 * may exceed `totalLines`. Any violation declines to the generic fallback rather
 * than emitting a card that misnumbers or overcounts.
 * @param meta - result metadata.
 * @returns the validated read window, or `undefined` for absent, malformed, or semantically invalid data.
 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang, column, version, continuation } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  if (column !== undefined && (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1)) return undefined
  if (version !== undefined && (typeof version !== 'string' || version.length === 0)) return undefined
  let next: ReadPosition | undefined
  if (continuation !== undefined) {
    if (typeof continuation !== 'object' || continuation === null) return undefined
    const candidate = continuation as Record<string, unknown>
    if (typeof candidate.offset !== 'number' || !Number.isSafeInteger(candidate.offset)
      || candidate.offset < offset || candidate.offset > totalLines
      || typeof candidate.column !== 'number' || !Number.isSafeInteger(candidate.column) || candidate.column < 1) return undefined
    next = { offset: candidate.offset, column: candidate.column }
  }
  let previous = offset - 1
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang },
    ...column === undefined ? {} : { column }, ...version === undefined ? {} : { version },
    ...next === undefined ? {} : { continuation: next } }
}

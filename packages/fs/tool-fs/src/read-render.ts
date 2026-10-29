/**
 * Pure read presentation: turn provider-decoded text into a bounded, line-numbered window and
 * model-facing envelope. Chunk scanning caps the current line, so even one newline-free giant
 * line cannot grow memory without bound.
 * @module @deepseek-ai/dsh-tool-fs/read-render
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Default maximum characters returned for a single line (the `readMaxLineLength` config). */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for selected file lines (the `readMaxBytes` config). */
export const READ_MAX_BYTES = 50 * 1024

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** 1-based Unicode code-point column in the first requested line. */
  column?: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum Unicode code points returned from one line before continuation. */
  maxLineLength: number
  /** Maximum bytes of selected output; overflow stops the scan and marks `truncatedByBytes`. */
  maxBytes: number
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
  /** Cursor for a partially returned line, or a line that did not fit. */
  continuation?: { offset: number; column: number }
}

/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
export interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** First-line code-point column for this response. */
  column?: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes?: true
  /** Cursor for remaining text on a line. */
  continuation?: { offset: number; column: number }
  /** Filesystem metadata before and after the read, when available. */
  versionBefore?: string
  versionAfter?: string
  /** True when the post-read provider version could not be observed. */
  versionUnavailable?: true
}

/**
 * Build a bounded window without buffering whole lines. Columns count Unicode code points.
 * @param chunks - decoded text chunks in file order.
 * @param request - line and character limits for this read.
 * @param displayPath - path used in range errors.
 * @returns numbered lines, total lines, and a continuation for partial lines.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const lines: FileTextLine[] = []
  let totalLines = 0
  let outputBytes = 0
  let truncatedByBytes = false
  let continuation: { offset: number; column: number } | undefined
  let position = 0
  let selected = ''
  let selectedCount = 0
  let pendingCR = false
  let carry = ''
  const lineHasInput = { value: false }
  const initialColumn = request.column ?? 1

  function append(char: string): void {
    position += 1
    lineHasInput.value = true
    const number = totalLines + 1
    if (number < request.offset || lines.length >= request.limit || continuation !== undefined) return
    const start = number === request.offset ? initialColumn : 1
    if (position < start) return
    const size = Buffer.byteLength(char, 'utf8')
    const separator = selectedCount === 0 && lines.length > 0 ? 1 : 0
    if (selectedCount >= request.maxLineLength || outputBytes + separator + size > request.maxBytes) {
      truncatedByBytes = outputBytes + separator + size > request.maxBytes
      if (selectedCount === 0 && lines.length === 0) {
        throw new FsError(`cannot read "${displayPath}": byte cap too small for one character`, 'FS_IO_ERROR')
      }
      continuation = { offset: number, column: position }
      return
    }
    outputBytes += separator + size
    selected += char
    selectedCount += 1
  }

  function finishLine(): void {
    totalLines += 1
    if (totalLines === request.offset && initialColumn > Math.max(position, 1)) {
      throw new FsError(`column ${initialColumn} is out of range for line ${totalLines} of "${displayPath}"`, 'FS_NOT_FOUND')
    }
    if (totalLines >= request.offset && lines.length < request.limit && (continuation === undefined || selectedCount > 0)) {
      if (selectedCount === 0 && lines.length > 0) {
        if (outputBytes + 1 > request.maxBytes) {
          truncatedByBytes = true
          continuation = { offset: totalLines, column: 1 }
        } else {
          outputBytes += 1
          lines.push({ number: totalLines, text: selected })
        }
      } else {
        lines.push({ number: totalLines, text: selected })
      }
    }
    position = 0
    selected = ''
    selectedCount = 0
    lineHasInput.value = false
  }

  function consume(char: string): void {
    if (char === '\n') {
      pendingCR = false
      finishLine()
      return
    }
    if (pendingCR) append('\r')
    pendingCR = char === '\r'
    if (!pendingCR) append(char)
    else lineHasInput.value = true
  }

  for await (const chunk of chunks) {
    let value = carry + chunk
    carry = ''
    const last = value.charCodeAt(value.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      carry = value.slice(-1)
      value = value.slice(0, -1)
    }
    for (const char of value) consume(char)
  }
  if (carry) consume(carry)
  if (lineHasInput.value) finishLine()
  if (request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${totalLines} lines)`, 'FS_NOT_FOUND')
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
  if (outcome.continuation !== undefined) {
    footer = `(Output capped. Continue with offset=${outcome.continuation.offset}, column=${outcome.continuation.column}.)`
  } else if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  if (outcome.versionUnavailable) {
    footer += '\n(File version unavailable after read; consistency is unknown.)'
  } else if (outcome.versionBefore !== undefined && outcome.versionAfter !== undefined
    && (outcome.versionBefore !== outcome.versionAfter || outcome.offset > 1 || (outcome.column ?? 1) > 1
      || outcome.continuation !== undefined || endLine < outcome.totalLines)) {
    footer += `\n(File version before: ${JSON.stringify(outcome.versionBefore)}; after: ${JSON.stringify(outcome.versionAfter)}. Metadata only; compare across pages.)`
    if (outcome.versionBefore !== outcome.versionAfter) footer += '\n(File changed during read; returned text may not represent a single version.)'
  }
  if ((outcome.column ?? 1) > 1) footer += `\n(First line begins at column ${outcome.column}.)`
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
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  let previous = offset - 1
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang } }
}

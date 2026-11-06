/**
 * Model-facing UTF-8 read. It checks the provider version before and after a bounded window,
 * streams large or size-unknown files, and emits an observation only for an unchanged file.
 * @module @deepseek-ai/dsh-tool-fs/src/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta } from './read-render.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000

/**
 * Default streaming threshold (the `readStreamMinSize` config): files at or
 * above this size stream; smaller files read whole into memory.
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Resolved read-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum Unicode code points returned for a single line fragment. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize: number
}

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  column: number
  limit: number
  expectedVersion?: string
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - Schema-validated arguments; positions and limits must be positive safe integers.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns Validated input with line/column defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(args: {
  file_path: string
  offset?: number
  column?: number
  limit?: number
  expected_version?: string
}, maxLimit: number): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const column = args.column === undefined ? 1 : parsePositiveInteger(args.column, 'column')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  if (args.expected_version !== undefined && args.expected_version.length === 0) throw new Error('expected_version must be non-empty')
  return { filePath: args.file_path, offset, column, limit,
    ...args.expected_version === undefined ? {} : { expectedVersion: args.expected_version } }
}

/**
 * Register the `read` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps (plugin config after defaulting).
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : 'Use the read tool — not shell commands like cat — to inspect text files. Continue with the returned offset, column and expected_version until no continuation remains; columns count Unicode code points, not grapheme clusters.',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      column: { type: 'number', description: '1-based Unicode code-point column on the first line. Defaults to 1; use the returned continuation without skipping a partial line.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
      expected_version: { type: 'string', description: 'Provider version from the preceding read; a changed file requires restarting the read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          column: { type: 'integer', required: true },
          version: { type: 'string', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
          continuation: { type: 'object', additionalProperties: false, properties: {
            offset: { type: 'integer', required: true }, column: { type: 'integer', required: true },
          } },
        },
      },
      render: (_args, value) => {
        return [{
          type: 'text',
          text: formatReadOutput(value.path, {
            offset: value.offset,
            lines: value.lines,
            totalLines: value.totalLines,
            column: value.column,
            version: value.version,
            ...value.continuation === undefined ? {} : { continuation: value.continuation },
          }),
        }]
      },
      // Project the structured window into persisted `meta` so a UI's read card
      // survives replay: the raw canonical output object is not on the wire, only
      // the model-facing text, from which the line/lang data cannot be recovered.
      // Provider versions stay in continuation instructions, not display metadata.
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(({ number, text }) => ({ number, text })),
          totalLines: value.totalLines,
          ...value.column === 1 ? {} : { column: value.column },
          ...value.continuation === undefined || value.continuation.column === 1 ? {} : { continuation: value.continuation },
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    // Observation races fail closed because guarded mutations re-check the version in-lock.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      // The final stat must match this version before the read becomes an observation.
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)
      if (input.expectedVersion !== undefined && input.expectedVersion !== info.version) {
        throw new FsError(`cannot continue reading "${target.displayPath}": file version changed; restart from offset=1, column=1`, 'FS_STALE_VERSION')
      }

      // Stream when the file is large OR size is unknown, so a size-less backend
      // never buffers an arbitrarily large file.
      const chunks = info.size === undefined || info.size >= caps.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : [await ctx.fs.readText(target, exec.signal)]
      const window = await buildWindow(
        chunks,
        { offset: input.offset, column: input.column, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
        target.displayPath,
      )
      const after = await ctx.fs.stat(target, exec.signal)
      if (after?.type !== 'file' || after.version !== info.version) {
        throw new FsError(`cannot read "${target.displayPath}": file changed while reading; restart from offset=1, column=1`, 'FS_STALE_VERSION')
      }

      const outcome = {
        path: target.displayPath,
        offset: input.offset,
        column: input.column,
        version: info.version,
        lines: window.lines,
        totalLines: window.totalLines,
        ...window.continuation === undefined ? {} : { continuation: window.continuation },
      }
      // Record the present observation (a no-op when no policy plugin listens). The
      // read already succeeded; an fs/observed listener is contractually a
      // synchronous, side-effect-only recorder.
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // Result-time display: a `read` card carrying the structured line window a
    // capable UI renders as a line-numbered, syntax-highlighted view. The
    // structured data is narrowed from the persisted `meta` (replay-safe); the
    // envelope-stripped model-facing text rides along as `content` so a UI without
    // the read capability still shows the file text. A malformed or absent meta,
    // or a result whose text is not the read envelope, declines to `undefined`
    // (the generic fallback), never throwing on replay of obsolete logged output.
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // Group 1 always captures (possibly empty) when the envelope matches.
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    // Pure display: a generic card titled by the file with the read window appended (`Read
    // foo.txt (5 - 8)`), `read` kind (icon), and a follow-along location whose line is the
    // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
    // the title bare instead of smuggling config into this pure presenter.
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}

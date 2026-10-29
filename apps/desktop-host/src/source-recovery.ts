/** Read-only navigation to text already recorded in the current Session. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from './manuscript-revisions.ts'

/** Cordis plugin identity. */
export const name = 'muse-source-recovery'
/** Existing query and tool services, scoped to the invoking agent. */
export const inject = ['tools', 'sessionQuery']
/** Bounds on index metadata and recovery pages. */
export interface Config {
  /** Maximum source events listed in one notice. */
  maxEntries: number
  /** Maximum UTF-8 bytes in one index notice. */
  maxIndexBytes: number
  /** Maximum requested code points in one recovery page. */
  maxPageChars: number
  /** Maximum code points in a serialized notice or tool result. */
  maxOutputCharacters: number
  /** Maximum retained event bytes per active Session; zero disables caching. */
  maxCacheBytes: number
}
/** Loader configuration for recovery index and page limits. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  maxEntries: Schema.number().step(1).min(1).default(20),
  maxIndexBytes: Schema.number().step(1).min(512).default(8192),
  maxPageChars: Schema.number().step(1).min(1).default(4000),
  maxOutputCharacters: Schema.number().step(1).min(1024).default(7500),
  maxCacheBytes: Schema.number().step(1).min(0).default(2 * 1024 * 1024),
})

const windowSchema = z.object({ path: z.string(), offset: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(), lines: z.array(z.object({ number: z.number().int().positive(), text: z.string() })),
  column: z.number().int().positive().optional(),
  continuation: z.object({ offset: z.number().int().positive(), column: z.number().int().positive() }).optional(),
  versionBefore: z.string().optional(), versionAfter: z.string().optional(), versionUnavailable: z.boolean().optional() })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

type ReadEvent = Extract<SessionEvent, { type: 'tool/result' }>
interface Entry {
  seq: number
  path: string | null
  offset: number | null
  returned_lines: number | null
  total_lines: number | null
  read_file_scope: 'complete' | 'partial' | 'truncated' | 'unknown'
  recorded_text_blocks: { block: number; chars: number; sha256: string }[]
  recorded_result: 'original_logged_event_not_verified_complete'
  file_version: 'not_recorded' | 'provider_metadata_recorded_not_content_hash'
}

function calls(events: readonly SessionEvent[]) {
  const names = new Map<string, string>(), results = new Map<number, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const name = names.get(event.data.message.toolCallId)
      if (name === 'read') results.set(event.seq, name)
      names.delete(event.data.message.toolCallId)
    }
  }
  return { names, results }
}
function readEntry(event: ReadEvent): Entry {
  const meta = windowSchema.safeParse(event.data.meta)
  const result = meta.success ? meta.data : undefined
  const truncated = (result?.lines.some(line => /\.\.\. \(line truncated to \d+ chars\)$/u.test(line.text)) ?? false)
    || (result?.continuation !== undefined && result.continuation.offset <= (result.lines.at(-1)?.number ?? 0))
  const changed = result?.versionUnavailable === true
    || (result?.versionBefore !== undefined && result.versionBefore !== result.versionAfter)
  const scope = result === undefined || changed ? 'unknown' : truncated ? 'truncated'
    : (result.column ?? 1) === 1 && result.continuation === undefined && result.offset === 1 && result.lines.length === result.totalLines
      && result.lines.every((line, i) => line.number === i + 1) ? 'complete' : 'partial'
  return { seq: event.seq, path: result?.path ?? null, offset: result?.offset ?? null,
    returned_lines: result?.lines.length ?? null, total_lines: result?.totalLines ?? null, read_file_scope: scope,
    recorded_text_blocks: event.data.message.content.flatMap((block, i) => block.type === 'text'
      ? [{ block: i, chars: Array.from(block.text).length, sha256: sha(block.text) }] : []),
    recorded_result: 'original_logged_event_not_verified_complete',
    file_version: result?.versionBefore === undefined ? 'not_recorded' : 'provider_metadata_recorded_not_content_hash' }
}

/** Reconstruct read-result navigation from committed replacements, without deciding source relevance.
 * @param events - Current Session's raw events in sequence order.
 * @param config - Bounds on metadata exposed to the model.
 * @returns Index JSON, or undefined when no read result was replaced.
 */
export function recoveryIndex(events: readonly SessionEvent[], config: Config): string | undefined {
  const toolNames = calls(events).results, selected = new Set<number>()
  const bySeq = new Map<number, SessionEvent>(events.map(event => [event.seq, event]))
  const visit = (seq: number, seen: Set<number>) => {
    if (seen.has(seq)) return
    seen.add(seq)
    const event = bySeq.get(seq)
    if (!event) return
    if (event.type === 'tool/result' && event.surfaceOp === 'append' && !event.data.message.isError
      && toolNames.get(event.seq) === 'read') selected.add(event.seq)
    for (const parent of event.sourceEventSeqs ?? []) visit(parent, seen)
  }
  for (const event of events) {
    if ((event.type !== 'tool/result' && event.type !== 'user/message') || event.surfaceOp === 'append') continue
    const previous = bySeq.get(event.seq - 1)
    if (!previous || (previous.type !== 'compaction/prune' && previous.type !== 'compaction/summary')
      || !previous.data.shadowedSeqs.every(seq => event.sourceEventSeqs?.includes(seq))) continue
    for (const seq of previous.data.shadowedSeqs) visit(seq, new Set())
  }
  const entries = [...selected].sort((a, b) => b - a).flatMap((seq) => {
    const event = bySeq.get(seq)
    return event?.type === 'tool/result' ? [readEntry(event)] : []
  })
  if (!entries.length) return undefined
  const retained: Entry[] = []
  const render = (omitted: number) => JSON.stringify({ source_recovery: { entries: retained, omitted,
    instruction: '这些是已裁剪或压缩的历史 read 事件索引，不代表已读原文件全文。使用 source_recover 分页读取原事件文本；文件可能已更改。' } })
  for (const entry of entries) {
    if (retained.length >= config.maxEntries) break
    retained.push(entry)
    const text = render(entries.length - retained.length)
    if (Buffer.byteLength(text) > config.maxIndexBytes || Array.from(text).length > config.maxOutputCharacters) { retained.pop(); break }
  }
  return render(entries.length - retained.length)
}

/** Retrieve a bounded Unicode-code-point page of one recorded read result, not the current file.
 * @param events - Raw events from the invoking Session.
 * @param seq - Original result event number.
 * @param block - Zero-based content-block number.
 * @param offset - Zero-based Unicode-code-point offset.
 * @param limit - Maximum code points in this page.
 * @returns Page and integrity metadata for the original logged result.
 */
export function recoverPage(events: readonly SessionEvent[], seq: number, block: number, offset: number, limit: number) {
  for (const [name, value] of Object.entries({ seq, block, offset, limit })) {
    if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0)) throw new Error(`${name} must be a safe integer in range`)
  }
  return pageFromEvent(events[seq], calls(events).results, seq, block, offset, limit)
}

function pageFromEvent(event: SessionEvent | undefined, toolNames: Map<number, string>,
  seq: number, block: number, offset: number, limit: number) {
  for (const [name, value] of Object.entries({ seq, block, offset, limit })) {
    if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0)) throw new Error(`${name} must be a safe integer in range`)
  }
  if (!event || event.seq !== seq || event.type !== 'tool/result' || event.surfaceOp !== 'append'
    || event.data.message.isError || toolNames.get(event.seq) !== 'read') {
    throw new Error('No successful original read result exists at this sequence in the current Session')
  }
  const part = event.data.message.content[block]
  if (!part || part.type !== 'text') throw new Error('The requested content block is not recorded text')
  const points = Array.from(part.text)
  if (offset > points.length) throw new Error('offset exceeds recorded text length')
  const end = Math.min(offset + limit, points.length)
  return { ...readEntry(event), block, offset, next_offset: end < points.length ? end : null,
    total_chars: points.length, text_sha256: sha(part.text), page_complete: end === points.length,
    text: points.slice(offset, end).join('') }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * Modified and adapted from OpenAI Codex a07c8eb, codex-rs/core/src/tools/context.rs response_text.
 * Reserve the serialized metadata first, shrinking only the text page when its JSON encoding exceeds the output budget.
 * @param page - A page returned by recoverPage.
 * @param maxOutputCharacters - Maximum serialized Unicode code points.
 * @returns Valid JSON with an unchanged source locator and exact continuation offset.
 * @throws when the source locator alone cannot fit.
 */
export function serializeRecoveryPage(page: ReturnType<typeof recoverPage>, maxOutputCharacters: number): string {
  const points = Array.from(page.text)
  const render = (count: number) => {
    const end = page.offset + count
    return JSON.stringify({ ...page, text: points.slice(0, count).join(''),
      next_offset: end < page.total_chars ? end : null, page_complete: end === page.total_chars })
  }
  if (Array.from(render(0)).length > maxOutputCharacters) throw new Error('Recovery source metadata exceeds the output budget')
  let low = 0, high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Array.from(render(middle)).length <= maxOutputCharacters) low = middle
    else high = middle - 1
  }
  if (points.length > 0 && low === 0) throw new Error('Recovery output budget cannot fit any text after source metadata')
  return render(low)
}

/** Register a read-only current-Session recovery tool and bounded replacement notice. */
export function apply(ctx: Context, config: Config): void {
  const dirty = new WeakSet<object>(), indexed = new WeakMap<object, string | null>(), failures = new WeakMap<object, string>()
  const names = new WeakMap<object, Map<string, string>>(), results = new WeakMap<object, Map<number, string>>()
  const caches = new WeakMap<object, { entries: Map<number, { event: SessionEvent; bytes: number }>; bytes: number }>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') names.get(session)?.set(event.data.callId, event.data.name)
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const name = names.get(session)?.get(event.data.message.toolCallId)
      if (name === 'read') results.get(session)?.set(event.seq, name)
      names.get(session)?.delete(event.data.message.toolCallId)
    }
    if ((event.type === 'tool/result' || event.type === 'user/message') && event.surfaceOp !== 'append') dirty.add(session)
  })
  ctx.tools.register(defineTool({
    name: 'source_recover',
    description: 'Page through text of a successful original read result already recorded in this Session. It does not read the current file or restore text omitted by the original read.',
    parameters: { seq: { type: 'integer', required: true, description: 'Original read result event sequence.' },
      block: { type: 'integer', required: true, description: 'Zero-based content block number.' },
      offset: { type: 'integer', required: true, description: 'Zero-based Unicode code point offset.' },
      limit: { type: 'integer', required: true, description: `Maximum code points; at most ${config.maxPageChars}.` } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('source_recover requires a calling agent')
      if (args.limit > config.maxPageChars) throw new Error(`limit exceeds ${config.maxPageChars}`)
      if (!Number.isSafeInteger(args.seq) || args.seq < 0) throw new Error('seq must be a non-negative safe integer')
      const session = exec.agent.session
      const cache = caches.get(session) ?? { entries: new Map<number, { event: SessionEvent; bytes: number }>(), bytes: 0 }
      caches.set(session, cache)
      let entry = cache.entries.get(args.seq)
      if (entry !== undefined) {
        cache.entries.delete(args.seq)
        cache.entries.set(args.seq, entry)
      } else {
        const result = await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: SessionSeq(args.seq) }, exec.signal)
        exec.signal.throwIfAborted()
        const bytes = Buffer.byteLength(JSON.stringify(result.target))
        entry = { event: result.target, bytes }
      }
      const output = serializeRecoveryPage(pageFromEvent(entry.event, results.get(session) ?? new Map<number, string>(),
        args.seq, args.block, args.offset, args.limit), config.maxOutputCharacters)
      if (!cache.entries.has(args.seq) && entry.bytes <= config.maxCacheBytes) {
        while (cache.bytes + entry.bytes > config.maxCacheBytes) {
          const oldest = cache.entries.entries().next().value
          if (oldest === undefined) break
          cache.entries.delete(oldest[0]); cache.bytes -= oldest[1].bytes
        }
        cache.entries.set(args.seq, entry); cache.bytes += entry.bytes
      }
      return output
    },
    presentCall: () => ({ card: 'generic', title: 'Recover recorded source', kind: 'read' }),
  }))
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (!indexed.has(agent.session) || dirty.has(agent.session)) {
      try {
        const snapshot = await ctx.sessionQuery.readSession(agent.session.id)
        signal.throwIfAborted()
        const recorded = calls(snapshot.events)
        names.set(agent.session, recorded.names)
        results.set(agent.session, recorded.results)
        indexed.set(agent.session, recoveryIndex(snapshot.events, config) ?? null)
        dirty.delete(agent.session)
        failures.delete(agent.session)
      } catch (error) {
        signal.throwIfAborted()
        const failure = `历史来源索引不可用：${error instanceof Error ? error.message : String(error)}；未确认历史材料完整。`
        if (failures.get(agent.session) === failure) return decision
        failures.set(agent.session, failure)
        return { ...decision, messages: [...decision.messages, createUserMessage({
          source: { kind: 'muse-manuscript', form: 'notice', summary: '历史来源索引不可用' },
          content: [{ type: 'text', text: failure }],
        })] }
      }
    }
    const index = indexed.get(agent.session)
    if (!index || agent.session.deriveMessages().some(message => message.role === 'user' && message.source.kind === 'muse-manuscript'
      && message.content.some(block => block.type === 'text' && block.text === index))) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'muse-manuscript', form: 'notice', summary: '可恢复的历史来源索引' }, content: [{ type: 'text', text: index }],
    })] }
  })
}

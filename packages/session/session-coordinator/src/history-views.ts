/** Compact, paged views of one Session log for Main: a turn outline, step items and image lookup. */
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Characters kept from a turn's input or reply in the outline. */
const OUTLINE_TEXT_CHARS = 120
/** Characters kept from one step's text. */
const STEP_TEXT_CHARS = 200
/** Characters kept from one tool call's arguments. */
const ARGUMENT_CHARS = 160
/** Context forms that repeat runtime context rather than report work. */
const CONTEXT_FORMS: ReadonlySet<string> = new Set(['snapshot', 'catalog', 'instructions'])
/** Message sources whose text is a turn's task. */
const TASK_SOURCES: ReadonlySet<string> = new Set(['user', 'muse-coordination', 'schedule'])

/** One turn of a Session, as `coordinator_read` view `outline` lists it. */
export interface TurnOutline {
  readonly turn: number
  /** Sequence of the turn's `turn/start`; pass it as `from_seq` to read the turn's steps. */
  readonly startSeq: number
  /** The turn's first human, coordination or schedule input, cut to one line. */
  readonly input: string
  /** Tool calls by name. */
  readonly tools: Readonly<Record<string, number>>
  /** Image blocks that reached the model in the turn. */
  readonly images: number
  /** Failed tool results in the turn. */
  readonly errors: number
  /** Turn end reason, with the error text for a failed turn; `open` while the turn runs. */
  readonly end: string
  /** The turn's last assistant text, cut to one line. */
  readonly reply: string
}

/** One step item, as `coordinator_read` view `steps` lists it. */
export type StepItem =
  | { readonly seq: number; readonly type: 'turn'; readonly turn: number }
  | { readonly seq: number; readonly type: 'input'; readonly source: string; readonly text: string; readonly images: number }
  | { readonly seq: number; readonly type: 'reply'; readonly text: string }
  | { readonly seq: number; readonly type: 'call'; readonly tool: string; readonly arguments: string }
  | { readonly seq: number; readonly type: 'result'; readonly tool: string; readonly error: boolean; readonly text: string; readonly images: number }
  | { readonly seq: number; readonly type: 'turn-end'; readonly reason: string }

/**
 * Cut text to one line.
 * @param text - Any text.
 * @param chars - Maximum characters kept.
 * @returns At most `chars` characters without line breaks.
 */
function cut(text: string, chars: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= chars ? line : `${line.slice(0, chars - 1)}…`
}

/**
 * Join the text blocks of message content.
 * @param content - Message content.
 * @returns The text blocks joined by spaces.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
}

/**
 * List the image blocks sent to the model as images.
 * @param content - Message content.
 * @returns Image blocks without offload placeholders, in content order.
 */
function imagesOf(content: readonly ContentBlock[]): ImageBlock[] {
  return content.flatMap(block => block.type === 'image' && block.offloaded !== true ? [block] : [])
}

/**
 * Describe how a turn ended.
 * @param event - A `turn/end` event.
 * @returns The reason kind, with the error text for a failed turn.
 */
function endOf(event: SessionEvent<'turn/end'>): string {
  const reason = event.data.reason
  return reason.kind === 'error' ? `error: ${cut(reason.error.message, STEP_TEXT_CHARS)}` : reason.kind
}

/**
 * Summarize every turn of a Session log.
 * @param events - Complete Session log in sequence order.
 * @returns One outline per started turn, oldest first.
 */
export function outlineTurns(events: readonly SessionEvent[]): TurnOutline[] {
  type Building = { -readonly [K in Exclude<keyof TurnOutline, 'tools'>]: TurnOutline[K] } & { readonly calls: Map<string, number> }
  const turns: Building[] = []
  let current: Building | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, startSeq: event.seq, input: '', calls: new Map(), images: 0, errors: 0, end: 'open', reply: '' }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    switch (event.type) {
      case 'user/message':
        current.images += imagesOf(event.data.content).length
        if (current.input === '' && TASK_SOURCES.has(event.data.source.kind)) current.input = cut(textOf(event.data.content), OUTLINE_TEXT_CHARS)
        break
      case 'assistant/message': {
        const text = textOf(event.data.message.content)
        if (text.trim() !== '') current.reply = cut(text, OUTLINE_TEXT_CHARS)
        break
      }
      case 'tool/call':
        current.calls.set(event.data.name, (current.calls.get(event.data.name) ?? 0) + 1)
        break
      case 'tool/result':
        current.images += imagesOf(event.data.message.content).length
        if (event.data.message.isError === true) current.errors++
        break
      case 'turn/end':
        current.end = endOf(event)
        break
      default:
        // Other events add nothing to a turn outline.
        break
    }
  }
  return turns.map(({ calls, ...turn }) => ({ ...turn, tools: Object.fromEntries(calls) }))
}

/**
 * List compact step items from a sequence position.
 * @param events - Complete Session log in sequence order.
 * @param fromSeq - Inclusive first sequence to list.
 * @returns Items for task input, replies, tool calls, results and turn boundaries; runtime context is left out.
 */
export function stepItems(events: readonly SessionEvent[], fromSeq: number): StepItem[] {
  const items: StepItem[] = []
  const tools = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') tools.set(event.data.callId, event.data.name)
    if (event.seq < fromSeq) continue
    switch (event.type) {
      case 'turn/start':
        items.push({ seq: event.seq, type: 'turn', turn: event.data.turn })
        break
      case 'user/message': {
        const source = event.data.source
        const form = 'form' in source ? source.form : undefined
        if (form !== undefined && CONTEXT_FORMS.has(form)) break
        items.push({ seq: event.seq, type: 'input', source: source.kind, text: cut(textOf(event.data.content), STEP_TEXT_CHARS),
          images: imagesOf(event.data.content).length })
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.message.content)
        if (text.trim() !== '') items.push({ seq: event.seq, type: 'reply', text: cut(text, STEP_TEXT_CHARS) })
        break
      }
      case 'tool/call':
        items.push({ seq: event.seq, type: 'call', tool: event.data.name, arguments: cut(event.data.arguments, ARGUMENT_CHARS) })
        break
      case 'tool/result': {
        const message = event.data.message
        items.push({ seq: event.seq, type: 'result', tool: tools.get(message.toolCallId) ?? 'unknown', error: message.isError === true,
          text: cut(textOf(message.content), STEP_TEXT_CHARS), images: imagesOf(message.content).length })
        break
      }
      case 'turn/end':
        items.push({ seq: event.seq, type: 'turn-end', reason: endOf(event) })
        break
      default:
        // Request headers, streams, inbox and plugin events are not steps.
        break
    }
  }
  return items
}

/** One search hit within a Session, as `coordinator_read` view `search` lists it. */
export interface SearchHit {
  readonly seq: number
  readonly type: string
  readonly snippet: string
}

/**
 * Find step items whose text contains a query, for deployments without a full-text index.
 * @param events - Complete Session log in sequence order.
 * @param query - Case-insensitive text to find.
 * @param limit - Maximum hits.
 * @returns Hits in sequence order with up to 60 characters of context on each side.
 */
export function scanSteps(events: readonly SessionEvent[], query: string, limit: number): SearchHit[] {
  const needle = query.trim().toLowerCase()
  const hits: SearchHit[] = []
  for (const item of stepItems(events, 0)) {
    const text = item.type === 'call' ? `${item.tool} ${item.arguments}` : item.type === 'result' ? `${item.tool} ${item.text}`
      : item.type === 'input' || item.type === 'reply' ? item.text : ''
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    hits.push({ seq: item.seq, type: item.type, snippet: text.slice(Math.max(0, at - 60), at + needle.length + 60) })
    if (hits.length === limit) break
  }
  return hits
}

/**
 * Find one image a Session's model received.
 * @param events - Complete Session log.
 * @param seq - Sequence of a `user/message` or `tool/result` event.
 * @param index - Zero-based position among that event's images, as `steps` counts them.
 * @returns The image block, or undefined when the event has no such image.
 */
export function imageAt(events: readonly SessionEvent[], seq: number, index: number): ImageBlock | undefined {
  const event = events.find(item => item.seq === seq)
  const content = event?.type === 'user/message' ? event.data.content : event?.type === 'tool/result' ? event.data.message.content : []
  return imagesOf(content)[index]
}

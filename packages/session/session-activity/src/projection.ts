/**
 * The host-only `sessionActivity` unit: a pure fold of one Session's tool calls, failures, image
 * inputs, declared deliverables, owned jobs, token use and turn ends into bounded running totals.
 *
 * @module @deepseek-ai/dsh-session-activity/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tool-present/types'

/** Characters kept from a tool's arguments or a failure text. */
export const ACTIVITY_TEXT_CHARS = 160

/** One tool's calls in this Session. */
export interface ToolTally {
  /** Committed `tool/call` events. */
  readonly calls: number
  /** Results committed with `isError`. */
  readonly errors: number
  /** Sequence of the latest call. */
  readonly lastSeq: number
  /** The latest call's raw arguments, cut to {@link ACTIVITY_TEXT_CHARS}. */
  readonly lastArguments: string
}

/** A dated one-line fact. */
export interface ActivityNote {
  /** Sequence of the event that produced the note. */
  readonly seq: number
  /** Event time, epoch milliseconds. */
  readonly time: number
  /** Bounded text. */
  readonly text: string
}

/** Running totals of one Session. */
export interface SessionActivityState {
  /** Sequence of the latest event that changed this state; -1 before the first. */
  readonly seq: number
  /** Turn opened by the latest `turn/start` still awaiting its `turn/end`; null between turns. */
  readonly openTurn: number | null
  /** Closed turns. */
  readonly turns: number
  /** Per-tool tallies keyed by tool name. */
  readonly tools: Readonly<Record<string, ToolTally>>
  /** Tool names of dispatched calls whose result has not landed, keyed by call id. */
  readonly pendingCalls: Readonly<Record<string, string>>
  /** Image blocks that entered the model through tool results or injected messages. */
  readonly images: number
  /** Failed tool results, failed turns and failed owned jobs. */
  readonly errors: number
  /** The most recent failure. */
  readonly lastError: ActivityNote | null
  /** Declared deliverable paths with the sequence of their latest declaration. */
  readonly files: Readonly<Record<string, number>>
  /** Owned jobs by state. */
  readonly jobs: { readonly running: number; readonly completed: number; readonly failed: number }
  /** Summed provider input tokens. */
  readonly inputTokens: number
  /** Summed provider output tokens. */
  readonly outputTokens: number
  /** Input tokens of the latest request, the size of the context it sent. */
  readonly contextTokens: number
  /** The latest turn end. */
  readonly lastTurnEnd: { readonly seq: number; readonly kind: string; readonly text: string } | null
}

const noteSchema = z.object({ seq: z.number().int(), time: z.number(), text: z.string() }).strict()

const stateSchema: z.ZodType<SessionActivityState> = z.object({
  seq: z.number().int(),
  openTurn: z.number().int().nonnegative().nullable(),
  turns: z.number().int().nonnegative(),
  tools: z.record(z.string(), z.object({
    calls: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    lastSeq: z.number().int(),
    lastArguments: z.string(),
  }).strict()),
  pendingCalls: z.record(z.string(), z.string()),
  images: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  lastError: noteSchema.nullable(),
  files: z.record(z.string(), z.number().int()),
  jobs: z.object({
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  contextTokens: z.number().nonnegative(),
  lastTurnEnd: z.object({ seq: z.number().int(), kind: z.string(), text: z.string() }).strict().nullable(),
}).strict()

/**
 * Cut text to the stored bound on one line.
 * @param text - Any caller or model text.
 * @returns At most {@link ACTIVITY_TEXT_CHARS} characters without line breaks.
 */
export function boundActivityText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= ACTIVITY_TEXT_CHARS ? line : `${line.slice(0, ACTIVITY_TEXT_CHARS - 1)}…`
}

/**
 * Count image blocks sent to the model as images.
 * @param content - Model-facing content blocks.
 * @returns The number of image blocks not replaced by an offload placeholder.
 */
function imageCount(content: readonly ContentBlock[]): number {
  return content.filter(block => block.type === 'image' && block.offloaded !== true).length
}

/**
 * Join the text blocks of failed tool output.
 * @param content - Model-facing content blocks.
 * @returns The joined text.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
}

/**
 * Read an own record entry; provider-minted keys such as `constructor` never resolve to inherited members.
 * @param record - Plain JSON record.
 * @param key - Entry key.
 * @returns The own value, or undefined.
 */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * Initial state for an empty log.
 * @returns Zero totals with no open turn.
 */
export function initialActivity(): SessionActivityState {
  return {
    seq: -1, openTurn: null, turns: 0, tools: {}, pendingCalls: {}, images: 0, errors: 0, lastError: null, files: {},
    jobs: { running: 0, completed: 0, failed: 0 }, inputTokens: 0, outputTokens: 0, contextTokens: 0, lastTurnEnd: null,
  }
}

/** The `sessionActivity` unit registered on `ctx.sessionProjections`. */
export const sessionActivityProjectionDefinition = {
  key: 'sessionActivity',
  stateVersion: 1,
  stateSchema,
  init: initialActivity,
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return { ...state, seq: event.seq, openTurn: event.data.turn }
      case 'turn/end': {
        const reason = event.data.reason
        const text = reason.kind === 'error' ? boundActivityText(reason.error.message) : ''
        const failed = reason.kind === 'error'
        return {
          ...state, seq: event.seq, openTurn: null, turns: state.turns + 1, pendingCalls: {},
          lastTurnEnd: { seq: event.seq, kind: reason.kind, text },
          ...failed ? { errors: state.errors + 1, lastError: { seq: event.seq, time: event.time, text: `turn failed: ${text}` } } : {},
        }
      }
      case 'tool/call': {
        const previous = own(state.tools, event.data.name)
        return {
          ...state, seq: event.seq,
          pendingCalls: { ...state.pendingCalls, [event.data.callId]: event.data.name },
          tools: {
            ...state.tools,
            [event.data.name]: {
              calls: (previous?.calls ?? 0) + 1, errors: previous?.errors ?? 0, lastSeq: event.seq,
              lastArguments: boundActivityText(event.data.arguments),
            },
          },
        }
      }
      case 'tool/result': {
        const message = event.data.message
        const name = own(state.pendingCalls, message.toolCallId)
        const images = imageCount(message.content)
        if (name === undefined && images === 0 && message.isError !== true) return state
        const pendingCalls = Object.fromEntries(Object.entries(state.pendingCalls).filter(([id]) => id !== message.toolCallId))
        const tally = name === undefined ? undefined : own(state.tools, name)
        if (message.isError !== true) return { ...state, seq: event.seq, pendingCalls, images: state.images + images }
        const label = name ?? 'tool'
        return {
          ...state, seq: event.seq, pendingCalls, images: state.images + images, errors: state.errors + 1,
          lastError: { seq: event.seq, time: event.time, text: boundActivityText(`${label}: ${textOf(message.content)}`) },
          ...tally === undefined || name === undefined ? {} : { tools: { ...state.tools, [name]: { ...tally, errors: tally.errors + 1 } } },
        }
      }
      case 'user/message': {
        const images = imageCount(event.data.content)
        return images === 0 ? state : { ...state, seq: event.seq, images: state.images + images }
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage === undefined) return state
        return {
          ...state, seq: event.seq,
          inputTokens: state.inputTokens + usage.inputTokens, outputTokens: state.outputTokens + usage.outputTokens,
          contextTokens: usage.inputTokens,
        }
      }
      case 'deliverables/presented': {
        if (event.data.files.length === 0) return state
        const files = { ...state.files }
        for (const file of event.data.files) files[file.path] = event.seq
        return { ...state, seq: event.seq, files }
      }
      case 'job/registered':
        return { ...state, seq: event.seq, jobs: { ...state.jobs, running: state.jobs.running + 1 } }
      case 'job/settled': {
        const running = Math.max(0, state.jobs.running - 1)
        if (event.data.status !== 'failed') {
          return { ...state, seq: event.seq, jobs: { ...state.jobs, running, completed: state.jobs.completed + 1 } }
        }
        return {
          ...state, seq: event.seq, jobs: { ...state.jobs, running, failed: state.jobs.failed + 1 }, errors: state.errors + 1,
          lastError: { seq: event.seq, time: event.time, text: boundActivityText(`job ${event.data.kind} failed: ${event.data.detail ?? event.data.label}`) },
        }
      }
      default:
        // Other and plugin-declared events carry no activity this unit counts.
        return state
    }
  },
} satisfies ProjectionDefinition<'sessionActivity', SessionActivityState>

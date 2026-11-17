/**
 * The host-only `sessionActivity` unit: a pure fold of one Session's turn boundaries, latest tool
 * call and direct subagent labels, the facts a status line needs beyond the live Agent state.
 *
 * @module @deepseek-ai/dsh-session-activity/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'

/** Characters kept from a tool call's arguments or a turn failure. */
export const ACTIVITY_TEXT_CHARS = 160

/** The latest tool call of a Session. */
export interface LastToolCall {
  /** Tool name. */
  readonly name: string
  /** Event time, epoch milliseconds. */
  readonly time: number
  /** Raw arguments on one line, cut to {@link ACTIVITY_TEXT_CHARS}. */
  readonly arguments: string
}

/** How the latest turn ended. */
export interface LastTurnEnd {
  /** Event time, epoch milliseconds. */
  readonly time: number
  /** Turn end reason kind, such as `completed`, `aborted` or `error`. */
  readonly kind: string
  /** Failure text for `error`, otherwise empty. */
  readonly text: string
}

/** Turn and tool facts of one Session. */
export interface SessionActivityState {
  /** Turn opened by the latest `turn/start` still awaiting its `turn/end`; null between turns. */
  readonly openTurn: number | null
  /** Start time of the open turn, epoch milliseconds; null between turns. */
  readonly turnStartedAt: number | null
  /** The latest tool call; null before the first. */
  readonly lastTool: LastToolCall | null
  /** The latest turn end; null before the first. */
  readonly lastTurnEnd: LastTurnEnd | null
  /** Display labels of this Session's direct subagents, `name: label`, keyed by child Session id. */
  readonly children: Readonly<Record<string, string>>
}

const stateSchema: z.ZodType<SessionActivityState> = z.object({
  openTurn: z.number().int().nonnegative().nullable(),
  turnStartedAt: z.number().nullable(),
  lastTool: z.object({ name: z.string(), time: z.number(), arguments: z.string() }).strict().nullable(),
  lastTurnEnd: z.object({ time: z.number(), kind: z.string(), text: z.string() }).strict().nullable(),
  children: z.record(z.string(), z.string()),
}).strict()

/**
 * Cut text to a bound on one line.
 * @param text - Any caller or model text.
 * @param chars - Maximum characters kept.
 * @returns At most `chars` characters without line breaks.
 */
export function boundActivityText(text: string, chars = ACTIVITY_TEXT_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= chars ? line : `${line.slice(0, chars - 1)}…`
}

/**
 * Initial state for an empty log.
 * @returns No open turn, tool call, turn end or subagent.
 */
export function initialActivity(): SessionActivityState {
  return { openTurn: null, turnStartedAt: null, lastTool: null, lastTurnEnd: null, children: {} }
}

/** The `sessionActivity` unit registered on `ctx.sessionProjections`. */
export const sessionActivityProjectionDefinition = {
  key: 'sessionActivity',
  stateVersion: 3,
  stateSchema,
  init: initialActivity,
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return { ...state, openTurn: event.data.turn, turnStartedAt: event.time }
      case 'turn/end': {
        const reason = event.data.reason
        const text = reason.kind === 'error' ? boundActivityText(reason.error.message) : ''
        return { ...state, openTurn: null, turnStartedAt: null, lastTurnEnd: { time: event.time, kind: reason.kind, text } }
      }
      case 'tool/call':
        return { ...state, lastTool: { name: event.data.name, time: event.time, arguments: boundActivityText(event.data.arguments) } }
      case 'subagent/catalog': {
        const entry = event.data
        const label = [entry.version === 3 ? entry.name : undefined, entry.label]
          .filter(part => part !== undefined && part !== '').join(': ')
        return label === '' ? state : { ...state, children: { ...state.children, [entry.childId]: boundActivityText(label, 80) } }
      }
      default:
        // Other and plugin-declared events change no status fact.
        return state
    }
  },
} satisfies ProjectionDefinition<'sessionActivity', SessionActivityState>

/** Preserve a legacy Feishu session without guessing which chat owns it. */

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Existing editable profile fields used to locate a previous session. */
export interface LegacyFeishuConfig {
  /** Current credential owner; old files from other apps are ignored. */
  readonly appId: string
  /** Scanner identity retained by the credential settings section. */
  readonly registeredBy?: string
  /** Existing profile session binding, when the previous bridge recorded one. */
  readonly activeSessionId?: string
}

/** A previous session verified against the Host's current session inventory. */
export interface LegacyFeishuSession {
  /** Original Session ID, never reminted by migration. */
  readonly sessionId: SessionId
  /** Directory from the matching persisted/live Session header. */
  readonly cwd: string
  /** Durable source holding the previous session reference. */
  readonly source: 'profile' | 'bridge-config'
}

/** Session-map operations exposed by the bundled Feishu provider. */
export interface FeishuSessionMap {
  /** @returns The session already bound to this chat, if any. */
  get(chatId: string): string | undefined
  /** @returns The chat already owning this session, if any. */
  chatFor(sessionId: string): string | undefined
  /** Bind in memory; the following setCwd persists both values. */
  set(chatId: string, sessionId: string): void
  /** Set cwd and synchronously persist the provider's complete map. */
  setCwd(chatId: string, cwd: string): void
}

/** Whether an authorized chat can explicitly continue the previous session. */
export type LegacyFeishuChoice =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'available'; readonly session: LegacyFeishuSession }
  | { readonly kind: 'bound'; readonly session: LegacyFeishuSession; readonly chatId: string }
  | { readonly kind: 'occupied'; readonly sessionId: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyState(home: string): Record<string, unknown> | undefined {
  let source: string
  try {
    source = readFileSync(join(home, 'dsh-bridge', 'config.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error('muse-med: legacy Feishu state could not be read', { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (_error) {
    // JSON parser diagnostics can quote the credential-bearing input.
    throw new Error('muse-med: legacy Feishu state is not valid JSON')
  }
  if (!record(parsed) || !record(parsed['feishu'])) return undefined
  return parsed['feishu']
}

/**
 * Locate a previous session without copying credentials or changing session files.
 * Profile binding wins; legacy state is considered only for the same configured app
 * and, when recorded, scanner. The persisted session header owns its cwd.
 * @param options - Current profile identity, Harness home, and live/persisted headers.
 * @returns The verified candidate, or undefined when no matching header is available.
 * @throws When a present legacy state file cannot be read or parsed safely.
 */
export function resolveLegacyFeishuSession(options: {
  readonly home: string
  readonly config: LegacyFeishuConfig
  readonly headers: readonly Pick<SessionHeader, 'id' | 'cwd'>[]
}): LegacyFeishuSession | undefined {
  const { config, headers } = options
  if (!config.appId) return undefined
  let id = config.activeSessionId
  let source: LegacyFeishuSession['source'] = 'profile'
  if (!id) {
    const stored = legacyState(options.home)
    if (stored === undefined || stored['appId'] !== config.appId) return undefined
    if (typeof stored['registeredBy'] === 'string' && stored['registeredBy'] !== (config.registeredBy ?? '')) return undefined
    id = typeof stored['activeSessionId'] === 'string' ? stored['activeSessionId'] : undefined
    source = 'bridge-config'
  }
  if (!id) return undefined
  const header = headers.find(candidate => candidate.id === id)
  if (header?.cwd === undefined || !isAbsolute(header.cwd)) return undefined
  return { sessionId: header.id, cwd: header.cwd, source }
}

/**
 * Offer explicit recovery only when neither the chat nor the previous session is rebound.
 * @param candidate - Verified previous session.
 * @param map - Current provider mapping, already loaded from its durable file.
 * @param chatId - Real chat ID from an authorized inbound event.
 * @returns Recovery availability without changing the map.
 */
export function legacyFeishuChoice(
  candidate: LegacyFeishuSession | undefined, map: FeishuSessionMap, chatId: string,
): LegacyFeishuChoice {
  if (candidate === undefined) return { kind: 'unavailable' }
  const owner = map.chatFor(candidate.sessionId)
  if (owner !== undefined) return { kind: 'bound', session: candidate, chatId: owner }
  const existing = map.get(chatId)
  if (existing !== undefined) return { kind: 'occupied', sessionId: existing }
  return { kind: 'available', session: candidate }
}

/**
 * Bind an authorized chat after the user explicitly chooses to continue the old session.
 * Rechecks ownership synchronously and never replaces an existing chat/session mapping.
 * @param candidate - Verified previous session shown in the recovery prompt.
 * @param map - Current provider mapping.
 * @param chatId - Authorized chat whose user confirmed recovery.
 * @returns The resulting state; occupied or unavailable mappings remain unchanged.
 */
export function bindLegacyFeishuSession(
  candidate: LegacyFeishuSession | undefined, map: FeishuSessionMap, chatId: string,
): LegacyFeishuChoice {
  const state = legacyFeishuChoice(candidate, map, chatId)
  if (state.kind !== 'available') return state
  map.set(chatId, state.session.sessionId)
  map.setCwd(chatId, state.session.cwd)
  return { kind: 'bound', session: state.session, chatId }
}

/** Explicit recovery preserves session identity without guessing a Feishu chat. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import {
  bindLegacyFeishuSession, legacyFeishuChoice, resolveLegacyFeishuSession,
  type FeishuSessionMap, type LegacyFeishuSession,
} from '../src/feishu-migration.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { home: string; header: { id: SessionId; cwd: string }; state: (value: unknown) => void } {
  const home = mkdtempSync(join(tmpdir(), 'muse feishu migration 中文-'))
  roots.push(home)
  mkdirSync(join(home, 'dsh-bridge'))
  return {
    home, header: { id: 'legacy-session' as SessionId, cwd: join(home, 'original workspace') },
    state: (value) => { writeFileSync(join(home, 'dsh-bridge/config.json'), JSON.stringify(value)) },
  }
}

function mapFixture(): FeishuSessionMap & { readonly bindings: Map<string, string>; readonly cwds: Map<string, string>; writes: number } {
  const bindings = new Map<string, string>()
  const cwds = new Map<string, string>()
  return {
    bindings, cwds, writes: 0,
    get: chat => bindings.get(chat),
    chatFor: session => [...bindings].find(([, id]) => id === session)?.[0],
    set: (chat, session) => { bindings.set(chat, session) },
    setCwd(chat, cwd) { cwds.set(chat, cwd); this.writes++ },
  }
}

it('keeps the configured session and header cwd without reading unrelated legacy credentials', () => {
  const { home, header } = fixture()
  writeFileSync(join(home, 'dsh-bridge/config.json'), 'malformed unused credentials')
  mkdirSync(join(home, 'sessions'))
  const log = join(home, 'sessions/legacy.jsonl')
  const bytes = Buffer.from('existing Session log bytes\n')
  writeFileSync(log, bytes)
  expect(resolveLegacyFeishuSession({ home, config: { appId: 'cli_current', activeSessionId: header.id }, headers: [header] }))
    .toEqual({ sessionId: header.id, cwd: header.cwd, source: 'profile' })
  expect(readFileSync(log)).toEqual(bytes)
  expect(readFileSync(join(home, 'dsh-bridge/config.json'), 'utf8')).toBe('malformed unused credentials')
})

it('reads only same-app legacy session identity and takes its cwd from the actual header', () => {
  const { home, header, state } = fixture()
  state({ feishu: { appId: 'cli_owned', appSecret: 'synthetic-retained-secret', registeredBy: 'ou_owner', activeSessionId: header.id, cwd: '/stale/cwd', allowFrom: ['oc_group', 'ou_owner'] } })
  const original = readFileSync(join(home, 'dsh-bridge/config.json'))
  expect(resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned', registeredBy: 'ou_owner' }, headers: [header] }))
    .toEqual({ sessionId: header.id, cwd: header.cwd, source: 'bridge-config' })
  expect(readFileSync(join(home, 'dsh-bridge/config.json'))).toEqual(original)
})

it('does not infer a chat from a scanner, a unique allowed group or legacy cwd', () => {
  const { home, header, state } = fixture()
  state({ feishu: { appId: 'cli_owned', registeredBy: 'ou_owner', activeSessionId: header.id, cwd: header.cwd, allowFrom: ['oc_only_group'] } })
  const candidate = resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned', registeredBy: 'ou_owner' }, headers: [header] })
  const map = mapFixture()
  expect(legacyFeishuChoice(candidate, map, 'oc_actual_inbound')).toEqual({ kind: 'available', session: candidate })
  expect(map.bindings.size).toBe(0)
  expect(map.writes).toBe(0)
})

it.each([
  ['different app', { appId: 'cli_other', registeredBy: 'ou_owner' }],
  ['different scanner', { appId: 'cli_owned', registeredBy: 'ou_other' }],
  ['forgotten credentials', { appId: '' }],
] as const)('ignores old state for %s', (_name, config) => {
  const { home, header, state } = fixture()
  state({ feishu: { appId: 'cli_owned', registeredBy: 'ou_owner', activeSessionId: header.id } })
  expect(resolveLegacyFeishuSession({ home, config, headers: [header] })).toBeUndefined()
})

it('leaves an explicitly missing configured session unresolved instead of falling back to stale state', () => {
  const { home, header, state } = fixture()
  state({ feishu: { appId: 'cli_owned', activeSessionId: header.id } })
  expect(resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned', activeSessionId: 'missing' }, headers: [header] })).toBeUndefined()
  expect(resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned' }, headers: [] })).toBeUndefined()
  expect(resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned', activeSessionId: header.id }, headers: [{ ...header, cwd: 'relative' }] })).toBeUndefined()
})

it.each([undefined, null, [], {}, { feishu: null }, { feishu: [] }, { feishu: { appId: 'cli_owned', activeSessionId: 42 } }])('accepts absent or unrelated legacy state as no candidate: %j', (value) => {
  const { home, header, state } = fixture()
  if (value !== undefined) state(value)
  expect(resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned' }, headers: [header] })).toBeUndefined()
})

it('reports malformed state without copying credential-bearing parser excerpts', () => {
  const { home } = fixture()
  writeFileSync(join(home, 'dsh-bridge/config.json'), '{"appSecret":"synthetic-sensitive-value" malformed')
  let failure: unknown
  try { resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned' }, headers: [] }) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('legacy Feishu state is not valid JSON')
  expect(String(failure)).not.toContain('synthetic-sensitive-value')
  expect(failure).not.toHaveProperty('cause')
})

it('surfaces unreadable legacy state instead of silently discarding a potential binding', () => {
  const { home } = fixture()
  mkdirSync(join(home, 'dsh-bridge/config.json'))
  expect(() => resolveLegacyFeishuSession({ home, config: { appId: 'cli_owned' }, headers: [] })).toThrow('legacy Feishu state could not be read')
})

it('binds only after explicit recovery and preserves the original ID and working directory', () => {
  const { header } = fixture()
  const candidate: LegacyFeishuSession = { sessionId: header.id, cwd: header.cwd, source: 'profile' }
  const map = mapFixture()
  expect(bindLegacyFeishuSession(candidate, map, 'oc_confirmed')).toEqual({ kind: 'bound', session: candidate, chatId: 'oc_confirmed' })
  expect(map.get('oc_confirmed')).toBe(header.id)
  expect(map.cwds.get('oc_confirmed')).toBe(header.cwd)
  const writes = map.writes
  expect(bindLegacyFeishuSession(candidate, map, 'oc_confirmed')).toEqual({ kind: 'bound', session: candidate, chatId: 'oc_confirmed' })
  expect(map.writes).toBe(writes)
  expect(bindLegacyFeishuSession(candidate, map, 'oc_another')).toEqual({ kind: 'bound', session: candidate, chatId: 'oc_confirmed' })
  expect(map.get('oc_another')).toBeUndefined()
  expect(map.writes).toBe(writes)
})

it('does not replace a current chat binding or create a session when no verified candidate exists', () => {
  const { header } = fixture()
  const candidate: LegacyFeishuSession = { sessionId: header.id, cwd: header.cwd, source: 'bridge-config' }
  const map = mapFixture()
  map.set('oc_existing', 'newer-session')
  expect(bindLegacyFeishuSession(candidate, map, 'oc_existing')).toEqual({ kind: 'occupied', sessionId: 'newer-session' })
  expect(map.get('oc_existing')).toBe('newer-session')
  expect(bindLegacyFeishuSession(undefined, map, 'oc_new')).toEqual({ kind: 'unavailable' })
  expect(map.writes).toBe(0)
})

/** Complete bounded-directory payloads through the ordinary built SDK profile. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-tool-skill'
import { DeepSeekHarness, validatedSessionEvent } from '../src/index.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI = join(ROOT, 'apps/cli/lib/bin.js')
const CASE = join(ROOT, 'snapshots/session/muse-skill-market-bounded-catalog')
const EXPECTED = new URL('./expected/skill-catalog-runtime.json', import.meta.url)
const SESSION = 'sdk-skill-catalog-primary'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function recordedInput(): Promise<string> {
  for (const line of (await readFile(join(CASE, 'session.v4.jsonl'), 'utf8')).trim().split('\n')) {
    const event: unknown = JSON.parse(line)
    if (!record(event) || event.type !== 'agent/inbox/spliced' || !record(event.data)
      || !Array.isArray(event.data.inserted)) continue
    for (const message of event.data.inserted) {
      if (!record(message) || !record(message.source) || message.source.kind !== 'user'
        || !Array.isArray(message.content)) continue
      return message.content.flatMap((block: unknown) => record(block) && block.type === 'text'
        && typeof block.text === 'string' ? [block.text] : []).join('\n')
    }
  }
  throw new Error('The recorded SDK scenario has no direct user input')
}

function hydrate(value: unknown, identities: ReadonlyMap<string, string>, cwd: string): unknown {
  if (typeof value === 'string') {
    let text = value.replace(/\{\{cwd\}\}([\\/][^\n]*)/gu,
      (_match, suffix: string) => join(cwd, ...suffix.split(/[\\/]/u)))
    for (const [token, identity] of identities) text = text.replaceAll(token, identity)
    return text.replaceAll('{{cwd}}', cwd)
  }
  if (Array.isArray(value)) return value.map(item => hydrate(item, identities, cwd))
  return record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item, identities, cwd)])) : value
}

it.skipIf(!existsSync(CLI))('retains full bounded catalog pages, cursor results and durable diagnostics through the sdk profile', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-skill-catalog-'))
  try {
    const home = join(cwd, 'home'), scope = join(home, 'profiles/sdk/node_modules/@deepseek-ai')
    await mkdir(scope, { recursive: true })
    await symlink(join(ROOT, 'packages/test-support/llm-replay'), join(scope, 'dsh-llm-replay'), process.platform === 'win32' ? 'junction' : 'dir')
    const harness = new DeepSeekHarness({
      dshBin: CLI, profile: 'sdk', dshHome: home, cwd, processCwd: cwd,
      patches: [join(CASE, 'cordis.snapshot.yml')], provider: 'deepseek-official', model: 'deepseek-v4-flash',
      env: { ...process.env, DEEPSEEK_API_KEY: '', DSH_TELEMETRY_DISABLED: '1', DSH_EXAMPLE_MODE: 'lib',
        DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: join(CASE, 'session.v4.jsonl') },
    })
    try {
      const result = await harness.run(await recordedInput(), { sessionId: SESSION })
      expect(result.sessionId).toBe(SESSION)
      const notifications = result.notifications.filter(notification => notification.method === 'session.event'
        && notification.params.sessionId === result.sessionId).map(notification => validatedSessionEvent(notification.params.event))
      expect(notifications).toEqual(result.events)
      const catalogs = result.events.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'skill-catalog' ? [event.data] : [])
      expect(catalogs.length).toBeGreaterThan(0)
      for (const catalog of catalogs) {
        expect(catalog.source).toMatchObject({ kind: 'skill-catalog', bounded: true })
        expect(catalog.source).not.toHaveProperty('incomplete')
      }
      const tools = result.events.flatMap(event => event.type === 'tool/result' ? [event.data] : [])
      const calls = result.events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
      for (const [previous, next] of [['call_bounded_page_1', 'call_bounded_page_2'],
        ['call_bounded_page_2', 'call_bounded_page_3']]) {
        const message = tools.find(event => event.message.toolCallId === previous)?.message
        const call = calls.find(event => event.callId === next)
        if (message === undefined || call === undefined) throw new Error('The actual paged calls are missing')
        const page: unknown = JSON.parse(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
        const args: unknown = JSON.parse(call.arguments)
        if (!record(page) || !record(args)) throw new Error('Expected actual directory objects')
        expect(args.cursor).toEqual(page.nextCursor)
        if (!record(page.nextCursor)) throw new Error('The previous page has no continuation')
        expect(page.nextCursor.sessionId).toBe(result.sessionId)
      }
      for (const [callId, code] of [['call_bounded_foreign', 'SKILL_CATALOG_FOREIGN_CURSOR'],
        ['call_bounded_stale', 'SKILL_CATALOG_STALE_CURSOR'], ['call_bounded_invalid', 'SKILL_CATALOG_INVALID_REQUEST']]) {
        const failure = tools.find(event => event.message.toolCallId === callId)
        if (failure === undefined) throw new Error('The actual directory refusal is missing')
        expect(failure.message.isError).toBe(true)
        expect(failure.message.content).toEqual([{ type: 'text', text: `Error: ${code}` }])
        expect(failure.error).toMatchObject({ name: 'SkillCatalogError', code })
      }
      const expected: unknown = JSON.parse(await readFile(EXPECTED, 'utf8'))
      if (!record(expected) || !Array.isArray(expected.catalogMessages) || !Array.isArray(expected.toolResults)) {
        throw new Error('Expected the complete recorded SDK payloads')
      }
      const identities = new Map([['{{session:1}}', result.sessionId]])
      for (const [index, value] of expected.catalogMessages.entries()) {
        const actual = catalogs[index]
        if (!record(value) || typeof value.id !== 'string' || actual === undefined) throw new Error('Missing catalog identity')
        identities.set(value.id, actual.id)
      }
      for (const value of expected.toolResults) {
        if (!record(value) || !record(value.message) || typeof value.message.id !== 'string') throw new Error('Missing tool result identity')
        const message = value.message
        const actual = tools.find(event => event.message.toolCallId === message.toolCallId)
        if (actual === undefined) throw new Error('Missing actual tool result')
        identities.set(value.message.id, actual.message.id)
      }
      const proof: unknown = JSON.parse(await readFile(join(cwd, 'market-catalog-proof.json'), 'utf8'))
      const actual = { finalResponse: result.finalResponse, finishReason: result.finishReason,
        catalogMessages: catalogs, toolResults: tools, proof }
      expect(actual).toEqual(hydrate(expected, identities, await realpath(cwd)))
    } finally { await harness.close() }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

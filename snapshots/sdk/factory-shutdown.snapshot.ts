/** Recorded-session SDK projection for SIGTERM while an in-process child is still active. */
import { existsSync, readFileSync, watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HarnessClient, TransportClosedError, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import {
  assertSessionFixtureVersion, formatSystemPromptSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshot, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  sessionFixtureName, sessionFixtureNames,
} from '@deepseek-ai/dsh-session-snapshot'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

const owner = fileURLToPath(new URL('./factory-shutdown/', import.meta.url))
const bootstrap = fileURLToPath(new URL('./subagent-spawn-in-process/session.1.v3.jsonl', import.meta.url))

/** Wait on the fixture's durable readiness marker; observation never releases the child's abort barrier. */
function readiness(root: string, receiptFile: string): { ready: Promise<Record<string, unknown>>; close(): void } {
  const ready = Promise.withResolvers<Record<string, unknown>>()
  const deadline = setTimeout(() => { ready.reject(new Error('child readiness deadline elapsed')) }, 30_000)
  const observe = (): void => {
    if (!existsSync(receiptFile)) return
    const content = readFileSync(receiptFile, 'utf8')
    const completed = content.lastIndexOf('\n')
    if (completed < 0) return
    const rows = content.slice(0, completed).split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const published = rows.find(row => row['phase'] === 'published')
    if (published !== undefined && rows.some(row => row['phase'] === 'model-ready')) ready.resolve(published)
  }
  const watcher = watch(root, observe)
  observe()
  return { ready: ready.promise, close(): void { clearTimeout(deadline); watcher.close() } }
}

/** Read complete plain JSONL generation files produced by this isolated SDK profile. */
async function logsBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return Promise.all(latestPersistedSessionPaths(entries).map(path => readFile(join(root, path), 'utf8')))
}

/** Parse one persisted generation without weakening validation of the SDK's process boundary. */
function rows(content: string): Record<string, unknown>[] {
  return content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe.skipIf(process.platform === 'win32')('SDK factory shutdown (POSIX SIGTERM)', () => {
  it('joins the active child before releasing inbox projections and closes both durable turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-factory-shutdown-'))
    const receiptFile = join(root, 'receipt.jsonl')
    const readyFile = join(root, 'model.ready')
    const overrideFile = join(root, 'replay.override.json')
    const patch = join(root, 'shutdown.patch.json')
    const sessionRoot = join(root, 'sessions')
    const selected = sessionFixtureNames(await readdir(owner))
    const childFixture = selected[1]
    if (childFixture === undefined && process.env.DSH_SNAPSHOT !== 'refresh') throw new Error('shutdown child fixture is missing')
    const replayFile = childFixture === undefined ? bootstrap : join(owner, childFixture)
    if (childFixture !== undefined) assertSessionFixtureVersion(childFixture, await readFile(replayFile, 'utf8'))
    const script = JSON.parse(await readFile(join(owner, 'replay.override.json'), 'utf8')) as { kind: string; readyFile: string }[]
    await writeFile(overrideFile, JSON.stringify(script.map(entry => ({ ...entry, readyFile }))) + '\n')
    await writeFile(patch, JSON.stringify([
      { id: 'session-persistence-jsonl', config: { root: sessionRoot, compression: 'none' } },
      { insert: [{ id: 'factory-shutdown-fixture', name: join(owner, 'runtime.mjs'), config: {
        replayFile, overrideFile, receiptFile, readyFile,
      } }] },
    ]) + '\n')
    const barrier = readiness(root, receiptFile)
    const client = new HarnessClient({
      profile: 'sdk', patches: [patch], dshHome: join(root, 'home'), processCwd: root,
      env: { ...process.env, DEEPSEEK_API_KEY: '', DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access' },
      initializeTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
    })
    const subscription = client.subscribe()
    const notifications: HarnessNotification[] = []
    const closed = (async () => {
      try {
        for (;;) notifications.push(await subscription.next())
      } catch (error: unknown) {
        if (!(error instanceof TransportClosedError)) throw error
        return error.message
      }
    })()
    try {
      await client.initialize({ cwd: root, provider: 'shutdown-replay', model: 'shutdown' })
      await client.prompt('shutdown-parent', [{ type: 'text', text: 'Exercise active child shutdown.' }])
      const published = await barrier.ready
      expect(existsSync(readyFile)).toBe(true)
      const pid = published['pid']
      if (typeof pid !== 'number') throw new Error('fixture did not publish the owned SDK PID')
      process.kill(pid, 'SIGTERM')
      const diagnostic = await closed
      expect(diagnostic).toContain('exit code: 0')
      expect(diagnostic).not.toMatch(/fatal uncaught exception|projection registration is not active/u)
      expect(diagnostic).toContain('SHUTDOWN_MODEL_ABORTED')
      expect(diagnostic).toContain('SHUTDOWN_LATE_ABORT_DELIVERED')
      await client.close()
      const phases = rows(await readFile(receiptFile, 'utf8'))
      expect(phases.map(row => row['phase'])).toEqual([
        'published', 'model-ready', 'model-aborted', 'late-abort-delivered', 'settled',
      ])
      expect(phases.at(-1)?.['stopReason']).toBe('aborted')
      const persisted = await logsBelow(sessionRoot)
      expect(persisted).toHaveLength(2)
      const durableEvents = new Map(persisted.map(log => {
        const records = rows(log)
        return [records[0]?.['id'], records.slice(1)] as const
      }))
      for (const notification of notifications) {
        if (notification.method === 'session.event') {
          expect(durableEvents.get(notification.params['sessionId'])).toContainEqual(notification.params['event'])
        }
      }
      persisted.sort((left, right) => Number(rows(left)[0]?.['parentSession'] !== undefined)
        - Number(rows(right)[0]?.['parentSession'] !== undefined))
      const snapshots = redactSessionSnapshotIds(persisted).map(log => normalizeSessionSnapshot(
        log, { cwd: root, sessionIds: [] }, { identityMode: 'preserve' },
      ))
      const ends = persisted.map(log => rows(log).findLast(row => row['type'] === 'turn/end')?.['data'])
      expect(ends).toEqual([
        { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
        { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
      ])
      const stableEvents = notifications.filter(notification => notification.method === 'session.event').map(notification => {
        const event = notification.params['event'] as { type: string }
        return event.type
      }).filter(type => !['turn/end', 'step/end', 'assistant/message'].includes(type))
      const projection = JSON.stringify({ exitCode: 0, lateAbortDelivered: true, closedTurns: ends, eventsBeforeClose: stableEvents }, null, 2) + '\n'
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(owner, { recursive: true })
        await writeFile(join(owner, sessionFixtureName(0, SESSION_FORMAT_VERSION)), snapshots[0] ?? '')
        await writeFile(join(owner, sessionFixtureName(1, SESSION_FORMAT_VERSION)), snapshots[1] ?? '')
        await writeFile(join(owner, 'result.expected.json'), projection)
        const child = persisted[1]
        if (child === undefined) throw new Error('child log was not persisted')
        const context = { cwd: root, sessionIds: [] }
        const prompts = normalizedSystemPrompts(child, context)
        const schemas = normalizedToolSchemas(child, context)
        await writeFile(join(owner, 'system-prompt.1.expected.md'), formatSystemPromptSnapshot(prompts[0] ?? '', prompts.slice(1)))
        await writeFile(join(owner, 'tool-schemas.1.expected.json'), JSON.stringify({ initial: schemas[0] ?? [], changes: schemas.slice(1) }, null, 2) + '\n')
      }
      expect(projection).toBe(await readFile(join(owner, 'result.expected.json'), 'utf8'))
      expect(snapshots).toEqual(await Promise.all(sessionFixtureNames(await readdir(owner)).map(file => readFile(join(owner, file), 'utf8'))))
    } finally {
      barrier.close()
      subscription.close()
      await client.close()
      await closed
      await rm(root, { recursive: true, force: true })
    }
  })
})

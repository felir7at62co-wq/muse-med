import { afterEach, describe, expect, it } from 'vitest'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import {
  assertFixtureInventory,
  fixtureUserPrompts,
  launchWebScaffold,
  parseSeedFixture,
  recordedSessionFixturePath,
  selectedSessionFixture,
} from './scaffold.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web separate writer output', () => {
  async function fixture(): Promise<{ root: string; input: string; writer: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-writer-output-'))
    roots.push(root)
    const input = join(root, 'session.v4.jsonl')
    await copyFile(new URL('../../../snapshots/web/live-interactions/session.v4.jsonl', import.meta.url), input)
    await writeFile(join(root, 'snapshot.yml'), 'version: 1\nprofile: web\nwriterOutput: true\n')
    return { root, input, writer: join(root, 'writer.expected.jsonl') }
  }

  async function drive(input: string, mode: 'replay' | 'refresh'): Promise<void> {
    const previous = process.env.DSH_SNAPSHOT
    process.env.DSH_SNAPSHOT = mode
    try {
      const scaffold = await launchWebScaffold({ replayFixture: input })
      const failures: unknown[] = []
      let handle: AgentHandle | undefined
      try {
        handle = await scaffold.ctx.agents.create({
          sessionId: SessionId('web-writer-output'), meta: { cwd: scaffold.workspaceCwd, agentPreset: 'standard' },
          agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          setup: scope => scaffold.ctx.agentPresets.mount(scope, 'standard').then(() => undefined),
        })
        const prompts = fixtureUserPrompts(await readFile(input, 'utf8'))
        expect(prompts).toHaveLength(1)
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompts[0]! }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      } catch (error) { failures.push(error) }
      try { await handle?.dispose() } catch (error) { failures.push(error) }
      try { await scaffold.close() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Web writer output fixture failed')
    } finally {
      if (previous === undefined) delete process.env.DSH_SNAPSHOT
      else process.env.DSH_SNAPSHOT = previous
    }
  }

  it('refreshes only the writer oracle and rejects a changed event during real replay', async () => {
    const f = await fixture()
    const canonical = await readFile(f.input, 'utf8')
    await drive(f.input, 'refresh')
    expect(await readFile(f.input, 'utf8')).toBe(canonical)
    const writer = await readFile(f.writer, 'utf8')
    expect(writer).toContain('Current working directory:')
    await drive(f.input, 'replay')
    await writeFile(f.writer, writer.replace('Current working directory:', 'Incorrect working directory:'))
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('persisted replay') })],
    })
    expect(await readFile(f.input, 'utf8')).toBe(canonical)
  }, 60_000)

  it('rejects a missing writer oracle during real replay without recreating it', async () => {
    const f = await fixture()
    const canonical = await readFile(f.input, 'utf8')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'ENOENT' })] })
    await expect(readFile(f.writer, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.input, 'utf8')).toBe(canonical)
  }, 30_000)

  it('rejects child canonical roles for a Web writer-output owner', async () => {
    const f = await fixture()
    await copyFile(f.input, join(f.root, 'session.1.v4.jsonl'))
    await expect(assertFixtureInventory(f.root, ['session.v4.jsonl', 'session.1.v4.jsonl']))
      .rejects.toThrow('root-only Session owner')
  })

  it('requires the root writer oracle in replay while permitting refresh to harvest it later', async () => {
    const f = await fixture()
    await expect(assertFixtureInventory(f.root, ['session.v4.jsonl'], 'refresh')).resolves.toBeUndefined()
    await expect(assertFixtureInventory(f.root, ['session.v4.jsonl'], 'replay')).rejects.toThrow()
  })

  it('rejects an undeclared writer oracle in an ordinary Web fixture inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-unexpected-writer-'))
    roots.push(root)
    await writeFile(join(root, 'snapshot.yml'), 'version: 1\nprofile: web\n')
    await writeFile(join(root, 'session.v4.jsonl'), '{}\n')
    await writeFile(join(root, 'writer.expected.jsonl'), '{}\n')
    await expect(assertFixtureInventory(root, ['session.v4.jsonl'])).rejects.toThrow()
  })

  it('rejects an extra child writer oracle for a root-only Web owner', async () => {
    const f = await fixture()
    await drive(f.input, 'refresh')
    await writeFile(join(f.root, 'writer.1.expected.jsonl'), '{}\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('unexpected writer oracle') })],
    })
    await expect(assertFixtureInventory(f.root, ['session.v4.jsonl'])).rejects.toThrow()
  }, 30_000)

  it('keeps an ordinary Web owner on its canonical oracle', async () => {
    const f = await fixture()
    await drive(f.input, 'refresh')
    await writeFile(join(f.root, 'snapshot.yml'), 'version: 1\nprofile: web\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('persisted replay') })],
    })
  }, 30_000)

  it('checks current writer prompt and tool pins through real replay', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'snapshot.yml'),
      'version: 1\nprofile: web\nwriterOutput: true\nheader:\n  class: web-default\n  pin: true\n')
    await drive(f.input, 'refresh')
    await drive(f.input, 'replay')
    const promptPath = join(f.root, 'system-prompt.expected.md')
    const prompt = await readFile(promptPath, 'utf8')
    await writeFile(promptPath, 'Unexpected prompt\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('system-prompt pin') })],
    })
    await writeFile(promptPath, prompt)
    await writeFile(join(f.root, 'tool-schemas.expected.json'), '[]\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('tool-schema pin') })],
    })
  }, 60_000)
})

describe('Web seed stream timing', () => {
  it.each([2, 3])('preserves embedded timestamps from format v%i and its current projection', async (version) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/skill-load/session.v${version}.jsonl`, import.meta.url), 'utf8')
    const current = prepareSessionSnapshotFixtureForComparison(fixture)
    const expected = parseSessionLog(current)

    expect(parseSeedFixture(fixture).events).toEqual(expected)
    expect(parseSeedFixture(current).events).toEqual(expected)
  })

  it.each(['session.jsonl', 'session.v1.jsonl'])('reconstructs positive stream intervals from %s', async (filename) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/text-turn/${filename}`, import.meta.url), 'utf8')
    const messages = parseSeedFixture(fixture).events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const stream = messages[0]!.data.stream
    expect(stream.length).toBeGreaterThan(1)

    let previousEnd = -1
    for (const record of stream) {
      const start = 'time' in record ? record.time : record.time0
      expect(start).toBeGreaterThan(previousEnd)
      previousEnd = 'time' in record ? record.time : record.time0 + record.dt.reduce((total, delta) => total + delta, 0)
    }
    expect(previousEnd).toBeGreaterThan(0)
  })
})

describe('Web snapshot generation filenames', () => {
  it('selects the highest parent and child generations without counting retained inputs twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    for (const [name, version] of [
      ['session.jsonl', 0],
      ['session.v2.jsonl', 2],
      ['session.1.jsonl', 0],
      ['session.1.v1.jsonl', 1],
    ] as const) {
      await writeFile(join(root, name), `${JSON.stringify({
        type: 'session', version, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
      })}\n`)
    }

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v2.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.1.jsonl')))
      .resolves.toBe(join(root, 'session.1.v1.jsonl'))
    await expect(selectedSessionFixture(join(root, 'replay.override.json')))
      .resolves.toBe(join(root, 'replay.override.json'))
  })

  it('leaves an absent override-only parent fixture unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)

    await expect(selectedSessionFixture(join(root, 'session.jsonl'), true))
      .resolves.toBe(join(root, 'session.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .rejects.toThrow('missing parent session fixture')
  })

  it('records beside an older generation and preserves the parent or child role', () => {
    const fixtures = join('/', 'fixtures')
    expect(recordedSessionFixturePath(join(fixtures, 'session.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.2.jsonl'), 3))
      .toBe(join(fixtures, 'session.2.v3.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.v1.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(() => recordedSessionFixturePath(join(fixtures, 'notes.jsonl'), 1))
      .toThrow('invalid Session fixture path')
  })

  it('treats retained generations as one exact inventory role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 0, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'session.v1.jsonl'), `${JSON.stringify({
      type: 'session', version: 1, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'ui.expected.md'), 'stable\n')

    await expect(assertFixtureInventory(root, ['session.jsonl', 'ui.expected.md']))
      .resolves.toBeUndefined()
  })
})

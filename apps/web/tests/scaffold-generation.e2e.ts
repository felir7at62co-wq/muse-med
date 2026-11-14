/** Real Web writer replay runs only after the application artifacts are built. */
import { afterEach, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'
import { createWebWriterFixture } from './fixtures/writer-output.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web separate writer output', () => {
  const fixture = () => createWebWriterFixture(roots)

  function failureMessageIncludes(fragment: string): (failure: unknown) => boolean {
    return failure => typeof failure === 'object' && failure !== null && 'message' in failure
      && typeof failure.message === 'string' && failure.message.includes(fragment)
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
      errors: [expect.toSatisfy(failureMessageIncludes('persisted replay'))],
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

  it('rejects an extra child writer oracle for a root-only Web owner', async () => {
    const f = await fixture()
    await drive(f.input, 'refresh')
    await writeFile(join(f.root, 'writer.1.expected.jsonl'), '{}\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.toSatisfy(failureMessageIncludes('unexpected writer oracle'))],
    })
    await expect(assertFixtureInventory(f.root, ['session.v4.jsonl'])).rejects.toThrow()
  }, 30_000)

  it('keeps an ordinary Web owner on its canonical oracle', async () => {
    const f = await fixture()
    await drive(f.input, 'refresh')
    await writeFile(join(f.root, 'snapshot.yml'), 'version: 1\nprofile: web\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.toSatisfy(failureMessageIncludes('persisted replay'))],
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
      errors: [expect.toSatisfy(failureMessageIncludes('system-prompt pin'))],
    })
    await writeFile(promptPath, prompt)
    await writeFile(join(f.root, 'tool-schemas.expected.json'), '[]\n')
    await expect(drive(f.input, 'replay')).rejects.toMatchObject({
      errors: [expect.toSatisfy(failureMessageIncludes('tool-schema pin'))],
    })
  }, 60_000)
})

/** Only the tool execution can prove a restored picture clock and retained original sound. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, vi } from 'vitest'
import { resolveSettings } from '../src/index.ts'
import { registerLocalClipTool } from '../src/local-clip-tool.ts'
import { createSourceClockConformVerifier, type SourceClockConformBinding } from '../src/source-clock-conform-evidence.ts'
import * as Conform from '../src/source-clock-conform.ts'

const projectPath = resolve('project')
const binding: SourceClockConformBinding = { version: 1, project: projectPath, episode: '21',
  original: { path: join(projectPath, 'original.mp4'), sha256: 'a'.repeat(64) },
  processed: { path: join(projectPath, 'processed.mp4'), sha256: 'b'.repeat(64) },
  output: { path: join(projectPath, 'conformed.mp4'), sha256: 'c'.repeat(64) },
  clock: { originalRate: '24/1', processedRate: '27/1', originalFrames: 96, processedFrames: 108,
    mappingSha256: 'd'.repeat(64) },
  audio: { sha256: 'e'.repeat(64), sampleRate: 32000, channels: 2, packetsSha256: 'f'.repeat(64) },
}

it('authenticates the exact native and nested completion in the initiating ordinary Session', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  try {
    const verify = await createSourceClockConformVerifier(ctx)
    const session = ctx.sessions.create(SessionId('conform-native'))
    const nestedSession = ctx.sessions.create(SessionId('conform-nested'))
    const subagent = ctx.sessions.create(SessionId('conform-subagent'), { meta: { origin: 'subagent' } })
    const signal = new AbortController().signal
    const meta = { [TOOL_BODY_META_KEY]: binding }
    const callId = ToolCallId('conform-call')
    const native = (owner: Session, name: string, body = true, error = false) => {
      owner.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
      owner.append('tool/result', { turn: 1, step: 1, meta: body ? meta : binding,
        message: createToolResultMessage({ callId, isError: error, content: [{ type: 'text', text: JSON.stringify(binding) }] }),
      }, { surfaceOp: 'append' })
    }
    const check = (owner: Session, claimed = binding) => { verify(owner, claimed, signal) }
    native(session, 'another_tool')
    native(session, 'drama_conform_clip', false)
    native(session, 'drama_conform_clip', true, true)
    expect(() => { check(session) }).toThrow('SOURCE_CLOCK_SESSION')
    native(session, 'drama_conform_clip')
    expect(() => { check(session) }).not.toThrow()
    expect(() => { check(session, { ...binding, clock: { ...binding.clock, originalFrames: 95 } }) }).toThrow('SOURCE_CLOCK_SESSION')
    expect(() => { check(session, { ...binding, audio: { ...binding.audio, packetsSha256: '1'.repeat(64) } }) }).toThrow('SOURCE_CLOCK_SESSION')
    expect(() => { check(session, { ...binding, processed: { ...binding.processed, sha256: '2'.repeat(64) } }) }).toThrow('SOURCE_CLOCK_SESSION')
    const fork = ctx.sessions.fork(session, undefined, SessionId('conform-fork'))
    expect(() => { check(fork) }).toThrow('SOURCE_CLOCK_SESSION')
    native(subagent, 'drama_conform_clip')
    expect(() => { check(subagent) }).toThrow('SOURCE_CLOCK_SESSION')

    const rootCallId = ToolCallId('conform-program')
    const dispatch = { rootCallId, parentCallId: rootCallId, subCallId: ToolCallId('conform-program:ptc:1'),
      name: 'drama_conform_clip', arguments: {} }
    const complete = { ...dispatch, isError: false, content: [], meta }
    nestedSession.append('tool/ptc-dispatch', complete)
    expect(() => { check(nestedSession) }).toThrow('SOURCE_CLOCK_SESSION')
    nestedSession.append('tool/ptc-dispatch-start', dispatch)
    nestedSession.append('tool/ptc-dispatch', { ...complete, parentCallId: ToolCallId('different-parent') })
    expect(() => { check(nestedSession) }).toThrow('SOURCE_CLOCK_SESSION')
    nestedSession.append('tool/ptc-dispatch', complete)
    expect(() => { check(nestedSession) }).not.toThrow()
  } finally { await ctx.fiber.dispose() }
})

it('uses real file hashes through the registered tool and refuses readonly and out-of-project inputs before media work', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-conform-tool-'))
  const ctx = new Context()
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const produce = vi.spyOn(Conform, 'conformSourceClock').mockImplementation(async (_toolkit, args) => ({
    ...binding, project: args.project, original: args.original, processed: args.processed,
    output: { ...binding.output, path: join(args.project, 'editing', 'conformed.mp4') },
  }))
  try {
    const project = join(work, 'project')
    const original = join(project, 'original.mp4'), processed = join(project, 'processed.mp4')
    const outside = join(work, 'other.mp4')
    await mkdir(project)
    await Promise.all([writeFile(original, 'original bytes'), writeFile(processed, 'processed bytes'), writeFile(outside, 'different bytes')])
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: work })
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('conform-tool'), {}, { cwd: work })
    registerLocalClipTool(ctx, resolveSettings({}))
    const invoke = (picture = 'processed.mp4') => executeModelToolFixture(ctx, { name: 'drama_conform_clip',
      callId: ToolCallId('conform-tool'), arguments: { project: 'project', episode: 21, original: 'original.mp4', processed: picture },
      signal: new AbortController().signal, agent })
    agent.session.append('sandbox/mode', { mode: 'read-only' })
    expect(await invoke()).toMatchObject({ isError: true })
    agent.session.append('sandbox/mode', { mode: 'workspace-write' })
    expect(await invoke(outside)).toMatchObject({ isError: true })
    expect(produce).not.toHaveBeenCalled()
    const actual = await invoke()
    expect(actual.isError, JSON.stringify(actual.content)).toBe(false)
    expect(produce).toHaveBeenCalledOnce()
    expect(produce.mock.calls[0]?.[1]).toEqual({ project, episode: 21,
      original: { path: original, sha256: digest('original bytes') },
      processed: { path: processed, sha256: digest('processed bytes') } })
    expect(actual.meta).toMatchObject({ [TOOL_BODY_META_KEY]: {
      original: { path: original, sha256: digest('original bytes') },
      processed: { path: processed, sha256: digest('processed bytes') },
    } })
  } finally {
    produce.mockRestore()
    await ctx.fiber.dispose()
    await rm(work, { recursive: true, force: true })
  }
})

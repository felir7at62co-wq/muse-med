/** Legacy recovery deployment configuration through the real Loader, tool registry and Session. */
import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as Jubian from '../src/index.ts'
import * as Recovery from '../src/video-recovery.ts'
import * as Media from '../src/video-media-check.ts'

beforeEach(() => {
  vi.spyOn(Recovery, 'runVideoRecovery').mockResolvedValue()
  vi.spyOn(Media, 'checkVideoMedia').mockResolvedValue({ sha256: 'sha256:' + 'a'.repeat(64), video: true, audio: true })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture() {
  const fixture = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'fixture-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const { ctx, home } = fixture
  vi.stubEnv('DSH_HOME', home)
  const projectDir = join(home, 'project')
  const ffmpegPath = join(home, 'decoder')
  const ledgerRoot = join(home, 'ledger')
  await mkdir(join(projectDir, 'video_tasks', 'review'), { recursive: true })
  await writeFile(join(projectDir, 'project_config.json'), JSON.stringify({ jubian_script_id: 4543 }))
  await writeFile(ffmpegPath, 'decoder fixture')
  const config = { ledgerRoot, workspaceSecrets: false, watchPollIntervalMs: 25, watchTimeoutMs: 1000 }
  const recovery = { projectDir, ffmpegPath, keys: ['recorded-video'] }
  const mount = async (overrides: Record<string, unknown> = {}) => {
    const entry = await ctx.loader.create({ name: 'cordis:jubian', config: { ...config, ...overrides } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve(entry).fiber
    if (!fiber) throw new Error('Jubian Loader entry was not created')
    await fiber.await()
    return fiber
  }
  const artifact = async (key = 'recorded-video') => {
    const text = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review', media_checks: [] })
    await writeFile(join(projectDir, 'video_tasks', 'review', createHash('sha256').update(key).digest('hex') + '.json'), text)
    return createHash('sha256').update(text).digest('hex')
  }
  const agent = async (cwd?: string) => {
    if (!ctx.get('agents')) {
      await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(Projections)
      await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    }
    return await ctx.agentLoop.create(SessionId('recovery-' + Math.random().toString(36).slice(2)),
      { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd })
  }
  const call = async (args: Record<string, unknown>, owner?: Awaited<ReturnType<typeof agent>>, signal = new AbortController().signal) =>
    await ctx.tools.execute({ name: 'jubian_video_review', callId: ToolCallId('recovery-review'), arguments: args,
      ...(owner === undefined ? {} : { agent: owner }), signal })
  return { ...fixture, config, recovery, projectDir, ffmpegPath, ledgerRoot, mount, artifact, agent, call }
}

it.each([
  { projectDir: 'relative' }, { ffmpegPath: 'relative' }, { decodeTimeoutMs: 0 },
  { decodeTimeoutMs: 86400001 }, { decodeTimeoutMs: 1.5 }, { keys: [] }, { keys: [' '] }, { keys: 'invalid' }, { keys: [4] },
])('rejects invalid deployment recovery configuration %j before starting a worker', async (invalid) => {
  const f = await fixture()
  await expect(f.mount({ videoRecovery: { ...f.recovery, ...invalid } })).rejects.toThrow('videoRecovery requires')
  expect(Recovery.runVideoRecovery).not.toHaveBeenCalled()
})

it('requires the configured project Session and original key before exposing a review', async () => {
  const f = await fixture()
  await f.mount({ videoRecovery: f.recovery })
  const args = { action: 'read', idempotency_key: 'recorded-video' }
  const missingOwner = await f.call(args)
  expect(missingOwner.isError).toBe(true)
  if (missingOwner.isError) expect(missingOwner.error.message).toContain('configured project session')
  expect(await f.call(args, await f.agent())).toMatchObject({ isError: true })
  expect(await f.call(args, await f.agent(f.home))).toMatchObject({ isError: true })
  expect(await f.call({ ...args, idempotency_key: 'other' }, await f.agent(f.projectDir))).toMatchObject({ isError: true })
  const digest = await f.artifact()
  const result = await f.call(args, await f.agent(f.projectDir))
  expect(result).toMatchObject({ isError: false, value: { digest } })
})

it.each(['missing', 'assistant', 'image-only', 'wrong-digest', 'missing-digest', 'approve', 'reject', 'approve-with-image'] as const)(
  'accepts only the latest exact human decision (%s)', async (decision) => {
    const f = await fixture()
    await f.mount({ videoRecovery: f.recovery })
    const digest = await f.artifact()
    const owner = await f.agent(f.projectDir)
    const action = decision === 'reject' ? 'reject' : 'approve'
    if (decision === 'assistant') {
      owner.session.append('assistant/message', {
        message: createAssistantMessage({ content: [{ type: 'text', text: `${action} recorded-video ${digest}` }],
          source: { provider: 'mock', model: 'mock' } }),
        turn: 1, step: 1, stream: [],
      }, { surfaceOp: 'append' })
    } else if (decision !== 'missing') {
      owner.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
        ...(decision === 'image-only' || decision === 'approve-with-image' ? [{ type: 'image' as const, attachment: {
          attachmentId: AttachmentId('sha256:' + 'a'.repeat(64)), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
        } }] : []),
        ...(decision === 'image-only' ? [] : [{ type: 'text' as const,
          text: `${action} recorded-video ${decision === 'wrong-digest' ? 'wrong' : digest}` }]),
      ] }), { surfaceOp: 'append' })
    }
    const result = await f.call({ action, idempotency_key: 'recorded-video',
      ...(decision === 'missing-digest' ? {} : { digest }) }, owner)
    expect(result).toMatchObject({ isError: !['approve', 'reject', 'approve-with-image'].includes(decision) })
    if (result.isError) expect(result.error.message).toContain('exact decision')
    else expect(result.value).toMatchObject({ decision: { action, digest } })
  },
)

it('discovers only recorded native-video intents when deployment keys are omitted', async () => {
  const f = await fixture()
  const { keys: _keys, ...recovery } = f.recovery
  await f.mount({ videoRecovery: recovery })
  const owner = await f.agent(f.projectDir)
  const args = { action: 'read', idempotency_key: 'recorded-video' }
  expect(await f.call(args, owner)).toMatchObject({ isError: true })
  const ledger = new JubianLedger({ root: f.ledgerRoot })
  await ledger.begin({ idempotencyKey: 'recorded-video', method: 'storyboard_native_submit',
    requestSha256: 'b'.repeat(64), beforeTaskIds: [], videoPreviewPath: join(f.projectDir, 'video_tasks', 'preview.json') })
  const digest = await f.artifact()
  expect(await f.call(args, owner)).toMatchObject({ isError: false, value: { digest } })
})

it('owns the background cancellation, retry diagnostic and configured media checker', async () => {
  const f = await fixture()
  const stopped = Promise.withResolvers<undefined>()
  let observed: AbortSignal | undefined
  vi.mocked(Recovery.runVideoRecovery).mockImplementation(async (client, _ledger, project, keys, interval, signal, onError, inspect) => {
    observed = signal
    expect(project).toBe(f.projectDir)
    expect(keys).toEqual(f.recovery.keys)
    expect(interval).toBe(25)
    expect(client).toBeDefined()
    onError('recorded-video')
    await inspect('https://example.test/clip.mp4', signal)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    stopped.resolve(undefined)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fiber = await f.mount({ videoRecovery: { ...f.recovery, decodeTimeoutMs: 250 } })
  await vi.waitFor(() => { expect(Media.checkVideoMedia).toHaveBeenCalledOnce() })
  expect(Media.checkVideoMedia).toHaveBeenCalledWith('https://example.test/clip.mp4', f.ffmpegPath, 250, observed)
  expect(warn).toHaveBeenCalledWith('Jubian video recovery check failed; retrying')
  await fiber.dispose()
  await stopped.promise
  expect(observed?.aborted).toBe(true)
})

it.each(['fixed-explicit', 'fixed-default', 'dynamic-env', 'dynamic-absent'] as const)(
  'connects recovery Settings to the %s deployment transport', async (mode) => {
    const f = await fixture()
    if (mode === 'dynamic-env') vi.stubEnv('DSH_FFMPEG_PATH', f.ffmpegPath)
    else vi.stubEnv('DSH_FFMPEG_PATH', '')
    const fixed = mode.startsWith('fixed')
    await f.mount({ videoRecoverySettings: true,
      ...(fixed ? { videoRecovery: { ...f.recovery, ...(mode === 'fixed-explicit' ? { decodeTimeoutMs: 250 } : {}) } } : {}) })
    expect(f.ctx.jubianVideoRecovery).toBeDefined()
    if (fixed) {
      expect(await f.ctx.jubianVideoRecovery.status()).toMatchObject({ configurable: false, enabled: true, projectDir: f.projectDir })
    } else if (mode === 'dynamic-env') {
      await f.ctx.jubianVideoRecovery.configure({ enabled: true, projectDir: f.projectDir })
      expect(Recovery.runVideoRecovery).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), await realpath(f.projectDir),
        undefined, 25, expect.any(AbortSignal), expect.any(Function), expect.any(Function))
      expect(await f.ctx.jubianVideoRecovery.status()).toMatchObject({ configurable: true, enabled: true })
    } else expect(await f.ctx.jubianVideoRecovery.status()).toMatchObject({ configurable: true, decoderAvailable: false })
  },
)

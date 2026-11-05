/** Fixed recovery authorization uses the actual Loader, native executor and effective working directory. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Tools, { type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as Recovery from '../src/video-recovery.ts'
import { VideoMediaDrainError } from '../src/video-media-check.ts'
import * as Media from '../src/video-media-check.ts'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture() {
  const f = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'native', name: 'cordis:native' }, { id: 'credentials', name: 'cordis:credentials' },
    { id: 'fs', name: 'cordis:fs' }, { id: 'subprocess', name: 'cordis:subprocess' },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } }, { id: 'directory', name: 'cordis:directory' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, native: NativeExecutor, credentials: MemoryCredentials,
    fs: FileSystem, subprocess: Subprocess, llm: Llm, sessions: Sessions, projections: Projections,
    agents: AgentRegistry, loop: AgentLoop, directory: WorkingDirectory, jubian: Jubian } })
  vi.stubEnv('DSH_HOME', f.home)
  const project = join(f.home, 'project'), key = 'original-key', ledgerRoot = join(f.home, 'ledger')
  await mkdir(join(project, 'video_tasks', 'review'), { recursive: true })
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}')
  const preview = join(project, 'video_tasks', 'preview.json')
  await writeFile(preview, '{}')
  const ledger = new JubianLedger({ root: ledgerRoot })
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'original',
    scriptId: 1, beforeTaskIds: [], videoPreviewPath: preview })
  const report = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review', media_checks: [] })
  await writeFile(join(project, 'video_tasks', 'review', hash(key) + '.json'), report)
  const config = { ledgerRoot, workspaceSecrets: false, videoRecovery: {
    projectDir: project, ffmpegPath: process.execPath, keys: [key] }, watchPollIntervalMs: 10 }
  const mount = async (overrides: object = {}) => {
    const entry = await f.ctx.loader.create({ name: 'cordis:jubian', config: { ...config, ...overrides } })
    const fiber = f.ctx.loader.resolve(entry).fiber
    if (!fiber) throw new Error('Loader omitted the Jubian fiber')
    await fiber.await()
    return fiber
  }
  const call = (args: object, agent?: Awaited<ReturnType<typeof f.ctx.agentLoop.create>>, signal = new AbortController().signal) =>
    executeModelToolFixture(f.ctx, { name: 'jubian_video_review', callId: ToolCallId('recovery-review'),
      arguments: args, ...(agent === undefined ? {} : { agent }), signal })
  return { ...f, project, key, ledger, digest: hash(report), config, mount, call }
}

it('uses current directory instead of the original header and requires the latest actual user command', async () => {
  const f = await fixture()
  const fiber = await f.mount()
  const outside = await f.ctx.agentLoop.create(SessionId('moved-into-project'), { provider: 'mock', model: 'mock' }, { cwd: f.home })
  await f.ctx.workingDirectory.set(outside, f.project)
  expect(outside.session.header.cwd).toBe(f.home)
  const args = { action: 'read', idempotency_key: f.key }
  expect(await f.call(args, outside)).toMatchObject({ isError: false, value: { digest: f.digest } })
  expect(await f.call(args)).toMatchObject({ isError: true })
  expect(await f.call({ ...args, idempotency_key: 'another-key' }, outside)).toMatchObject({ isError: true })
  const moved = await f.ctx.agentLoop.create(SessionId('moved-out-of-project'), { provider: 'mock', model: 'mock' }, { cwd: f.project })
  await f.ctx.workingDirectory.set(moved, f.home)
  expect(await f.call(args, moved)).toMatchObject({ isError: true })
  const decision = { action: 'approve', idempotency_key: f.key, digest: f.digest }
  outside.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Only read the report' }] }), { surfaceOp: 'append' })
  outside.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
    content: [{ type: 'text', text: `approve ${f.key} ${f.digest}` }] }), { surfaceOp: 'append' })
  expect(await f.call(decision, outside)).toMatchObject({ isError: true })
  outside.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `approve ${f.key} ${f.digest}` }] }), { surfaceOp: 'append' })
  expect(await f.call(decision, outside)).toMatchObject({ isError: false, value: { decision: { action: 'approve' } } })
  expect(f.ctx.get('jubianVideoRecovery')).toBeUndefined()
  const files = await f.ledger.files()
  expect(files).toHaveLength(1)
  expect(await f.ledger.records()).toHaveLength(1)
  await fiber.dispose()
  expect(f.ctx.tools.get('jubian_video_review')).toBeUndefined()
  expect(await readFile(files[0]!, 'utf8')).not.toContain('settle')
})

it('fails conflicting modes at load before exposing tools or starting a worker', async () => {
  const f = await fixture()
  await expect(f.mount({ videoRecoverySettings: true })).rejects.toThrow('mutually exclusive')
  expect(f.ctx.tools.get('jubian_video_review')).toBeUndefined()
  expect(f.ctx.get('jubianVideoRecovery')).toBeUndefined()
  expect(await f.ledger.records()).toHaveLength(1)
})

it.each(['relative', '', null, 8])('rejects a present invalid Settings decoder override at load: %j', async (value) => {
  const f = await fixture()
  await expect(f.mount({ videoRecovery: undefined, videoRecoverySettings: true, videoRecoveryFfmpegPath: value }))
    .rejects.toThrow('absolute Host decoder')
  expect(f.ctx.get('jubianVideoRecovery')).toBeUndefined()
})

it('loads Settings with a validated decoder override and independent deadline, without a fixed review tool', async () => {
  const f = await fixture()
  const fiber = await f.mount({ videoRecovery: undefined, videoRecoverySettings: true,
    videoRecoveryFfmpegPath: await realpath(process.execPath), videoRecoveryDecodeTimeoutMs: 500,
    videoRecoveryDecodeGraceMs: 50, videoRecoveryDecodeMaxOutputBytes: 4096 })
  expect(f.ctx.tools.get('jubian_video_review')).toBeUndefined()
  expect(await f.ctx.jubianVideoRecovery.status()).toMatchObject({ enabled: false, decoderAvailable: true })
  await fiber.dispose()
  expect(f.ctx.get('jubianVideoRecovery')).toBeUndefined()
})


it.each([
  { videoRecoverySettings: 'yes' },
  { videoRecoveryFfmpegPath: process.execPath },
  { videoRecoveryDecodeTimeoutMs: 100, videoRecovery: { decodeTimeoutMs: 200 } },
])('rejects conflicting or malformed recovery deployment config %j', async (overrides) => {
  const f = await fixture()
  await expect(f.mount(overrides)).rejects.toThrow()
  expect(f.ctx.tools.get('jubian_video_review')).toBeUndefined()
})

it('does not invoke a retained fixed tool after its owner has unloaded', async () => {
  const f = await fixture(), fiber = await f.mount()
  const definition = f.ctx.tools.get('jubian_video_review')
  if (definition === undefined) throw new Error('Fixed review tool is missing')
  await fiber.dispose()
  const callId = ToolCallId('retained-fixed-review')
  const args = { action: 'read', idempotency_key: f.key }
  await expect(definition.execute(args, { arguments: args, callId, rootCallId: callId,
    token: Symbol('retained') as ToolExecutionToken, name: definition.name, signal: new AbortController().signal,
    deferContext() {}, concludeTurn() {} })).rejects.toThrow('shutting down')
})

it.each([new Error('worker stopped'), 'worker stopped'] as const)('reports a fixed worker failure and retains its original intent', async (failure) => {
  const f = await fixture(), reported = Promise.withResolvers<undefined>()
  vi.spyOn(Recovery, 'runVideoRecovery').mockRejectedValueOnce(failure)
  f.ctx.logger.exporter({ export(message) {
    if (message.type === 'warn' && message.args.includes('worker stopped')) reported.resolve(undefined)
  } })
  await f.mount()
  await reported.promise
  expect(await f.ledger.records()).toHaveLength(1)
})

it('reports fixed read errors and preserves an unconfirmed native range on unload', async () => {
  const f = await fixture(), errors: unknown[][] = []
  f.ctx.logger.exporter({ export(message) { if (message.type === 'error') errors.push(message.args) } })
  vi.spyOn(Media, 'checkVideoMedia').mockResolvedValueOnce({ sha256: 'sha256:' + hash('fixture'), video: true, audio: true })
  vi.spyOn(Recovery, 'runVideoRecovery').mockImplementationOnce(async (_client, _ledger, _project, _keys, _interval, signal, onError, inspect) => {
    onError(f.key)
    expect(await inspect('https://example.test/fixture.mp4', signal)).toMatchObject({ video: true, audio: true })
    await new Promise<void>((resolve) =>{  signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    throw new VideoMediaDrainError('fixed native range unconfirmed')
  })
  const fiber = await f.mount()
  expect(f.ctx.logger.buffer.some(message => message.type === 'warn' && String(message.args[0]).includes('read failed'))).toBe(true)
  await fiber.dispose()
  expect(errors.flat()).toContainEqual(expect.objectContaining({ message: 'fixed native range unconfirmed' }))
})


it('fails a fixed deployment project before registering the review tool and drains initialization', async () => {
  const f = await fixture()
  await expect(f.mount({ videoRecovery: { ...f.config.videoRecovery, projectDir: join(f.home, 'missing-project') } })).rejects.toThrow()
  expect(f.ctx.tools.get('jubian_video_review')).toBeUndefined()
})

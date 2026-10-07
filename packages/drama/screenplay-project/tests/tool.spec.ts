/** Registered project commands use initiating sessions, standing policies, and canonical logged output. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { PROJECT_FILE } from '../src/schema.ts'

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-tool-'))
  const ctx = new Context()
  fixtures.push({ ctx, root })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('screenplay-writer'), {}, { cwd: root })
  const register = vi.spyOn(ctx.tools, 'register')
  apply(ctx, Config({}))
  const tool = register.mock.calls[0]![0]
  let ordinal = 0
  const call = (request: Record<string, unknown>, initiated = true) => ctx.tools.execute({
    name: 'screenplay_project', callId: ToolCallId(`screenplay-${++ordinal}`), arguments: { request },
    signal: new AbortController().signal, ...(initiated ? { agent } : {}),
  })
  return { ctx, root, agent, driver, tool, call }
}

it('validates configurable allocation budgets and rejects nonpositive or fractional values', () => {
  expect(name).toBe('screenplay-project')
  expect(inject).toEqual(['fs', 'tools', 'attachments', 'llm'])
  expect(Config({})).toEqual({
    maxSourceBytes: 16 * 1024 * 1024, maxProjectBytes: 32 * 1024 * 1024, maxReadUnits: 100, maxReadBytes: 64 * 1024, maxFactBatch: 20,
  })
  for (const field of ['maxSourceBytes', 'maxProjectBytes', 'maxReadUnits', 'maxReadBytes', 'maxFactBatch']) {
    for (const value of [0, -1, 1.5]) expect(() => Config({ [field]: value })).toThrow()
  }
})

it('publishes from a real initiating session and renders exactly the canonical result', async () => {
  const { call, root, tool } = await fixture()
  const result = await call({ method: 'init', project: 'project.json', mode: 'faithful', instructions: '保留原文。' })
  expect(result.isError).toBe(false)
  if (result.value === undefined) throw Error('Successful project init omitted its canonical result')
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value, null, 2) }])
  expect(PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))).instructions).toBe('保留原文。')
  expect(tool.output.presentationMeta?.({ request: { method: 'status', project: 'project.json' } }, result.value)).toEqual({ method: 'status', project: 'project.json' })
  expect(tool.isConcurrencySafe?.({ request: { method: 'status', project: 'project.json' } })).toBe(true)
  expect(tool.isConcurrencySafe?.({ request: { method: 'init', project: 'project.json', mode: 'faithful', instructions: '方向' } })).toBe(false)
})

it('fails malformed model JSON and agentless calls before creating project files', async () => {
  const { call } = await fixture()
  for (const request of [{ method: 'init', project: 'project.json' }, { method: 'unknown', project: 'project.json' },
    { method: 'status', project: 'project.json', expected_revision: 0 }]) expect((await call(request)).isError).toBe(true)
  const result = await call({ method: 'init', project: 'project.json', mode: 'faithful', instructions: '保留原文。' }, false)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('initiating agent session')
})

it('resolves standing policy for a session without cwd and rejects a confining provider missing its policy owner', async () => {
  const { ctx, driver, root } = await fixture()
  Object.defineProperty(ctx.fs, 'sandboxMode', { value: 'workspace-write' })
  expect(() =>{  apply(ctx, Config({})) }).toThrow('requires sandboxPolicy')
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  const agent = await driver.create(SessionId('screenplay-without-cwd'))
  const write = vi.spyOn(ctx.fs, 'writeText')
  const result = await ctx.tools.execute({ name: 'screenplay_project', callId: ToolCallId('policy-call'),
    arguments: { request: { method: 'init', project: join(root, 'standing.json'), mode: 'faithful', instructions: '保留原文。' } },
    signal: new AbortController().signal, agent })
  expect(result.isError).toBe(false)
  expect(write.mock.calls[0]![4]).toEqual({ mode: 'workspace-write', workspaceRoot: root, sessionId: agent.session.id })
})

it('returns verified frame images only to an explicitly resolved image-capable route', async () => {
  const { ctx, root, call, driver, agent } = await fixture()
  await call({ method: 'init', project: 'project.json', mode: 'faithful', instructions: '核对原帧，不猜角色。' })
  const video = join(root, 'source.mp4')
  await writeFile(video, 'Owned video test bytes')
  const signal = new AbortController().signal
  const version = (await ctx.fs.stat(await ctx.fs.resolve(video, { signal }), signal))!.version
  const image = await ctx.attachments.saveImage({ data: await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer(), mediaType: 'image/png' })
  await writeFile(join(root, 'inspection.json'), JSON.stringify({ path: video, source_version: version, inspection: 'sampled_frames', verified_readback: true,
    duration_seconds: 10, frames: [{ requested_seconds: 1, timestamp_seconds: 1, image }] }))
  expect((await call({ method: 'import_source', project: 'project.json', expected_revision: 0, path: 'inspection.json', source_kind: 'video_inspection' })).isError).toBe(false)
  const source = PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))).sources[0]!
  const request = { method: 'read_source', project: 'project.json', source_id: source.id, start: 1, count: 1 }
  expect(JSON.stringify((await call(request)).content)).toContain('image_route')
  const providerOnly = await driver.create(SessionId('provider-only'), { provider: 'fixture' }, { cwd: root })
  const invoke = (actor: typeof agent, id: string) => ctx.tools.execute({ name: 'screenplay_project', callId: ToolCallId(id), arguments: { request }, signal, agent: actor })
  expect((await invoke(providerOnly, 'missing-model')).isError).toBe(true)
  agent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'image' } } })
  const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({ provider: 'fixture', id: 'image', name: 'Fixture' })
  expect((await invoke(agent, 'unknown-modalities')).isError).toBe(true)
  resolve.mockResolvedValue({ provider: 'fixture', id: 'image', name: 'Fixture', inputModalities: ['text'] })
  expect((await invoke(agent, 'text-only')).isError).toBe(true)
  resolve.mockResolvedValue({ provider: 'fixture', id: 'image', name: 'Fixture', inputModalities: ['text', 'image'] })
  const result = await invoke(agent, 'image-route')
  expect(result.isError).toBe(false)
  expect(result.content).toContainEqual({ type: 'image', attachment: image })
  expect(resolve).toHaveBeenLastCalledWith('fixture', 'image', expect.any(AbortSignal))
  const optionRoute = await driver.create(SessionId('options-route'), { provider: 'fixture', model: 'image' }, { cwd: root })
  expect((await invoke(optionRoute, 'option-image-route')).isError).toBe(false)
})

it('renders canonical text-only source windows without inserting images', async () => {
  const { root, call } = await fixture()
  await call({ method: 'init', project: 'project.json', mode: 'faithful', instructions: '保留原文。' })
  await writeFile(join(root, 'source.txt'), '甲想：钥匙在我手里。')
  await call({ method: 'import_source', project: 'project.json', expected_revision: 0, path: 'source.txt', source_kind: 'text' })
  const source = PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))).sources[0]!
  const result = await call({ method: 'read_source', project: 'project.json', source_id: source.id, start: 1, count: 1 })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value, null, 2) }])
})

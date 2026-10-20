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
import { LlmAdapter, ToolCallId, createUserMessage, markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import * as SelfCheckFixture from './fixtures/self-check-model.ts'
import * as RefinementFixture from './fixtures/refinement-model.ts'
import * as StoryFixture from './fixtures/story-faithful-model.ts'
import { prepareStoryFixture, STORY_FIXTURE_REQUEST } from './fixtures/story-faithful-fixture.ts'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import * as Video from '@deepseek-ai/dsh-tool-video-inspect'
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
async function fixture(config: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-tool-'))
  const ctx = new Context()
  fixtures.push({ ctx, root })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('screenplay-writer'), {}, { cwd: root })
  const register = vi.spyOn(ctx.tools, 'register')
  const projections = vi.spyOn(ctx.sessionProjections, 'register')
  apply(ctx, Config(config))
  const tool = register.mock.calls[0]![0]
  let ordinal = 0
  const call = (request: Record<string, unknown>, initiated = true) => ctx.tools.execute({
    name: 'screenplay_project', callId: ToolCallId(`screenplay-${++ordinal}`), arguments: { request },
    signal: new AbortController().signal, ...(initiated ? { agent } : {}),
  })
  return { ctx, root, agent, driver, tool, call, projections }
}

it('omits disabled creation extensions from the advisory tool instructions', async () => {
  const { tool } = await fixture({ reviewMode: 'advisory', storyFaithfulMode: 'disabled', refinementMode: 'disabled' })
  expect(tool.description).toContain('同一会话可审校')
  expect(tool.description).not.toContain('init_story_faithful')
  expect(tool.description).not.toContain('fork_refinement')
})

it('describes explicitly enabled creation extensions as advisory, retaining real grants and located changes', async () => {
  const { tool } = await fixture({ reviewMode: 'advisory', storyFaithfulMode: 'story-faithful-v2', refinementMode: 'source-preserving-v1' })
  expect(tool.description).toContain('init_story_faithful 绑定真实用户作品请求、原视频及集号')
  expect(tool.description).toContain('fork_refinement 保留真实基线和用户原话授权')
  expect(tool.description).toContain('不强制审校者身份或A/B/C轮')
  expect(tool.description).not.toContain('review_fact 须由另一会话')
})

it('rejects dependent creation settings before mounting without their projection owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-composition-')), ctx = new Context()
  fixtures.push({ ctx, root })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  expect(() => { apply(ctx, Config({ storyFaithfulMode: 'story-faithful-v2' })) }).toThrow('requires self-check or advisory')
  for (const config of [{ reviewMode: 'self-check' }, { refinementMode: 'source-preserving-v1' },
    { reviewMode: 'self-check', storyFaithfulMode: 'story-faithful-v2' }] satisfies Partial<Config>[]) {
    expect(() => { apply(ctx, Config(config)) }).toThrow('requires live sessionProjections')
  }
})

it('rejects empty, unprojected, and superseded genuine story grants before writing a work', async () => {
  const { agent, call, projections, root } = await fixture({ reviewMode: 'self-check', storyFaithfulMode: 'story-faithful-v2' })
  const request = { method: 'init_story_faithful', project: 'story.json', work_title: '第一部', videos: [], episodes: [1],
    scope_instructions: '保持来源故事。', authorization_quote: ' ', consent_assessment: '仅第一部。', allowed_categories: [] }
  expect(JSON.stringify((await call(request)).content)).toContain('请引用真实用户')
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '将第一部转剧本。' }] }), { surfaceOp: 'append' })
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '改为第二部。' }] }), { surfaceOp: 'append' })
  const oldGrant = { ...request, authorization_quote: '将第一部转剧本。' }
  expect(JSON.stringify((await call(oldGrant)).content)).toContain('新作品必须引用最新真实用户请求')
  const registration = projections.mock.results[0]
  if (registration?.type !== 'return') throw Error('Refinement projection registration is missing')
  registration.value()
  expect(JSON.stringify((await call(oldGrant)).content)).toContain('真实用户消息投影尚未就绪')
  await expect(readFile(join(root, 'story.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('validates configurable allocation budgets and rejects nonpositive or fractional values', () => {
  expect(name).toBe('screenplay-project')
  expect(inject).toEqual(['fs', 'tools', 'attachments', 'llm'])
  expect(Config({})).toEqual({
    reviewMode: 'independent', refinementMode: 'disabled', storyFaithfulMode: 'disabled',
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

it('lets the initiating agent review and draft chosen episodes without review or adoption order gates', async () => {
  const { call, root, tool, agent } = await fixture({ reviewMode: 'advisory' })
  const project = 'advisory.json'
  const current = async () => PROJECT_FILE.parse(JSON.parse(await readFile(join(root, project), 'utf8')))
  expect(tool.description).toContain('自主审校模式')
  expect(tool.description).not.toContain('review_fact 须由另一会话')
  await writeFile(join(root, 'source.txt'), '甲：门开着。\n甲走进屋里。')
  expect((await call({ method: 'init', project, mode: 'faithful', instructions: '保留来源，由Agent自行决定审校。' })).isError).toBe(false)
  expect((await call({ method: 'import_source', project, expected_revision: (await current()).revision,
    path: 'source.txt', source_kind: 'text' })).isError).toBe(false)
  const source = (await current()).sources[0]!
  for (const [index, kind] of ['speech', 'action'].entries()) {
    const unit = source.units[index]!
    expect((await call({ method: 'propose_fact', project, expected_revision: (await current()).revision,
      fact: { kind, origin: 'source', actor: '甲', layer: 'present', summary: unit.text,
        anchors: [{ unit_id: unit.id, quote: unit.text }] } })).isError).toBe(false)
  }
  const facts = (await current()).facts
  expect((await call({ method: 'review_fact', project, expected_revision: (await current()).revision,
    fact_id: facts[0]!.id, decision: 'approve', reason: '已核对原话，记录本会话判断。' })).isError).toBe(false)
  expect((await call({ method: 'stage', project, expected_revision: (await current()).revision, episode: 1,
    scenes: [{ location: '屋门', time: '日', setting: '内', layer: 'present', transition: 'opening', characters: ['甲'],
      beats: [{ kind: 'dialogue', actor: '甲', text: '门开着。', fact_ids: [facts[0]!.id], requires_knowledge: [], witnesses: [] },
        { kind: 'action', actor: '甲', text: '甲走进屋里。', fact_ids: [facts[1]!.id], requires_knowledge: [], witnesses: [] }] }] })).isError).toBe(false)
  const candidate = (await current()).candidates[0]!
  expect((await call({ method: 'commit', project, expected_revision: (await current()).revision,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 })).isError).toBe(false)
  expect((await call({ method: 'export', project, candidate_id: candidate.id, directory: 'final' })).isError).toBe(false)
  const adopted = await current()
  expect(adopted.facts[0]!.review).toMatchObject({ actor: agent.session.id, kind: 'advisory', decision: 'approve' })
  expect(adopted.facts[1]!.review).toBeUndefined()
  expect(adopted.candidates[0]!.review).toBeUndefined()
  expect(adopted.accepted).toEqual([candidate.id])
  expect((await call({ method: 'stage', project, expected_revision: adopted.revision, episode: 3,
    scenes: candidate.scenes })).isError).toBe(false)
  const third = (await current()).candidates.at(-1)!
  const savedProject = await readFile(join(root, project), 'utf8')
  const draftExport = await call({ method: 'export', project, candidate_id: third.id, directory: 'third-draft' })
  expect(draftExport.isError).toBe(false)
  expect(draftExport.value).toMatchObject({ adoption: { episode: 3, adopted: false, committed_at: null, review: null } })
  expect(await readFile(join(root, project), 'utf8')).toBe(savedProject)
  expect((await current()).accepted).toEqual([candidate.id])
  const draftPath = join(root, 'third-draft', `episode-3-${third.id.slice(2)}.md`)
  expect(await readFile(draftPath, 'utf8')).toContain('第3集')
  expect((await call({ method: 'commit', project, expected_revision: (await current()).revision,
    candidate_id: third.id, candidate_sha256: third.sha256 })).isError).toBe(false)
  expect((await current()).accepted).toEqual([candidate.id, third.id])
  await writeFile(join(root, 'source.txt'), '已更换的来源。')
  const changed = await call({ method: 'export', project, candidate_id: candidate.id, directory: 'changed' })
  expect(changed.isError).toBe(true)
  expect(JSON.stringify(changed.content)).toContain('source_changed')
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

class NativeReadAdapter extends LlmAdapter {
  private readonly steps = new Map<string, number>()
  constructor(private readonly root: string, private readonly failAfterRead = false) { super() }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, inputModalities: ['text'] as const }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const session = options.sessionId, step = this.steps.get(session) ?? 0
    this.steps.set(session, step + 1)
    const project = `${session}.json`
    let requests: Record<string, unknown>[] = []
    if (step === 0) requests = [
      { method: 'init', project, mode: 'faithful', instructions: '保留来源。' },
      { method: 'import_source', project, expected_revision: 0, path: 'source.txt', source_kind: 'text' },
    ]
    if (step === 1) {
      const source = PROJECT_FILE.parse(JSON.parse(await readFile(join(this.root, project), 'utf8'))).sources[0]!
      requests = [{ method: 'read_source', project, source_id: source.id, start: 1, count: 1 }]
    }
    if (step === 2) {
      expect(options.messages.some(message => message.source?.kind === 'screenplay-project-read')).toBe(true)
      if (this.failAfterRead) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER_ERROR', message: 'Read observation failed' } } }
        return
      }
      requests = [{ method: 'status', project }]
    }
    if (step === 3 && this.failAfterRead) requests = [{ method: 'status', project }]
    for (const [index, request] of requests.entries()) {
      const id = ToolCallId(`${session}-${step}-${index}`), args = JSON.stringify({ request })
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: 'screenplay_project', argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'screenplay_project', arguments: args } }
    }
    yield { type: 'finish', reason: { kind: requests.length ? 'tool-calls' : 'stop' } }
  }
}

it.each([false, true])('retains native reads only through successful model observation, failed request=%s', async (failed) => {
  const { ctx, root } = await fixture({ reviewMode: 'self-check' })
  await writeFile(join(root, 'source.txt'), '甲推门。')
  ctx.llm.registerAdapter(['native-read-fixture'], new NativeReadAdapter(root, failed))
  const handle = await ctx.agents.create({ sessionId: SessionId('native-reader'),
    agentOptions: { provider: 'native-read-fixture', model: 'native-read-fixture' }, meta: { cwd: root } })
  const { agent } = handle
  const send = () => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '读取当前来源。' }] })) }
  send()
  await agent.whenIdle()
  const read = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'screenplay-project-read')
  if (read?.type !== 'user/message') throw Error('Native read context is missing')
  expect(read.data.content).toHaveLength(1)
  const content = read.data.content[0]
  if (content?.type !== 'text') throw Error('Native text read context is missing')
  expect(content.text).toContain('甲推门。')
  if (failed) {
    agent.session.append('user/message', { ...read.data, content: [{ type: 'text', text: '已替换的读取上下文。' }] },
      { surfaceOp: { op: 'replace', startSeq: read.seq, endSeq: read.seq }, sourceEventSeqs: [read.seq] })
    send()
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
  } else {
    const secondHandle = await ctx.agents.create({ sessionId: SessionId('native-reader-second'),
      agentOptions: { provider: 'native-read-fixture', model: 'native-read-fixture' }, meta: { cwd: root } })
    const second = secondHandle.agent
    second.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '读取第二个项目。' }] }))
    await second.whenIdle()
    await handle.dispose()
    await secondHandle.dispose()
  }
  for (const loopMarked of [false, true]) {
    const options: GenerateOptions = { provider: 'native-read-fixture', model: 'native-read-fixture',
      messages: [{ role: 'user', content: [{ type: 'text', text: '没有持久消息身份的辅助输入。' }] }], purpose: 'session-title' }
    // The process-local marker alone cannot grant an identity-free input a read receipt.
    if (loopMarked) markAgentLoopRequest(options)
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  }
})


it.each([false, true])('observes actual rereads before self approval in PTC, with observed images offloaded=%s', async (offload) => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-loop-self-check-')), ctx = new Context()
  fixtures.push({ ctx, root })
  const errors: string[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(LocalSandbox)
  await ctx.plugin(NodeRuntime).await()
  await writeFile(join(root, 'source.txt'), '甲想：钥匙在我手里。\n甲推门。\n')
  apply(ctx, Config({ reviewMode: 'self-check' }))
  await ctx.plugin(SelfCheckFixture, { cwd: root }).await()
  let completedPrograms = 0, replaced = false
  ctx.on('tools/result', (exec) => { if (exec.name === 'run_code') completedPrograms++ })
  ctx.on('tools/execute', async (exec, next) => {
    if (offload && !replaced && completedPrograms === 16 && exec.agent !== undefined && exec.name === 'screenplay_project') {
      const source = exec.agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
        && event.data.source.kind === 'screenplay-project-read' && event.data.content.some(block => block.type === 'image'))
      if (source?.type !== 'user/message') throw Error('Observed image read is missing')
      exec.agent.session.append('user/message', { ...source.data,
        content: source.data.content.map(block => block.type === 'image' ? { ...block, offloaded: true } : block) },
      { surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] })
      replaced = true
    }
    return next()
  })
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('screenplay-self-check-loop'), {
    provider: 'screenplay-self-check-fixture', model: 'screenplay-self-check-fixture',
  }, { cwd: root })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '按实际来源自检并交付第一集。' }] }))
  await agent.whenIdle()
  expect(errors).toEqual([])
  const project = PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')))
  expect(project.accepted).toHaveLength(1)
  expect(replaced).toBe(offload)
  expect(project.candidates.at(-1)?.review).toMatchObject({ decision: 'approve', kind: 'self-check' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result' && event.data.message.isError))
    .not.toHaveLength(0)
}, 60_000)


it('binds a real user refinement grant and delivers separately through the PTC loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-loop-refinement-')), ctx = new Context()
  fixtures.push({ ctx, root })
  const errors: string[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(LocalSandbox)
  await ctx.plugin(NodeRuntime).await()
  const original = '甲想：钥匙在我手里。'
  await writeFile(join(root, 'source.txt'), original)
  apply(ctx, Config({ reviewMode: 'self-check', refinementMode: 'source-preserving-v1' }))
  await ctx.plugin(RefinementFixture).await()
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('screenplay-refinement-loop'), {
    provider: 'screenplay-refinement-fixture', model: 'screenplay-refinement-fixture',
  }, { cwd: root })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '只精修第一集，可以补最小 OS，不改变事件。' }] }))
  await agent.whenIdle()
  expect(errors).toEqual([])
  const baseline = PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'original.json'), 'utf8')))
  const refined = PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'refinement-v1/qa/screenplay-project.json'), 'utf8')))
  expect(baseline.accepted).toHaveLength(1)
  expect(refined.accepted).toHaveLength(1)
  expect(refined.refinement?.authorization.quote).toBe('只精修第一集，可以补最小 OS，不改变事件。')
  expect(refined.candidates.at(-1)?.refinement?.notes.changes).toHaveLength(1)
  expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe(original)
}, 60_000)


class CurrentLogQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw Error('This fixture reads its original Session only') }
  async searchEvents(): Promise<never> { throw Error('This fixture reads its original Session only') }
}

it('creates a story from decoded original frames and verifies final C approval in the running loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-loop-story-')), ctx = new Context()
  fixtures.push({ ctx, root })
  const errors: string[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(LocalSandbox)
  await ctx.plugin(NodeRuntime).await()
  await ctx.plugin(CurrentLogQuery)
  await ctx.plugin(Video, Video.Config({ trustedEvidence: true })).await()
  await prepareStoryFixture(root)
  apply(ctx, Config({ reviewMode: 'self-check', storyFaithfulMode: 'story-faithful-v2' }))
  await ctx.plugin(StoryFixture, { cwd: root }).await()
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('screenplay-story-loop'), {
    provider: 'screenplay-story-faithful-fixture', model: 'screenplay-story-faithful-fixture',
  }, { cwd: root })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: STORY_FIXTURE_REQUEST }] }))
  await agent.whenIdle()
  expect(errors).toEqual([])
  const project = PROJECT_FILE.parse(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')))
  expect(project.accepted).toHaveLength(1)
  expect(project.sources.some(source => source.trusted_video_receipt !== undefined)).toBe(true)
  expect(project.candidates.at(-1)?.review?.story_acceptance?.sha256).toMatch(/^[a-f0-9]{64}$/u)
}, 60_000)
